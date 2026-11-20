'use strict';
/** Shared v1.11 plugin store, lifecycle management HTTP contract and validation.
 * Architecture A and C use this ONE implementation of install/save/remove.
 * Static Editor delivery deliberately belongs to local-server.cjs only.
 */
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const {pathToFileURL} = require('node:url');

const MAX_FILES = 100;
const MAX_PACKAGE_BYTES = 50 * 1024 * 1024;
const MAX_REQUEST_BYTES = 70 * 1024 * 1024;
const ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const FOLDER_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*_\d{8}T\d{9}Z$/;
const ALLOWED_HOSTS = new Set(['localhost', '127.0.0.1']);
function verify(ok, message, status = 400) {
    if (!ok) { const err = new Error(message); err.status = status; throw err; }
}
function safeRelative(s) {
    verify(typeof s === 'string' && s.length > 0 && s.length <= 1024 && !s.includes('\\') &&
        !s.startsWith('/') && !s.includes('\u0000') && !s.includes(':') && !s.includes('?') && !s.includes('#'), 'Unsafe file path');
    const parts = s.split('/');
    verify(parts.length <= 9 && parts.every(x => x.length > 0 && x.length <= 128 && x !== '.' && x !== '..' &&
        !x.startsWith('.') && !/[\u0000-\u001f]/.test(x)), 'Unsafe file path segment');
    return parts;
}
function catalogEqual(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
function json(res, status, data) {
    const bytes = Buffer.from(JSON.stringify(data));
    res.writeHead(status, {'Content-Type':'application/json; charset=utf-8', 'Content-Length':bytes.length,
        'Cache-Control':'no-store', 'X-Content-Type-Options':'nosniff'});
    res.end(bytes);
}
async function bodyJson(req) {
    const len = Number(req.headers['content-length']);
    if (Number.isFinite(len)) verify(len <= MAX_REQUEST_BYTES, 'Request too large', 413);
    const chunks = []; let size = 0;
    for await (const chunk of req) {
        size += chunk.length;
        verify(size <= MAX_REQUEST_BYTES, 'Request too large', 413);
        chunks.push(chunk);
    }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { throw Object.assign(new Error('Invalid JSON request'), {status:400}); }
}
function safeOrigin(req, port, allowedOrigins = null) {
    const host = req.headers.host || '';
    const [hostname, hostPort] = host.split(':');
    verify(ALLOWED_HOSTS.has(hostname) && Number(hostPort || 80) === port, 'Invalid Host header', 403);
    const origin = req.headers.origin;
    if (origin !== undefined) {
        verify(allowedOrigins ? allowedOrigins.includes(origin) :
            (origin === `http://localhost:${port}` || origin === `http://127.0.0.1:${port}`),
            'Cross-origin plugin management is prohibited', 403);
    }
}
function checkWriteRequest(req, port, allowedOrigins) {
    safeOrigin(req, port, allowedOrigins);
    verify(req.headers['x-supersplat-plugin-manager'] === '1', 'Missing plugin management request header', 403);
    verify(typeof req.headers.origin === 'string', 'Browser Origin header required for write operations', 403);
    const type = String(req.headers['content-type'] || '');
    if (req.method !== 'DELETE') verify(type.startsWith('application/json'), 'Expected JSON request', 415);
}
async function existingCatalog(pluginRoot, validateCatalog) {
    const raw = JSON.parse(await fsp.readFile(path.join(pluginRoot,'manifest.json'),'utf8'));
    return validateCatalog(raw);
}
async function atomicCatalog(pluginRoot, catalog) {
    const target = path.join(pluginRoot, 'manifest.json');
    const tmp = path.join(pluginRoot, `.spm-manifest-${crypto.randomUUID()}.tmp`);
    try {
        await fsp.writeFile(tmp, JSON.stringify(catalog, null, 2) + '\n', {flag:'wx'});
        // Node rename replaces the destination file; failure leaves the old manifest intact.
        await fsp.rename(tmp, target);
    } finally { await fsp.rm(tmp, {force:true}).catch(() => {}); }
}
async function safeFolder(root, name) {
    verify(FOLDER_RE.test(name), 'Invalid plugin release folder');
    const dir = path.join(root, name);
    const stat = await fsp.lstat(dir);
    verify(stat.isDirectory() && !stat.isSymbolicLink(), 'Plugin folder is not a normal directory');
    return dir;
}
function getUploadedFiles(raw) {
    verify(Array.isArray(raw?.files) && raw.files.length >= 2 && raw.files.length <= MAX_FILES,
        `Plugin package must contain 2–${MAX_FILES} files`);
    let total = 0; const names = new Set(); const files = [];
    for (const f of raw.files) {
        const parts = safeRelative(f?.path);
        const name = parts.join('/');
        verify(!names.has(name), `Duplicate package file: ${name}`); names.add(name);
        verify(typeof f.data_base64 === 'string' && f.data_base64.length <= MAX_PACKAGE_BYTES * 4 / 3 + 8 &&
            /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(f.data_base64),
            `Invalid encoded file: ${name}`);
        const data = Buffer.from(f.data_base64, 'base64');
        total += data.length;
        verify(total <= MAX_PACKAGE_BYTES, 'Plugin package exceeds 50 MB', 413);
        files.push({name, parts, data});
    }
    verify(names.has('plugin.json'), 'Plugin package missing plugin.json');
    return {files, names};
}
function stamp() { return new Date().toISOString().replace(/[-:.]/g,''); }
// Stage package removal with a bounded retry for transient Windows directory locks.
// This step precedes any catalog change; a failed rename leaves the installed
// release and the manifest untouched. Do not fall back to recursive deletion.
const RENAME_RETRY_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);
async function stagePackageRemoval(original, trash, {
    rename = (source, destination) => fsp.rename(source, destination),
    sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
    retryDelays = [100, 250, 500]
} = {}) {
    let failure;
    let attempts = 0;
    for (let attempt = 1; attempt <= retryDelays.length + 1; attempt++) {
        attempts = attempt;
        try {
            await rename(original, trash);
            return {attempts: attempt};
        } catch (e) {
            failure = e;
            if (!RENAME_RETRY_CODES.has(e?.code) || attempt > retryDelays.length) break;
            await sleep(retryDelays[attempt - 1]);
        }
    }
    const code = failure?.code || 'UNKNOWN';
    const error = new Error(`Cannot stage plugin removal: directory rename failed (${code}, ${attempts} attempt(s)). ` +
        'Installed package and manifest remain unchanged. Check folder locks, permissions, or filesystem restrictions, then retry.');
    error.status = code === 'EPERM' || code === 'EACCES' || code === 'EBUSY' ? 409 : 500;
    error.code = 'PLUGIN_REMOVE_RENAME_FAILED';
    error.filesystemCode = code;
    error.attempts = attempts;
    error.catalogChanged = false;
    error.cause = failure;
    throw error;
}
// On some Windows volumes a populated directory cannot be renamed even when
// individual entries can be removed. The catalog is the authoritative list of
// installed packages: if staging is denied after its bounded retries, first
// unpublish the release, then attempt direct deletion. Do NOT roll the catalog
// back if deletion has started: it may have removed only some of the files.
// This is a different consistency strategy, not an assertion about why EPERM
// occurred. Never attempt it on non-permission errors or when catalog save fails.
async function removePackageTransaction(pluginRoot, original, trash, nextCatalog, {
    stage = stagePackageRemoval,
    saveCatalog = atomicCatalog,
    remove = (folder, options) => fsp.rm(folder, options),
    restore = (from, to) => fsp.rename(from, to)
} = {}) {
    let staged = false;
    try {
        await stage(original, trash);
        staged = true;
    } catch (e) {
        if (e?.code !== 'PLUGIN_REMOVE_RENAME_FAILED' || !RENAME_RETRY_CODES.has(e.filesystemCode)) throw e;
        console.warn(`[Plugin Manager] rename staging refused (${e.filesystemCode}); ` +
            `unpublishing ${path.basename(original)} before direct deletion.`);
    }
    if (!staged) {
        // A failed save leaves all package files and the catalog unchanged.
        await saveCatalog(pluginRoot, nextCatalog);
        try {
            await remove(original, {recursive:true, force:false});
            return {status:'Removed', packageDeleted:true, method:'catalog-first'};
        } catch (e) {
            // A partially removed directory must NEVER be reactivated by
            // restoring its old manifest entry. Keep the unlisted remainder
            // available for explicit inspection/cleanup outside the API.
            const code = e?.code || 'UNKNOWN';
            console.warn(`[Plugin Manager] ${path.basename(original)} removed from catalog, ` +
                `but directory deletion failed (${code}). Residual files may remain.`);
            return {status:'Removed', packageDeleted:false, method:'catalog-first',
                warning:`Plugin unregistered, but deletion failed (${code}); residual files may remain in ` +
                    `${path.basename(original)}. Stop services and inspect the directory before manual cleanup.`};
        }
    }
    let committed = false;
    try {
        await saveCatalog(pluginRoot, nextCatalog);
        committed = true;
        try {
            await remove(trash, {recursive:true, force:true});
            return {status:'Removed', packageDeleted:true, method:'staged'};
        } catch (e) {
            console.warn(`[Plugin Manager] stale staged package: ${path.basename(trash)} (${e.code || 'UNKNOWN'}).`);
            return {status:'Removed', packageDeleted:false, method:'staged',
                warning:`Plugin unregistered, but temporary directory ${path.basename(trash)} ` +
                    `could not be deleted (${e.code || 'UNKNOWN'}).`};
        }
    } catch (e) {
        if (!committed) {
            try { await restore(trash, original); }
            catch (rollback) {
                throw new Error(`Plugin removal rollback failed; package retained in ${path.basename(trash)}: ` +
                    `${rollback.message}. Original error: ${e.message}`);
            }
        }
        throw e;
    }
}

function capSnapshot() { return {api_version:1, install:true, save:true, remove:true,
    store:'dist/plugins', local_only:true}; }

async function createManagementRouter({dist, requireIndex = false, allowedOrigins = null, nativeServices = false, confirmNative, getManagementPort = () => null} = {}) {
    const root = path.resolve(dist || path.join(__dirname,'..','supersplat','dist'));
    const rootStat = await fsp.stat(root);
    verify(rootStat.isDirectory(), 'Built distribution missing');
    if (requireIndex) await fsp.access(path.join(root, 'index.html'));
    const pluginRoot = path.join(root,'plugins');
    await fsp.access(path.join(pluginRoot,'manifest.json'));
    // Reuse the same metadata and manifest validators as the browser manager.
    const { validateCatalog, validateMetadata } = await import(pathToFileURL(path.join(__dirname,'custom-editor.js')).href);
    function validatedMetadata(raw, id) {
        try { return validateMetadata(raw,id); }
        catch (e) {e.status=400;throw e;}
    }
    // The API catalog is development evidence, not a prerequisite for the server.
    let currentInventory = null;
    try {
        const value = JSON.parse(await fsp.readFile(path.join(pluginRoot,'editor-api.json'),'utf8'));
        verify(value.schema_version === 1 && Array.isArray(value.available_methods) &&
            /^[0-9a-f]{40}$/i.test(value.commit || ''), 'Invalid API inventory');
        currentInventory = value;
    } catch (e) { console.warn('Plugin API inventory unavailable; compatibility will be not assessed:', e.message); }
    let ts = null;
    try { ts = require('./typescript-loader.cjs').typeScriptFrom(path.dirname(root)); }
    catch (e) { console.warn('Plugin syntax/import screening unavailable (advisory):', e.message); }
    let packageAudit = null;
    try { ({packageAudit} = require('./plugin-compat.cjs')); }
    catch (e) { console.warn('Plugin compatibility screening unavailable (advisory):', e.message); }
    // Even a broken optional auditor must not disable secure package installation.
    function screen(files, meta) {
        try {
            if (packageAudit) return packageAudit(files,meta,currentInventory,ts);
        } catch (e) { console.warn('Plugin compatibility screening failed (advisory):', e.message); }
        return {schema_version:1,status:'NOT_ASSESSED',editor_commit:currentInventory?.commit || null,
            package_sha256:null,notices:['Optional compatibility screening unavailable; no API compatibility conclusion.'],
            assurance:'NOT_ASSESSED_NO_RUNTIME_OR_SECURITY_CERTIFICATION'};
    }
    // Existing releases are not silently reassessed on server startup.
    // Install audits the new package; optional full-build reports remain independent.
    let pending = Promise.resolve();
    function serialized(action) {
        const next = pending.then(action,action);
        pending = next.catch(() => {});
        return next;
    }
    // Only the backend accepts explicitly configured cross-origin browser traffic.
    if (allowedOrigins !== null) {
        verify(Array.isArray(allowedOrigins) && allowedOrigins.length > 0 &&
            allowedOrigins.every(origin => {
                try {
                    const u = new URL(origin);
                    return u.protocol === 'http:' && ['127.0.0.1','localhost'].includes(u.hostname) &&
                        u.port !== '' && u.origin === origin && !u.username && !u.password;
                } catch { return false; }
            }), 'Explicit loopback Editor origin required');
    }
    const native = nativeServices ? require('./native-process.cjs').createNativeProcesses({dist:root,editorOrigin:allowedOrigins[0],confirmNative,getManagementPort}) : null;
    if (native) await native.syncStatus();
    const nativeRoute = /^\/api\/plugins\/native\/([a-z0-9]+(?:-[a-z0-9]+)*)\/(start|status|stop|reassign)$/;
    // A stop must interrupt an in-flight or queued start before entering the
    // existing write queue. The queue still owns all filesystem mutations.
    const pendingNativeStarts = new Map();
    const cancelled = () => Object.assign(Error('Native execution authorization or startup cancelled.'),{status:403,code:'NATIVE_AUTH_CANCELLED'});
    const endpointMethods = pathname => native && nativeRoute.test(pathname) ? ['POST'] : pathname === '/api/plugins/capabilities' || pathname === '/api/plugins' || (native && pathname === '/api/plugins/native/listeners') ? ['GET'] :
        pathname === '/api/plugins/install' ? ['POST'] :
        pathname === '/api/plugins/config' ? ['PUT'] :
        /^\/api\/plugins\/[a-z0-9]+(?:-[a-z0-9]+)*$/.test(pathname) ? ['DELETE'] : [];
    async function handle(req, res) {
        const listenPort = req.socket.localPort;
        safeOrigin(req, listenPort, allowedOrigins);
        const pathname = new URL(req.url, `http://localhost:${listenPort}`).pathname;
        if (allowedOrigins !== null && req.headers.origin) {
            res.setHeader('Access-Control-Allow-Origin', req.headers.origin);
            res.setHeader('Vary', 'Origin');
        }
        if (pathname !== '/api/plugins' && !pathname.startsWith('/api/plugins/')) return false;
        if (req.method === 'OPTIONS' && allowedOrigins !== null) {
            verify(typeof req.headers.origin === 'string', 'Browser Origin required', 403);
            const method = req.headers['access-control-request-method'];
            verify(endpointMethods(pathname).includes(method), 'Preflight method not permitted', 403);
            const headers = String(req.headers['access-control-request-headers'] || '').toLowerCase()
                .split(',').map(v => v.trim()).filter(Boolean);
            verify(headers.every(v => ['content-type','x-supersplat-plugin-manager'].includes(v)),
                'Preflight header not permitted', 403);
            res.writeHead(204, {'Access-Control-Allow-Methods':endpointMethods(pathname).join(', '),
                'Access-Control-Allow-Headers':'Content-Type, X-SuperSplat-Plugin-Manager',
                'Access-Control-Max-Age':'600', 'Cache-Control':'no-store'});
            res.end();
            return true;
        }
            if (req.method === 'GET' && pathname === '/api/plugins/capabilities') { json(res,200,{...capSnapshot(),...(native ? {native_service:1,native_authorization:native.authorizationMode} : {})}); return true; }
            if (req.method === 'GET' && pathname === '/api/plugins') { json(res,200,await existingCatalog(pluginRoot,validateCatalog)); return true; }
            if (native && req.method === 'GET' && pathname === '/api/plugins/native/listeners') { json(res,200,await native.listenerSummary()); return true; }
            if (!['POST','PUT','DELETE'].includes(req.method)) { json(res,405,{error:'Method not allowed'}); return true; }
            checkWriteRequest(req,listenPort,allowedOrigins);
            const nativeMatch = native && nativeRoute.exec(pathname);
            if (req.method === 'POST' && nativeMatch) {
                const [,id,action]=nativeMatch;
                const payload=await bodyJson(req);
                async function record(){
                    const current=await existingCatalog(pluginRoot,validateCatalog);
                    const rec=current.plugins.find(p=>p.id===id);
                    verify(rec,`Plugin ${id} not found`,404);
                    verify(payload && Object.keys(payload).length===1 && payload.folder===rec.folder,'Native service release mismatch or unexpected request fields',409);
                    return rec;
                }
                const first=await record();
                const key=first.folder;
                if(action==='status'){await native.eligible(first);const state=await native.status(first);if(state.state==='stopped'&&pendingNativeStarts.get(key)?.size)state.state='starting';json(res,200,state);return true;}
                if(action==='stop'){
                    await native.eligible(first);
                    for(const controller of pendingNativeStarts.get(key)||[])controller.abort(cancelled());
                    await serialized(async()=>{const rec=await record();await native.eligible(rec);json(res,200,await native.stop(rec));});
                    return true;
                }
                const controller=new AbortController();
                const pending=pendingNativeStarts.get(key)||new Set();pending.add(controller);pendingNativeStarts.set(key,pending);
                const disconnected=()=>{if(!res.writableEnded)controller.abort(cancelled());};
                res.on('close',disconnected);if(res.destroyed)disconnected();
                try{await serialized(async()=>{const rec=await record();const result=await (action==='reassign'?native.reassign(rec,{signal:controller.signal}):native.start(rec,{signal:controller.signal}));if(!res.destroyed)json(res,200,result);});}
                finally{res.off('close',disconnected);pending.delete(controller);if(!pending.size)pendingNativeStarts.delete(key);}
                return true;
            }
            await serialized(async () => {
                const current = await existingCatalog(pluginRoot,validateCatalog);
                if (req.method === 'POST' && pathname === '/api/plugins/install') {
                    const payload = await bodyJson(req);
                    verify(payload && typeof payload === 'object', 'Invalid plugin installation request');
                    const {files,names} = getUploadedFiles(payload);
                    let rawMeta;
                    try { rawMeta = JSON.parse(files.find(f=>f.name==='plugin.json').data.toString('utf8')); }
                    catch { throw new Error('Invalid plugin.json'); }
                    const meta = validatedMetadata(rawMeta);
                    verify(names.has(meta.entry.slice(2)), 'Plugin entry file is missing from package');
                    if (meta.native_service) verify(names.has(meta.native_service.entry.slice(2)), 'Native service entry file is missing from package');
                    verify(!names.has('audit.json'), 'audit.json is reserved for server-generated compatibility evidence');
                    const compatibility = screen(files,meta);
                    // API/import compatibility is advisory at installation; the package is
                    // retained with audit.json. Static findings never block activation.
                    verify(!current.plugins.some(p=>p.id===meta.id), `Plugin ${meta.id} is already installed`,409);
                    // Timestamp collision is a conflict, never an overwrite.
                    const folder = `${meta.id}_${stamp()}`;
                    const finalDir = path.join(pluginRoot,folder);
                    verify(!fs.existsSync(finalDir), 'Plugin release folder already exists',409);
                    const tempName = `.spm-stage-${crypto.randomUUID()}`;
                    const tempDir = path.join(pluginRoot,tempName);
                    await fsp.mkdir(tempDir,{recursive:false});
                    let moved = false, committed = false;
                    try {
                        for (const f of files) {
                            const dest = path.join(tempDir,...f.parts);
                            await fsp.mkdir(path.dirname(dest),{recursive:true});
                            await fsp.writeFile(dest,f.data,{flag:'wx'});
                        }
                        await fsp.writeFile(path.join(tempDir,'audit.json'),JSON.stringify(compatibility,null,2)+'\n',{flag:'wx'});
                        await fsp.rename(tempDir,finalDir); moved = true;
                        const next = validateCatalog({schema_version:1, plugins:[...current.plugins,
                            {id:meta.id,folder,enabled:false,settings:{}}]});
                        await atomicCatalog(pluginRoot,next); committed = true;
                        return json(res,201,{status:'Installed',plugin:next.plugins.at(-1),metadata:meta,compatibility});
                    } catch (e) {
                        if (!committed) await fsp.rm(moved?finalDir:tempDir,{recursive:true,force:true}).catch(()=>{});
                        throw e;
                    }
                }
                if (req.method === 'PUT' && pathname === '/api/plugins/config') {
                    const payload = await bodyJson(req);
                    const baseline = validateCatalog(payload?.expected_catalog);
                    verify(catalogEqual(current, baseline), 'Plugin catalog changed; refresh before saving',409);
                    const next = validateCatalog(payload?.catalog);
                    verify(next.plugins.length === current.plugins.length && next.plugins.every((p,i)=>
                        p.id===current.plugins[i].id && p.folder===current.plugins[i].folder),
                        'Configuration cannot install, remove, or change plugin folders');
                    // Legacy startup_approval fields are tolerated for backward
                    // compatibility but do not authorize or block execution.
                    await atomicCatalog(pluginRoot,next);
                    return json(res,200,{status:'Saved',catalog:next});
                }
                const match = /^\/api\/plugins\/([a-z0-9]+(?:-[a-z0-9]+)*)$/.exec(pathname);
                if (req.method === 'DELETE' && match) {
                    const id=match[1];
                    const payload=await bodyJson(req);
                    const baseline=validateCatalog(payload?.expected_catalog);
                    verify(catalogEqual(current,baseline),'Plugin catalog changed; refresh before removal',409);
                    const rec=current.plugins.find(p=>p.id===id);
                    verify(rec,`Plugin ${id} not found`,404);
                    if (native) { await native.stop(rec); await native.revoke(rec); }
                    const original=await safeFolder(pluginRoot,rec.folder);
                    const trash=path.join(pluginRoot,`.spm-trash-${crypto.randomUUID()}`);
                    const next=validateCatalog({schema_version:1,plugins:current.plugins.filter(p=>p.id!==id)});
                    return json(res,200,await removePackageTransaction(pluginRoot,original,trash,next));
                }
                return json(res,404,{error:'Unknown plugin-management endpoint'});
            });
        return true;
    }
    return {handle, root, pluginRoot, closeNative:()=>native?.close()};
}
module.exports = {createManagementRouter, safeOrigin, json, verify, stagePackageRemoval, removePackageTransaction};
