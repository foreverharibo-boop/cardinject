// Request-local ownership receipts. Never remove matching manual/foreign text.
export const FINAL_REQUEST_STATE = Symbol('cardinject.final-request');
const signature = message => JSON.stringify(message);

export function detachFinalInjection(body, receipt) {
    if (!receipt || receipt.model !== body.model || receipt.type !== body.type || !Array.isArray(body.messages)) return false;
    // Match the exact previous prefix in order; other wrappers may insert items.
    let cursor = 0;
    for (const expected of receipt.prefix) {
        while (cursor < body.messages.length && signature(body.messages[cursor]) !== expected) cursor++;
        if (cursor === body.messages.length) return false;
        cursor++;
    }
    if (signature(body.messages[cursor]) !== receipt.entry) return false;
    // If an identical item also appeared later, ownership is ambiguous.
    if (body.messages.slice(cursor + 1).some(message => signature(message) === receipt.entry)) return false;
    body.messages = [...body.messages.slice(0, cursor), ...body.messages.slice(cursor + 1)];
    return true;
}

export function appendFinalInjection(body, categories) {
    const items = categories.filter(cat => cat.enabled && cat.content?.trim() && String(cat.resolvedContent ?? cat.content).trim());
    if (!items.length || !Array.isArray(body.messages)) return { categories: [], receipt: null, changed: false };
    // Append after regular placements; keep system authority. Providers may
    // extract system instructions separately, so model-side ordering can differ.
    const message = { role: 'system', content: items.map(cat => String(cat.resolvedContent ?? cat.content).trim()).join('\n\n') };
    const index = body.messages.length;
    const receipt = { model: body.model, type: body.type, prefix: body.messages.map(signature), entry: signature(message) };
    body.messages = [...body.messages, message];
    return { changed: true, receipt, categories: items.map((cat, ordinal) => ({
        key: String(cat.key || ordinal), position: cat.position, status: 'inserted', index, role: 'system', final: true,
    })) };
}
