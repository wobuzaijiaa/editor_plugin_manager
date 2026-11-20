'use strict';
const {removeFixture,fixtureScope,listen,closeServer,closeBackend,freePort}=require('./fixture-utils.cjs');
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const http=require('node:http');
const {pathToFileURL}=require('node:url');
const {createManagementServer}=require('../management-server.cjs');
const EDITOR_ORIGIN='http://127.0.0.1:3013';
const meta={id:'scene-info',name:'Scene Information',classification:'Utility',version:'0.1.0',
    author:'test',date:'2026-11-05',description:'Scene stats',entry:'./index.js',requires:{editor_api:[],internal_api:[]}};
const pkg={files:[{path:'plugin.json',data_base64:Buffer.from(JSON.stringify(meta)).toString('base64')},
    {path:'index.js',data_base64:Buffer.from('export async function activate(){return {}}').toString('base64')}]};
async function setup(t){
    const temp=await fs.mkdtemp(path.join(os.tmpdir(),'spm-c-'));
    const scope=fixtureScope(t,temp);
    const dist=path.join(temp,'dist');await fs.mkdir(path.join(dist,'plugins'),{recursive:true});
    await fs.writeFile(path.join(dist,'plugins','manifest.json'),JSON.stringify({schema_version:1,plugins:[]}));
    // No index.html: the management backend must not depend on an Editor build.
    const {server,closeNative}=await createManagementServer({dist,port:0,editorOrigin:EDITOR_ORIGIN});
    const stopBackend=()=>closeBackend(server,closeNative);
    scope.defer(stopBackend);
    await listen(server);
    const base=`http://127.0.0.1:${server.address().port}`;
    const req=(url,options={})=>fetch(base+url,options);
    const write=(method,url,value,origin=EDITOR_ORIGIN,extra={})=>req(url,{method,
        headers:{Origin:origin,'Content-Type':'application/json','X-SuperSplat-Plugin-Manager':'1',...extra},
        body:JSON.stringify(value)});
    return {dist,base,req,write,scope,stopBackend};
}
test('C-01 management works without Editor index and exposes no static files',async t=>{
    const x=await setup(t);
    assert.equal((await x.req('/api/plugins/capabilities')).status,200);
    for (const url of ['/', '/index.html', '/index.js', '/custom-editor.js', '/plugins/manifest.json', '/plugins/audit.json']) {
        const r=await x.req(url);assert.equal(r.status,404,url);assert.match(r.headers.get('content-type'),/application\/json/);
    }
});
test('C-02 allowed CORS preflight and API success/error responses',async t=>{
    const x=await setup(t);
    const r=await x.req('/api/plugins/install',{method:'OPTIONS',headers:{
        Origin:EDITOR_ORIGIN,'Access-Control-Request-Method':'POST',
        'Access-Control-Request-Headers':'content-type,x-supersplat-plugin-manager'}});
    assert.equal(r.status,204);
    assert.equal(r.headers.get('access-control-allow-origin'),EDITOR_ORIGIN);
    assert.match(r.headers.get('access-control-allow-headers'),/X-SuperSplat-Plugin-Manager/);
    const bad=await x.write('POST','/api/plugins/install',{files:[]});
    assert.equal(bad.status,400);assert.equal(bad.headers.get('access-control-allow-origin'),EDITOR_ORIGIN);
    const success=await x.write('POST','/api/plugins/install',pkg);
    assert.equal(success.status,201);assert.equal(success.headers.get('access-control-allow-origin'),EDITOR_ORIGIN);
    assert.equal((await (await x.req('/api/plugins',{headers:{Origin:EDITOR_ORIGIN}})).json()).plugins.length,1);
});
test('C-03 reject hostile origins, Origin null, forged Host and non-permitted preflight',async t=>{
    const x=await setup(t);
    assert.equal((await x.write('POST','/api/plugins/install',pkg,'http://evil.example')).status,403);
    assert.equal((await x.write('POST','/api/plugins/install',pkg,'null')).status,403);
    assert.equal((await x.write('POST','/api/plugins/install',pkg,EDITOR_ORIGIN,{'X-SuperSplat-Plugin-Manager':'0'})).status,403);
    assert.equal((await x.req('/api/plugins/install',{method:'OPTIONS',headers:{Origin:EDITOR_ORIGIN,
        'Access-Control-Request-Method':'POST','Access-Control-Request-Headers':'authorization'}})).status,403);
    assert.equal((await x.req('/api/plugins/config',{method:'OPTIONS',headers:{Origin:EDITOR_ORIGIN,
        'Access-Control-Request-Method':'DELETE'}})).status,403);
    assert.equal((await x.req('/api/plugins',{headers:{Origin:'http://evil.example'}})).status,403);
    const forbiddenHost=await new Promise((resolve,reject)=>{
        const r=http.get(x.base+'/api/plugins',{headers:{Host:'evil.example:9999'}},res=>{
            res.resume();res.on('end',()=>resolve(res.statusCode));});r.on('error',reject);});
    assert.equal(forbiddenHost,403);
    assert.equal((await x.req('/api/plugins',{headers:{Origin:EDITOR_ORIGIN}})).status,200);
    assert.equal((await (await x.req('/api/plugins')).json()).plugins.length,0);
});
test('C-04 install, save CAS, remove and fresh replacement preserve v1.11 semantics',async t=>{
    const x=await setup(t);
    assert.equal((await x.write('POST','/api/plugins/install',pkg)).status,201);
    const first=(await (await x.req('/api/plugins')).json());
    const old=first.plugins[0];assert.equal(old.enabled,false);
    assert.equal((await fs.readFile(path.join(x.dist,'plugins',old.folder,'index.js'),'utf8')).includes('activate'),true);
    const desired=structuredClone(first);desired.plugins[0].enabled=true;desired.plugins[0].settings={flag:true};
    assert.equal((await x.write('PUT','/api/plugins/config',{catalog:desired,expected_catalog:first})).status,200);
    assert.equal((await x.write('PUT','/api/plugins/config',{catalog:desired,expected_catalog:first})).status,409);
    assert.equal((await x.write('DELETE','/api/plugins/scene-info',{expected_catalog:desired})).status,200);
    assert.equal((await x.write('POST','/api/plugins/install',pkg)).status,201);
    const replacement=(await (await x.req('/api/plugins')).json()).plugins[0];
    assert.notEqual(replacement.folder,old.folder);
    assert.equal(replacement.enabled,false);assert.deepEqual(replacement.settings,{});
});
test('C-05 reject unsafe packages and preserve manifest',async t=>{
    const x=await setup(t);
    const bad=structuredClone(pkg);bad.files[1].path='../outside.js';
    assert.equal((await x.write('POST','/api/plugins/install',bad)).status,400);
    assert.equal((await (await x.req('/api/plugins')).json()).plugins.length,0);
});
test('C-06 startup requires explicit loopback Editor origin',async t=>{
    const root=await fs.mkdtemp(path.join(os.tmpdir(),'spm-c-config-'));
    t.after(()=>removeFixture(root));
    await fs.mkdir(path.join(root,'plugins'));
    await fs.writeFile(path.join(root,'plugins','manifest.json'),JSON.stringify({schema_version:1,plugins:[]}));
    for (const origin of [undefined,'https://example.com','http://127.0.0.1','http://127.0.0.1:3013/path','http://evil.example:3013']) {
        await assert.rejects(()=>createManagementServer({dist:root,port:0,editorOrigin:origin}),origin||'undefined');
    }
});
test('C-07 browser Manager routes management requests separately from static URLs',async t=>{
    const x=await setup(t);
    const managerFile=path.join(__dirname,'..','custom-editor.js');
    const entry=pathToFileURL(managerFile).href+'?arch-c='+Date.now();
    const oldDocument=globalThis.document,oldFetch=globalThis.fetch;
    const called=[];
    globalThis.document={baseURI:'file:///',querySelectorAll:()=>[{getAttribute:key=>key==='src'?entry:
        key==='data-management-origin'?x.base:null}]};
    globalThis.fetch=async (url,opts)=>{called.push({url:String(url),opts});return {ok:true,status:200,
        headers:{get:()=> 'application/json'},json:async()=>({api_version:1,local_only:true})};};
    try {
        const manager=await import(entry);
        assert.equal((await manager.localPluginApi.capabilities()).api_version,1);
        assert.equal(called[0].url,x.base+'/api/plugins/capabilities');
        assert.match(manager.pluginUrl('scene-info_20261107T105500000Z','./index.js'),/\/plugins\/scene-info_/);
        assert.doesNotMatch(manager.pluginUrl('scene-info_20261107T105500000Z','./index.js'),/api\/plugins/);
    } finally {if(oldDocument===undefined)delete globalThis.document;else globalThis.document=oldDocument;
        globalThis.fetch=oldFetch;}
});
test('C-08 independent static file delivery survives shutdown of management backend (synthetic)',async t=>{
    const x=await setup(t);
    assert.equal((await x.write('POST','/api/plugins/install',pkg)).status,201);
    const catalog=JSON.parse(await fs.readFile(path.join(x.dist,'plugins','manifest.json'),'utf8'));
    const folder=catalog.plugins[0].folder;
    // This fixture simulates file-only static serving, NOT the original SuperSplat serve package.
    const staticServer=http.createServer(async (req,res)=>{
        const permitted=new Map([['/plugins/manifest.json',path.join(x.dist,'plugins','manifest.json')],
            [`/plugins/${folder}/index.js`,path.join(x.dist,'plugins',folder,'index.js')]]);
        const file=permitted.get(req.url);
        if(!file){res.writeHead(404);res.end();return;}
        res.writeHead(200,{'Content-Type':file.endsWith('.js')?'text/javascript':'application/json',
            'Cache-Control':'no-store'});res.end(await fs.readFile(file));
    });
    x.scope.defer(()=>closeServer(staticServer));
    await listen(staticServer);
    const staticBase=`http://127.0.0.1:${staticServer.address().port}`;
    await x.stopBackend();
    await assert.rejects(()=>fetch(x.base+'/api/plugins/capabilities'));
    assert.equal((await (await fetch(staticBase+'/plugins/manifest.json')).json()).plugins.length,1);
    const module=await fetch(staticBase+`/plugins/${folder}/index.js`);
    assert.equal(module.status,200);assert.match(await module.text(),/activate/);
});
