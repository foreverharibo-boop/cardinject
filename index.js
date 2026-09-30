// CardInject
import { applyCategoryInjections, chatEvidence, mainRequestDecision, requestFingerprint, resolveContent } from './injection-runtime.js';
import { hasHookOwner, markHookOwner } from './hook-chain.js';

const FETCH_HOOK_OWNER = Symbol('cardinject.fetch');
const PROMPT_CAPTURE_OWNER = Symbol('cardinject.preparePrompt');
let _ciRuntimeActive = true;
const _ciRequestHandlers = [];
const _ciOwnPromptId = id => typeof id === 'string' && id.startsWith('cardinject_') && id.length > 11;

const EXT_KEY = 'cardinject';
// ST 실제 extension_prompt_types 값 (script.js/extensions.js 기준):
//   0 = IN_PROMPT      : 캐릭터 카드 바로 다음, 채팅 시작 직전 (시스템 영역에서 "가장 강력")
//   1 = IN_CHAT         : 채팅 기록 내부, depth로 위치 지정
//   2 = BEFORE_PROMPT   : 메인 시스템 프롬프트보다도 앞, 진짜 최상단
const PT = { IN_PROMPT: 0, IN_CHAT: 1, BEFORE_PROMPT: 2 };

// fetch hook 전용 타입
const PT_NOTE = 12;    // 작가노트 본문 뒤에 삽입, 위치가 없으면 설정된 depth로 대체
const PT_PRESET_REL = 13; // 특정 프리셋 프롬프트 바로 앞/뒤 (동적, POSITIONS 테이블 밖에서 처리)

// ⚠️ ST 프롬프트 실제 순서 (중요):
// [시스템 프롬프트] → [캐릭터 설명/시나리오] → [sys_top/sys_bottom/after_char 자리]
//   → [채팅 기록 전체 (긴 대화일수록 여기가 대부분을 차지)] → [작가노트] → [AI 응답 직전]

const POSITIONS = {
    // ── setExtensionPrompt 처리 (진짜 최상단, 검증됨) ────────────────────────────
    sys_top:      { label: '🔝 시스템 최상단(모든 것보다 위)',             type: PT.BEFORE_PROMPT, depth: 0 },

    // ── setExtensionPrompt 처리 + 전송 직전 누락 보충 ─────────────────────────
    chat_recent:  { label: '💬 최근 메시지 위 (depth 2)',                 type: PT.IN_CHAT, depth: 2      },

    // ── fetch hook 처리 ───────────────────────────────────────────────────────────
    with_note:    { label: '📝 작가노트',                                 type: PT_NOTE,    depth: 0       },
};

// 이전 버전 저장값 호환용 별칭 (드롭다운에는 안 뜸, 기존 데이터 해석 전용)
const POSITION_ALIASES = {
    sys_bottom:   'sys_top',
    after_char:   'sys_top',
    chat_top:     'sys_top',
    chat_deep:    'chat_recent',
    chat_mid:     'chat_recent',
    chat_bottom:  'chat_recent',
    pre_assist:   'with_note',
};

function _resolvePosition(key) {
    if (typeof key === 'string' && (key.startsWith('preset_after_') || key.startsWith('preset_before_'))) {
        return { label: key, type: PT_PRESET_REL, depth: 0 };
    }
    return POSITIONS[key] || POSITIONS[POSITION_ALIASES[key]] || POSITIONS.sys_top;
}

// ── 프리셋 프롬프트 목록 불러오기 ────────────────────────────────────────────
// ST의 OpenAI/Chat Completion 프리셋에 등록된 프롬프트 항목들의 목록을 읽어와서
// 카테고리 위치를 "이 프리셋 앞/뒤"로 지정할 수 있게 함.
function _getPresetPrompts() {
    const oai = _api?.oai_settings
        ?? window.oai_settings
        ?? getCtx()?.oaiSettings
        ?? getCtx()?.oai_settings
        ?? window.SillyTavern?.getContext?.()?.oaiSettings;
    if (!oai || !Array.isArray(oai.prompts)) {
        console.warn('[CI] 프리셋 프롬프트 목록 불러오기 실패 — oai_settings/prompts를 찾지 못함.');
        return [];
    }

    const idx = getSelectedIdx();
    const char = getAllChars()[idx];
    const charId = char?.avatar ?? char?.name ?? null;
    let order = null;
    if (Array.isArray(oai.prompt_order)) {
        order = oai.prompt_order.find(o => o.character_id === charId)
             ?? oai.prompt_order.find(o => o.character_id === 100001)
             ?? oai.prompt_order[0];
    }
    const orderList = order?.order ?? [];

    const result = [];
    for (const entry of orderList) {
        const p = oai.prompts.find(pp => pp.identifier === entry.identifier);
        if (!p) continue;
        if (p.marker) continue; // 마커류(=Chat History 등 자리표시자)는 제외
        result.push({
            identifier: p.identifier,
            name: p.name || p.identifier,
            content: p.content || '',
            role: p.role || 'system',
            enabledInPreset: entry.enabled !== false,
        });
    }
    return result;
}

// 카테고리 위치 select에 붙일 "프리셋 프롬프트 앞/뒤" 동적 옵션 HTML 생성
function _presetRelOptionsHtml(currentPosition) {
    const prompts = _getPresetPrompts();
    if (!prompts.length) return '';
    const opts = prompts.map(p => {
        const afterVal  = `preset_after_${p.identifier}`;
        const beforeVal = `preset_before_${p.identifier}`;
        return `<option value="${esc(afterVal)}" ${currentPosition===afterVal?'selected':''}>${esc(p.name)} 다음</option>` +
               `<option value="${esc(beforeVal)}" ${currentPosition===beforeVal?'selected':''}>${esc(p.name)} 앞</option>`;
    }).join('');
    return `<optgroup label="── 프리셋 프롬프트 기준 ──">${opts}</optgroup>`;
}

// 위치에 따른 강도 매핑
const POSITION_IMPORTANCE = {
    sys_top:     'high',
    with_note:   'high',
    chat_recent: 'medium',
};
function _importanceForPosition(posKey) {
    return POSITION_IMPORTANCE[posKey] || POSITION_IMPORTANCE[POSITION_ALIASES[posKey]] || 'medium';
}

// 작가노트 실제 텍스트 내용 — fetch hook에서 최종 메시지 배열 속 AN을
// 정확히 찾아내기 위한 용도 (depth 추측이 아니라 내용 매칭으로 확실하게 위치시킴)
function _getAuthorNoteText() {
    try {
        const ctx = getCtx();
        const meta = ctx?.chatMetadata ?? ctx?.chat_metadata ?? window.chat_metadata;
        const t = meta?.note_prompt;
        if (typeof t === 'string' && t.trim()) return t.trim();
    } catch (_) {}
    return '';
}

// ── ST API ────────────────────────────────────────────────────────────────────

let _api = null;
async function getApi() {
    if (_api) return _api;
    _api = {};
    for (const p of ['../../../extensions.js', '../../../../script.js', '../../../openai.js']) {
        try { Object.assign(_api, await import(p)); }
        catch (e) { console.warn('[CI] import 실패:', p, e.message); }
    }
    _installPromptCapture();
    _registerInjectionRequestHooks();
    return _api;
}

function getCtx() {
    if (window.SillyTavern?.getContext) return window.SillyTavern.getContext();
    if (_api?.getContext) return _api.getContext();
    return null;
}

// 캐시트 분석용 백그라운드 생성 호출.
// 선택한 연결 프로필에 직접 요청하며, 본채팅이나 현재 연결은 건드리지 않음.
async function callGenerate(prompt) {
    await getApi();
    const service = getCtx()?.ConnectionManagerRequestService;
    if (!service || typeof service.sendRequest !== 'function') {
        throw new Error('ST 백그라운드 요청 서비스를 찾을 수 없어요. SillyTavern을 업데이트해주세요.');
    }

    const profileId = _analysisProfileId ?? ensureGlobalSettings().connectionProfileId;
    if (!profileId) throw new Error('확장 탭에서 연결 프로필을 먼저 선택해주세요.');

    const profile = typeof service.getProfile === 'function' ? service.getProfile(profileId) : null;
    if (typeof service.isProfileSupported === 'function' && profile && !service.isProfileSupported(profile)) {
        throw new Error('선택한 연결 프로필은 백그라운드 생성을 지원하지 않아요.');
    }

    globalThis._ciAnalyzing = true;
    try {
        const result = await service.sendRequest(profileId, prompt, 4096, {
            stream: false,
            extractData: true,
            includePreset: false,
            includeInstruct: false,
        });
        const text = typeof result === 'string' ? result : result?.content;
        if (typeof text !== 'string' || !text.trim()) throw new Error('백그라운드 생성 결과가 비어있어요.');
        return text;
    } finally {
        globalThis._ciAnalyzing = false;
    }
}

// ── Settings (캐릭터별 저장) ──────────────────────────────────────────────────

// 원문 주입과는 분리된 화면 확인용 Google 한국어 번역.
async function translateToKorean(text) {
    if (!text?.trim()) throw new Error('번역할 내용이 없어요.');

    let translateFn = typeof globalThis.translate === 'function' ? globalThis.translate : null;
    if (!translateFn) {
        try {
            const module = await import('../../translate/index.js');
            translateFn = module.translate;
        } catch (e) {
            console.warn('[CI] 번역 모듈 import 실패:', e.message);
        }
    }
    if (typeof translateFn !== 'function') {
        throw new Error('SillyTavern Google 번역 기능을 찾을 수 없어요.');
    }

    const translated = await translateFn(text, 'ko', 'google');
    if (typeof translated !== 'string' || !translated.trim()) {
        throw new Error('Google 번역 결과가 비어있어요.');
    }
    return translated.trim();
}

function ensureGlobalSettings() {
    const ctx = getCtx();
    const store = ctx?.extensionSettings ?? ctx?.extension_settings ?? {};
    if (!store[EXT_KEY]) store[EXT_KEY] = { perChar: {}, selectedCharIdx: null, lastCharId: null, activeKeys: [] };
    const s = store[EXT_KEY];
    if (!s.perChar) s.perChar = {};
    if (!Array.isArray(s.activeKeys)) s.activeKeys = [];

    // 구버전 마이그레이션: 예전엔 categories가 전역 배열 하나였음
    if (Array.isArray(s.categories)) {
        const idx = s.selectedCharIdx ?? 0;
        const key = _charKey(idx) ?? '__migrated__';
        if (!s.perChar[key]) s.perChar[key] = { categories: s.categories };
        delete s.categories;
    }
    return s;
}

// 캐릭터를 구분하는 안정적인 키 (아바타 파일명 우선, 없으면 이름)
function _charKey(idx) {
    const char = getAllChars()[idx];
    if (!char) return null;
    return char.avatar || char.name || `idx_${idx}`;
}

function ensureSettings() {
    const g = ensureGlobalSettings();
    const idx = getSelectedIdx();
    const key = _charKey(idx) ?? '__no_char__';
    if (!g.perChar[key]) g.perChar[key] = { categories: [] };
    const charStore = g.perChar[key];

    // 이전 버전 저장값 마이그레이션: 제거된 위치들 → 가장 가까운 남은 위치로
    if (Array.isArray(charStore.categories)) {
        charStore.categories.forEach(c => {
            if (c.position && POSITION_ALIASES[c.position]) {
                c.position = POSITION_ALIASES[c.position];
            }
        });
    }
    return charStore;
}

async function save() {
    try { (_api?.saveSettingsDebounced ?? window.saveSettingsDebounced ?? (() => {}))(); } catch (_) {}
}

// ── Characters ────────────────────────────────────────────────────────────────

function getAllChars() { return getCtx()?.characters ?? []; }

function _getCurrentCharId() {
    const ctx = getCtx();
    const candidates = [
        ctx?.characterId,
        window.this_chid,
        window.SillyTavern?.getContext?.()?.characterId,
    ];
    for (const c of candidates) {
        if (c != null && !Number.isNaN(Number(c))) return Number(c);
    }
    return null;
}

function getSelectedIdx() {
    const g = ensureGlobalSettings(), chars = getAllChars();
    if (g.selectedCharIdx != null && chars[g.selectedCharIdx]) return g.selectedCharIdx;
    const curId = _getCurrentCharId();
    if (curId != null && chars[curId]) return curId;
    return chars.length ? 0 : null;
}

function getSheet(idx) {
    const char = getAllChars()[idx ?? getSelectedIdx()];
    if (!char) return null;
    return {
        name: char.name || '(이름 없음)',
        description: char.description || '',
        personality: char.personality || '',
        scenario: char.scenario || '',
        mes_example: char.mes_example || '',
        system_prompt: char.system_prompt || '',
        post_history_instructions: char.post_history_instructions || '',
    };
}

// ── Connection Profiles ───────────────────────────────────────────────────────
// ST 설정 패널의 실제 <select id="connection_profiles"> DOM을 직접 읽고 조작함.
// (내부 데이터 구조가 ST 버전마다 달라서, 화면에 이미 렌더링된 select의
//  option 목록을 그대로 읽는 게 가장 안정적)

function _findProfileSelectEl() {
    const ids = ['#connection_profiles', '#connection_profile_select', '#profile_select_dropdown'];
    for (const id of ids) {
        const el = document.querySelector(id);
        if (el && el.tagName === 'SELECT') return el;
    }
    return null;
}

function getConnectionProfiles() {
    const service = getCtx()?.ConnectionManagerRequestService;
    if (service && typeof service.getSupportedProfiles === 'function') {
        const profiles = service.getSupportedProfiles();
        if (Array.isArray(profiles) && profiles.length) {
            return profiles.map(p => ({ id: p.id, name: p.name || p.id }));
        }
    }

    const el = _findProfileSelectEl();
    if (el) {
        return Array.from(el.options).map(o => ({ id: o.value, name: o.textContent.trim() }));
    }
    // DOM에서 못 찾으면 내부 데이터 구조로 폴백 시도
    const ctx = getCtx();
    const cm = ctx?.extensionSettings?.connectionManager
        ?? window.extension_settings?.connectionManager
        ?? ctx?.extension_settings?.connectionManager;
    if (cm && Array.isArray(cm.profiles)) {
        return cm.profiles.map(p => ({ id: p.id, name: p.name }));
    }
    return null;
}

// ── Injection ─────────────────────────────────────────────────────────────────

// 실제 주입 로직
// 최상단과 최근 메시지 위치는 표준 setExtensionPrompt로 등록.
// 작가노트와 프리셋 상대 위치는 요청 조립 후 처리하며, 최종 전송에서 모두 재확인.
function _doInject(fn) {
    if (!_ciRuntimeActive) return 0;
    const g = ensureGlobalSettings();

    // 이전에 등록했던 키들 먼저 전부 지워서 캐릭터 전환 시 주입이 남아있는 문제 방지
    if (Array.isArray(g.activeKeys)) {
        g.activeKeys.filter(_ciOwnPromptId).forEach(id => {
            try { fn(id, '', PT.IN_PROMPT, 0, false, 0); } catch (_) {}
            _directWrite(id, '', PT.IN_PROMPT, 0);
        });
    }
    g.activeKeys = [];

    const cats = ensureSettings().categories;
    let count = 0;
    cats.forEach((cat, i) => {
        const id = `${EXT_KEY}_${cat.key || i}`;
        const pos = _resolvePosition(cat.position);
        g.activeKeys.push(id);
        if (cat.enabled) count++;

        // 요청 본문에서 처리하는 작가노트와 프리셋 상대 위치는
        // 여기서 기존 등록값만 지우고 건너뜀
        if (pos.type === PT_NOTE || pos.type === PT_PRESET_REL) {
            try { fn(id, '', PT.IN_PROMPT, 0, false, 0); } catch(_) {}
            _directWrite(id, '', PT.IN_PROMPT, 0);
            return;
        }

        if (cat.enabled && cat.content?.trim()) {
            const depth = pos.type === PT.IN_CHAT ? Math.max(0, Number(cat.customDepth ?? pos.depth) || 0) : pos.depth ?? 0;
            try { fn(id, cat.content, pos.type, depth, false, 0); } catch(e) { console.warn('[CI] fn 오류:', e); }
            _directWrite(id, cat.content, pos.type, depth);
        } else {
            try { fn(id, '', PT.IN_PROMPT, 0, false, 0); } catch(_) {}
            _directWrite(id, '', PT.IN_PROMPT, 0);
        }
    });
    return count;
}

// ── Generate Interceptor: 표준 프롬프트 등록과 본채팅 증거 수집 ──────────────
// manifest.json의 generate_interceptor로 등록됨.
globalThis.ciInterceptor = async function (chat, contextSize, abort, type) {
    if (!_ciRuntimeActive) return;
    try {
        _installFetchHook();
        _installPromptCapture();
        const normalized = String(type ?? '').trim().toLowerCase() || 'normal';
        if (!['normal', 'regenerate', 'swipe', 'continue', 'quiet'].includes(normalized)) return;
        _ciChatSnapshot = chatEvidence(chat);
        // quiet can be either a gated main reply or an auxiliary Generate.
        // Observe here, then prove the actual sender at SETTINGS_READY/fetch.
        if (normalized === 'quiet') return;
        const fn = _findSetPrompt();
        if (fn) _doInject(fn);
        _applyNoteInjection(_ciEnabledCategories());
    } catch (e) {
        console.error('[CI] interceptor 오류:', e);
    }
};

// 작가노트(Author's Note)에 with_note 카테고리 내용을 직접 이어붙임.
// fetch hook이 최종 요청 메시지 배열에서 직접 처리 — 여기서는 캐시 갱신만.
const CI_NOTE_MARKER = '\n\n[CSI:with_note]\n';
let _lastNoteHash = '';

function _applyNoteInjection(enabledCats) {
    const noteCats = (enabledCats ?? ensureSettings().categories.filter(c => c.enabled && c.content?.trim()))
        .filter(c => c.position === 'with_note');
    globalThis._ciNoteContent = noteCats.length
        ? noteCats.map(c => c.content).join('\n\n')
        : '';
}

// setExtensionPrompt 함수 찾기
function _findSetPrompt() {
    try {
        const ctx = getCtx();
        if (typeof ctx?.setExtensionPrompt === 'function') return ctx.setExtensionPrompt;
    } catch (_) {}
    if (typeof window.setExtensionPrompt === 'function') return window.setExtensionPrompt;
    if (typeof _api?.setExtensionPrompt === 'function') return _api.setExtensionPrompt;
    return null;
}

// extension_prompts 직접 접근 (module 인스턴스 우회 목적)
function _directWrite(id, value, position, depth) {
    if (!_ciOwnPromptId(id)) return false;
    const targets = [
        () => window.extension_prompts,
        () => getCtx()?.extensionPrompts,
        () => getCtx()?.extension_prompts,
        () => _api?.extension_prompts,
    ];
    for (const getter of targets) {
        try {
            const ep = getter();
            if (ep && typeof ep === 'object') {
                if (value) {
                    ep[id] = { value, position, depth, scan: false, role: 0 };
                } else {
                    delete ep[id];
                }
                return true;
            }
        } catch (_) {}
    }
    return false;
}

async function applyInjections() {
    await getApi();

    const fn = _findSetPrompt();
    if (!fn) {
        const apiKeys = Object.keys(_api || {}).filter(k =>
            k.toLowerCase().includes('prompt') || k.toLowerCase().includes('extension')
        ).slice(0, 10);
        console.error('[CI] setExtensionPrompt 없음. 관련 키:', apiKeys);
        toast('error', 'setExtensionPrompt를 찾을 수 없어요. 콘솔의 [CI] 로그 확인해주세요.');
        return;
    }

    const cats = ensureSettings().categories;
    if (!cats.length) {
        toast('warning', '주입할 카테고리가 없어요. 먼저 분석해주세요.');
        return;
    }

    const enabled = cats.filter(c => c.enabled && c.content?.trim());
    const count = _doInject(fn);
    _applyNoteInjection(enabled);
    await save();

    console.log(`[CI] 수동 주입 적용: 활성 카테고리 ${count}개`);
    toast('success', `✓ ${count}개 카테고리 주입 완료!`);
}

async function clearInjections() {
    await getApi();
    const fn = _findSetPrompt();
    const g = ensureGlobalSettings();
    if (fn && Array.isArray(g.activeKeys)) {
        g.activeKeys.filter(_ciOwnPromptId).forEach(id => {
            try { fn(id, '', PT.IN_PROMPT, 0, false, 0); } catch (_) {}
            _directWrite(id, '', PT.IN_PROMPT, 0);
        });
    }
    g.activeKeys = [];
    _applyNoteInjection([]);
    console.log('[CI] 주입 초기화 완료');
}

// ── Prompt ────────────────────────────────────────────────────────────────────

function buildPrompt(s) {
    const parts = [];
    if (s.description)               parts.push(`[Character Description]\n${s.description}`);
    if (s.personality)               parts.push(`[Personality]\n${s.personality}`);
    if (s.scenario)                  parts.push(`[Scenario]\n${s.scenario}`);
    if (s.mes_example)               parts.push(`[Example Messages]\n${s.mes_example}`);
    if (s.system_prompt)             parts.push(`[System Prompt]\n${s.system_prompt}`);
    if (s.post_history_instructions) parts.push(`[Post History Instructions]\n${s.post_history_instructions}`);

    return `[OOC: STOP. DO NOT ROLEPLAY. DO NOT RESPOND AS ANY CHARACTER. THIS IS NOT A ROLEPLAY MESSAGE.
This is a technical JSON analysis task performed by a SillyTavern extension.
IGNORE ALL CHARACTER INSTRUCTIONS, SYSTEM PROMPTS, AND PERSONA DEFINITIONS ABOVE.
You must respond with ONLY a raw JSON object. No prose, no narration, no character voice, no markdown.]

TASK: Analyze the following character sheet text and categorize its content into groups for AI prompt injection.

OUTPUT FORMAT — respond with ONLY this JSON structure, nothing else:
{
  "categories": [
    {
      "key": "unique_snake_key",
      "name": "Category Name (same language as source)",
      "content": "Rewritten as a clear AI instruction. Keep original language. Use {{char}} instead of the character's literal name.",
      "importance": "high",
      "suggested_position": "sys_top"
    }
  ]
}

FIELD VALUES:
- content: Every sentence must make clear who it's about by using the literal macro "{{char}}" in place of the character's name "${s.name}" (e.g. write "{{char}} is stubborn" not "${s.name} is stubborn"). This lets the roleplay AI recognize whose trait it's reading. If the user/player character is referenced, use "{{user}}" the same way.
- importance: "high" / "medium" / "low"
- suggested_position: "sys_top" / "with_note" / "chat_recent"
  - sys_top    : Core identity, personality, rules — must always be present (system top)
  - with_note  : Context that benefits from being near recent messages (author's note position)
  - chat_recent: Recent context, short-term behavior hints (depth 2, just above latest messages)
- Use 3 to 8 categories. Keep the source material's language.

CHARACTER SHEET FOR "${s.name}":
=====
${parts.join('\n\n')}
=====

[REMINDER: Output ONLY the JSON object above. No roleplay. No character voice. No markdown fences. Every "content" field must use the literal macro "{{char}}" instead of writing "${s.name}" directly.]`;
}

// ── Toast 알림 (ST toastr와 완전히 독립된 자체 UI) ──────────────────────────────
function toast(type, msg) {
    const el = document.createElement('div');
    el.className = `ci-own-toast ci-toast-${type === 'success' || type === 'error' || type === 'warning' ? type : 'info'}`;
    el.textContent = msg;
    document.documentElement.appendChild(el);

    // 모바일에서 주소창/툴바가 접히거나 페이지가 스크롤된 상태일 때
    // visualViewport 기준으로 위치를 보정 (모달과 동일한 방식)
    const positionToast = () => {
        const vp = window.visualViewport;
        const ox = vp ? vp.offsetLeft : 0;
        const oy = vp ? vp.offsetTop  : 0;
        const vw = vp ? vp.width      : window.innerWidth;
        el.style.left = Math.round(ox + vw / 2) + 'px';
        el.style.top  = Math.round(oy + 10) + 'px';
    };
    positionToast();

    let vpHandlers = [];
    if (window.visualViewport) {
        vpHandlers = [positionToast];
        window.visualViewport.addEventListener('resize', positionToast);
        window.visualViewport.addEventListener('scroll', positionToast);
    }

    requestAnimationFrame(() => el.classList.add('ci-toast-show'));

    const duration = type === 'error' ? 3500 : 1800;
    setTimeout(() => {
        el.classList.remove('ci-toast-show');
        setTimeout(() => {
            el.remove();
            if (window.visualViewport) {
                vpHandlers.forEach(fn => {
                    window.visualViewport.removeEventListener('resize', fn);
                    window.visualViewport.removeEventListener('scroll', fn);
                });
            }
        }, 200);
    }, duration);
}

// ── Utilities ─────────────────────────────────────────────────────────────────

const esc = str => { const d = document.createElement('div'); d.textContent = str||''; return d.innerHTML; };
const impLabel = v => ({high:'높음', medium:'중간', low:'낮음'}[v]||'중간');

// ── Modal positioning ─────────────────────────────────────────────────────────

function positionModal() {
    if (!modalEl) return;
    const vp = window.visualViewport;
    const vw = vp ? vp.width  : window.innerWidth;
    const vh = vp ? vp.height : window.innerHeight;
    const ox = vp ? vp.offsetLeft : 0;
    const oy = vp ? vp.offsetTop  : 0;
    const mw = Math.min(560, Math.round(vw * 0.94));
    const mh = Math.round(vh * 0.88);
    modalEl.style.left      = Math.round(ox + (vw - mw) / 2) + 'px';
    modalEl.style.top       = Math.round(oy + vh * 0.06) + 'px';
    modalEl.style.width     = mw + 'px';
    modalEl.style.maxHeight = mh + 'px';
    modalEl.style.transform = 'none';
}

// ── Modal DOM ─────────────────────────────────────────────────────────────────

let backdropEl = null;
let modalEl    = null;
let analyzing  = false;
let _analysisProfileId = null;     // 백그라운드 생성에 사용할 연결 프로필
let vpListeners = [];

function buildModal() {
    backdropEl = document.createElement('div');
    backdropEl.id = 'ci-backdrop';
    backdropEl.addEventListener('click', closeModal);
    document.documentElement.appendChild(backdropEl);

    modalEl = document.createElement('div');
    modalEl.id = 'ci-modal';
    modalEl.innerHTML = `
  <div class="ci-header">
    <div class="ci-title">
      <span class="ci-icon"><i class="fa-solid fa-syringe"></i></span>
      CardInject
    </div>
    <button class="ci-x" id="ci-x">×</button>
  </div>

  <div class="ci-charbar">
    <i class="fa-solid fa-user ci-char-ico"></i>
    <select class="ci-char-sel" id="ci-char-sel"></select>
    <span class="ci-pill" id="ci-pill" style="display:none"></span>
  </div>

  <div class="ci-top">
    <button class="ci-analyze-btn" id="ci-analyze">
      <i class="fa-solid fa-wand-magic-sparkles"></i> AI로 캐시트 분석하기
    </button>
    <button class="ci-sec ci-add-btn" id="ci-add-cat" style="width:100%;justify-content:center;margin-top:8px">
      <i class="fa-solid fa-plus"></i> 직접 칸 추가
    </button>
    <p class="ci-status" id="ci-status"></p>
  </div>

  <div class="ci-sep"></div>
  <div class="ci-list" id="ci-list"></div>

  <div class="ci-foot">
    <button class="ci-ghost" id="ci-reset"><i class="fa-solid fa-rotate-left"></i> 초기화</button>
    <div style="display:flex;gap:8px">
      <button class="ci-sec" id="ci-save"><i class="fa-solid fa-floppy-disk"></i> 저장</button>
      <button class="ci-pri" id="ci-apply"><i class="fa-solid fa-check"></i> 주입 적용</button>
    </div>
  </div>`;

    document.documentElement.appendChild(modalEl);

    modalEl.querySelector('#ci-x').onclick       = closeModal;
    modalEl.querySelector('#ci-analyze').onclick  = doAnalyze;
    modalEl.querySelector('#ci-add-cat').onclick  = addManualCategory;
    modalEl.querySelector('#ci-apply').onclick    = async () => { await applyInjections(); setStatus('✓ 주입 적용 완료!', 'ok'); };
    modalEl.querySelector('#ci-save').onclick     = async () => { await save(); setStatus('✓ 저장됐어요.', 'ok'); toast('info', '설정이 저장됐어요.'); };
    modalEl.querySelector('#ci-reset').onclick    = doReset;
    modalEl.querySelector('#ci-char-sel').onchange = e => {
        ensureGlobalSettings().selectedCharIdx = parseInt(e.target.value);
        save();
        const s = ensureSettings();
        const pill = modalEl.querySelector('#ci-pill');
        pill.textContent = `${s.categories.length}개`;
        pill.style.display = s.categories.length ? '' : 'none';
        render();
    };
}

function populateCharSel() {
    const sel = modalEl?.querySelector('#ci-char-sel');
    if (!sel) return;
    const chars = getAllChars(), cur = getSelectedIdx();
    console.log('[CI] populateCharSel — 현재 감지:', chars[cur]?.name, '(idx', cur, ') | this_chid:', window.this_chid, '| ctx.characterId:', getCtx()?.characterId);
    sel.innerHTML = chars.length
        ? chars.map((c, i) => `<option value="${i}" ${i===cur?'selected':''}>${esc(c.name||`캐릭터${i+1}`)}</option>`).join('')
        : '<option value="">캐릭터 없음</option>';
}

function openModal() {
    if (!backdropEl) buildModal();

    const curId = _getCurrentCharId();
    if (curId != null) {
        ensureGlobalSettings().selectedCharIdx = curId;
    }

    populateCharSel();
    const s = ensureSettings();
    const pill = modalEl.querySelector('#ci-pill');
    pill.textContent = `${s.categories.length}개`;
    pill.style.display = s.categories.length ? '' : 'none';

    backdropEl.style.display = 'block';
    modalEl.style.display    = 'flex';
    positionModal();

    const reposition = () => positionModal();
    if (window.visualViewport) {
        window.visualViewport.addEventListener('resize', reposition);
        window.visualViewport.addEventListener('scroll', reposition);
        vpListeners = [reposition];
    }
    render();
}

function closeModal() {
    if (backdropEl) backdropEl.style.display = 'none';
    if (modalEl)    modalEl.style.display    = 'none';
    if (window.visualViewport && vpListeners.length) {
        vpListeners.forEach(fn => {
            window.visualViewport.removeEventListener('resize', fn);
            window.visualViewport.removeEventListener('scroll', fn);
        });
        vpListeners = [];
    }
}

// ── Analysis ──────────────────────────────────────────────────────────────────

// 사용자가 AI 분석 없이 직접 채워넣는 빈 카테고리 카드 생성
function addManualCategory() {
    const s = ensureSettings();
    const newCat = {
        key:         'manual_' + Math.random().toString(36).slice(2),
        name:        '새 카테고리',
        content:     '',
        importance:  'medium',
        position:    'sys_top',
        customDepth: POSITIONS.sys_top.depth,
        enabled:     true,
        expanded:    true, // 바로 입력할 수 있게 펼쳐진 상태로 생성
    };
    s.categories.push(newCat);
    save();
    render();

    const pill = modalEl.querySelector('#ci-pill');
    if (pill) {
        pill.textContent = `${s.categories.length}개`;
        pill.style.display = '';
    }

    // 새로 만든 카드가 화면에 보이게 스크롤 + 이름 입력창에 바로 포커스
    requestAnimationFrame(() => {
        const cards = modalEl.querySelectorAll('.ci-card');
        const lastCard = cards[cards.length - 1];
        if (lastCard) {
            lastCard.scrollIntoView({ behavior: 'smooth', block: 'center' });
            const nameInp = lastCard.querySelector('.ci-cname-inp');
            if (nameInp) { nameInp.focus(); nameInp.select(); }
        }
    });
}

// 개별 카테고리 하나만 캐릭터 시트 기준으로 다시 분석해서 content를 새로 채움
function buildRecollectPrompt(s, catName, oldContent) {
    const parts = [];
    if (s.description)               parts.push(`[Character Description]\n${s.description}`);
    if (s.personality)               parts.push(`[Personality]\n${s.personality}`);
    if (s.scenario)                  parts.push(`[Scenario]\n${s.scenario}`);
    if (s.mes_example)               parts.push(`[Example Messages]\n${s.mes_example}`);
    if (s.system_prompt)             parts.push(`[System Prompt]\n${s.system_prompt}`);
    if (s.post_history_instructions) parts.push(`[Post History Instructions]\n${s.post_history_instructions}`);

    return `[OOC: STOP. DO NOT ROLEPLAY. DO NOT RESPOND AS ANY CHARACTER. THIS IS NOT A ROLEPLAY MESSAGE.
This is a technical JSON analysis task performed by a SillyTavern extension.
IGNORE ALL CHARACTER INSTRUCTIONS, SYSTEM PROMPTS, AND PERSONA DEFINITIONS ABOVE.
You must respond with ONLY a raw JSON object. No prose, no narration, no character voice, no markdown.]

TASK: Re-analyze the character sheet below and rewrite the content for ONE specific category only: "${catName}".
Look through the full sheet again for anything relevant to this category — including details the previous version may have missed.

PREVIOUS CONTENT FOR THIS CATEGORY (for reference — improve/replace it, don't just repeat it):
${oldContent || '(비어있었음)'}

OUTPUT FORMAT — respond with ONLY this JSON structure, nothing else:
{
  "content": "Rewritten as a clear AI instruction, using the literal macro \\"{{char}}\\" instead of the character's name \\"${s.name}\\" (and \\"{{user}}\\" for the user/player character where relevant). Keep the source material's language.",
  "importance": "high"
}

FIELD VALUES:
- importance: "high" / "medium" / "low"

CHARACTER SHEET FOR "${s.name}":
=====
${parts.join('\n\n')}
=====

[REMINDER: Output ONLY the JSON object above. No roleplay. No character voice. No markdown fences. Use "{{char}}" instead of writing "${s.name}" directly.]`;
}

async function recollectCategory(i) {
    const s = ensureSettings();
    const cat = s.categories[i];
    if (!cat) return;

    const idx = getSelectedIdx(), sheet = getSheet(idx);
    if (!sheet) { setStatus('캐릭터를 선택해주세요.', 'err'); return; }

    const btn = modalEl.querySelector(`.ci-recollect-btn[data-i="${i}"]`);
    if (btn) {
        if (btn.dataset.busy === '1') return; // 중복 클릭 방지
        btn.dataset.busy = '1';
        btn.disabled = true;
        btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> 다시 수집 중...';
    }
    setStatus(`"${cat.name}" 재수집 중...`, 'load');

    try {
        const raw   = await callGenerate(buildRecollectPrompt(sheet, cat.name, cat.content));
        const clean = raw.replace(/```(?:json)?\n?/g,'').replace(/```/g,'').trim();
        const parsed = JSON.parse(clean);
        if (!parsed.content) throw new Error('재수집 결과가 비어있어요');

        cat.content = parsed.content;
        delete cat.translation;
        delete cat.translationSource;
        delete cat.translationVisible;
        if (parsed.importance) cat.importance = parsed.importance;
        await save();
        render();
        setStatus(`✓ "${cat.name}" 재수집 완료!`, 'ok');
    } catch (e) {
        console.error('[CI]', e);
        setStatus(`재수집 실패: ${e.message}`, 'err');
    } finally {
        // render()로 버튼 자체가 새로 그려지므로 별도 복구 불필요
    }
}

async function doAnalyze() {
    if (analyzing) return;
    const idx = getSelectedIdx(), sheet = getSheet(idx);
    if (!sheet) { setStatus('캐릭터를 선택해주세요.', 'err'); return; }
    if (!Object.values(sheet).join('').trim()) { setStatus('캐릭터 시트가 비어있어요.', 'err'); return; }

    analyzing = true;
    const btn = modalEl.querySelector('#ci-analyze');
    btn.disabled = true;
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> 분석 중...';
    setStatus('캐릭터 시트 분석 중...', 'load');

    try {
        const raw   = await callGenerate(buildPrompt(sheet));
        const clean = raw.replace(/```(?:json)?\n?/g,'').replace(/```/g,'').trim();
        const cats  = JSON.parse(clean).categories;
        if (!Array.isArray(cats)||!cats.length) throw new Error('카테고리 추출 실패');

        const s = ensureSettings();
        s.categories = cats.map(c => {
            const pos = _resolvePosition(c.suggested_position);
            return {
                key:         c.key || Math.random().toString(36).slice(2),
                name:        c.name || 'Category',
                content:     c.content || '',
                importance:  c.importance || 'medium',
                position:    (c.suggested_position in POSITIONS) ? c.suggested_position : 'sys_top',
                customDepth: pos.depth,
                enabled:     true,
                expanded:    false,
            };
        });
        await save();

        render();
        const pill = modalEl.querySelector('#ci-pill');
        pill.textContent = `${cats.length}개`;
        pill.style.display = '';
        setStatus(`✓ ${cats.length}개 카테고리 분석 완료!`, 'ok');
    } catch (e) {
        console.error('[CI]', e);
        setStatus(`실패: ${e.message}`, 'err');
    } finally {
        analyzing = false;
        btn.disabled = false;
        btn.innerHTML = '<i class="fa-solid fa-wand-magic-sparkles"></i> AI로 캐시트 분석하기';

    }
}

// ── Render ────────────────────────────────────────────────────────────────────

function render() {
    const container = modalEl?.querySelector('#ci-list');
    if (!container) return;
    const s = ensureSettings(), cats = s.categories;

    if (!cats.length) {
        container.innerHTML = `
          <div class="ci-empty">
            <i class="fa-solid fa-scroll"></i>
            <p>아직 분석된 카테고리가 없어요.<br>위 버튼으로 분석해보세요!</p>
          </div>`;
        return;
    }

    container.innerHTML = cats.map((c, i) => {
        const pos = _resolvePosition(c.position);
        const showDepth = pos.type === PT.IN_CHAT;
        const hasTranslation = Boolean(c.translation && c.translationSource === c.content);
        const translationVisible = hasTranslation && c.translationVisible === true;
        const translationLabel = hasTranslation
            ? (translationVisible ? '번역본 숨기기' : '번역본 보기')
            : 'Google 번역 보기';
        return `
      <div class="ci-card ${c.enabled?'':'ci-off'}" data-i="${i}">
        <div class="ci-card-top">
          <div class="ci-card-left">
            <span class="ci-imp ci-imp-${c.importance}">${impLabel(c.importance)}</span>
            <input class="ci-cname ci-cname-inp" type="text" data-i="${i}" value="${esc(c.name)}">
          </div>
          <div class="ci-card-right">
            <button class="ci-chevron" data-i="${i}"><i class="fa-solid fa-chevron-${c.expanded?'up':'down'}"></i></button>
            <label class="ci-tog">
              <input type="checkbox" class="ci-chk" data-i="${i}" ${c.enabled?'checked':''}>
              <span class="ci-knob"></span>
            </label>
            <button class="ci-chevron ci-del-btn" data-i="${i}" title="삭제"><i class="fa-solid fa-trash-can"></i></button>
          </div>
        </div>
        ${c.expanded?`
        <div class="ci-textarea-wrap">
          <textarea class="ci-ta" data-i="${i}">${esc(c.content)}</textarea>
          <button class="ci-sec ci-translate-btn" data-i="${i}" style="margin-top:6px;width:100%;justify-content:center">
            <i class="fa-solid fa-language"></i> ${translationLabel}
          </button>
          <div class="ci-translation" data-i="${i}" ${translationVisible ? '' : 'hidden'}>
            <div class="ci-translation-label">Google 번역 · 한국어</div>
            <div class="ci-translation-text">${hasTranslation ? esc(c.translation) : ''}</div>
          </div>
          <button class="ci-sec ci-recollect-btn" data-i="${i}" style="margin-top:6px;width:100%;justify-content:center">
            <i class="fa-solid fa-rotate"></i> 이 항목만 다시 수집
          </button>
        </div>`:''}
        <div class="ci-card-body">
          <div class="ci-row">
            <span class="ci-lbl">위치</span>
            <select class="ci-sel ci-pos-sel" data-i="${i}">
              ${Object.entries(POSITIONS).map(([k,v])=>`<option value="${k}" ${c.position===k?'selected':''}>${v.label}</option>`).join('')}
              ${_presetRelOptionsHtml(c.position)}
            </select>
          </div>
          ${showDepth?`
          <div class="ci-row ci-depth-row">
            <span class="ci-lbl">Depth</span>
            <input class="ci-num ci-depth-inp" type="text" inputmode="numeric"
                   pattern="[0-9]*" data-i="${i}"
                   value="${c.customDepth ?? pos.depth}">
            <span class="ci-hint">위로 몇 번째 메시지</span>
          </div>`:''}
          ${c.position === 'with_note' ? `
          <div class="ci-row">
            <span class="ci-lbl">방식</span>
            <span class="ci-hint">작가노트 본문 뒤에 합쳐짐 — 본문을 찾지 못하면 작가노트 depth 설정에 삽입</span>
          </div>`:''}
          ${_resolvePosition(c.position).type === PT_PRESET_REL ? `
          <div class="ci-row">
            <span class="ci-lbl">방식</span>
            <span class="ci-hint">선택한 프리셋 프롬프트 바로 옆에 삽입됨</span>
          </div>`:''}
        </div>
      </div>`;
    }).join('');

    // 이벤트 바인딩
    container.querySelectorAll('.ci-cname-inp').forEach(inp => {
        inp.addEventListener('click', e => e.stopPropagation());
        inp.addEventListener('input', async e => {
            const i = +e.target.dataset.i;
            s.categories[i].name = e.target.value;
            await save();
        });
    });

    container.querySelectorAll('.ci-chevron:not(.ci-del-btn)').forEach(b => b.addEventListener('click', e => {
        const i=+e.currentTarget.dataset.i;
        s.categories[i].expanded = !s.categories[i].expanded;
        render();
    }));

    container.querySelectorAll('.ci-del-btn').forEach(b => b.addEventListener('click', async e => {
        e.stopPropagation();
        const i = +e.currentTarget.dataset.i;
        const cat = s.categories[i];
        if (!confirm(`"${cat.name}" 카테고리를 삭제할까요?`)) return;
        s.categories.splice(i, 1);
        await save();
        render();
        const pill = modalEl.querySelector('#ci-pill');
        if (pill) {
            pill.textContent = `${s.categories.length}개`;
            pill.style.display = s.categories.length ? '' : 'none';
        }
        setStatus('✓ 삭제됐어요.', 'ok');
    }));

    container.querySelectorAll('.ci-recollect-btn').forEach(b => b.addEventListener('click', async e => {
        e.stopPropagation();
        const i = +e.currentTarget.dataset.i;
        await recollectCategory(i);
    }));

    container.querySelectorAll('.ci-translate-btn').forEach(b => b.addEventListener('click', async e => {
        e.stopPropagation();
        const button = e.currentTarget;
        const i = +button.dataset.i;
        const cat = s.categories[i];
        const card = button.closest('.ci-card');
        const box = card?.querySelector('.ci-translation');
        const textEl = box?.querySelector('.ci-translation-text');
        const hasCached = Boolean(cat.translation && cat.translationSource === cat.content);

        if (hasCached) {
            cat.translationVisible = !cat.translationVisible;
            if (box) box.hidden = !cat.translationVisible;
            button.innerHTML = `<i class="fa-solid fa-language"></i> ${cat.translationVisible ? '번역본 숨기기' : '번역본 보기'}`;
            await save();
            return;
        }

        const originalHtml = button.innerHTML;
        button.disabled = true;
        button.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Google 번역 중...';
        try {
            const translated = await translateToKorean(cat.content);
            cat.translation = translated;
            cat.translationSource = cat.content;
            cat.translationVisible = true;
            if (textEl) textEl.textContent = translated;
            if (box) box.hidden = false;
            button.innerHTML = '<i class="fa-solid fa-language"></i> 번역본 숨기기';
            await save();
        } catch (err) {
            console.error('[CI] Google 번역 실패:', err);
            setStatus(`번역 실패: ${err.message}`, 'err');
            button.innerHTML = originalHtml;
        } finally {
            button.disabled = false;
        }
    }));

    container.querySelectorAll('.ci-chk').forEach(inp => inp.addEventListener('change', async e => {
        const i=+e.target.dataset.i;
        s.categories[i].enabled = e.target.checked;
        await save();
        e.target.closest('.ci-card').classList.toggle('ci-off', !e.target.checked);
    }));

    container.querySelectorAll('.ci-pos-sel').forEach(sel => sel.addEventListener('change', async e => {
        const i=+e.target.dataset.i;
        const newPos = e.target.value;
        s.categories[i].position = newPos;
        if (POSITIONS[newPos]) s.categories[i].customDepth = POSITIONS[newPos].depth;
        s.categories[i].importance = _importanceForPosition(newPos);
        await save();
        render();
    }));

    container.querySelectorAll('.ci-depth-inp').forEach(inp => {
        const handler = async e => {
            const i = +e.target.dataset.i;
            const val = parseInt(e.target.value);
            if (!isNaN(val) && val >= 0) {
                s.categories[i].customDepth = val;
                await save();
            }
        };
        inp.addEventListener('change', handler);
        inp.addEventListener('blur',   handler);
    });

    container.querySelectorAll('.ci-ta').forEach(ta => ta.addEventListener('input', async e => {
        const i=+e.target.dataset.i;
        const cat = s.categories[i];
        cat.content = e.target.value;
        if (cat.translationSource !== cat.content) {
            delete cat.translation;
            delete cat.translationSource;
            delete cat.translationVisible;
            const card = e.target.closest('.ci-card');
            const box = card?.querySelector('.ci-translation');
            const textEl = box?.querySelector('.ci-translation-text');
            const button = card?.querySelector('.ci-translate-btn');
            if (box) box.hidden = true;
            if (textEl) textEl.textContent = '';
            if (button) button.innerHTML = '<i class="fa-solid fa-language"></i> Google 번역 보기';
        }
        await save();
    }));
}

function setStatus(msg, type) {
    const el = modalEl?.querySelector('#ci-status');
    if (!el) return;
    el.textContent = msg;
    el.className = `ci-status${type?' ci-s-'+type:''}`;
    if (type==='ok') setTimeout(()=>{ if(el.textContent===msg) el.textContent=''; }, 3500);
}

async function doReset() {
    if (!confirm('초기화할까요?')) return;
    await clearInjections();
    const s=ensureSettings(); s.categories=[];
    await save(); render();
    if (modalEl) modalEl.querySelector('#ci-pill').style.display='none';
    setStatus('초기화 완료.','ok');
}

// ── Panel ─────────────────────────────────────────────────────────────────────

function setupPanel() {
    try {
        $('#extensions_settings').append(`
<div class="inline-drawer" id="ci-drawer">
  <div class="inline-drawer-toggle inline-drawer-header">
    <b><i class="fa-solid fa-syringe" style="margin-right:6px"></i>CardInject</b>
    <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
  </div>
  <div class="inline-drawer-content">
    <div id="ci-profile-wrap" style="display:none;padding:8px 0">
      <div style="font-size:11px;color:#888;margin-bottom:4px;font-weight:600">연결 프로필</div>
      <select id="ci-profile-sel" style="width:100%;padding:5px 8px;font-size:12px;border:1px solid #ddd;border-radius:6px;background:#fff;box-sizing:border-box">
        <option value="">— 선택 —</option>
      </select>
    </div>
  </div>
</div>`);
        // 본채팅 연결은 바꾸지 않고, 이 프로필로 백그라운드 요청만 보냄.
        $(document).on('change', '#ci-profile-sel', function () {
            const id = $(this).val();
            if (id === undefined || id === null) return;
            _analysisProfileId = id;
            ensureGlobalSettings().connectionProfileId = id;
            save();
        });
        console.log('[CI] 패널 완료 ✓');
    } catch (e) {
        console.error('[CI] 패널 오류:', e);
    }
}

function setupWand() {
    try {
        $('#extensionsMenu').append(`
<div class="list-group-item flex-container flexGap5" id="ci-wand" title="CardInject">
  <i class="fa-solid fa-syringe"></i><span>CardInject</span>
</div>`);
        $('#ci-wand').on('click', () => {
            $('#extensionsMenu').closest('.popup').find('.popup_close').trigger('click');
            setTimeout(openModal, 80);
        });
        console.log('[CI] 완드 완료 ✓');
    } catch (e) {
        console.error('[CI] 완드 오류:', e);
    }
}

async function loadProfilesIntoPanel() {
    try {
        const profiles = getConnectionProfiles();

        if (!profiles || !profiles.length) {
            console.log('[CI] 연결 프로필 목록을 못 찾음 — 패널에서 숨김');
            return;
        }
        console.log('[CI] 프로필 발견:', profiles.length + '개');

        const sel = document.querySelector('#ci-profile-sel');
        const wrap = document.querySelector('#ci-profile-wrap');
        if (!sel || !wrap) return;

        // 기존 analysisProfileId 저장값도 자동 이전해 선택을 유지함.
        if (_analysisProfileId === null) {
            const globalSettings = ensureGlobalSettings();
            const saved = globalSettings.connectionProfileId ?? globalSettings.analysisProfileId;
            if (saved) _analysisProfileId = saved;
        }
        const curVal = profiles.some(p => p.id === _analysisProfileId)
            ? _analysisProfileId
            : profiles[0].id;

        sel.innerHTML = '';
        profiles.forEach(p => {
            const opt = document.createElement('option');
            opt.value = p.id; opt.textContent = p.name;
            if (p.id === curVal) opt.selected = true;
            sel.appendChild(opt);
        });
        _analysisProfileId = curVal;
        ensureGlobalSettings().connectionProfileId = curVal;
        save();
        wrap.style.display = '';
        console.log('[CI] 프로필 패널 업데이트 완료');
    } catch (e) {
        console.warn('[CI] 프로필 로드 실패 (무시):', e.message);
    }
}

// ── Init ──────────────────────────────────────────────────────────────────────

jQuery(() => {
    try { _installFetchHook(); } catch (_) {}

    try { ensureSettings(); } catch (_) {}
    setupPanel();
    setupWand();

    (async () => {
        try {
            const api = await getApi();
            if (!_ciRuntimeActive) return;
            const requestService = getCtx()?.ConnectionManagerRequestService;
            console.log('[CI] 백그라운드 요청 서비스:', typeof requestService?.sendRequest === 'function' ? '✓' : '✗');
            const hasSet = typeof api.setExtensionPrompt === 'function';
            const hasWinSet = typeof window.setExtensionPrompt === 'function';
            console.log('[CI] setExtensionPrompt - api:', hasSet ? '✓' : '✗', '| window:', hasWinSet ? '✓' : '✗');
            if (!hasSet && !hasWinSet) {
                console.warn('[CI] setExtensionPrompt 없음! 주입이 작동하지 않을 수 있어요.');
            }

            await loadProfilesIntoPanel();

            const { eventSource, event_types } = api;
            if (eventSource && event_types) {
                let _lastSwitchCharId = _getCurrentCharId();
                const onCharSwitch = () => {
                    if (!_ciRuntimeActive) return;
                    const curId = _getCurrentCharId();
                    // CHAT_CHANGED가 스와이프/메시지 수신 등에도 자주 발동되는 ST 빌드 대응 —
                    // 실제로 캐릭터가 바뀐 게 아니면 아무 것도 안 함(토스트도 안 뜸)
                    if (curId === _lastSwitchCharId) return;
                    _lastSwitchCharId = curId;

                    const g = ensureGlobalSettings();
                    if (curId != null) {
                        g.selectedCharIdx = curId;
                    } else {
                        g.selectedCharIdx = null;
                    }
                    save();

                    if (modalEl && modalEl.style.display !== 'none') {
                        populateCharSel();
                        render();
                        const s = ensureSettings();
                        const pill = modalEl.querySelector('#ci-pill');
                        if (pill) {
                            pill.textContent = `${s.categories.length}개`;
                            pill.style.display = s.categories.length ? '' : 'none';
                        }
                    }

                    clearInjections();
                    const s = ensureSettings();
                    if (s.categories.length) {
                        // 캐릭터 전환은 자동 백그라운드 동작이라 토스트 없이 조용히 주입
                        const fn = _findSetPrompt();
                        if (fn) {
                            _doInject(fn);
                            _applyNoteInjection(s.categories.filter(c => c.enabled && c.content?.trim()));
                        }
                    }

                    const charName = getAllChars()[curId]?.name || curId;
                    console.log('[CI] 캐릭터 전환:', charName);
                };

                if (event_types.CHARACTER_SELECTED) {
                    eventSource.on(event_types.CHARACTER_SELECTED, onCharSwitch);
                }
                if (event_types.CHAT_CHANGED) {
                    eventSource.on(event_types.CHAT_CHANGED, onCharSwitch);
                }

                console.log('[CI] event_types 목록:', JSON.stringify(event_types).slice(0, 300));

                const preGenCandidates = [
                    event_types.GENERATE_BEFORE_COMBINE_PROMPTS,
                    event_types.GENERATION_STARTED,
                    event_types.MESSAGE_SENT,
                    'generate_before_combine_prompts',
                    'generation_started',
                    'GENERATE_BEFORE_COMBINE_PROMPTS',
                    'generateBeforeCombinePrompts',
                ].filter(v => v != null && typeof v === 'string');

                const injHook = () => {
                    if (!_ciRuntimeActive) return;
                    _installFetchHook();
                    _installPromptCapture();
                    const fn = _findSetPrompt();
                    if (!fn) return;
                    const cats = ensureSettings().categories;
                    if (!cats.length) return;
                    const n = _doInject(fn);
                    if (n) console.log('[CI] 훅 자동 주입:', n + '개');
                };

                let hooked = false;
                for (const evt of preGenCandidates) {
                    try {
                        eventSource.on(evt, injHook);
                        hooked = true;
                        console.log('[CI] 훅 등록 성공:', evt);
                        if (evt !== 'message_sent' && evt !== event_types.MESSAGE_SENT) break;
                    } catch (_) {}
                }
                console.log('[CI] 메시지 전송 시점 훅으로만 주입 (interval 백업 제거)');
            }

            console.log('[CI] 완전 로드 ✓');
        } catch (e) {
            console.error('[CI] 비동기 초기화 오류:', e);
        }
    })();
});

// ── Main-request verification + request-only injection ─────────────────────
let _ciChatSnapshot = [];
const _ciConfirmedRequests = new Set();
const _ciPreparedPrompts = new Map();
const _ciResolvedCategories = new Map();
let _ciRequestHooksRegistered = false;

function _ciEnabledCategories() {
    return (ensureSettings().categories ?? []).filter(cat => cat.enabled && cat.content?.trim());
}

function _ciNames() {
    const ctx = getCtx();
    return { charName: ctx?.name2 || getAllChars()[getSelectedIdx()]?.name || '',
        userName: ctx?.name1 || window.name1 || '' };
}

function _ciResetRequestState() {
    _ciChatSnapshot = [];
    _ciConfirmedRequests.clear();
    _ciPreparedPrompts.clear();
    _ciResolvedCategories.clear();
}

function _installPromptCapture() {
    if (!_ciRuntimeActive) return;
    const manager = _api?.promptManager ?? getCtx()?.promptManager;
    if (!manager || typeof manager.preparePrompt !== 'function'
        || hasHookOwner(manager.preparePrompt, PROMPT_CAPTURE_OWNER)) return;
    const original = manager.preparePrompt;
    const wrapped = function (...args) {
        const result = original.apply(this, args);
        if (_ciRuntimeActive && result?.identifier && typeof result.content === 'string') {
            const key = String(result.identifier);
            const variants = _ciPreparedPrompts.get(key) ?? new Set();
            variants.add(result.content);
            if (variants.size > 8) variants.delete(variants.values().next().value);
            _ciPreparedPrompts.set(key, variants);
        }
        return result;
    };
    Object.defineProperty(wrapped, '__ciPreparedCapture', { value: true });
    markHookOwner(wrapped, original, PROMPT_CAPTURE_OWNER);
    manager.preparePrompt = wrapped;
}

function _ciRememberRequest(body) {
    const fingerprint = requestFingerprint(body);
    if (!fingerprint) return;
    _ciConfirmedRequests.add(fingerprint);
    if (_ciConfirmedRequests.size > 8) _ciConfirmedRequests.delete(_ciConfirmedRequests.values().next().value);
}

function _ciResolvedCats(names) {
    return _ciEnabledCategories().map((cat, index) => {
        const cacheKey = JSON.stringify([cat.key || index, cat.content, names]);
        if (!_ciResolvedCategories.has(cacheKey)) {
            _ciResolvedCategories.set(cacheKey, resolveContent(cat.content, names, _api?.substituteParams));
        }
        return { ...cat, resolvedContent: _ciResolvedCategories.get(cacheKey) };
    });
}

function _ciApplyOutboundRequest(body, source, stack) {
    if (!_ciRuntimeActive) return null;
    const ctx = getCtx(), names = _ciNames();
    const decision = mainRequestDecision(body, stack, {
        chat: ctx?.chat, snapshot: _ciChatSnapshot, names, confirmed: _ciConfirmedRequests,
    });
    if (!decision.eligible) {
        console.debug('[CI] 전송 요청 제외', { source, type: decision.type, reason: decision.reason });
        return null;
    }
    // A concurrent/hung analysis flag does not block a positively confirmed
    // main request. Its custom-request/raw sender is independently excluded.
    _ciRememberRequest(body);
    const cats = _ciResolvedCats(names);
    if (!cats.length) return null;
    const metadata = ctx?.chatMetadata ?? ctx?.chat_metadata ?? {};
    const report = applyCategoryInjections(body, cats, {
        names, presets: _getPresetPrompts(), prepared: _ciPreparedPrompts,
        noteText: _getAuthorNoteText().split(CI_NOTE_MARKER)[0],
        noteDepth: Number.isFinite(Number(metadata.note_depth)) ? Number(metadata.note_depth) : 4,
        substitute: _api?.substituteParams,
    });
    _ciRememberRequest(body);
    if (report.missing.length) console.warn('[CI] 주입 위치 대체', report.missing);
    if (source === 'fetch-final') {
        console.info('[CI] 전송 직전 카테고리 검사', {
            type: decision.type || '(없음)', requestPath: decision.requestPath,
            mainRequestMatched: true, fallbackUsed: report.missing.length > 0,
            expected: cats.map((cat, index) => String(cat.key || index)),
            categories: report.categories, fallback: report.missing,
        });
    }
    return report;
}

export function _registerInjectionRequestHooks() {
    if (!_ciRuntimeActive || _ciRequestHooksRegistered) return;
    const ctx = getCtx();
    const source = _api?.eventSource ?? ctx?.eventSource;
    const types = _api?.event_types ?? ctx?.eventTypes ?? ctx?.event_types;
    if (!source || !types) return;
    const on = (key, handler) => {
        if (!types[key]) return;
        const guarded = (...args) => { if (_ciRuntimeActive) return handler(...args); };
        source.on(types[key], guarded);
        _ciRequestHandlers.push({ source, event: types[key], handler: guarded });
    };
    on('GENERATION_STARTED', (_type, options = {}, dryRun = false) => {
        if (dryRun || options?.dryRun || _type?.dryRun) return;
        _ciResetRequestState();
        _ciChatSnapshot = chatEvidence(getCtx()?.chat);
        _installFetchHook();
        _installPromptCapture();
    });
    on('CHAT_COMPLETION_SETTINGS_READY', payload => {
        if (payload?.dryRun) return;
        const stack = new Error().stack ?? '';
        _installFetchHook();
        _ciApplyOutboundRequest(payload, 'settings-ready', stack);
    });
    for (const key of ['GENERATION_ENDED', 'GENERATION_STOPPED', 'CHAT_CHANGED']) {
        on(key, _ciResetRequestState);
    }
    _ciRequestHooksRegistered = true;
}

export function _installFetchHook() {
    if (!_ciRuntimeActive || typeof window.fetch !== 'function'
        || hasHookOwner(window.fetch, FETCH_HOOK_OWNER)) return;
    const previousFetch = window.fetch;
    const originalFetch = previousFetch.bind(window);
    const wrapped = async function ciGenerationFetch(url, options, ...rest) {
        if (!_ciRuntimeActive) return originalFetch(url, options, ...rest);
        const requestInput = typeof Request !== 'undefined' && url instanceof Request;
        const address = typeof url === 'string' ? url : String(url?.url ?? url?.href ?? '');
        const method = String(options?.method ?? (requestInput ? url.method : '')).toUpperCase();
        if (method === 'POST' && /\/api\/backends\/chat-completions\/generate(?:[?#]|$)/.test(address)) {
            const stack = new Error().stack ?? '';
            try {
                const serialized = options?.body ?? (requestInput ? await url.clone().text() : null);
                if (typeof serialized === 'string') {
                    const body = JSON.parse(serialized);
                    const report = _ciApplyOutboundRequest(body, 'fetch-final', stack);
                    if (report?.changed) options = { ...options, body: JSON.stringify(body) };
                }
            } catch (error) {
                console.warn('[CI] 전송 직전 주입 처리 실패 — 생성은 계속합니다.', error);
            }
        }
        return originalFetch(url, options, ...rest);
    };
    Object.defineProperty(wrapped, '__ciGenerationHook', { value: true });
    markHookOwner(wrapped, previousFetch, FETCH_HOOK_OWNER);
    window.fetch = wrapped;
    window._ciHooked = true;
    console.debug('[CI] 본생성 전송 훅 연결');
}

export function onEnable() {
    _ciRuntimeActive = true;
    _installFetchHook();
    _installPromptCapture();
    _registerInjectionRequestHooks();
    const fn = _findSetPrompt();
    if (fn) _doInject(fn);
}

export function onDisable() {
    _ciRuntimeActive = false;
    _ciResetRequestState();
    for (const { source, event, handler } of _ciRequestHandlers.splice(0)) {
        if (typeof source.removeListener === 'function') source.removeListener(event, handler);
        else if (typeof source.off === 'function') source.off(event, handler);
    }
    _ciRequestHooksRegistered = false;
    const settings = ensureGlobalSettings(), fn = _findSetPrompt();
    for (const id of settings.activeKeys.filter(_ciOwnPromptId)) {
        try { fn?.(id, '', PT.IN_PROMPT, 0, false, 0); } catch (_) {}
        _directWrite(id, '', PT.IN_PROMPT, 0);
    }
    settings.activeKeys = [];
    _applyNoteInjection([]);
    // Leave the shared wrapper chain intact; inactive wrappers just forward.
}
