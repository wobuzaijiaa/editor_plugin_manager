/**
 * SuperSplat Plugin Manager — v1.13 managed native TCP port lifecycle.
 * External ES module, loaded by one generated dist/index.html hook.
 * Copyright (c) 2026 repo@gjt. MIT; upstream SuperSplat has its own license.
 * No SuperSplat TypeScript modification. Local HTTP API handles installation; static hosting is read-only.
 */

const SCHEMA = 1;
const ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const FOLDER_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*_\d{8}T\d{9}Z$/;
const MAX_FILES = 100;
const MAX_BYTES = 50 * 1024 * 1024;
const MAX_DEPTH = 8;
const ROOT_URL = new URL('./plugins/', import.meta.url);
const CATALOG_URL = new URL('manifest.json', ROOT_URL);
const INVENTORY_URL = new URL('editor-api.json', ROOT_URL);


function check(condition, description) {
    if (!condition) throw new Error(description);
}
function plainObject(x) { return x !== null && typeof x === 'object' && !Array.isArray(x); }
function jsonClone(x) { return JSON.parse(JSON.stringify(x)); }
function equalData(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
function safeSegment(s) {
    return typeof s === 'string' && s.length > 0 && s.length <= 128 &&
        s !== '.' && s !== '..' && !s.startsWith('.') && !/[\\/\u0000-\u001f]/.test(s);
}
function normalizedEntry(entry) {
    check(typeof entry === 'string' && entry.startsWith('./') && !entry.includes('\\') &&
        !entry.includes('?') && !entry.includes('#') && !entry.includes(':') &&
        !entry.startsWith('//'), 'Plugin entry must be a relative module path.');
    const parts = entry.slice(2).split('/');
    check(parts.every(safeSegment) && /\.(?:js|mjs)$/.test(parts.at(-1)),
        'Plugin entry must point to a local .js/.mjs file.');
    return parts.join('/');
}
function validateSettings(obj) {
    check(plainObject(obj), 'Plugin settings must be a JSON object.');
    check(JSON.stringify(obj).length < 32768, 'Plugin settings exceed the size limit.');
    return jsonClone(obj);
}
export function validateCatalog(value) {
    check(plainObject(value) && value.schema_version === SCHEMA && Array.isArray(value.plugins),
        `Unsupported or invalid plugin manifest (schema ${SCHEMA} required).`);
    const ids = new Set();
    const folders = new Set();
    const plugins = value.plugins.map((p, i) => {
        check(plainObject(p) && ID_PATTERN.test(p.id || ''), `Invalid plugin ID at entry ${i}.`);
        check(FOLDER_PATTERN.test(p.folder || '') && p.folder.startsWith(p.id + '_'),
            `Unsafe plugin folder for ${p.id}.`);
        check(typeof p.enabled === 'boolean', `Plugin ${p.id} has no boolean enabled setting.`);
        check(!ids.has(p.id) && !folders.has(p.folder), `Duplicate plugin ID/folder: ${p.id}.`);
        ids.add(p.id);
        folders.add(p.folder);
        let startup_approval;
        if (p.startup_approval !== undefined) {
            check(plainObject(p.startup_approval) && /^[0-9a-f]{40}$/.test(p.startup_approval.editor_commit || '') &&
                /^[0-9a-f]{64}$/.test(p.startup_approval.package_sha256 || ''),
                `Invalid startup approval for ${p.id}.`);
            startup_approval = {editor_commit:p.startup_approval.editor_commit,
                package_sha256:p.startup_approval.package_sha256};
        }
        return { id: p.id, folder: p.folder, enabled: p.enabled,
            settings: validateSettings(p.settings ?? {}),
            ...(startup_approval ? {startup_approval} : {}) };
    });
    return { schema_version: SCHEMA, plugins };
}
export function validateMetadata(value, expectedId = null) {
    check(plainObject(value), 'Plugin metadata must be a JSON object.');
    check(ID_PATTERN.test(value.id || ''), 'Invalid plugin metadata ID.');
    if (expectedId !== null) check(value.id === expectedId, 'Plugin ID differs from manifest.');
    for (const field of ['name', 'classification', 'version', 'author', 'date', 'description']) {
        check(typeof value[field] === 'string' && value[field].trim() && value[field].length <= 500,
            `Missing/invalid plugin metadata field: ${field}.`);
    }
    check(/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(value.version), 'Invalid plugin version.');
    check(/^\d{4}-\d{2}-\d{2}$/.test(value.date) &&
        Number.isFinite(Date.parse(value.date + 'T00:00:00Z')), 'Invalid plugin date.');
    const entry = normalizedEntry(value.entry);
    const schemas = value.settings_schema ?? [];
    check(Array.isArray(schemas) && schemas.length <= 30, 'Invalid settings_schema.');
    const used = new Set();
    for (const item of schemas) {
        check(plainObject(item) && ID_PATTERN.test(item.key || '') &&
            ['boolean', 'string', 'number'].includes(item.type) &&
            typeof item.label === 'string' && item.label.length <= 100 && !used.has(item.key),
            'Invalid/duplicate settings_schema item.');
        used.add(item.key);
    }
    const requires = value.requires ?? {};
    check(plainObject(requires), 'Invalid requires contract.');
    const validMethods = (list, label) => {
        check(Array.isArray(list) && list.length <= 100, `Invalid ${label} requirements.`);
        const unique = new Set();
        for (const item of list) {
            check(typeof item === 'string' && item.length <= 120 &&
                /^[a-zA-Z][a-zA-Z0-9]*(?:\.[a-zA-Z][a-zA-Z0-9]*)*$/.test(item) &&
                !item.split('.').some(x => ['constructor','prototype','__proto__'].includes(x)) && !unique.has(item),
                `Invalid or duplicate ${label} requirement: ${item}`);
            unique.add(item);
        }
        return [...unique];
    };
    const required = {
        editor_api: validMethods(requires.editor_api ?? [], 'Editor API'),
        internal_api: validMethods(requires.internal_api ?? [], 'internal API')
    };
    const thirdParty = value.third_party ?? [];
    check(Array.isArray(thirdParty) && thirdParty.length <= 30, 'Invalid third_party list.');
    for (const item of thirdParty) {
        check(plainObject(item) && ['name','version','license'].every(k =>
            typeof item[k] === 'string' && item[k].trim() && item[k].length <= 120),
            'Invalid third_party declaration.');
    }
    let native_service;
    if (value.native_service !== undefined) {
        check(plainObject(value.native_service), 'Invalid native_service declaration.');
        const nativeEntry = normalizedEntry(value.native_service.entry);
        check(nativeEntry==='native/service.mjs', 'Native service entry must be ./native/service.mjs.');
        native_service = {entry:'./'+nativeEntry};
        if (value.native_service.port !== undefined) {
            const port=value.native_service.port;
            check(plainObject(port) && port.required === true &&
                Number.isInteger(port.preferred) && port.preferred >= 1024 && port.preferred <= 65535 &&
                Object.keys(port).every(key=>['required','preferred'].includes(key)),
                'Invalid managed native port declaration.');
            native_service.port={required:true,preferred:port.preferred};
        }
    }
    return { ...(native_service ? {native_service} : {}), id: value.id, name: value.name, classification: value.classification,
        version: value.version, author: value.author, date: value.date,
        description: value.description, entry: './' + entry, requires: required,
        requires_declared: value.requires !== undefined && value.requires_declared !== false,
        third_party: thirdParty.map(x=>({name:x.name,version:x.version,license:x.license})),
        settings_schema: schemas.map(s => ({ key: s.key, type: s.type, label: s.label })) };
}
export function releaseFolder(id, date = new Date()) {
    check(ID_PATTERN.test(id), 'Invalid plugin ID.');
    const timestamp = date.toISOString().replace(/[-:.]/g, '');
    return `${id}_${timestamp}`;
}
export function pluginUrl(folder, entry) {
    check(FOLDER_PATTERN.test(folder), 'Unsafe installed plugin folder.');
    return new URL(`${folder}/${normalizedEntry(entry)}`, ROOT_URL).href;
}

async function fetchJson(url) {
    const response = await fetch(url, { cache: 'no-store' });
    check(response.ok, `Could not load ${url.pathname}: HTTP ${response.status}.`);
    return response.json();
}
async function fetchCatalog() { return validateCatalog(await fetchJson(CATALOG_URL)); }
async function fetchInventory() {
    const value = await fetchJson(INVENTORY_URL);
    check(value?.schema_version === 1 && Array.isArray(value.available_methods) &&
        /^[0-9a-f]{40}$/i.test(value.commit || ''), 'Invalid Editor API inventory. Run a full build.');
    return value;
}
async function fetchAudit(folder) {
    try { return await fetchJson(new URL(`${folder}/audit.json`, ROOT_URL)); }
    catch { return null; } // Legacy plugin installed before compatibility reports existed.
}
export function checkCompatibility(meta, inventory, editor = null, packageAudit = null) {
    const required = meta.requires?.editor_api || [];
    // Audit evidence is advisory. Absence of the inventory is NOT evidence of a missing API.
    if (!inventory) return {status:'NOT_ASSESSED',missing:[],reason:'Editor API inventory unavailable'};
    const supported = new Set(inventory.available_methods);
    const missing = required.filter(p => !supported.has(p) || (editor &&
        typeof p.split('.').reduce((obj,part) => obj?.[part],editor) !== 'function'));
    const needsReview = (meta.requires?.internal_api?.length || 0) > 0 ||
        (meta.third_party?.length || 0) > 0 || !packageAudit ||
        packageAudit.status === 'REVIEW_REQUIRED' || packageAudit.editor_commit !== inventory.commit;
    const status = missing.length || packageAudit?.status === 'INCOMPATIBLE' ? 'INCOMPATIBLE' :
        meta.requires_declared === false || packageAudit?.status === 'NOT_ASSESSED' ? 'NOT_ASSESSED' :
        needsReview ? 'REVIEW_REQUIRED' : 'STATIC_COMPATIBLE';
    return {status, missing};
}
async function fetchMetadata(folder, id) {
    return validateMetadata(await fetchJson(new URL(`${folder}/plugin.json`, ROOT_URL)), id);
}
// Only management operations use the optional independent backend.
// Static manifest, metadata, audits and ES modules always remain on the Editor origin.
function managementApiUrl() {
    if (typeof document === 'undefined') return new URL('./api/plugins/', import.meta.url);
    const scriptUrl = new URL(import.meta.url);
    const hooks = [...document.querySelectorAll('script[type="module"][src]')];
    const hook = hooks.find(el => {
        try { return new URL(el.getAttribute('src'), document.baseURI).href === scriptUrl.href; }
        catch { return false; }
    });
    const configured = hook?.getAttribute('data-management-origin');
    if (!configured) return new URL('./api/plugins/', import.meta.url); // Architecture A
    const u = new URL(configured);
    check(u.protocol === 'http:' && ['127.0.0.1','localhost'].includes(u.hostname) &&
        u.port && u.href === u.origin + '/', 'Invalid loopback Plugin Manager backend origin.');
    return new URL('/api/plugins/', u);
}
const API_URL = managementApiUrl();

async function apiRequest(method, path, value, signal) {
    const headers = { 'X-SuperSplat-Plugin-Manager': '1' };
    const options = { method, headers, cache: 'no-store', signal };
    if (value !== undefined) {
        headers['Content-Type'] = 'application/json';
        options.body = JSON.stringify(value);
    }
    const res = await fetch(new URL(path, API_URL), options);
    let result;
    try { result = await res.json(); }
    catch { throw new Error(`Plugin service returned a non-JSON response (HTTP ${res.status}).`); }
    if (!res.ok) throw Object.assign(new Error(result?.error || `Plugin service HTTP ${res.status}.`), {status:res.status, code:result?.code});
    return result;
}

export const localPluginApi = {
    async capabilities() {
        try {
            const response = await fetch(new URL('capabilities', API_URL), { cache: 'no-store' });
            if (!response.ok || !response.headers.get('content-type')?.includes('application/json')) return null;
            const value = await response.json();
            return value?.api_version === 1 && value.local_only === true ? value : null;
        } catch { return null; }
    },
    install: files => apiRequest('POST', 'install', { files }),
    save: (catalog, expected_catalog) => apiRequest('PUT', 'config', { catalog, expected_catalog }),
    remove: (id, expected_catalog) => apiRequest('DELETE', encodeURIComponent(id), { expected_catalog }),
    native: (id, folder, action, options) => apiRequest('POST', `native/${encodeURIComponent(id)}/${action}`, {folder},options?.signal)
};

function encodeArrayBuffer(buffer) {
    const arr = new Uint8Array(buffer);
    let binary = '';
    for (let i = 0; i < arr.length; i += 16384) {
        binary += String.fromCharCode(...arr.subarray(i, i + 16384));
    }
    return btoa(binary);
}

export async function prepareUpload(files) {
    check(Array.isArray(files) && files.length >= 2 && files.length <= MAX_FILES,
        `Select one plugin folder containing 2–${MAX_FILES} files.`);
    const first = files[0]?.webkitRelativePath;
    check(typeof first === 'string' && first.includes('/'), 'Select a plugin folder, not individual files.');
    const root = first.split('/')[0];
    let total = 0;
    const paths = new Set();
    const packageFiles = [];
    for (const file of files) {
        const relative = file.webkitRelativePath;
        check(relative?.startsWith(root + '/'), 'Install one plugin folder at a time.');
        const relativePath = relative.slice(root.length + 1);
        const parts = relativePath.split('/');
        check(parts.length <= MAX_DEPTH + 1 && parts.every(safeSegment), 'Invalid plugin package file path.');
        check(!paths.has(relativePath), 'Duplicate plugin package file path.');
        paths.add(relativePath);
        total += file.size;
        check(total <= MAX_BYTES, 'Plugin package exceeds 50 MB.');
        packageFiles.push({ path: relativePath, data_base64: encodeArrayBuffer(await file.arrayBuffer()) });
    }
    check(paths.has('plugin.json'), 'Selected folder is missing plugin.json.');
    const metadataFile = files.find(f => f.webkitRelativePath === `${root}/plugin.json`);
    const metadata = validateMetadata(JSON.parse(await metadataFile.text()));
    check(paths.has(normalizedEntry(metadata.entry)), 'Selected plugin folder is missing its entry module.');
    if (metadata.native_service) check(paths.has(normalizedEntry(metadata.native_service.entry)), 'Selected plugin folder is missing its native service entry.');
    return { metadata, files: packageFiles };
}

function dom(tag, options = {}) {
    const el = document.createElement(tag);
    if (options.className) el.className = options.className;
    if (options.text !== undefined) el.textContent = options.text;
    if (options.title) el.title = options.title;
    if (options.type) el.type = options.type;
    return el;
}

export class PluginManager {
    constructor({ editor, importer = url => import(url), catalogReader = fetchCatalog,
        metadataReader = fetchMetadata, inventoryReader = fetchInventory, auditReader = fetchAudit,
        api = localPluginApi, logger = console } = {}) {
        this.editor = editor;
        this.importer = importer;
        this.catalogReader = catalogReader;
        this.metadataReader = metadataReader;
        this.inventoryReader = inventoryReader;
        this.auditReader = auditReader;
        this.apiInventory = null;
        this.nativeApprovalRecords = [];
        this.logger = logger;
        this.api = api;
        this.capabilities = null;
        this.catalog = { schema_version: SCHEMA, plugins: [] };
        this.diskBaseline = null;
        this.entries = new Map();
        this.locks = new Set();
        // Browser-local guard: an earlier release may still have live JavaScript after failed cleanup.
        this.reloadRequiredIds = new Set();
        this.dirty = false;

        this.activationOrder = [];
        this.startupFindings = [];
        this.auditWarnings = [];
        this.onChange = () => {};
    }
    emit() { this.onChange(); }
    state(id) { return this.entries.get(id)?.state; }
    record(id) { return this.catalog.plugins.find(p => p.id === id); }
    async readInventory() {
        try { this.apiInventory = await this.inventoryReader(); this.auditWarnings = []; }
        catch (e) {
            this.apiInventory = null;
            const warning = `API inventory unavailable (advisory only): ${e.message || e}`;
            this.auditWarnings = [warning];
            this.logger.warn?.(warning);
        }
    }
    async initialize() {
        this.capabilities = await this.api.capabilities();
        await this.readInventory();
        this.catalog = await this.catalogReader();
        this.diskBaseline = jsonClone(this.catalog);
        await this.loadMetadata();
        this.startupFindings = [];
        for (const p of this.catalog.plugins) {
            if (!p.enabled) continue;
            try { await this.activate(p.id); }
            catch (e) {
                const reason = `Startup activation failed: ${e.message || e}`;
                this.startupFindings.push({id:p.id,status:'ERROR',reason});
                this.logger.error?.('Plugin startup failed:', p.id, e);
            }
        }
        this.dirty = false;
        this.emit();
    }
    // A plugin owns its working state. The manager must not guess that a legacy
    // module lacking isRunning() is closed merely because open() returned.
    runningCondition(id) {
        const entry = this.entries.get(id);
        if (!entry || entry.state !== 'Active') return null;
        if (typeof entry.handle?.isRunning !== 'function') return 'Unknown';
        try {
            const value = entry.handle.isRunning();
            check(typeof value === 'boolean', 'isRunning() must return a synchronous boolean.');
            return value ? 'Running' : 'Closed';
        } catch (e) {
            entry.state = 'Error';
            entry.unsafeCleanup = true;
            entry.error = `isRunning() failed; cleanup state unknown: ${e.message || e}`;
            this.logger.error?.('Plugin status failed:', id, e);
            return 'Error';
        }
    }
    displayStatus(id) {
        const entry = this.entries.get(id);
        if (!entry) return 'Unknown';
        if (entry.state === 'Active') {
            const condition = this.runningCondition(id);
            return condition === 'Error' ? 'Error' : 'Active · ' + condition;
        }
        if (['Installed','Loaded','Inactive'].includes(entry.state)) return 'Inactive';
        return entry.state;
    }
    async readNativeApprovalStatus() {
        if (typeof document === 'undefined' || !['interactive-v3','interactive-v4'].includes(this.capabilities?.native_authorization) ||
            !this.catalog.plugins.some(p=>this.entries.get(p.id)?.meta?.native_service)) return;
        try {
            const value = await fetchJson(new URL('native-approvals.json', ROOT_URL));
            this.nativeApprovalRecords = [1,2].includes(value?.schema_version) && Array.isArray(value.plugins) ? value.plugins : [];
        } catch { this.nativeApprovalRecords = []; }
    }
    async loadMetadata() {
        for (const p of this.catalog.plugins) {
            const old = this.entries.get(p.id);
            if (old && old.folder === p.folder && (old.state === 'Active' || old.unsafeCleanup)) continue;
            try {
                const meta = await this.metadataReader(p.folder, p.id);
                const audit = await this.auditReader(p.folder);
                const compatibility = checkCompatibility(meta, this.apiInventory, this.editor, audit);
                this.entries.set(p.id, { ...old, id: p.id, folder: p.folder,
                    meta, audit, compatibility, state: old?.folder === p.folder && old.state !== 'Error' ? old.state : 'Installed',
                    module: old?.folder === p.folder ? old.module : null,
                    handle: old?.folder === p.folder ? old.handle : null,
                    error: null });
            } catch (e) {
                this.entries.set(p.id, { id: p.id, folder: p.folder, meta: null,
                    state: 'Error', error: String(e.message || e), module: null, handle: null });
            }
        }
        await this.readNativeApprovalStatus();
        this.emit();
    }
    async exclusive(id, task) {
        check(!this.locks.has(id), `Plugin ${id} already has an operation in progress.`);
        this.locks.add(id);
        this.emit();
        try { return await task(); }
        finally { this.locks.delete(id); this.emit(); }
    }
    async load(id) {
        return this.exclusive(id, async () => this.loadUnlocked(id));
    }
    async loadUnlocked(id) {
        const entry = this.entries.get(id);
        check(entry && this.record(id), `Unknown plugin: ${id}`);
        check(entry.state !== 'Error', `Plugin ${id} requires review/reload after an error.`);
        if (entry.module) return entry;
        try {
            const mod = await this.importer(pluginUrl(entry.folder, entry.meta.entry));
            check(typeof mod.activate === 'function', `Plugin ${id} has no activate(context) export.`);
            entry.module = mod;
            entry.state = 'Loaded';
            entry.error = null;
            this.emit();
            return entry;
        } catch (e) {
            // A failed ES module import may already have executed dependency top-level code.
            entry.state = 'Error';
            entry.unsafeCleanup = true;
            entry.error = `Module load failed; side effects may require reload: ${e.message || e}`;
            throw e;
        }
    }
    async activate(id) {
        return this.exclusive(id, async () => {
            const entry = this.entries.get(id);
            check(entry, `Unknown plugin: ${id}`);
            check(!this.reloadRequiredIds.has(id),
                `Plugin ${id} may still have JavaScript from a removed release. Reload the Editor before activation.`);
            check(entry.meta, `Plugin ${id} metadata is unavailable; refresh after correcting the package.`);
            if (entry.state === 'Active') return;
            // Compatibility is displayed as reference information, never as a runtime gate.
            entry.compatibility = checkCompatibility(entry.meta, this.apiInventory, this.editor, entry.audit);
            if (!entry.module) await this.loadUnlocked(id);
            check(['Loaded', 'Inactive'].includes(entry.state), `Plugin ${id} cannot activate from ${entry.state}.`);
            const p = this.record(id);
            const host = typeof document !== 'undefined' ? dom('div', { className: 'spm-plugin-host' }) : null;
            if (host) { host.dataset.pluginId = id; document.body.append(host); }
            try {
                const result = await entry.module.activate({ editor: this.editor, plugin: jsonClone(entry.meta),
                    settings: jsonClone(p.settings), uiHost: host, advanced: entry.meta.native_service && this.capabilities?.native_service === 1 && typeof this.api.native === 'function' ? {
                        native: Object.freeze(Object.fromEntries(['start','status','stop'].map(action=>[action,async(options)=>{
                            if(action==='start') check(['interactive-v3','interactive-v4'].includes(this.capabilities?.native_authorization), 'Deployed Plugin Manager does not support interactive native authorization. Stop Editor, deploy the matching management runtime using maintain_editor.bat copy, and restart.');
                            try { return await (options ? this.api.native(id,p.folder,action,options) : this.api.native(id,p.folder,action)); }
                            finally { if(action==='start') { void this.readNativeApprovalStatus().then(()=>this.emit()); } }
                        }])))
                    } : {} });
                check(result && typeof result.deactivate === 'function' && typeof result.open === 'function',
                    `Plugin ${id} must return open() and deactivate() methods.`);
                entry.handle = result;
                entry.host = host;
                entry.state = 'Active';
                entry.unsafeCleanup = false;
                entry.error = null;
                this.activationOrder = this.activationOrder.filter(x => x !== id).concat(id);
                this.startupFindings = this.startupFindings.filter(f=>f.id!==id);
                this.emit();
            } catch (e) {
                host?.remove();
                entry.state = 'Error';
                entry.unsafeCleanup = true;
                entry.error = `Activation failed; partial plugin side effects may require reloading: ${e.message || e}`;
                this.emit();
                throw e;
            }
        });
    }
    async deactivate(id, { confirm } = {}) {
        return this.exclusive(id, async () => {
            const entry = this.entries.get(id);
            check(entry && this.record(id), `Unknown plugin: ${id}`);
            if (entry.state !== 'Active' && !(entry.state === 'Error' && entry.handle)) return;
            const condition = entry.state === 'Active' ? this.runningCondition(id) : 'Error';
            const warningNeeded = condition !== 'Closed';
            if (warningNeeded) {
                check(typeof confirm === 'function',
                    `Plugin ${id} is ${condition || 'uncertain'}. Confirm the cleanup warning before Deactivate.`);
                check(await confirm({id, condition, message:
                    `Plugin ${id} is ${condition || 'uncertain'}. Cleanup may interrupt work or fail to restore scene state. Continue?`}),
                    'Deactivation cancelled.');
            }
            return this.deactivateUnlocked(id, { warned: warningNeeded });
        });
    }
    // One cleanup implementation, reused by Deactivate and Remove. Browser removal
    // is not conditional on cleanup success; both outcomes are reported separately.
    async deactivateUnlocked(id, { warned = false } = {}) {
        const entry = this.entries.get(id);
        check(entry && entry.handle && typeof entry.handle.deactivate === 'function',
            `Plugin ${id} has no usable cleanup handle.`);
        try {
            await entry.handle.deactivate();
            if (typeof entry.handle.isRunning === 'function') {
                const stillRunning = entry.handle.isRunning();
                check(stillRunning === false,
                    stillRunning === true ? 'Plugin reports it is still running after cleanup.' :
                    'Plugin returned an invalid running status after cleanup.');
            }
            if (entry.meta?.native_service && this.capabilities?.native_service === 1 && typeof this.api.native === 'function') {
                await this.api.native(id, this.record(id).folder, 'stop');
            }
            entry.host?.remove();
            entry.host = null;
            entry.handle = null;
            entry.state = 'Inactive';
            entry.unsafeCleanup = false;
            entry.error = null;
            entry.lastWarning = warned ? 'Cleanup succeeded as reported by the plugin; verify scene state.' : null;
            this.activationOrder = this.activationOrder.filter(x => x !== id);
            this.emit();
            return {verification: warned ? 'plugin_reported' : 'completed'};
        } catch (e) {
            entry.state = 'Error';
            entry.unsafeCleanup = true;
            entry.error = `Deactivation failed; cleanup not confirmed: ${e.message || e}`;
            this.emit();
            throw e;
        }
    }
    async open(id) {
        return this.exclusive(id, async () => {
            const entry = this.entries.get(id);
            check(entry?.state === 'Active', 'Only active plugins can be opened.');
            try { return await entry.handle.open(); }
            catch (e) {
                if (e?.name === 'AbortError') throw e;
                entry.state = 'Error';
                entry.unsafeCleanup = true;
                entry.error = `Open failed; plugin working state uncertain: ${e.message || e}`;
                this.emit();
                throw e;
            } finally { this.emit(); }
        });
    }
    async batch(ids, operation, { confirm } = {}) {
        check(['load', 'activate', 'deactivate', 'remove'].includes(operation), 'Invalid batch operation.');
        const outcomes = [];
        for (const id of [...new Set(ids)]) {
            const state = this.state(id);
            const eligible = operation === 'load' ? state === 'Installed' :
                operation === 'activate' ? ['Installed', 'Loaded', 'Inactive'].includes(state) :
                operation === 'deactivate' ? (state === 'Active' || (state === 'Error' && !!this.entries.get(id)?.handle)) :
                state !== undefined;
            if (!eligible) { outcomes.push({ id, ok: true, skipped: true }); continue; }
            try {
                const value = operation === 'deactivate' ? await this.deactivate(id, {confirm}) :
                    operation === 'remove' ? await this.remove(id, {confirm}) : await this[operation](id);
                outcomes.push({ id, ok: true, skipped: false, value });
            }
            catch (e) { outcomes.push({ id, ok: false, error: String(e.message || e) }); }
        }
        this.emit();
        return outcomes;
    }
    desired(id, enabled) {
        const rec = this.record(id);
        check(rec, 'Unknown plugin.');
        check(typeof enabled === 'boolean', 'Expected boolean.');
        if (enabled && !rec.enabled)
            check(this.entries.get(id)?.state === 'Active', 'Activate the plugin successfully before enabling Startup.');
        if (rec.enabled === enabled) return;
        rec.enabled = enabled;
        this.dirty = true;
        this.emit();
    }
    changeSettings(id, updates) {
        const rec = this.record(id);
        const entry = this.entries.get(id);
        check(rec && entry?.meta, 'Unknown plugin.');
        for (const [key, value] of Object.entries(updates)) {
            const rule = entry.meta.settings_schema.find(s => s.key === key);
            check(rule && typeof value === rule.type, `Invalid setting: ${key}`);
        }
        rec.settings = validateSettings({ ...rec.settings, ...updates });
        this.dirty = true;
        this.emit();
    }
    assertWritable() {
        check(this.capabilities?.install, 'Plugin installation is available only on the local plugin-management HTTP server.');
    }
    async save() {
        check(this.capabilities?.save, 'Saving plugin settings requires the local plugin-management HTTP server.');
        // Keep the old baseline until the server explicitly accepts the update.
        const updated = await this.api.save(validateCatalog(this.catalog), this.diskBaseline);
        this.catalog = validateCatalog(updated.catalog);
        this.diskBaseline = jsonClone(this.catalog);
        this.dirty = false;
        this.emit();
    }
    async refresh({ discardUnsaved = false } = {}) {
        if (this.dirty && !discardUnsaved) throw new Error('Unsaved settings. Save or explicitly discard them.');
        // A management backend may have started or stopped since Editor initialization.
        this.capabilities = await this.api.capabilities();
        const updated = await this.catalogReader();
        await this.readInventory();
        for (const [id, entry] of this.entries) {
            if (entry.state !== 'Active' && !(entry.state === 'Error' && entry.unsafeCleanup)) continue;
            const registered = updated.plugins.find(p => p.id === id);
            check(registered && registered.folder === entry.folder,
                `Plugin ${id} may still be running. Deactivate/recover before refreshing changed files.`);
        }
        const old = this.entries;
        this.catalog = updated;
        this.diskBaseline = jsonClone(updated);
        this.entries = new Map([...old].filter(([id]) => updated.plugins.some(p => p.id === id)));
        this.dirty = false;
        await this.loadMetadata();
        this.startupFindings = this.startupFindings.filter(f =>
            this.catalog.plugins.some(p=>p.id===f.id && p.enabled && this.entries.get(p.id)?.state!=='Active'));
        this.emit();
    }
    async installFiles(files, { confirm = () => true } = {}) {
        this.assertWritable();
        check(!this.dirty, 'Save or discard startup changes before installing.');
        const upload = await prepareUpload(files);
        check(!this.record(upload.metadata.id), `Plugin ${upload.metadata.id} is already installed; remove it first.`);
        check(await confirm(upload.metadata, upload.files), 'Installation cancelled.');
        const result = await this.api.install(upload.files);
        // Installation is committed by the server; do not pretend that a browser
        // import failure rolls back an already installed release.
        const p = result.plugin;
        this.catalog = validateCatalog({schema_version:SCHEMA, plugins:[...this.catalog.plugins,p]});
        this.diskBaseline = jsonClone(this.catalog);
        let entry;
        try {
            const meta = await this.metadataReader(p.folder, p.id);
            const audit = result.compatibility || await this.auditReader(p.folder);
            const compatibility = checkCompatibility(meta, this.apiInventory, this.editor, audit);
            entry = {id:p.id,folder:p.folder,meta,audit,compatibility,state:'Installed',module:null,handle:null,error:null};
            this.entries.set(p.id,entry);
            // Installing a package must not execute JavaScript, including ES module top-level code.
            // Activation imports the module on explicit user action. Runtime status is Installed.
        } catch (e) {
            entry = {id:p.id,folder:p.folder,meta:upload.metadata,state:'Error',module:null,handle:null,
                error:`Installed, but module validation failed: ${e.message||e}`};
            this.entries.set(p.id,entry);
        }
        this.dirty = false;
        this.emit();
        return entry;
    }
    async remove(id, {confirm} = {}) {
        return this.exclusive(id, async () => {
            check(this.capabilities?.remove, 'Plugin removal requires the local plugin-management HTTP server.');
            check(!this.dirty, 'Save or discard startup changes before removal.');
            const entry = this.entries.get(id);
            check(entry && this.record(id), `Unknown plugin: ${id}`);
            let cleanup = { status: 'not_required' };
            if (entry.handle && (entry.state === 'Active' || entry.state === 'Error')) {
                try {
                    const condition = entry.state === 'Active' ? this.runningCondition(id) : 'Error';
                    await this.deactivateUnlocked(id, {warned: condition !== 'Closed'});
                    cleanup = {status:'succeeded', verification:'plugin_reported'};
                } catch (e) {
                    cleanup = {status:'failed', reason:String(e.message || e)};
                    this.logger.warn?.('Plugin cleanup failed during removal:', id, e);
                }
            } else if (entry.unsafeCleanup || entry.state === 'Active') {
                cleanup = {status:'unavailable', reason:'No usable cleanup handle; previously loaded code may still execute.'};
            }
            // A failed or unavailable cleanup does not establish that imported
            // JavaScript has stopped. Require a separate, explicit decision before
            // removing the installed package; do not silently continue.
            if (cleanup.status === 'failed' || cleanup.status === 'unavailable') {
                const message = `Plugin ${id} cleanup is ${cleanup.status}: ${cleanup.reason || 'runtime state unknown'}.\n\n` +
                    'Removing its package cannot stop already imported JavaScript. ' +
                    'Reload the Editor afterward. Remove the installed files anyway?';
                check(typeof confirm === 'function' &&
                    await confirm({id, cleanup, message}),
                    'Package removal cancelled: plugin cleanup was not confirmed. Installed files and settings remain.');
            }
            let response;
            try {
                response = await this.api.remove(id, this.diskBaseline);
            } catch (e) {
                // Even if browser cleanup succeeded, the package/catalog remain installed.
                // Keep the resulting runtime state; do not pretend to restore Active.
                throw new Error(`Package removal failed (${e.message || e}); cleanup: ${cleanup.status}${cleanup.reason ? ' — ' + cleanup.reason : ''}.`);
            }
            check(response?.status === 'Removed', 'Server did not confirm package removal. Refresh the catalog.');
            this.catalog = validateCatalog({schema_version:SCHEMA, plugins:this.catalog.plugins.filter(p=>p.id!==id)});
            this.diskBaseline = jsonClone(this.catalog);
            this.entries.delete(id);
            this.startupFindings = this.startupFindings.filter(f=>f.id!==id);
            this.activationOrder = this.activationOrder.filter(x=>x!==id);
            const unsafe = cleanup.status === 'failed' || cleanup.status === 'unavailable';
            if (unsafe) this.reloadRequiredIds.add(id);
            this.emit();
            return {removed:true, cleanup, reloadRequired:unsafe, packageDeleted:response.packageDeleted !== false, ...(response.warning ? {serverWarning:response.warning} : {})};
        });
    }

}

const STYLE = `
#spm-toolbar {position:fixed;right:clamp(16px,4vw,72px);bottom:44px;z-index:1200;font:13px system-ui,sans-serif;color:#eee}
#spm-attention{max-width:290px;margin-bottom:5px;padding:9px;background:#4a3829;border:1px solid #ca9959;border-radius:6px;color:#fff;cursor:pointer;text-align:left}
.spm-panel .spm-attention-detail{padding:9px;margin:8px 0;background:#48382c;border:1px solid #a47c51;border-radius:6px;white-space:pre-wrap}
#spm-toolbar button,.spm-panel button{background:#333740;border:1px solid #747b86;color:#fff;border-radius:5px;padding:7px 9px;cursor:pointer;font:inherit}
#spm-toolbar button:hover,.spm-panel button:hover{background:#48515d}
#spm-toolbar button:disabled,.spm-panel button:disabled{opacity:.42;cursor:not-allowed}
.spm-menu[hidden],.spm-panel[hidden]{display:none!important}
.spm-menu{position:absolute;bottom:calc(100% + 5px);right:0;width:265px;max-height:min(65vh,450px);overflow-y:auto;display:flex;flex-direction:column;gap:3px;padding:7px;background:#252a30;border:1px solid #69727b;border-radius:7px;box-shadow:0 8px 22px #0007}
.spm-menu .spm-item{display:flex;align-items:center;gap:6px}
.spm-menu .spm-item>button:first-child{flex:1;text-align:left;overflow:hidden;text-overflow:ellipsis}
.spm-info{flex-shrink:0;padding:4px 7px!important}
.spm-panel{position:fixed;right:clamp(12px,4vw,72px);bottom:102px;z-index:1201;background:#252a30;color:#fff;border:1px solid #7f8792;border-radius:9px;box-shadow:0 14px 36px #0009;width:min(840px,calc(100vw - 24px));max-height:min(75vh,650px);overflow:auto;padding:13px;font:13px system-ui,sans-serif}
.spm-panel h2{margin:0;font-size:17px}
.spm-panel .spm-head,.spm-panel .spm-actions{display:flex;gap:7px;flex-wrap:wrap;align-items:center;margin:10px 0}
.spm-panel table{width:100%;border-collapse:collapse;font:inherit}
.spm-panel td,.spm-panel th{padding:7px 5px;border-bottom:1px solid #49515b;text-align:left;vertical-align:middle}
.spm-panel th{font-size:12px;color:#ccd2d8}
.spm-panel .spm-status{font-size:12px;font-weight:600}
.spm-panel .spm-error{color:#ff9e9e;white-space:pre-wrap}
.spm-panel input[type=text],.spm-panel input[type=number]{padding:5px;color:#fff;background:#313741;border:1px solid #777;border-radius:4px;max-width:170px}
.spm-panel .spm-help{font-size:12px;color:#c4cad0}
.spm-panel .spm-log{white-space:pre-wrap;max-height:100px;overflow:auto;font-size:12px;color:#d2e1ec}
.spm-menu .spm-state{font-size:11px;color:#91ddb6}
.spm-status-indicator{display:inline-block;width:9px;height:9px;border-radius:50%;margin-right:5px;background:#9ca3af}
.spm-status-indicator[data-condition="Running"]{background:#44bd73}
.spm-status-indicator[data-condition="Closed"]{background:#5fa5ff}
.spm-status-indicator[data-condition="Error"]{background:#f16c6c}
.spm-status-indicator[data-condition="Unknown"]{background:#b5a16b}
`;

function installStyle() {
    if (document.getElementById('spm-css')) return;
    const style = dom('style'); style.id = 'spm-css'; style.textContent = STYLE;
    document.head.append(style);
}
function infoButton(meta) {
    const b = dom('button', { text: 'ⓘ', title: `${meta.name}\n${meta.description}\n${meta.author} · ${meta.date} · ${meta.version}` });
    b.className = 'spm-info';
    b.setAttribute('aria-label', `Information about ${meta.name}`);
    b.onclick = (ev) => { ev.stopPropagation(); window.alert(b.title); };
    return b;
}

export class ManagerUI {
    constructor(manager) {
        this.manager = manager;
        this.selected = new Set();
        this.menuVisible = false;
        this.panelVisible = false;
        this.busy = false;
        this.messages = [];
        this.lastStatuses = '';
        manager.onChange = () => this.render();
    }
    notify(text) {
        this.messages.unshift(`${new Date().toLocaleTimeString()}  ${text}`);
        this.messages = this.messages.slice(0, 8);
        this.render();
    }
    async run(label, task) {
        if (this.busy) return;
        this.busy = true;
        this.render();
        try { await task(); }
        catch (e) { this.notify(`${label}: ${e.message || e}`); }
        finally { this.busy = false; this.render(); }
    }
    confirmation(meta, files) {
        return window.confirm(`Install ${meta.name} v${meta.version} by ${meta.author}?\n${meta.description}\n\n${files.length} files. Activated plugins execute JavaScript with Editor privileges. Only install trusted code.`);
    }
    startInstall() {
        if (!this.manager.capabilities?.install) return this.notify('Installation requires the local plugin-management HTTP server.');
        if (this.manager.dirty) return this.notify('Save or discard startup changes before installing a plugin.');
        // Native directory-file input reads the chosen source folder but does not
        // request write access or expose any local installation-directory picker.
        const picker = dom('input', {type:'file'});
        picker.multiple = true;
        picker.setAttribute('webkitdirectory','');
        picker.style.display = 'none';
        document.body.append(picker);
        picker.oncancel = () => picker.remove();
        picker.onchange = () => {
            const files = [...picker.files];
            picker.remove();
            if (!files.length) return;
            this.run('Install Plugin',async()=>{
                const entry=await this.manager.installFiles(files,{confirm:(meta,pkg)=>this.confirmation(meta,pkg)});
                this.notify(`${entry.meta.name} installed (${entry.state}); compatibility: ${entry.compatibility?.status || 'unknown'}. Activation is separate.`);
            });
        };
        picker.click();
    }
    async batch(action) {
        const ids = [...this.selected];
        if (!ids.length) return this.notify('Select one or more plugins first.');
        if (action === 'remove' && !window.confirm(
            `Remove ${ids.length} selected plugin(s)?\n\nThe Manager will attempt cleanup before deleting installed packages and saved settings/Startup preferences. If cleanup fails, old JavaScript may continue running and the same plugin ID cannot be activated again until an Editor reload.`)) return;
        return this.run(action, async () => {
            const outcomes = await this.manager.batch(ids, action, {
                confirm: ({message}) => window.confirm(message)
            });
            for (const result of outcomes) {
                if (!result.ok) {
                    this.notify(`${result.id}: ${result.error}`);
                    continue;
                }
                if (result.skipped) {
                    this.notify(`${result.id}: skipped (not eligible)`);
                    continue;
                }
                if (action === 'remove') {
                    this.selected.delete(result.id);
                    const value = result.value;
                    this.notify(`${result.id}: ${value.packageDeleted === false ? 'unregistered; directory cleanup incomplete' : 'package removed'}; cleanup ${value.cleanup.status}.` +
                        (value.reloadRequired ? ' Reload Editor before activating a replacement with this ID.' : '') +
                        (value.serverWarning ? ` Server warning: ${value.serverWarning}` : ''));
                } else {
                    this.notify(`${result.id}: ${action} completed` +
                        (result.value?.verification === 'plugin_reported' ? '; cleanup is plugin-reported, verify scene.' : '') + '.');
                }
            }
        });
    }
    mount() {
        installStyle();
        this.bar = dom('nav', { className: 'blocks-shortcuts' });
        this.bar.id = 'spm-toolbar';
        this.bar.setAttribute('aria-label', 'SuperSplat plugins');
        this.attention = dom('button');
        this.attention.id = 'spm-attention';
        this.attention.onclick = () => { this.panelVisible = true;this.menuVisible = false;this.render(); };
        this.bar.append(this.attention);
        this.menu = dom('div', { className: 'spm-menu' });
        this.bar.append(this.menu);
        this.button = dom('button', { text: 'Plugins ▲' });
        this.button.onclick = () => { this.menuVisible = !this.menuVisible; this.render(); };
        this.bar.append(this.button);
        document.body.append(this.bar);
        this.panel = dom('section', { className: 'spm-panel blocks-shortcuts' });
        this.panel.setAttribute('aria-label', 'Plugin Manager');
        document.body.append(this.panel);
        this.render();
        // Only redraw when a plugin's independently reported running state changes.
        // Keep the Editor and controls responsive; do not poll compatibility or the server.
        window.setInterval(() => {
            if (!this.panelVisible && !this.menuVisible) return;
            const statuses = this.manager.catalog.plugins.map(p => this.manager.displayStatus(p.id)).join('|');
            if (statuses !== this.lastStatuses) this.render();
        }, 750);
    }
    render() {
        if (!this.bar) return;
        const m = this.manager;
        this.attention.hidden = !m.startupFindings.length;
        this.attention.textContent = `${m.startupFindings.length} plugin startup failure(s). Open Plugin Manager for details.`;
        this.menu.hidden = !this.menuVisible;
        this.menu.replaceChildren();
        for (const id of [...m.activationOrder].reverse()) {
            const item = m.entries.get(id);
            if (item?.state !== 'Active') continue;
            const row = dom('div', { className: 'spm-item' });
            const btn = dom('button', { text: `${item.meta.name} · ${m.displayStatus(id)}` });
            btn.onclick = () => this.run('Open plugin', () => m.open(id));
            row.append(btn, infoButton(item.meta));
            this.menu.append(row);
        }
        const manage = dom('button', { text: 'Manage Plugins…' });
        manage.style.width = '100%';
        manage.onclick = () => { this.panelVisible = true; this.menuVisible = false; this.render(); };
        this.menu.append(manage);
        this.panel.hidden = !this.panelVisible;
        if (!this.panelVisible) {
            this.lastStatuses = m.catalog.plugins.map(p => m.displayStatus(p.id)).join('|');
            return;
        }
        this.panel.replaceChildren();
        const header = dom('div', { className: 'spm-head' });
        const heading = dom('h2', { text: 'Plugin Manager' });
        const close = dom('button', { text: 'Close' });
        close.onclick = () => { this.panelVisible = false; this.render(); };
        header.append(heading, close);
        this.panel.append(header);
        if (m.startupFindings.length) {
            const reasons = m.startupFindings.map(f=>`${f.id}: ${f.status} — ${f.reason}`).join('\n');
            this.panel.append(dom('div',{className:'spm-attention-detail',
                text:`Startup activation failed for ${m.startupFindings.length} plugin(s):\n${reasons}\nInspect the plugin error and its developer documentation. Reload the Editor after unresolved cleanup failures.`}));
        }
        for (const warning of m.auditWarnings) this.panel.append(dom('div',{className:'spm-help',
            text:`Diagnostic audit warning: ${warning}. Plugin execution is not blocked.`}));
        const tools = dom('div', { className: 'spm-actions' });
        const install = dom('button', { text: 'Install Plugin' });
        install.disabled = this.busy || !m.capabilities?.install;
        install.onclick = () => this.startInstall();
        tools.append(install);
        const refresh = dom('button', { text: 'Refresh' });
        refresh.disabled = this.busy;
        refresh.onclick = () => this.run('Refresh', async () => {
            let discard = false;
            if (m.dirty) {
                if (!window.confirm('Discard unsaved startup preferences and refresh from the server?')) return;
                discard = true;
            }
            await m.refresh({ discardUnsaved: discard });
            this.notify('Catalog refreshed. Activated plugins retain their runtime state.');
        });
        tools.append(refresh);
        this.panel.append(tools);
        const helpText = m.capabilities?.install
            ? 'Install Plugin: select a local folder containing plugin.json and its JavaScript entry. The local HTTP server installs it into dist/plugins; activation is separate. Save records startup preferences.'
            : 'Management backend unavailable (or read-only hosting). Local Install, Save and Remove require the backend; click Refresh after it starts.';
        const help = dom('div', { className: 'spm-help', text: helpText });
        this.panel.append(help);
        const table = dom('table');
        const thead = dom('thead');
        const hr = dom('tr');
        for (const name of ['', 'Plugin', 'Version', 'Classification', 'Status', 'Compatibility', 'Startup']) {
            hr.append(dom('th', { text: name }));
        }
        thead.append(hr); table.append(thead);
        const tbody = dom('tbody');
        for (const p of m.catalog.plugins) {
            const entry = m.entries.get(p.id);
            const tr = dom('tr');
            const selectCell = dom('td');
            const selected = dom('input', { type: 'checkbox' });
            selected.checked = this.selected.has(p.id);
            selected.onchange = () => { if (selected.checked) this.selected.add(p.id); else this.selected.delete(p.id); this.render(); };
            selectCell.append(selected);
            tr.append(selectCell);
            const nameCell = dom('td');
            nameCell.append(dom('span', { text: entry?.meta?.name || p.id }));
            if (entry?.meta) nameCell.append(infoButton(entry.meta));
            if (entry?.meta?.native_service && ['interactive-v3','interactive-v4'].includes(m.capabilities?.native_authorization)) {
                const approval = m.nativeApprovalRecords.find(x=>x?.id===p.id&&x.folder===p.folder&&x.approval_recorded===true);
                const port = approval?.port;
                nameCell.append(dom('small',{text:approval?` · Native approved${Number.isInteger(port)?` (port ${port})`:''}`:' · Native approval not recorded',title:'Advisory only: the backend validates release identity and port assignment on every start.'}));
                if (Number.isInteger(port) && m.capabilities?.native_authorization==='interactive-v4') {
                    const change=dom('button',{type:'button',text:'Change native port',title:'Stop the owned service and authorize a new TCP port.'});
                    change.disabled=m.busy;
                    change.onclick=async()=>{
                        if (!confirm('Stop this plugin native service and open local port reauthorization?'))return;
                        try { await m.api.native(p.id,p.folder,'reassign'); await m.readNativeApprovalStatus(); m.render(); }
                        catch(e){ alert(`Native port reassignment failed: ${e.message}`); }
                    };
                    nameCell.append(change);
                }
            }
            tr.append(nameCell);
            tr.append(dom('td', { text: entry?.meta?.version || '—' }));
            tr.append(dom('td', { text: entry?.meta?.classification || '—' }));
            const currentStatus = m.displayStatus(p.id);
            const state = dom('td');
            const condition = currentStatus === 'Error' ? 'Error' :
                currentStatus.startsWith('Active · ') ? currentStatus.slice('Active · '.length) : 'Inactive';
            const dot = dom('span', { className:'spm-status-indicator' });
            dot.dataset.condition = condition;
            dot.setAttribute('aria-hidden','true');
            state.append(dot, dom('span',{text:currentStatus}));
            state.className = currentStatus === 'Error' ? 'spm-error' : 'spm-status';
            state.title = entry?.error || entry?.lastWarning || (condition === 'Unknown' ?
                'Plugin does not implement isRunning(). The manager cannot verify it is closed.' : '');
            tr.append(state);
            const compat = entry?.compatibility?.status || 'NOT_ASSESSED';
            const compatibilityCell = dom('td', {text: compat === 'STATIC_COMPATIBLE' ? 'Static OK' :
                compat === 'REVIEW_REQUIRED' ? 'Review' :
                compat === 'INCOMPATIBLE' ? 'Incompatible' : 'Not assessed'});
            compatibilityCell.title = [entry?.audit?.notices?.join('; '),
                entry?.audit?.evaluation ? Object.entries(entry.audit.evaluation).map(([k,v])=>`${k}: ${v}`).join('; ') : '',
                entry?.compatibility?.missing?.length ? 'Missing: ' + entry.compatibility.missing.join(', ') : '',
                'Static checks are not a runtime/security certification.'].filter(Boolean).join(' | ');
            compatibilityCell.className = compat === 'INCOMPATIBLE' ? 'spm-error' : 'spm-status';
            tr.append(compatibilityCell);
            const startupCell = dom('td');
            const startup = dom('input', { type: 'checkbox' });
            startup.checked = p.enabled;
            startup.disabled = this.busy || (!p.enabled && entry?.state !== 'Active');
            startup.title = p.enabled ? 'Disable saved auto-activation (allowed when inactive)' :
                'First Activate this plugin successfully, then enable Startup and Save';
            startup.onchange = () => { m.desired(p.id, startup.checked); };
            startupCell.append(startup);
            tr.append(startupCell);
            tbody.append(tr);
        }
        table.append(tbody); this.panel.append(table);
        const buttons = dom('div', { className: 'spm-actions' });
        for (const name of ['activate', 'deactivate', 'remove']) {
            const b = dom('button', { text: name[0].toUpperCase() + name.slice(1) });
            const selected = [...this.selected];
            b.disabled = this.busy || !selected.length || (name==='remove' && !m.capabilities?.remove);
            b.onclick = () => this.batch(name);
            buttons.append(b);
        }
        const only = [...this.selected];
        const edit = dom('button', { text: 'Settings' });
        edit.disabled = this.busy || only.length !== 1 || !m.entries.get(only[0])?.meta?.settings_schema?.length;
        edit.onclick = () => this.edit(only[0]);
        const save = dom('button', { text: 'Save' + (m.dirty ? ' *' : '') });
        save.disabled = this.busy || !m.dirty || !m.capabilities?.save;
        save.onclick = () => this.run('Save', async () => {
            await m.save();
            this.notify('Startup preferences saved to plugins/manifest.json.');
        });
        buttons.append(edit, save);
        this.panel.append(buttons);
        const log = dom('div', { className: 'spm-log', text: this.messages.join('\n') });
        this.panel.append(log);
        this.lastStatuses = m.catalog.plugins.map(p => m.displayStatus(p.id)).join('|');
    }
    edit(id) {
        const entry = this.manager.entries.get(id);
        if (!entry?.meta?.settings_schema.length) return;
        const updated = {};
        for (const rule of entry.meta.settings_schema) {
            const current = this.manager.record(id).settings[rule.key];
            const answer = window.prompt(`${entry.meta.name} — ${rule.label} (${rule.type})`, String(current ?? ''));
            if (answer === null) return;
            if (rule.type === 'boolean') {
                if (!['true', 'false'].includes(answer.toLowerCase())) return this.notify('Use true or false.');
                updated[rule.key] = answer.toLowerCase() === 'true';
            } else if (rule.type === 'number') {
                if (!answer.trim() || !Number.isFinite(Number(answer))) return this.notify('Use a finite number.');
                updated[rule.key] = Number(answer);
            } else updated[rule.key] = answer;
        }
        this.manager.changeSettings(id, updated);
        this.notify('Settings changed. Save to persist; reactivate to apply.');
    }
}

async function waitForEditor(limitMs = 15000) {
    const started = Date.now();
    while (Date.now() - started < limitMs) {
        if (window.editor?.viewport && window.editor?.inspect) return window.editor;
        await new Promise(r => setTimeout(r, 75));
    }
    throw new Error('SuperSplat Editor API did not become available within 15 seconds.');
}
export async function bootstrap() {
    if (document.getElementById('spm-toolbar')) return;
    const editor = await waitForEditor();
    const manager = new PluginManager({ editor });
    const ui = new ManagerUI(manager);
    ui.mount();
    try { await manager.initialize(); }
    catch (e) {
        console.error('Plugin catalog initialization failed', e);
        ui.notify(`Initialization: ${e.message || e}`);
    }
    // Diagnostic handle for local testing, not a supported SuperSplat API.
    window.__superSplatPluginManager = manager;
}
if (typeof window !== 'undefined' && typeof document !== 'undefined') {
    bootstrap().catch(e => console.error('SuperSplat Plugin Manager startup failed:', e));
}
