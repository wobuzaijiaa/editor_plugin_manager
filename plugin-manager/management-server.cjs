'use strict';
/** Architecture C: management-only local HTTP server, no Editor static delivery. */
const http=require('node:http');
const path=require('node:path');
const {createManagementRouter,json,verify}=require('./management-core.cjs');
async function createManagementServer({dist,port=3014,host='127.0.0.1',editorOrigin,confirmNative}={}) {
    verify(host==='127.0.0.1','Management backend must bind to 127.0.0.1 only');
    verify(Number.isInteger(port) && (port===0 || port>=1024) && port<=65535,'Invalid port');
    verify(typeof editorOrigin==='string' && editorOrigin.length>0,'--editor-origin required');
    let server;
    const manager=await createManagementRouter({dist,allowedOrigins:[editorOrigin],nativeServices:true,confirmNative,getManagementPort:()=>server?.address()?.port ?? port});
    server=http.createServer((req,res)=>{
        manager.handle(req,res).then(handled=>{
            if(!handled) json(res,404,{error:'Management API only'});
        }).catch(e=>{
            if(res.destroyed)return;
            if(res.headersSent){res.destroy();return;}
            json(res,e.status||500,{error:e.status?e.message:`Plugin service error: ${e.message||e}`,
                ...(e.code === 'PLUGIN_REMOVE_RENAME_FAILED' ? {
                    code:e.code, filesystemCode:e.filesystemCode, attempts:e.attempts,
                    catalogChanged:false
                } : e.code && e.code.startsWith('NATIVE_') || e.code === 'PORT_IN_USE' ? {code:e.code,port:e.port??null} : {})});
        });
    });
    // Defensive fallback for callers closing the HTTP server directly.
    // The CLI shutdown path awaits closeNative() BEFORE closing HTTP.
    server.on('close',()=>{void manager.closeNative()?.catch(e=>console.error('[Native shutdown fallback]',e.message));});
    return {server,closeNative:manager.closeNative,root:manager.root,pluginRoot:manager.pluginRoot,host,port};
}
if (require.main===module) {
    const args=process.argv.slice(2);
    const deployed = path.basename(__dirname)==='runtime' && path.basename(path.dirname(__dirname))==='dist';
    let dist=deployed ? path.resolve(__dirname,'..') : path.resolve(__dirname,'../supersplat/dist'),port=3014,editorOrigin=null;
    for(let i=0;i<args.length;i++) {
        if(args[i]==='--dist' && args[i+1]) dist=path.resolve(args[++i]);
        else if(args[i]==='--port' && args[i+1]) port=Number(args[++i]);
        else if(args[i]==='--editor-origin' && args[i+1]) editorOrigin=args[++i];
        else {process.stderr.write('Usage: node dist/runtime/management-server.cjs [--dist <supersplat/dist>] --port 3014 --editor-origin http://127.0.0.1:3013\n');process.exit(2);}
    }
    if(deployed && dist!==path.resolve(__dirname,'..')){console.error('Distribution must identify the deployed runtime store.');process.exit(2);}
    createManagementServer({dist,port,editorOrigin}).then(({server,root,closeNative})=>{
        let stopping=null;
        const stop=()=>{
            if(stopping)return stopping;
            stopping=(async()=>{
                try{
                    // Keep Manager alive while child services and their listeners close.
                    // Do not close the HTTP listener before native cleanup completes.
                    await closeNative();
                    await new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve()));
                    console.log('[Native shutdown] All tracked native services verified stopped');
                }catch(error){
                    console.error('[Native shutdown] Incomplete:',error.message);
                    process.exitCode=1;
                    // A failed native cleanup cannot be marked as a clean Manager stop.
                    // Close HTTP only after logging the failure; parent exit code propagates.
                    if(server.listening)await new Promise(resolve=>server.close(()=>resolve()));
                }
            })();
            return stopping;
        };
        // The launcher requests an authenticated-by-parent-process graceful
        // shutdown over its private child-process IPC channel. SIGTERM alone is
        // not graceful on Windows. Closing this IPC channel after stop() allows
        // the child to exit with status 0 only after native cleanup has completed.
        process.on('message',message=>{
            if(message?.type !== 'manager-shutdown')return;
            void stop().finally(()=>{if(process.connected)process.disconnect();});
        });
        process.on('disconnect',()=>{void stop();});
        process.on('SIGINT',()=>{void stop();});process.on('SIGTERM',()=>{void stop();});
        server.listen(port,'127.0.0.1',()=>process.stdout.write(`SuperSplat management backend: http://127.0.0.1:${port}/api/plugins/capabilities (dist: ${root})\n`));
    })
        .catch(e=>{process.stderr.write(`Management backend startup failed: ${e.message||e}\n`);process.exitCode=1;});
}
module.exports={createManagementServer};
