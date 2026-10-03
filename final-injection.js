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

export function appendFinalInjection(body, categories, priorReceipt = null) {
    const items = categories.filter(cat => cat.enabled && cat.content?.trim() && String(cat.resolvedContent ?? cat.content).trim());
    if (!items.length || !Array.isArray(body.messages)) return { categories: [], receipt: null, changed: false };
    // Append after regular placements; keep system authority. Providers may
    // extract system instructions separately, so model-side ordering can differ.
    const message = { role: 'system', content: items.map(cat => String(cat.resolvedContent ?? cat.content).trim()).join('\n\n') };
    // An opaque wrapper may remove part of the receipt's prefix. If our exact
    // requested block is already at the tail in this same request, retain it
    // without deleting/repositioning anything or appending a second copy.
    const retained = priorReceipt && priorReceipt.model === body.model && priorReceipt.type === body.type
        && priorReceipt.entry === signature(message) && signature(body.messages.at(-1)) === priorReceipt.entry;
    const index = retained ? body.messages.length - 1 : body.messages.length;
    const receipt = { model: body.model, type: body.type, prefix: body.messages.slice(0, index).map(signature), entry: signature(message) };
    if (!retained) body.messages = [...body.messages, message];
    return { changed: !retained, receipt, categories: items.map((cat, ordinal) => ({
        key: String(cat.key || ordinal), position: cat.position, status: retained ? 'present' : 'inserted', index, role: 'system', final: true,
    })) };
}
