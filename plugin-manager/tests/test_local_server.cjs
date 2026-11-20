'use strict';
const {removeFixture,fixtureScope,listen,closeServer,closeBackend,freePort}=require('./fixture-utils.cjs');
const {test} = require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {createPluginServer}=require('../local-server.cjs');
const meta={id:'scene-info',name:'Scene Information',classification:'Utility',version:'0.1.0',
    author:'repo@gjt',date:'2026-11-05',description:'Scene stats',entry:'./index.js',requires:{editor_api:['inspect.scene'],internal_api:[]}};
async function setup(t,{withInventory=true}={}){
 const temp=await fs.mkdtemp(path.join(os.tmpdir(),'spm-http-'));
 const scope=fixtureScope(t,temp);
 const dist=path.join(temp,'dist');await fs.mkdir(path.join(dist,'plugins'),{recursive:true});
 await fs.writeFile(path.join(dist,'index.html'),'<html>Editor fixture</html>');
 await fs.writeFile(path.join(dist,'plugins','manifest.json'),JSON.stringify({schema_version:1,plugins:[]}));
 if(withInventory) await fs.writeFile(path.join(dist,'plugins','editor-api.json'),JSON.stringify({schema_version:1,
   commit:'4069712370df3425c386610f28a814403e835543',available_methods:['inspect.scene']}));
 const {server}=await createPluginServer({dist,port:0});
 scope.defer(()=>closeServer(server));
 const port=await listen(server);
 const base=`http://127.0.0.1:${port}`;
 const get=async url=>fetch(base+url);
 const write=async(method,url,payload,extraHeaders={})=>fetch(base+url,{method,
  headers:{Origin:base,'Content-Type':'application/json','X-SuperSplat-Plugin-Manager':'1',...extraHeaders},
  body:JSON.stringify(payload)});
 const pkg={files:[{path:'plugin.json',data_base64:Buffer.from(JSON.stringify(meta)).toString('base64')},
  {path:'index.js',data_base64:Buffer.from('export async function activate(){return {open(){},deactivate(){}}}').toString('base64')}]};
 return {base,dist,get,write,pkg};
}
test('HTTP-01 static Editor, manifest and capabilities served on one origin',async t=>{
 const x=await setup(t);
 assert.equal((await (await x.get('/')).text()).includes('Editor fixture'),true);
 const c=await (await x.get('/api/plugins/capabilities')).json();
 assert.equal(c.api_version,1);assert.equal(c.local_only,true);
 assert.equal(c.reassess,undefined);assert.equal(c.reinstall,undefined);
 assert.equal((await (await x.get('/plugins/manifest.json')).json()).plugins.length,0);
});
test('HTTP-02 installs selected package and serves metadata/module',async t=>{
 const x=await setup(t);
 const res=await x.write('POST','/api/plugins/install',x.pkg);
 assert.equal(res.status,201,await res.text().catch(()=>''));
 // Response has been consumed above only when assertion fails.
 const cat=await (await x.get('/api/plugins')).json();
 assert.equal(cat.plugins.length,1);
 const folder=cat.plugins[0].folder;
 assert.equal((await (await x.get(`/plugins/${folder}/plugin.json`)).json()).name,meta.name);
 const mod=await x.get(`/plugins/${folder}/index.js`);
 assert.equal(mod.status,200);assert.match(mod.headers.get('content-type'),/text\/javascript/);
});
test('HTTP-03 Save persists enabled state, rejects stale update',async t=>{
 const x=await setup(t);
 await x.write('POST','/api/plugins/install',x.pkg);
 const current=await (await x.get('/api/plugins')).json();
 const next=structuredClone(current);next.plugins[0].enabled=true;
 const res=await x.write('PUT','/api/plugins/config',{catalog:next,expected_catalog:current});
 assert.equal(res.status,200);
 assert.equal((await (await x.get('/api/plugins')).json()).plugins[0].enabled,true);
 const stale=await x.write('PUT','/api/plugins/config',{catalog:next,expected_catalog:current});
 assert.equal(stale.status,409);
});
test('HTTP-04 delete removes plugin and updates manifest',async t=>{
 const x=await setup(t);await x.write('POST','/api/plugins/install',x.pkg);
 const c=await (await x.get('/api/plugins')).json();
 const res=await x.write('DELETE','/api/plugins/scene-info',{expected_catalog:c});
 assert.equal(res.status,200);
 assert.equal((await (await x.get('/api/plugins')).json()).plugins.length,0);
 assert.equal((await x.get(`/plugins/${c.plugins[0].folder}/index.js`)).status,404);
});
test('HTTP-05 blocks unsanctioned origin and forged path',async t=>{
 const x=await setup(t);
 const noHeader=await x.write('POST','/api/plugins/install',x.pkg,{'X-SuperSplat-Plugin-Manager':'0'});
 assert.equal(noHeader.status,403);
 const hostile=await x.write('POST','/api/plugins/install',x.pkg,{Origin:'https://attacker.example'});
 assert.equal(hostile.status,403);
 const evil=structuredClone(x.pkg);evil.files[1].path='../evil.js';
 assert.equal((await x.write('POST','/api/plugins/install',evil)).status,400);
 assert.equal((await x.get('/.git/config')).status,403);
});
test('HTTP-06 rejects duplicate installation, bad entry and unsafe metadata',async t=>{
 const x=await setup(t);
 assert.equal((await x.write('POST','/api/plugins/install',x.pkg)).status,201);
 assert.equal((await x.write('POST','/api/plugins/install',x.pkg)).status,409);
 const c=await (await x.get('/api/plugins')).json();assert.equal(c.plugins.length,1);
 const bad=structuredClone(x.pkg);
 bad.files[0].data_base64=Buffer.from(JSON.stringify({...meta,entry:'./nonexistent.js'})).toString('base64');
 assert.equal((await x.write('POST','/api/plugins/install',bad)).status,400);
});

test('HTTP-07 missing Editor API installs with INCOMPATIBLE report, no activation',async t=>{
 const x=await setup(t);const bad=structuredClone(x.pkg);
 const m={...meta,requires:{editor_api:['inspect.notPresent'],internal_api:[]}};
 bad.files[0].data_base64=Buffer.from(JSON.stringify(m)).toString('base64');
 const res=await x.write('POST','/api/plugins/install',bad);
 assert.equal(res.status,201,await res.text().catch(()=>''));
 const cat=await (await x.get('/api/plugins')).json();
 assert.equal(cat.plugins.length,1); assert.equal(cat.plugins[0].enabled,false);
 const audit=await (await x.get(`/plugins/${cat.plugins[0].folder}/audit.json`)).json();
 assert.equal(audit.status,'INCOMPATIBLE');
 assert.deepEqual(audit.missing_editor_api,['inspect.notPresent']);
});
test('HTTP-08 broken local import is retained with incompatible audit',async t=>{
 const x=await setup(t);const bad=structuredClone(x.pkg);
 bad.files[1].data_base64=Buffer.from("import './missing.js'; export async function activate() {}").toString('base64');
 const res=await x.write('POST','/api/plugins/install',bad);
 assert.equal(res.status,201);
 const cat=await (await x.get('/api/plugins')).json();
 const audit=await (await x.get(`/plugins/${cat.plugins[0].folder}/audit.json`)).json();
 assert.equal(audit.status,'INCOMPATIBLE');
 assert.ok(audit.missing_imports.some(x=>x.includes('./missing.js')));
});
test('HTTP-09 internal API package is installed with REVIEW_REQUIRED audit',async t=>{
 const x=await setup(t);const custom=structuredClone(x.pkg);
 const m={...meta,requires:{editor_api:['inspect.scene'],internal_api:['window.scene']}};
 custom.files[0].data_base64=Buffer.from(JSON.stringify(m)).toString('base64');
 const res=await x.write('POST','/api/plugins/install',custom);
 assert.equal(res.status,201,await res.text().catch(()=>''));
 const cat=await (await x.get('/api/plugins')).json();
 const audit=await (await x.get(`/plugins/${cat.plugins[0].folder}/audit.json`)).json();
 assert.equal(audit.status,'REVIEW_REQUIRED');
});

test('HTTP-10 a package without Editor API declaration installs as NOT_ASSESSED',async t=>{
 const x=await setup(t);const legacy=structuredClone(x.pkg);
 const m={...meta};delete m.requires;
 legacy.files[0].data_base64=Buffer.from(JSON.stringify(m)).toString('base64');
 const res=await x.write('POST','/api/plugins/install',legacy);assert.equal(res.status,201);
 const cat=await (await x.get('/api/plugins')).json();
 const audit=await (await x.get(`/plugins/${cat.plugins[0].folder}/audit.json`)).json();
 assert.equal(audit.status,'NOT_ASSESSED');
 assert.equal(audit.evaluation.declared_requirements,false);
});

test('HTTP-11 removed reassess and reinstall endpoints cannot mutate packages',async t=>{
 const x=await setup(t);await x.write('POST','/api/plugins/install',x.pkg);
 const before=await (await x.get('/api/plugins')).json();const rec=before.plugins[0];
 const moduleBefore=await (await x.get(`/plugins/${rec.folder}/index.js`)).text();
 const a=await x.write('POST','/api/plugins/scene-info/reassess',{expected_catalog:before});
 const b=await x.write('PUT','/api/plugins/scene-info/package',{...x.pkg,expected_catalog:before});
 assert.equal(a.status,404);assert.equal(b.status,404);
 assert.deepEqual(await (await x.get('/api/plugins')).json(),before);
 assert.equal(await (await x.get(`/plugins/${rec.folder}/index.js`)).text(),moduleBefore);
});


test('HTTP-12 Remove then Install uses a new release, discards Startup and settings',async t=>{
 const x=await setup(t);await x.write('POST','/api/plugins/install',x.pkg);
 const original=await (await x.get('/api/plugins')).json();
 const changed=structuredClone(original);changed.plugins[0].enabled=true;changed.plugins[0].settings={flag:true};
 assert.equal((await x.write('PUT','/api/plugins/config',{catalog:changed,expected_catalog:original})).status,200);
 assert.equal((await x.write('DELETE','/api/plugins/scene-info',{expected_catalog:changed})).status,200);
 const updated=structuredClone(x.pkg);
 updated.files[0].data_base64=Buffer.from(JSON.stringify({...meta,version:'0.2.0'})).toString('base64');
 const res=await x.write('POST','/api/plugins/install',updated);assert.equal(res.status,201);
 const fresh=(await (await x.get('/api/plugins')).json()).plugins[0];
 assert.notEqual(fresh.folder,original.plugins[0].folder);
 assert.equal(fresh.enabled,false);assert.deepEqual(fresh.settings,{});
 assert.equal((await (await x.get(`/plugins/${fresh.folder}/plugin.json`)).json()).version,'0.2.0');
});


test('HTTP-13 invalid new package and duplicates never corrupt installed registration',async t=>{
 const x=await setup(t);await x.write('POST','/api/plugins/install',x.pkg);
 const before=await (await x.get('/api/plugins')).json();
 const prior=await (await x.get(`/plugins/${before.plugins[0].folder}/index.js`)).text();
 const invalid=structuredClone(x.pkg);invalid.files[1].path='../outside.js';
 assert.equal((await x.write('POST','/api/plugins/install',invalid)).status,400);
 assert.equal((await x.write('POST','/api/plugins/install',x.pkg)).status,409);
 assert.deepEqual(await (await x.get('/api/plugins')).json(),before);
 assert.equal(await (await x.get(`/plugins/${before.plugins[0].folder}/index.js`)).text(),prior);
});


test('HTTP-14 newly installed package receives current advisory audit evidence',async t=>{
 const x=await setup(t);const legacy=structuredClone(x.pkg);const old={...meta};delete old.requires;
 legacy.files[0].data_base64=Buffer.from(JSON.stringify(old)).toString('base64');
 assert.equal((await x.write('POST','/api/plugins/install',legacy)).status,201);
 const rec=(await (await x.get('/api/plugins')).json()).plugins[0];
 const report=await (await x.get(`/plugins/${rec.folder}/audit.json`)).json();
 assert.equal(report.status,'NOT_ASSESSED');
 assert.equal((await x.write('DELETE','/api/plugins/scene-info',{expected_catalog:{schema_version:1,plugins:[rec]}})).status,200);
 assert.equal((await x.write('POST','/api/plugins/install',x.pkg)).status,201);
 const fresh=(await (await x.get('/api/plugins')).json()).plugins[0];
 const current=await (await x.get(`/plugins/${fresh.folder}/audit.json`)).json();
 assert.equal(current.status,'STATIC_COMPATIBLE');
});


test('HTTP-15 Remove completely discards legacy Startup approval and config',async t=>{
 const x=await setup(t);await x.write('POST','/api/plugins/install',x.pkg);
 const before=await (await x.get('/api/plugins')).json();
 const next=structuredClone(before);next.plugins[0].enabled=true;
 next.plugins[0].startup_approval={package_sha256:'a'.repeat(64),editor_commit:'4069712370df3425c386610f28a814403e835543'};
 assert.equal((await x.write('PUT','/api/plugins/config',{catalog:next,expected_catalog:before})).status,200);
 assert.equal((await x.write('DELETE','/api/plugins/scene-info',{expected_catalog:next})).status,200);
 assert.equal((await x.write('POST','/api/plugins/install',x.pkg)).status,201);
 const newRec=(await (await x.get('/api/plugins')).json()).plugins[0];
 assert.equal(newRec.enabled,false);assert.equal(newRec.startup_approval,undefined);
 assert.deepEqual(newRec.settings,{});
});


test('HTTP-16 missing API inventory is advisory; installation still works',async t=>{
 const x=await setup(t,{withInventory:false});
 const res=await x.write('POST','/api/plugins/install',x.pkg);
 assert.equal(res.status,201);
 const catalog=await (await x.get('/api/plugins')).json();
 assert.equal(catalog.plugins.length,1);
 const report=await (await x.get(`/plugins/${catalog.plugins[0].folder}/audit.json`)).json();
 assert.equal(report.status,'NOT_ASSESSED');
 assert.equal(report.evaluation.public_api,'NOT_ASSESSED');
});

test('HTTP-18 optional audit modules can be absent without disabling safe installation',async t=>{
 const isolated=await fs.mkdtemp(path.join(os.tmpdir(),'spm-no-auditor-'));
 const scope=fixtureScope(t,isolated);
 for(const name of ['local-server.cjs','management-core.cjs','custom-editor.js']) {
  await fs.copyFile(path.join(__dirname,'..',name),path.join(isolated,name));
 }
 const dist=path.join(isolated,'dist');
 await fs.mkdir(path.join(dist,'plugins'),{recursive:true});
 await fs.writeFile(path.join(dist,'index.html'),'<html>Editor fixture</html>');
 await fs.writeFile(path.join(dist,'plugins','manifest.json'),JSON.stringify({schema_version:1,plugins:[]}));
 const {createPluginServer: isolatedServer}=require(path.join(isolated,'local-server.cjs'));
 const {server}=await isolatedServer({dist,port:0});
 scope.defer(()=>closeServer(server));
 await listen(server);
 const base=`http://127.0.0.1:${server.address().port}`;
 const post=files=>fetch(base+'/api/plugins/install',{
  method:'POST',headers:{Origin:base,'Content-Type':'application/json','X-SuperSplat-Plugin-Manager':'1'},
  body:JSON.stringify({files})});
 const files=[{path:'plugin.json',data_base64:Buffer.from(JSON.stringify(meta)).toString('base64')},
  {path:'index.js',data_base64:Buffer.from('export async function activate(){return {open(){},deactivate(){}}}').toString('base64')}];
 const unsafe=[files[0],{...files[1],path:'../escape.js'}];
 assert.equal((await post(unsafe)).status,400,'package safety must remain mandatory');
 const installed=await post(files);
 assert.equal(installed.status,201,await installed.text().catch(()=>'failure'));
 const catalog=await (await fetch(base+'/api/plugins')).json();
 assert.equal(catalog.plugins.length,1);
 const audit=await (await fetch(base+`/plugins/${catalog.plugins[0].folder}/audit.json`)).json();
 assert.equal(audit.status,'NOT_ASSESSED');
 assert.match(audit.notices.join(' '),/screening unavailable/);
});
