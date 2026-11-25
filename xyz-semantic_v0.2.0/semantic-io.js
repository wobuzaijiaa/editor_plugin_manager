/* XYZ Semantic v0.1.7: one writable, model-bound semantic document. */
import { validateDocument } from './semantic-core.js';

const JSON_TYPES = [{ description: 'XYZ Semantic JSON', accept: { 'application/json': ['.json'] } }];
export function safeSemanticPart(value, fallback = 'building') {
    const part = String(value ?? '').trim().replace(/[\\/:*?"<>|\x00-\x1f]/g, '_')
        .replace(/\s+/g, '_').replace(/_+/g, '_').replace(/^[._ ]+|[._ ]+$/g, '').slice(0, 70);
    return part || fallback;
}
export function semanticFileName(building) { return `semantic_${safeSemanticPart(building)}.json`; }
export function semanticOutputStem(building, floor = null, room = null, date = new Date()) {
    const parts = [building, floor, room].filter(x => x !== null && x !== undefined).map(x => safeSemanticPart(x));
    const timestamp = date.toISOString().replace(/[-:.]/g, '');
    return `${parts.join('_').slice(0, 175)}_${timestamp}`;
}
export async function readSemanticJson(file) {
    if (!file || file.size > 8 * 1024 * 1024) throw new Error('Semantic JSON must be smaller than 8 MB.');
    let json;
    try { json = JSON.parse(await file.text()); }
    catch (_) { throw new Error('The selected file is not valid JSON.'); }
    return validateDocument(json);
}
export function selectNewSemanticFile(building) {
    if (typeof window.showSaveFilePicker !== 'function')
        throw new Error('Automatic save requires Chrome/Edge File System Access on localhost/HTTPS.');
    return window.showSaveFilePicker({ suggestedName: semanticFileName(building), types: JSON_TYPES });
}
export function selectExistingSemanticFile() {
    if (typeof window.showOpenFilePicker !== 'function')
        throw new Error('Writable semantic import requires Chrome/Edge File System Access on localhost/HTTPS.');
    return window.showOpenFilePicker({ multiple: false, types: JSON_TYPES });
}
export async function writeSemanticFile(handle, doc) {
    if (!handle?.createWritable) throw new Error('No writable semantic document. Bind or import a file first.');
    const bytes = JSON.stringify(validateDocument(doc), null, 2) + '\n';
    const stream = await handle.createWritable();
    try { await stream.write(bytes); await stream.close(); }
    catch (error) { try { await stream.abort?.(); } catch (_) {} throw error; }
    return handle.name || semanticFileName(doc.model.name);
}
// Serialize writes: an older save must never finish after a newer save.
// A rejected operation does not permanently poison the queue.
export function createSemanticWriter() {
    let queue = Promise.resolve();
    return (handle, doc) => {
        const snapshot = validateDocument(doc);
        const task = queue.catch(() => {}).then(() => writeSemanticFile(handle, snapshot));
        queue = task;
        return task;
    };
}
// Retained for existing callers/tests, but normal UI writes through a persistent handle.
export function saveSemanticJson(doc, handle) {
    if (!handle) return Promise.reject(new Error('Choose the semantic file destination first.'));
    return writeSemanticFile(handle, doc);
}
