'use strict';
/** Legacy Architecture A: static Editor + shared plugin management API.
 * Preserved for baseline tests and rollback. C uses management-server.cjs.
 */
const http=require('node:http');
const fs=require('node:fs');
const fsp=require('node:fs/promises');
const path=require('node:path');
const {createManagementRouter,safeOrigin,json,verify}=require('./management-core.cjs');
const MIME = {
    '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8', '.wasm': 'application/wasm',
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml',
    '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2',
    '.map': 'application/json; charset=utf-8', '.ply': 'application/octet-stream',
    '.splat': 'application/octet-stream', '.sog': 'application/octet-stream',
    '.spz': 'application/octet-stream', '.txt': 'text/plain; charset=utf-8'
};
async function createPluginServer({dist,port=3011,host='127.0.0.1'}={}) {
    verify(host==='127.0.0.1','Local plugin management must bind to 127.0.0.1 only');
    verify(Number.isInteger(port) && (port===0 || port>=1024) && port<=65535,'Invalid port');
    const manager=await createManagementRouter({dist,requireIndex:true});
    const {root,pluginRoot}=manager;
    async function staticFile(req, res, pathname) {
        let decoded;
        try { decoded = decodeURIComponent(pathname); }
        catch { json(res, 400, {error:'Invalid URL encoding'}); return; }
        if (decoded === '/') decoded = '/index.html';
        const parts = decoded.slice(1).split('/');
        if (!parts.every(s => s && s !== '.' && s !== '..' && !s.includes('\\') && !s.includes('\u0000') && !s.startsWith('.'))) {
            json(res, 403, {error:'Unsafe static path'}); return;
        }
        const target = path.resolve(root, ...parts);
        if (!target.startsWith(root + path.sep)) { json(res, 403, {error:'Unsafe path'}); return; }
        let current = root;
        try {
            for (const part of parts) {
                current = path.join(current,part);
                const st = await fsp.lstat(current);
                if (st.isSymbolicLink()) { json(res,403,{error:'Symlink not served'}); return; }
            }
            const st = await fsp.stat(target);
            if (!st.isFile()) { json(res,404,{error:'File not found'}); return; }
            res.writeHead(200, {'Content-Type':MIME[path.extname(target).toLowerCase()] || 'application/octet-stream',
                'Content-Length':st.size, 'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});
            if (req.method === 'HEAD') res.end(); else fs.createReadStream(target).pipe(res);
        } catch (e) {
            if (e.code === 'ENOENT') json(res,404,{error:'File not found'});
            else throw e;
        }
    }
    async function route(req,res) {
        const listenPort=req.socket.localPort;
        safeOrigin(req,listenPort);
        if (await manager.handle(req,res)) return;
        const pathname=new URL(req.url,`http://localhost:${listenPort}`).pathname;
        if (!['GET','HEAD'].includes(req.method)) return json(res,405,{error:'Read-only static endpoint'});
        return staticFile(req,res,pathname);
    }
    const server=http.createServer((req,res)=>{
        route(req,res).catch(e=>{
            if(res.headersSent){res.destroy();return;}
            json(res,e.status||500,{error:e.status?e.message:`Plugin service error: ${e.message||e}`,
                ...(e.code === 'PLUGIN_REMOVE_RENAME_FAILED' ? {
                    code:e.code, filesystemCode:e.filesystemCode, attempts:e.attempts,
                    catalogChanged:false
                } : {})});
        });
    });
    return {server,root,pluginRoot,port,host};
}
if (require.main === module) {
    const args = process.argv.slice(2);
    let dist = path.resolve(__dirname,'../supersplat/dist');
    let port = 3011;
    for (let i=0;i<args.length;i++) {
        if (args[i]==='--dist') dist=path.resolve(args[++i] || '');
        else if (args[i]==='--port') port=Number(args[++i]);
        else { process.stderr.write('Usage: node plugin-manager/local-server.cjs [--dist <supersplat/dist>] [--port 3011]\n');process.exit(2); }
    }
    createPluginServer({dist,port}).then(({server,root})=>server.listen(port,'127.0.0.1',()=>
        process.stdout.write(`SuperSplat local plugin server: http://127.0.0.1:${port}/ (dist: ${root})\n`)))
        .catch(e=>{process.stderr.write(`Plugin server startup failed: ${e.message||e}\n`);process.exitCode=1;});
}
module.exports={createPluginServer};
