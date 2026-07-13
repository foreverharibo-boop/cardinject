// CardInject

const EXT_KEY = 'cardinject';
// ST 실제 extension_prompt_types 값 (script.js/extensions.js 기준):
//   0 = IN_PROMPT      : 캐릭터 카드 바로 다음, 채팅 시작 직전 (시스템 영역에서 "가장 강력")
//   1 = IN_CHAT         : 채팅 기록 내부, depth로 위치 지정
//   2 = BEFORE_PROMPT   : 메인 시스템 프롬프트보다도 앞, 진짜 최상단
const PT = { IN_PROMPT: 0, IN_CHAT: 1, BEFORE_PROMPT: 2 };

// fetch hook 전용 타입
const PT_NOTE = 12;    // 작가노트 텍스트 자체에 직접 이어붙임 (위치 100% 일치 보장)

// ⚠️ ST 프롬프트 실제 순서 (중요):
// [시스템 프롬프트] → [캐릭터 설명/시나리오] → [sys_top/sys_bottom/after_char 자리]
//   → [채팅 기록 전체 (긴 대화일수록 여기가 대부분을 차지)] → [작가노트] → [AI 응답 직전]

const POSITIONS = {
    // ── setExtensionPrompt 처리 (진짜 최상단, 검증됨) ────────────────────────────
    sys_top:      { label: '🔝 시스템 최상단(모든 것보다 위)',             type: PT.BEFORE_PROMPT, depth: 0 },

    // ── ciInterceptor 처리 (채팅 배열에 직접 삽입, 검증됨) ──────────────────────
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
    return POSITIONS[key] || POSITIONS[POSITION_ALIASES[key]] || POSITIONS.sys_top;
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
    for (const p of ['../../../extensions.js', '../../../../script.js']) {
        try { Object.assign(_api, await import(p)); }
        catch (e) { console.warn('[CI] import 실패:', p, e.message); }
    }
    return _api;
}

function getCtx() {
    if (window.SillyTavern?.getContext) return window.SillyTavern.getContext();
    if (_api?.getContext) return _api.getContext();
    return null;
}

// 캐시트 분석용 생성 호출.
// ST의 generateQuietPrompt를 정상적으로 사용하되(가장 단순하고 표준적인 방법),
// 이 ST 빌드에서는 quiet 생성이 채팅창에 살짝 찍혀버리는 경우가 있어서
// 호출 전후로 채팅 길이를 비교해 늘어났으면 그 메시지를 바로 잘라내서 정리함.
async function callGenerate(prompt) {
    const api = await getApi();
    const fn = api.generateQuietPrompt ?? window.generateQuietPrompt ?? getCtx()?.generateQuietPrompt;
    if (typeof fn !== 'function') throw new Error('ST 생성 함수를 찾을 수 없어요');

    // 채팅 배열 참조 — 여러 경로 시도
    let chatArr = null;
    try { chatArr = window.chat; } catch (_) {}
    if (!Array.isArray(chatArr)) try { chatArr = getCtx()?.chat; } catch (_) {}
    if (!Array.isArray(chatArr)) try { chatArr = window.SillyTavern?.getContext()?.chat; } catch (_) {}
    const beforeLen = Array.isArray(chatArr) ? chatArr.length : -1;
    const beforeDomCount = $('#chat .mes').length;
    console.log('[CI] 분석 시작 — 채팅 배열:', beforeLen, '(', chatArr ? 'found' : 'NOT FOUND', ') | DOM:', beforeDomCount);

    globalThis._ciAnalyzing = true;
    let result;
    try {
        result = await fn(prompt, false, true);
    } finally {
        globalThis._ciAnalyzing = false;
    }

    // ── 채팅 정리 — 즉시 + 500ms 후 이중 시도 (비동기 DOM 업데이트 대응) ──
    const doCleanup = () => {
        let cleaned = false;
        // 1) 데이터 배열
        let arr = null;
            try { arr = window.chat; } catch (_) {}
            if (!Array.isArray(arr)) try { arr = getCtx()?.chat; } catch (_) {}
            if (!Array.isArray(arr)) try { arr = window.SillyTavern?.getContext()?.chat; } catch (_) {}
        if (Array.isArray(arr) && beforeLen >= 0 && arr.length > beforeLen) {
            const added = arr.length - beforeLen;
            arr.splice(beforeLen, added);
            console.log('[CI] 채팅 배열에서', added, '개 제거 (현재:', arr.length, ')');
            cleaned = true;
        }
        // 2) DOM 메시지 버블
        const curDom = $('#chat .mes').length;
        if (curDom > beforeDomCount) {
            const toRemove = curDom - beforeDomCount;
            $('#chat .mes').slice(-toRemove).remove();
            console.log('[CI] DOM에서', toRemove, '개 제거 (현재:', curDom - toRemove, ')');
            cleaned = true;
        }
        // 3) 저장
        if (cleaned) {
            const saveFn = window.saveChatConditional ?? window.saveChat;
            if (typeof saveFn === 'function') { try { saveFn(); } catch (_) {} }
        }
        return cleaned;
    };

    try {
        doCleanup();
        setTimeout(doCleanup, 500);
        setTimeout(doCleanup, 1500);
    } catch (e) {
        console.warn('[CI] 채팅 정리 실패:', e.message);
    }

    return result;
}

// ── Settings (캐릭터별 저장) ──────────────────────────────────────────────────

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

function getConnectionProfiles() {
    const ctx = getCtx();
    return ctx?.connectionProfiles
        ?? ctx?.connection_profiles
        ?? window.connection_profiles
        ?? null;
}

async function loadProfile(name) {
    const api = await getApi();
    const fn = api.loadConnectionProfile
        ?? api.load_connection_profile
        ?? window.loadConnectionProfile;
    if (typeof fn === 'function') {
        await fn(name);
        return true;
    }
    if (typeof $ !== 'undefined') {
        const $sel = $('#connection_profile_select');
        if ($sel.length) {
            $sel.val(name).trigger('change');
            return true;
        }
    }
    return false;
}

// ── Injection ─────────────────────────────────────────────────────────────────

// 실제 주입 로직
// ★ IN_CHAT(chat_recent, depth 지정) 위치는 ciInterceptor(generate_interceptor)가 담당.
// ★ PT_NOTE(with_note) 위치는 fetch hook이 담당.
// 여기서는 BEFORE_PROMPT(시스템 최상단)만 setExtensionPrompt로 처리.
function _doInject(fn) {
    const g = ensureGlobalSettings();

    // 이전에 등록했던 키들 먼저 전부 지워서 캐릭터 전환 시 주입이 남아있는 문제 방지
    if (Array.isArray(g.activeKeys)) {
        g.activeKeys.forEach(id => {
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

        // ciInterceptor 담당(IN_CHAT)과 fetch hook 담당(PT_NOTE)은
        // 여기서 기존 등록값만 지우고 건너뜀
        if (pos.type === PT.IN_CHAT || pos.type === PT_NOTE) {
            try { fn(id, '', PT.IN_PROMPT, 0, false, 0); } catch(_) {}
            _directWrite(id, '', PT.IN_PROMPT, 0);
            return;
        }

        if (cat.enabled && cat.content?.trim()) {
            const depth = pos.depth ?? 0;
            try { fn(id, cat.content, pos.type, depth, false, 0); } catch(e) { console.warn('[CI] fn 오류:', e); }
            _directWrite(id, cat.content, pos.type, depth);
            count++;
        } else {
            try { fn(id, '', PT.IN_PROMPT, 0, false, 0); } catch(_) {}
            _directWrite(id, '', PT.IN_PROMPT, 0);
        }
    });
    return count;
}

// ── Generate Interceptor: IN_CHAT(chat_recent) 담당 ─────────────────────────
// manifest.json의 generate_interceptor로 등록됨.
globalThis.ciInterceptor = async function (chat, contextSize, abort, type) {
    try {
        if (type === 'quiet') return;

        const cats = ensureSettings().categories.filter(c => c.enabled && c.content?.trim());

        // 작가노트 합치기 캐시 갱신 (fetch hook이 실제 삽입 담당)
        _applyNoteInjection(cats);

        // PT_NOTE는 type이 PT.IN_CHAT이 아니므로 아래 필터에서 자동 제외됨
        const inChat = cats.filter(c => _resolvePosition(c.position)?.type === PT.IN_CHAT);
        if (!inChat.length) return;

        // depth가 클수록(오래된 메시지 쪽) 먼저 끼워 넣어야,
        // depth가 작은(최하단) 항목이 나중에 삽입되면서 실제로 더 아래에 위치하게 됨
        const getDepth = (cat) => cat.customDepth ?? _resolvePosition(cat.position)?.depth ?? 0;
        const sorted = [...inChat].sort((a, b) => getDepth(b) - getDepth(a));

        for (const cat of sorted) {
            const depth = getDepth(cat);
            const entry = {
                is_user: false,
                name: 'System',
                send_date: Date.now(),
                mes: cat.content,
                extra: {},
            };
            if (depth <= 0) {
                chat.push(entry);
            } else {
                const idx = Math.max(0, chat.length - depth);
                chat.splice(idx, 0, entry);
            }
        }
        console.log('[CI] interceptor 주입:', inChat.length + '개 (', sorted.map(c => c.name).join(', '), ')');
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

    console.log(`[CI] 수동 주입 완료: ${count}개 (+ 채팅/작가노트 위치는 매 생성마다 자동)`);
    toast('success', `✓ ${count}개 카테고리 주입 완료!`);
}

async function clearInjections() {
    await getApi();
    const fn = _findSetPrompt();
    const g = ensureGlobalSettings();
    if (fn && Array.isArray(g.activeKeys)) {
        g.activeKeys.forEach(id => {
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
      "content": "Rewritten as a clear AI instruction. Keep original language.",
      "importance": "high",
      "suggested_position": "sys_top"
    }
  ]
}

FIELD VALUES:
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

[REMINDER: Output ONLY the JSON object above. No roleplay. No character voice. No markdown fences.]`;
}

// ── Toast 알림 (ST toastr와 완전히 독립된 자체 UI) ──────────────────────────────
function toast(type, msg) {
    const el = document.createElement('div');
    el.className = `ci-own-toast ci-toast-${type === 'success' || type === 'error' || type === 'warning' ? type : 'info'}`;
    el.textContent = msg;
    document.documentElement.appendChild(el);
    requestAnimationFrame(() => el.classList.add('ci-toast-show'));

    const duration = type === 'error' ? 5000 : 3000;
    setTimeout(() => {
        el.classList.remove('ci-toast-show');
        setTimeout(() => el.remove(), 250);
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

async function doAnalyze() {
    if (analyzing) return;
    const idx = getSelectedIdx(), sheet = getSheet(idx);
    if (!sheet) { setStatus('캐릭터를 선택해주세요.', 'err'); return; }
    if (!Object.values(sheet).join('').trim()) { setStatus('캐릭터 시트가 비어있어요.', 'err'); return; }

    analyzing = true;
    const btn = modalEl.querySelector('#ci-analyze');
    btn.disabled = true;
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> 분석 중...';
    setStatus('⚠️ 채팅이 잠깐 보내지지만 완료 후 자동 정리돼요. 취소 금지!', 'load');
    toast('warning', '분석 중: 채팅이 잠깐 보내집니다. 취소하지 마세요!');

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
        return `
      <div class="ci-card ${c.enabled?'':'ci-off'}" data-i="${i}">
        <div class="ci-card-top">
          <div class="ci-card-left">
            <span class="ci-imp ci-imp-${c.importance}">${impLabel(c.importance)}</span>
            <span class="ci-cname">${esc(c.name)}</span>
          </div>
          <div class="ci-card-right">
            <button class="ci-chevron" data-i="${i}"><i class="fa-solid fa-chevron-${c.expanded?'up':'down'}"></i></button>
            <label class="ci-tog">
              <input type="checkbox" class="ci-chk" data-i="${i}" ${c.enabled?'checked':''}>
              <span class="ci-knob"></span>
            </label>
          </div>
        </div>
        ${c.expanded?`
        <div class="ci-textarea-wrap">
          <textarea class="ci-ta" data-i="${i}">${esc(c.content)}</textarea>
        </div>`:''}
        <div class="ci-card-body">
          <div class="ci-row">
            <span class="ci-lbl">위치</span>
            <select class="ci-sel ci-pos-sel" data-i="${i}">
              ${Object.entries(POSITIONS).map(([k,v])=>`<option value="${k}" ${c.position===k?'selected':''}>${v.label}</option>`).join('')}
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
            <span class="ci-hint">작가노트 텍스트에 직접 합쳐짐 — 위치 100% 일치, 조정 불필요</span>
          </div>`:''}
        </div>
      </div>`;
    }).join('');

    // 이벤트 바인딩
    container.querySelectorAll('.ci-chevron').forEach(b => b.addEventListener('click', e => {
        const i=+e.currentTarget.dataset.i;
        s.categories[i].expanded = !s.categories[i].expanded;
        render();
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
        s.categories[i].content = e.target.value;
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
    <div style="padding:8px 0;display:flex;gap:8px">
      <button id="ci-p-open"  class="menu_button menu_button_icon" style="flex:1"><i class="fa-solid fa-syringe"></i> 열기</button>
      <button id="ci-p-apply" class="menu_button menu_button_icon" style="flex:1"><i class="fa-solid fa-check"></i> 주입 적용</button>
    </div>
    <div id="ci-profile-wrap" style="display:none;padding:4px 0 0">
      <div style="font-size:11px;color:#888;margin-bottom:4px;font-weight:600">연결 프로필</div>
      <select id="ci-profile-sel" style="width:100%;padding:5px 8px;font-size:12px;border:1px solid #ddd;border-radius:6px;background:#fff;box-sizing:border-box">
        <option value="">— 선택 —</option>
      </select>
    </div>
    <div id="ci-p-msg" style="font-size:12px;text-align:center;min-height:16px;padding:4px 0 6px;color:#666"></div>
  </div>
</div>`);
        $('#ci-p-open').on('click', openModal);
        $('#ci-p-apply').on('click', async () => {
            await applyInjections();
        });
        $(document).on('change', '#ci-profile-sel', async function () {
            const name = $(this).val();
            if (!name) return;
            const ok = await loadProfile(name);
            $('#ci-p-msg').text(ok ? `✓ "${name}" 로드됨` : '프로필 로드 API 없음');
            setTimeout(() => $('#ci-p-msg').text(''), 3000);
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
        const api = await getApi();
        const ctx = getCtx();

        let profiles = null;
        const candidates = [
            () => ctx?.connectionProfiles,
            () => ctx?.connection_profiles,
            () => api.connectionProfiles,
            () => api.connection_profiles,
            () => window.connection_profiles,
            () => window.connectionProfiles,
            () => window.power_user?.connection_profiles,
            () => window.oai_settings?.connection_profiles,
        ];

        for (const getter of candidates) {
            try {
                const result = getter();
                if (Array.isArray(result) && result.length > 0) {
                    profiles = result;
                    console.log('[CI] 프로필 발견:', result.length + '개');
                    break;
                }
            } catch (_) {}
        }

        if (!profiles || !profiles.length) {
            console.log('[CI] 연결 프로필 없음 — 패널에서 숨김');
            return;
        }

        const sel = document.querySelector('#ci-profile-sel');
        const wrap = document.querySelector('#ci-profile-wrap');
        if (!sel || !wrap) return;

        sel.innerHTML = '<option value="">— 선택 —</option>';
        profiles.forEach(p => {
            const name = typeof p === 'string' ? p : (p.name ?? p.id ?? String(p));
            const opt = document.createElement('option');
            opt.value = name; opt.textContent = name;
            sel.appendChild(opt);
        });
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
            console.log('[CI] generateQuietPrompt:', typeof api.generateQuietPrompt === 'function' ? '✓' : `✗ window:${typeof window.generateQuietPrompt}`);
            const hasSet = typeof api.setExtensionPrompt === 'function';
            const hasWinSet = typeof window.setExtensionPrompt === 'function';
            console.log('[CI] setExtensionPrompt - api:', hasSet ? '✓' : '✗', '| window:', hasWinSet ? '✓' : '✗');
            if (!hasSet && !hasWinSet) {
                console.warn('[CI] setExtensionPrompt 없음! 주입이 작동하지 않을 수 있어요.');
            }

            await loadProfilesIntoPanel();

            const { eventSource, event_types } = api;
            if (eventSource && event_types) {
                const onCharSwitch = () => {
                    const curId = _getCurrentCharId();
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
                    if (s.categories.length) applyInjections();

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

                let _lastAutoCharId = null;
                setInterval(() => {
                    try {
                        const curId = _getCurrentCharId();
                        if (curId != null && curId !== _lastAutoCharId) {
                            _lastAutoCharId = curId;
                            const g = ensureGlobalSettings();
                            g.selectedCharIdx = curId;
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
                            const s = ensureSettings();
                            if (s.categories.length) {
                                const fn2 = _findSetPrompt();
                                if (fn2) _doInject(fn2);
                            }
                        }
                    } catch (_) {}

                    const fn = _findSetPrompt();
                    if (!fn) return;
                    const cats = ensureSettings().categories;
                    if (!cats.length) return;
                    _doInject(fn);
                    _applyNoteInjection();
                }, 1500);
                console.log('[CI] interval 백업 주입 + 캐릭터 자동감지 시작');
            }

            console.log('[CI] 완전 로드 ✓');
        } catch (e) {
            console.error('[CI] 비동기 초기화 오류:', e);
        }
    })();
});

// ── Fetch Hook 설치 — with_note 전용 ────────────────────────────────────────
// with_note(작가노트 합치기)만 처리. AI API 요청을 가로채서
// 최종 메시지 배열의 작가노트 텍스트 바로 뒤에 카테고리 내용을 이어붙임.

function _installFetchHook() {
    if (window._ciHooked) return;
    window._ciHooked = true;

    const origFetch = window.fetch.bind(window);
    window.fetch = async function(url, options, ...rest) {
        // 캐시트 분석 요청 중엔 절대 건드리지 않음
        if (globalThis._ciAnalyzing) {
            return origFetch(url, options, ...rest);
        }

        if (options?.method?.toUpperCase() === 'POST' && typeof options?.body === 'string') {
            try {
                const urlStr0 = typeof url === 'string' ? url : (url?.url ?? '');

                // 번역기 등 다른 확장의 API 요청 제외
                const isNonGenUrl = /translat|tts|speech|embed|caption|vision|classif/i.test(urlStr0);
                let isNonGenCaller = false;
                try {
                    const stack = new Error().stack || '';
                    isNonGenCaller = /translator\.js|custom-request\.js|fetchTranslation/i.test(stack);
                } catch (_) {}

                if (isNonGenUrl || isNonGenCaller) {
                    return origFetch(url, options, ...rest);
                }

                const body = JSON.parse(options.body);
                const cats = ensureSettings().categories.filter(c => c.enabled && c.content?.trim());

                // with_note: 최종 메시지 배열에서 작가노트 텍스트를 찾아 바로 뒤에 삽입
                const noteCats = cats.filter(c => c.position === 'with_note');
                const noteContent = noteCats.length ? noteCats.map(c => c.content).join('\n\n') : '';

                if (noteContent && Array.isArray(body.messages)) {
                    let noteText = '';
                    try {
                        const ctx = getCtx();
                        const meta = ctx?.chatMetadata ?? ctx?.chat_metadata;
                        const raw = meta?.note_prompt || '';
                        const mi = raw.indexOf(CI_NOTE_MARKER);
                        noteText = (mi >= 0 ? raw.slice(0, mi) : raw).trim();
                    } catch (_) {}

                    // 작가노트 앵커 생성:
                    // {{char}}/{{user}} 매크로를 실제 이름으로 치환해서 매칭.
                    // {{// 코멘트}} 형식 줄은 최종 요청에서 사라지므로 제외.
                    let anchor = '';
                    if (noteText) {
                        const ctxN = getCtx();
                        const charName = ctxN?.name2 || getAllChars()[getSelectedIdx()]?.name || '';
                        const userName = ctxN?.name1 || window.name1 || '';
                        const substitute = (s) => s
                            .replace(/\{\{char\}\}/gi, charName)
                            .replace(/\{\{user\}\}/gi, userName);

                        const lines = noteText.split('\n')
                            .map(l => l.trim())
                            .filter(l => l.length >= 20 && !l.startsWith('{{//') && !l.startsWith('{{ //'));

                        const substituted = lines.map(substitute).filter(l => !l.includes('{{'));
                        const longest = substituted.sort((a, b) => b.length - a.length)[0] || '';

                        if (longest.length > 60) {
                            const mid = Math.floor(longest.length / 2) - 25;
                            anchor = longest.slice(Math.max(0, mid), Math.max(0, mid) + 50);
                        } else {
                            anchor = longest;
                        }
                    }

                    let inserted = false;
                    if (anchor) {
                        const anIdx = body.messages.findIndex(m =>
                            typeof m.content === 'string' && m.content.includes(anchor)
                        );
                        if (anIdx >= 0) {
                            body.messages[anIdx].content =
                                body.messages[anIdx].content + '\n\n' + noteContent;
                            inserted = true;
                            console.log('[CI] fetch hook: 작가노트 텍스트 끝에 이어붙임 ✓ (index', anIdx, ', anchor:', anchor.slice(0, 30) + '...)');
                        } else {
                            console.warn('[CI] fetch hook: 앵커 매칭 실패. anchor:', anchor);
                        }
                    }

                    if (!inserted) {
                        // 앵커 매칭 실패 → 작가노트 depth 위치에 근사 삽입
                        let noteDepth = 4;
                        try {
                            const meta2 = getCtx()?.chatMetadata ?? getCtx()?.chat_metadata;
                            if (typeof meta2?.note_depth === 'number') noteDepth = meta2.note_depth;
                        } catch (_) {}
                        const insertAt = Math.max(0, body.messages.length - noteDepth);
                        body.messages.splice(insertAt, 0, { role: 'system', content: noteContent });
                        console.log('[CI] fetch hook: 앵커 실패 → depth', noteDepth, '기준 근사 삽입 (index', insertAt, ')');
                    }

                    options = { ...options, body: JSON.stringify(body) };

                    // 진단용 로그
                    try {
                        const debugBody = JSON.parse(options.body);
                        if (Array.isArray(debugBody.messages)) {
                            console.log('[CI][DEBUG] 최종 messages 마지막 3개:',
                                JSON.stringify(debugBody.messages.slice(-3), null, 2));
                        }
                    } catch (_) {}
                }
            } catch (_) { /* JSON parse 실패 = 바이너리 등 무시 */ }
        }
        return origFetch(url, options, ...rest);
    };
    console.log('[CI] fetch hook 설치 ✓');
}
