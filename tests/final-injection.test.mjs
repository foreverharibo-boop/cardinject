import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFinalInjection, detachFinalInjection } from '../final-injection.js';

const finalCat = (key, position = 'pre_assist', content = key) => ({ key, position, content, enabled: true, customDepth: 100 });

test('최종 지시문은 기존 동일 본문·프리필·멀티모달 뒤에 추가하고 원본을 보존한다', () => {
    const original = [{ role: 'system', content: 'FINAL' }, { role: 'user', content: [{ type: 'text', text: 'Scene' }, { type: 'image_url', image_url: { url: 'fixture' } }] }, { role: 'assistant', content: 'Prefill' }];
    const snapshot = structuredClone(original);
    Object.freeze(original);
    const body = { messages: original, model: 'main', type: 'continue' };
    const report = appendFinalInjection(body, [finalCat('FINAL'), finalCat('SECOND', 'chat_bottom'), { ...finalCat('OFF'), enabled: false }]);
    assert.deepEqual(body.messages.at(-1), { role: 'system', content: 'FINAL\n\nSECOND' });
    assert.deepEqual(body.messages.slice(0, -1), snapshot);
    assert.deepEqual(original, snapshot);
    assert.equal(report.categories[0].index, 3);
    assert.equal(report.categories[1].index, 3);
    assert.deepEqual(Object.keys(body), ['messages', 'model', 'type']);
});

test('동일 최종 본문인 두 카테고리를 요청 수만큼 유지한다', () => {
    const body = { messages: [{ role: 'user', content: 'Scene' }] };
    appendFinalInjection(body, [finalCat('A', 'pre_assist', 'SAME'), finalCat('B', 'chat_bottom', 'SAME')]);
    assert.equal(body.messages.at(-1).content, 'SAME\n\nSAME');
});

test('전송 중 재검사할 때 자기 블록만 이동하고 중간 삽입·후속 규칙을 보존한다', () => {
    const manual = { role: 'system', content: 'FINAL' };
    const body = { model: 'main', type: 'normal', messages: [manual, { role: 'user', content: 'Scene' }] };
    const cats = [finalCat('FINAL')];
    let { receipt } = appendFinalInjection(body, cats);
    for (let i = 0; i < 200; i++) {
        body.messages.splice(1, 0, { role: 'system', content: 'FOREIGN_BEFORE_' + i });
        body.messages.push({ role: 'system', content: 'FOREIGN_AFTER_' + i });
        assert.equal(detachFinalInjection(body, receipt), true);
        ({ receipt } = appendFinalInjection(body, cats));
        assert.deepEqual(body.messages.at(-1), manual);
        assert.strictEqual(body.messages[0], manual);
        assert.equal(body.messages.filter(item => item.content === 'FINAL').length, 2);
    }
    assert.equal(body.messages.filter(item => item.content.startsWith('FOREIGN_')).length, 400);
});

test('소유 증거가 달라지거나 모호하면 동일한 수동·타 확장 내용을 삭제하지 않는다', () => {
    for (const mode of ['changed-prefix', 'identical-after', 'different-model']) {
        const body = { model: 'main', type: 'normal', messages: [{ role: 'user', content: 'Scene' }] };
        const { receipt } = appendFinalInjection(body, [finalCat('FINAL')]);
        if (mode === 'changed-prefix') body.messages[0] = { role: 'user', content: 'Rewritten scene' };
        if (mode === 'identical-after') body.messages.push({ role: 'system', content: 'FINAL' });
        if (mode === 'different-model') body.model = 'other';
        const snapshot = structuredClone(body);
        assert.equal(detachFinalInjection(body, receipt), false);
        assert.deepEqual(body, snapshot);
    }
});

test('실제 최종 fetch에서만 주입하고 등록·보조 생성·프리셋·다른 확장·Request를 보존한다', async () => {
    const keys = ['window', 'jQuery', 'SillyTavern', 'fetch', 'ciInterceptor', '_ciHooked'];
    const saved = new Map(keys.map(key => [key, { exists: Object.hasOwn(globalThis, key), value: globalThis[key] }]));
    const originalConsole = { info: console.info, warn: console.warn, debug: console.debug };
    const logs = [], sent = [], calls = [], listeners = new Map();
    console.info = (...args) => logs.push(args); console.debug = console.warn = () => {};
    const preset = Object.freeze({ prompts: Object.freeze([{ identifier: 'tail', content: 'PRESET_TAIL' }]), prompt_order: Object.freeze([{ character_id: 100001, order: Object.freeze([{ identifier: 'tail', enabled: true }]) }]) });
    const cats = [finalCat('FINAL_A'), { key: 'REGULAR', enabled: true, position: 'chat_recent', content: 'DEPTH_0', customDepth: 0 }, finalCat('FINAL_B', 'chat_bottom', '{{char}} FINAL_B')];
    const chat = Object.freeze([{ is_user: true, mes: 'Scene' }]);
    const ctx = { characterId: 0, characters: [{ name: 'Emris', avatar: 'E.png' }], name1: 'Dana', name2: 'Emris', chat, oaiSettings: preset,
        extensionSettings: { cardinject: { perChar: { 'E.png': { categories: cats } }, selectedCharIdx: 0, activeKeys: ['cardinject_OLD'] } },
        extensionPrompts: { cardinject_OLD: { value: 'OLD_FINAL' }, foreign: { value: 'KEEP' } },
        eventTypes: { GENERATION_STARTED: 'start', CHAT_COMPLETION_SETTINGS_READY: 'settings', GENERATION_ENDED: 'end' },
        eventSource: { on(event, handler) { if (!listeners.has(event)) listeners.set(event, new Set()); listeners.get(event).add(handler); }, removeListener(event, handler) { listeners.get(event)?.delete(handler); } },
        setExtensionPrompt(...args) { calls.push(args); },
    };
    const presetSnapshot = JSON.stringify(preset), catsSnapshot = JSON.stringify(cats);
    const emit = (event, ...args) => { for (const handler of listeners.get(event) ?? []) handler(...args); };
    const controller = new AbortController();
    globalThis.window = globalThis; globalThis.jQuery = () => {}; globalThis.SillyTavern = { getContext: () => ctx };
    globalThis.fetch = async (url, options) => {
        const request = url instanceof Request;
        sent.push({ body: JSON.parse(options?.body ?? await url.clone().text()), signal: options?.signal ?? (request ? url.signal : undefined), headers: options?.headers ?? (request ? url.headers : undefined) });
        return { ok: true };
    };
    const fixture = type => ({ model: 'main', type, stream: true, temperature: 0.9, messages: [
        { role: 'system', content: 'FINAL_A' }, // Manual duplicate must survive.
        { role: 'user', content: 'Scene' }, { role: 'system', content: 'PRESET_TAIL' }, { role: 'assistant', content: 'PREFILL' },
    ] });
    async function sendOpenAIRequest(body) {
        emit('settings', body);
        assert.ok(!body.messages.some(item => item.content.includes('FINAL_B')), '최종 위치는 조립 이벤트에서 추가하지 않음');
        body.messages.push({ role: 'system', content: 'AFTER_SETTINGS' });
        return globalThis.fetch('/api/backends/chat-completions/generate', { method: 'POST', body: JSON.stringify(body), headers: { 'X-Fixture': 'kept' }, signal: controller.signal });
    }
    async function sendGenerationRequest(body) { return await sendOpenAIRequest(body); }
    async function generateRawData(body) { return await sendOpenAIRequest(body); }
    let mod;
    try {
        mod = await import('../index.js?final-position-integration'); mod.onEnable();
        assert.ok(!calls.some(args => args[1] && /FINAL_[AB]/.test(args[1])));
        assert.ok(!ctx.extensionPrompts.cardinject_OLD);
        // A quiet main reply must clear an old depth registration when a
        // category changes to final placement without clicking Apply first.
        cats[1].position = 'pre_assist';
        const beforeSwitch = calls.length;
        emit('start', 'quiet');
        assert.ok(!ctx.extensionPrompts.cardinject_REGULAR);
        assert.ok(!calls.slice(beforeSwitch).some(args => args[0] === 'cardinject_REGULAR' && args[1]));
        cats[1].position = 'chat_recent';
        for (const type of ['normal', 'quiet', 'regenerate', 'swipe', 'continue']) {
            emit('start', type);
            await sendGenerationRequest(fixture(type));
            const actual = sent.at(-1);
            assert.deepEqual(actual.body.messages.at(-1), { role: 'system', content: 'FINAL_A\n\nEmris FINAL_B' });
            assert.equal(actual.body.messages.filter(item => item.content.includes('FINAL_B')).length, 1);
            assert.ok(actual.body.messages.some(item => item.role === 'system' && item.content === 'FINAL_A'));
            assert.ok(actual.body.messages.some(item => item.content === 'DEPTH_0'));
            assert.equal(actual.body.type, type); assert.equal(actual.body.temperature, 0.9); assert.equal(actual.body.stream, true);
            assert.strictEqual(actual.signal, controller.signal);
            assert.deepEqual(Object.keys(actual.body).sort(), ['messages', 'model', 'stream', 'temperature', 'type']);
        }
        // A replayed certified Request keeps its body/headers/signal and one own block.
        const serialized = JSON.stringify(sent.at(-1).body);
        const request = new Request('https://st.example/api/backends/chat-completions/generate', { method: 'POST', body: serialized, headers: { 'X-Fixture': 'request-kept' }, signal: controller.signal });
        await globalThis.fetch(request);
        assert.equal(sent.at(-1).body.messages.filter(item => item.content.includes('FINAL_B')).length, 1);
        assert.equal(sent.at(-1).headers.get('X-Fixture'), 'request-kept');
        assert.strictEqual(sent.at(-1).signal, request.signal);
        assert.equal(await request.text(), serialized);
        // Reattach around a late foreign wrapper; inner hook must put our own
        // final item after its additions while preserving the foreign item.
        const inner = globalThis.fetch;
        globalThis.fetch = async (url, options) => {
            const body = JSON.parse(options.body);
            body.messages.push({ role: 'system', content: 'FOREIGN_LAST' });
            return inner(url, { ...options, body: JSON.stringify(body) });
        };
        for (let i = 0; i < 200; i++) {
            emit('start', 'quiet');
            await sendGenerationRequest(fixture('quiet'));
            const actual = sent.at(-1).body;
            assert.equal(actual.messages.at(-1).content, 'FINAL_A\n\nEmris FINAL_B');
            assert.equal(actual.messages.at(-2).content, 'FOREIGN_LAST');
            assert.equal(actual.messages.filter(item => item.content.includes('FINAL_B')).length, 1);
        }
        await generateRawData(fixture('quiet'));
        assert.ok(!sent.at(-1).body.messages.some(item => item.content.includes('FINAL_B')));
        assert.equal(JSON.stringify(preset), presetSnapshot); assert.equal(JSON.stringify(cats), catsSnapshot);
        assert.deepEqual(chat, [{ is_user: true, mes: 'Scene' }]);
        assert.deepEqual(ctx.extensionPrompts.foreign, { value: 'KEEP' });
        const reports = logs.filter(args => args[0] === '[CI] 전송 직전 카테고리 검사');
        assert.ok(reports.some(args => args[1].categories.some(item => item.final && item.index >= 4 && item.role === 'system')));
        mod.onDisable();
        await sendGenerationRequest(fixture('quiet'));
        assert.ok(!sent.at(-1).body.messages.some(item => item.content.includes('FINAL_B')));
        assert.deepEqual(ctx.extensionPrompts.foreign, { value: 'KEEP' });
    } finally {
        mod?.onDisable(); Object.assign(console, originalConsole);
        for (const [key, item] of saved) { if (item.exists) globalThis[key] = item.value; else delete globalThis[key]; }
    }
});

test('최종 옵션은 하나이고 옛 최하단은 별칭으로 호환하며 depth와 Pro 의존성이 없다', async () => {
    const { readFile } = await import('node:fs/promises');
    const source = await readFile(new URL('../index.js', import.meta.url), 'utf8');
    assert.match(source, /pre_assist:\s+\{ label: '🤖 AI 응답 바로 직전 \(최종 system 지시문\)',\s+type: PT_FINAL/);
    assert.match(source, /chat_bottom:\s+'pre_assist'/);
    const positions = source.slice(source.indexOf('const POSITIONS ='), source.indexOf('// 이전 버전 저장값'));
    assert.equal((positions.match(/type: PT_FINAL/g) ?? []).length, 1);
    assert.doesNotMatch(positions, /chat_bottom:/);
    assert.match(source, /const showDepth = pos\.type === PT\.IN_CHAT/);
    assert.doesNotMatch(source, /charsheet_injector|CharSheetInjectorBridge|CardInject Pro|CardInject\s+v\d|record\.order\.splice|oai\.prompt_order\s*=|saveOpenAIPreset|savePreset|chat\.(?:splice|push)/);
    const helper = await readFile(new URL('../final-injection.js', import.meta.url), 'utf8');
    assert.match(helper, /role: 'system'/);
    assert.doesNotMatch(helper, /role: 'user'/);
    const manifest = JSON.parse(await readFile(new URL('../manifest.json', import.meta.url), 'utf8'));
    assert.equal(manifest.display_name, 'CardInject');
    assert.equal(manifest.generate_interceptor, 'ciInterceptor');
    assert.equal(manifest.version, '1.0.6');
});

test('다른 확장이 앞부분을 재작성해도 이미 마지막인 자기 지시문을 중복하거나 삭제하지 않는다', () => {
    const manual = { role: 'system', content: 'FINAL' };
    const body = { model: 'main', type: 'quiet', messages: [manual, { role: 'user', content: 'Scene' }, { role: 'system', content: 'TT_OLD' }] };
    const cats = [finalCat('FINAL')];
    const { receipt } = appendFinalInjection(body, cats);
    body.messages = body.messages.filter(message => message.content !== 'TT_OLD');
    assert.equal(detachFinalInjection(body, receipt), false);
    const original = structuredClone(body.messages);
    const report = appendFinalInjection(body, cats, receipt);
    assert.equal(report.changed, false);
    assert.equal(report.categories[0].status, 'present');
    assert.deepEqual(body.messages, original);
    assert.strictEqual(body.messages[0], manual);
    assert.equal(body.messages.filter(message => message.content === 'FINAL').length, 2);
});
