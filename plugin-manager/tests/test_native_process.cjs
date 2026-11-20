'use strict';
const {removeFixture,fixtureScope,listen,closeServer,closeBackend,freePort}=require('./fixture-utils.cjs');
const {test}=require('node:test');const assert=require('node:assert/strict');
const fs=require('node:fs/promises');const path=require('node:path');const os=require('node:os');
const http=require('node:http');const {spawn,spawnSync}=require('node:child_process');
const {createManagementServer}=require('../management-server.cjs');const {authorize}=require('../native-process.cjs');
const origin='http://127.0.0.1:4321';
// Windows may briefly retain directory handles after file deletion. Retry only
// test-owned temporary tree cleanup; exhausted retries still fail the test.
const meta=id=>({id,name:id,classification:'Test',version:'1.0.0',author:'test',date:'2026-11-17',description:'Generic native fixture',entry:'./index.js',native_service:{entry:'./native/service.mjs'}});
const pack=files=>({files:Object.entries(files).map(([path,data])=>({path,data_base64:Buffer.from(data).toString('base64')}))});
function fixture(port,mode){return `import http from 'node:http';import {execFileSync} from 'node:child_process';import fs from 'node:fs';
const origin=process.argv[3];const server=http.createServer((req,res)=>{if(req.headers.origin!==origin){res.writeHead(403);res.end();return;}res.end(JSON.stringify({pid:process.pid,value:${mode==='tool'?"execFileSync(process.execPath,['-e','process.stdout.write(String(6*7))'],{encoding:'utf8'})":"'hello'"}}));});
const stop=()=>server.close(()=>{if(process.connected)process.disconnect();});process.on('disconnect',stop);process.on('message',m=>{if(m?.type==='native-stop')stop();});server.on('error',()=>{process.exitCode=1;if(process.connected)process.disconnect();});server.listen(${port},'127.0.0.1',()=>process.send({type:'native-ready'}));`;}
async function setup(t,confirmNative=async()=>false){const temp=await fs.mkdtemp(path.join(os.tmpdir(),'spm-native-'));const scope=fixtureScope(t,temp);const dist=path.join(temp,'dist');await fs.mkdir(path.join(dist,'plugins'),{recursive:true});await fs.writeFile(path.join(dist,'plugins','manifest.json'),JSON.stringify({schema_version:1,plugins:[]}));const b=await createManagementServer({dist,port:0,editorOrigin:origin,confirmNative});scope.defer(()=>closeBackend(b.server,b.closeNative));await listen(b.server);const base='http://127.0.0.1:'+b.server.address().port+'/api/plugins/';

 const write=(suffix,data,method='POST',over={})=>fetch(base+suffix,{method,headers:{Origin:origin,'Content-Type':'application/json','X-SuperSplat-Plugin-Manager':'1',...over},body:JSON.stringify(data)});
 const install=async(id,code)=>{const r=await write('install',pack({'plugin.json':JSON.stringify(meta(id)),'index.js':'export function activate(){return {open(){},deactivate(){}}}','native/service.mjs':code}));assert.equal(r.status,201,await r.clone().text());return (await r.json()).plugin;};
 const call=(rec,action,body={folder:rec.folder},headers)=>write(`native/${rec.id}/${action}`,body,'POST',headers);
 return {dist,b,base,write,install,call};}
const request=(port)=>fetch(`http://127.0.0.1:${port}/`,{headers:{Origin:origin}});
test('N-01: two independently installed native services, cold startup, approval, duplicate request, tool execution, removal and shutdown',async t=>{
 const x=await setup(t),p1=await freePort(),p2=await freePort(),a=await x.install('hello-native',fixture(p1,'hello')),b=await x.install('tool-native',fixture(p2,'tool'));
 assert.equal((await (await fetch(x.base+'capabilities')).json()).native_service,1);
 await assert.rejects(request(p1));await assert.rejects(request(p2));
 const pre=await fetch(x.base+'native/hello-native/start',{method:'OPTIONS',headers:{Origin:origin,'Access-Control-Request-Method':'POST','Access-Control-Request-Headers':'content-type,x-supersplat-plugin-manager'}});assert.equal(pre.status,204);
 assert.equal((await x.call(a,'start')).status,403);await authorize(x.dist,a.id);await authorize(x.dist,b.id);
 assert.equal((await x.call(a,'start',{folder:a.folder,command:'anything'})).status,409);
 assert.equal((await x.call(a,'start',undefined,{Origin:'http://untrusted.example'})).status,403);
 assert.equal((await x.call(a,'start',undefined,{'X-SuperSplat-Plugin-Manager':'0'})).status,403);
 assert.equal((await x.call(a,'start',{folder:b.folder})).status,409);
 const rr=await Promise.all([x.call(a,'start'),x.call(a,'start')]);for(const r of rr){assert.equal(r.status,200,await r.clone().text());assert.equal((await r.json()).state,'running');}
 const first=await(await request(p1)).json();assert.equal(first.value,'hello');
 assert.equal((await x.call(a,'start')).status,200);assert.equal((await(await request(p1)).json()).pid,first.pid);await assert.rejects(request(p2));
 const startB=await x.call(b,'start');assert.equal(startB.status,200,await startB.clone().text());assert.equal((await(await request(p2)).json()).value,'42');
 const cat=await(await fetch(x.base.slice(0,-1))).json();assert.equal((await x.write(a.id,{expected_catalog:cat},'DELETE')).status,200);await assert.rejects(request(p1));assert.equal((await request(p2)).status,200);
 await x.b.closeNative();await assert.rejects(request(p2));
});
test('N-02: release changes invalidate approval; explicit stop and retry; occupied port is not adopted',async t=>{
 const x=await setup(t),p=await freePort(),a=await x.install('change-test',fixture(p,'hello'));await authorize(x.dist,a.id);
 const entry=path.join(x.dist,'plugins',a.folder,'native/service.mjs');await fs.appendFile(entry,'\n// changed\n');assert.equal((await x.call(a,'start')).status,403);await authorize(x.dist,a.id);
 const occupant=http.createServer((_,res)=>res.end('occupied'));await listen(occupant,p);try{assert.notEqual((await x.call(a,'start')).status,200);assert.equal(await(await request(p)).text(),'occupied');}finally{await closeServer(occupant);}
 assert.equal((await x.call(a,'start')).status,200);assert.equal((await x.call(a,'stop')).status,200);await assert.rejects(request(p));assert.equal((await x.call(a,'status').then(r=>r.json())).state,'stopped');
});
test('N-03: native metadata is additive and activation context remains empty for browser-only plugins',async()=>{
 const {validateMetadata,PluginManager}=await import('../custom-editor.js');const native=meta('test-native');const legacy={...native,id:'legacy'};delete legacy.native_service;
 assert.equal(validateMetadata(legacy).native_service,undefined);assert.throws(()=>validateMetadata({...native,native_service:{entry:'./../x.mjs'}}));assert.throws(()=>validateMetadata({...native,native_service:{entry:'./run.bat'}}));
 const calls=[],contexts=[];const rows=[legacy,native].map(m=>({id:m.id,folder:m.id+'_20261117T100000000Z',enabled:false,settings:{}}));
 const manager=new PluginManager({editor:{viewport:{},inspect:{}},catalogReader:async()=>({schema_version:1,plugins:rows}),metadataReader:async(_,id)=>validateMetadata(id===legacy.id?legacy:native),inventoryReader:async()=>null,auditReader:async()=>null,api:{capabilities:async()=>({api_version:1,native_service:1,native_authorization:'interactive-v4'}),native:async(...args)=>{calls.push(args);return {state:'running'};}},importer:async()=>({activate:async ctx=>{contexts.push(ctx);return {open(){},deactivate(){},isRunning(){return false;}};}})});
 await manager.initialize();await manager.activate(legacy.id);await manager.activate(native.id);assert.deepEqual(contexts[0].advanced,{});assert.deepEqual(calls,[]);await contexts[1].advanced.native.start();assert.deepEqual(calls[0],[native.id,rows[1].folder,'start']);await manager.deactivate(native.id);assert.equal(calls[1][2],'stop');
});

test('N-04: forced management process termination disconnects an owned native service', {timeout:20000}, async t=>{
 const temp=await fs.mkdtemp(path.join(os.tmpdir(),'spm-native-force-stop-'));
 const dist=path.join(temp,'dist'),runtime=path.join(dist,'runtime');
 await fs.mkdir(path.join(dist,'plugins'),{recursive:true});await fs.mkdir(runtime);
 await fs.writeFile(path.join(dist,'plugins','manifest.json'),JSON.stringify({schema_version:1,plugins:[]}));
 await fs.writeFile(path.join(runtime,'package.json'),JSON.stringify({private:true,type:'module'}));
 for(const file of ['management-server.cjs','management-core.cjs','custom-editor.js','plugin-compat.cjs','typescript-loader.cjs','native-process.cjs'])await fs.copyFile(path.join(__dirname,'..',file),path.join(runtime,file));
 const managerPort=await freePort(),servicePort=await freePort();
 const base=`http://127.0.0.1:${managerPort}/api/plugins/`;
 const child=spawn(process.execPath,[path.join(runtime,'management-server.cjs'),'--dist',dist,'--port',String(managerPort),'--editor-origin',origin],{stdio:['ignore','pipe','pipe']});
 const exited=new Promise(resolve=>child.once('exit',resolve));
 let servicePid=null;const logs=[];child.stdout.on('data',b=>logs.push(b.toString()));child.stderr.on('data',b=>logs.push(b.toString()));
 t.after(async()=>{if(child.exitCode===null&&child.signalCode===null){child.kill('SIGKILL');await exited;}if(servicePid){try{const r=await request(servicePort);if((await r.json()).pid===servicePid)process.kill(servicePid,'SIGKILL');}catch{}}await removeFixture(temp);});
 let caps;
 for(let i=0;i<100;i++){try{caps=await(await fetch(base+'capabilities')).json();break;}catch{await new Promise(r=>setTimeout(r,30));}}
 assert.equal(caps?.native_service,1,logs.join(''));assert.equal(caps?.native_authorization,'interactive-v4');
 const write=(suffix,data)=>fetch(base+suffix,{method:'POST',headers:{Origin:origin,'Content-Type':'application/json','X-SuperSplat-Plugin-Manager':'1'},body:JSON.stringify(data)});
 const installed=await write('install',pack({'plugin.json':JSON.stringify(meta('stop-fixture')),'index.js':'export function activate(){return {open(){},deactivate(){}}}','native/service.mjs':fixture(servicePort,'hello')}));
 assert.equal(installed.status,201,await installed.clone().text());const rec=(await installed.json()).plugin;
 await authorize(dist,rec.id);
 const started=await write(`native/${rec.id}/start`,{folder:rec.folder});assert.equal(started.status,200,await started.clone().text());
 servicePid=(await(await request(servicePort)).json()).pid;
 assert.notEqual(servicePid,child.pid);
 child.kill('SIGKILL');await exited;
 let stopped=false;for(let i=0;i<100;i++){try{await request(servicePort);}catch{stopped=true;break;}await new Promise(r=>setTimeout(r,50));}
 assert.equal(stopped,true,'Native service must close on parent IPC disconnect');
 servicePid=null;
});

test('N-05: first start prompts locally, cancellation is non-destructive, consent persists and reinstall prompts again',async t=>{
 let allow=false, prompts=0, seen;
 const x=await setup(t,async info=>{prompts++;seen=info;return allow;});
 const port=await freePort(),a=await x.install('interactive-test',fixture(port,'hello'));
 const approvals=path.join(x.dist,'runtime','.supersplat-native-approvals.json');
 assert.equal(prompts,0);assert.equal((await x.call(a,'status')).status,200);assert.equal(prompts,0);
 const canceled=await x.call(a,'start');assert.equal(canceled.status,403);assert.equal((await canceled.json()).code,'NATIVE_AUTH_CANCELLED');
 assert.equal(prompts,1);assert.deepEqual(JSON.parse(await fs.readFile(approvals,'utf8')),{schema_version:2,approvals:[]});await assert.rejects(request(port));
 allow=true;
 const results=await Promise.all([x.call(a,'start'),x.call(a,'start')]);for(const r of results)assert.equal(r.status,200,await r.clone().text());
 assert.equal(prompts,2);assert.equal(seen.record.folder,a.folder);assert.equal(seen.identity.metadata.native_service.entry,'./native/service.mjs');
 const stored=JSON.parse(await fs.readFile(approvals,'utf8'));assert.deepEqual(stored.approvals,[{id:a.id,folder:a.folder,sha256:seen.identity.sha256}]);
 await x.call(a,'stop');assert.equal((await x.call(a,'start')).status,200);assert.equal(prompts,2);
 await x.b.closeNative();await assert.rejects(request(port));
 // Restart a fresh controller against persisted approval; no dialog required.
 const restart=await createManagementServer({dist:x.dist,port:0,editorOrigin:origin,confirmNative:async()=>assert.fail('Unexpected repeat consent')});
 await listen(restart.server,0);
 const base=`http://127.0.0.1:${restart.server.address().port}/api/plugins/`;
 const write=(suffix,data,method='POST')=>fetch(base+suffix,{method,headers:{Origin:origin,'Content-Type':'application/json','X-SuperSplat-Plugin-Manager':'1'},body:JSON.stringify(data)});
 try{
  assert.equal((await write(`native/${a.id}/start`,{folder:a.folder})).status,200);
  const cat=await(await fetch(base.slice(0,-1))).json();assert.equal((await write(a.id,{expected_catalog:cat},'DELETE')).status,200);
 }finally{await closeBackend(restart.server,restart.closeNative);}
 const next=await x.install(a.id,fixture(port,'hello'));assert.notEqual(next.folder,a.folder);
 // New controller for the new installed release.
 const second=await createManagementServer({dist:x.dist,port:0,editorOrigin:origin,confirmNative:async info=>{assert.equal(info.record.folder,next.folder);prompts++;return true;}});
 await listen(second.server,0);
 try{
  const r=await fetch(`http://127.0.0.1:${second.server.address().port}/api/plugins/native/${next.id}/start`,{method:'POST',headers:{Origin:origin,'Content-Type':'application/json','X-SuperSplat-Plugin-Manager':'1'},body:JSON.stringify({folder:next.folder})});assert.equal(r.status,200,await r.clone().text());assert.equal(prompts,3);
 }finally{await closeBackend(second.server,second.closeNative);}
});
test('N-06: package change during consent cannot authorize a different hash',async t=>{
 const x=await setup(t,async ({identity})=>{await fs.appendFile(identity.entry,'\n// modified while dialog open\n');return true;});
 const port=await freePort(),a=await x.install('changed-consent',fixture(port,'hello'));
 const r=await x.call(a,'start');assert.equal(r.status,409,await r.clone().text());
 assert.deepEqual(JSON.parse(await fs.readFile(path.join(x.dist,'runtime','.supersplat-native-approvals.json'),'utf8')),{schema_version:2,approvals:[]});await assert.rejects(request(port));
});
test('N-07: backend shutdown while consent is pending prevents approval and launch',async t=>{
 let entered;const waiting=new Promise(r=>entered=r);
 const x=await setup(t,({signal})=>new Promise(resolve=>{signal.addEventListener('abort',()=>resolve(true),{once:true});entered();}));
 const port=await freePort(),a=await x.install('shutdown-consent',fixture(port,'hello'));
 const pending=x.call(a,'start');await waiting;await x.b.closeNative();assert.equal((await pending).status,503);
 assert.deepEqual(JSON.parse(await fs.readFile(path.join(x.dist,'runtime','.supersplat-native-approvals.json'),'utf8')),{schema_version:2,approvals:[]});await assert.rejects(request(port));
});

test('N-08: browser native API preserves typed authorization cancellation',async()=>{
 const {localPluginApi}=await import('../custom-editor.js');
 const original=global.fetch;
 try{
  global.fetch=async()=>new Response(JSON.stringify({error:'Native execution authorization cancelled.',code:'NATIVE_AUTH_CANCELLED'}),{status:403});
  await assert.rejects(localPluginApi.native('test-native','test-native_20261117T100000000Z','start'),{code:'NATIVE_AUTH_CANCELLED',status:403});
 }finally{global.fetch=original;}
});

test('N-09: stale backend cannot receive a native start through revised browser Manager',async()=>{
 const {validateMetadata,PluginManager}=await import('../custom-editor.js');const m=meta('old-runtime');const rec={id:m.id,folder:m.id+'_20261117T100000000Z',enabled:false,settings:{}};const calls=[];let context;
 const manager=new PluginManager({editor:{viewport:{},inspect:{}},catalogReader:async()=>({schema_version:1,plugins:[rec]}),metadataReader:async()=>validateMetadata(m),inventoryReader:async()=>null,auditReader:async()=>null,api:{capabilities:async()=>({api_version:1,native_service:1}),native:async(...args)=>{calls.push(args);return {state:'stopped'};}},importer:async()=>({activate:async ctx=>{context=ctx;return {open(){},deactivate(){},isRunning(){return false;}};}})});
 await manager.initialize();await manager.activate(m.id);await assert.rejects(()=>context.advanced.native.start(),/does not support interactive native authorization/);assert.deepEqual(calls,[]);await manager.deactivate(m.id);assert.equal(calls[0][2],'stop');
});


test('N-10: local maintenance approval uses only the deployed relative runtime and its own store',async t=>{
 const x=await setup(t),p=await freePort(),rec=await x.install('relative-runtime',fixture(p,'hello'));
 const source=path.dirname(x.dist),runtime=path.join(x.dist,'runtime');
 await fs.mkdir(runtime,{recursive:true});
 for(const file of ['native-process.cjs','custom-editor.js'])await fs.copyFile(path.join(__dirname,'..',file),path.join(runtime,file));
 await fs.writeFile(path.join(runtime,'package.json'),JSON.stringify({private:true,type:'module'}));
 const approvalFile=path.join(runtime,'.supersplat-native-approvals.json');
 const run=(entry,args,cwd=source)=>spawnSync(process.execPath,[entry,...args],{cwd,encoding:'utf8',timeout:10000});
 const cli='./dist/runtime/native-process.cjs';
 const bad=run(cli,['--authorize',rec.id,'--dist','./other/dist']);assert.notEqual(bad.status,0);assert.match(bad.stderr,/does not identify this deployed runtime store/);
 const external=run(path.join(__dirname,'..','native-process.cjs'),['--authorize',rec.id,'--dist',x.dist]);assert.notEqual(external.status,0);assert.match(external.stderr,/Use the deployed controller/);
 assert.deepEqual(JSON.parse(await fs.readFile(approvalFile,'utf8')),{schema_version:2,approvals:[]});
 const ok=run(cli,['--authorize',rec.id]);assert.equal(ok.status,0,ok.stderr);assert.match(ok.stdout,/Authorized native execution/);
 const saved=JSON.parse(await fs.readFile(approvalFile,'utf8'));assert.equal(saved.approvals[0].folder,rec.folder);assert.match(saved.approvals[0].sha256,/^[a-f0-9]{64}$/);
 await assert.rejects(fs.stat(path.join(x.dist,'.supersplat-native-approvals.json')),{code:'ENOENT'});
 const legacy=run(cli,['--authorize',rec.id,'--dist','./dist']);assert.equal(legacy.status,0,legacy.stderr);
 const otherCwd=run('./runtime/native-process.cjs',['--authorize',rec.id],x.dist);assert.equal(otherCwd.status,0,otherCwd.stderr);
 const r=await x.call(rec,'start');assert.equal(r.status,200,await r.clone().text());assert.equal((await r.json()).state,'running');
 assert.equal((await x.call(rec,'stop')).status,200);await assert.rejects(request(p));
});

test('N-11: exact declared native entry and service required; browser-only removal unaffected',async t=>{
 const x=await setup(t,async()=>{assert.fail('Ineligible package must never prompt');});
 const base=meta('browser-only');delete base.native_service;
 const files={'plugin.json':JSON.stringify(base),'index.js':'export function activate(){}','native/service.mjs':'throw Error("not eligible")'};
 const r=await x.write('install',pack(files));assert.equal(r.status,201,await r.clone().text());const rec=(await r.json()).plugin;
 for(const action of ['start','status','stop'])assert.equal((await x.call(rec,action)).status,403);
 const wrong=meta('wrong-entry');wrong.native_service.entry='./other.mjs';
 const invalid=await x.write('install',pack({'plugin.json':JSON.stringify(wrong),'index.js':files['index.js'],'other.mjs':''}));assert.equal(invalid.status,400);
 const missing=await x.write('install',pack({'plugin.json':JSON.stringify(meta('missing-entry')),'index.js':files['index.js']}));assert.equal(missing.status,400);
 const installed=await x.install('removed-entry','');await fs.unlink(path.join(x.dist,'plugins',installed.folder,'native/service.mjs'));
 for(const action of ['start','status','stop'])assert.equal((await x.call(installed,action)).status,403);
 assert.throws(()=>require('../validate-plugin-store.cjs').validateStore(path.join(x.dist,'plugins')), /Missing or unsafe native service/);
 const catalog=await(await fetch(x.base.slice(0,-1))).json();
 const removal=await x.write(rec.id,{expected_catalog:catalog},'DELETE');
 const result=await removal.json();assert.equal(removal.status,200,JSON.stringify(result));
 assert.equal(result.packageDeleted,true,JSON.stringify(result));
 await assert.rejects(fs.stat(path.join(x.dist,'plugins',rec.folder)),{code:'ENOENT'});
 const after=await(await fetch(x.base.slice(0,-1))).json();assert.equal(after.plugins.some(p=>p.id===rec.id),false);
 assert.deepEqual(JSON.parse(await fs.readFile(path.join(x.dist,'runtime','.supersplat-native-approvals.json'),'utf8')),{schema_version:2,approvals:[]});
 assert.deepEqual(JSON.parse(await fs.readFile(path.join(x.dist,'plugins','native-approvals.json'),'utf8')),{schema_version:2,plugins:[]});
});

test('N-12: projection cannot authorize; exact-release approval and removal synchronize both files',async t=>{
 let allowed=false,prompts=0;
 const x=await setup(t,async()=>{prompts++;return allowed;});const port=await freePort();const rec=await x.install('projection-native',fixture(port,'hello'));
 const projection=path.join(x.dist,'plugins','native-approvals.json'),authority=path.join(x.dist,'runtime','.supersplat-native-approvals.json');
 const forged={schema_version:2,plugins:[{id:rec.id,folder:rec.folder,approval_recorded:true}]};await fs.writeFile(projection,JSON.stringify(forged));
 assert.equal((await x.call(rec,'start')).status,403);assert.equal(prompts,1);assert.deepEqual(JSON.parse(await fs.readFile(authority,'utf8')),{schema_version:2,approvals:[]});await assert.rejects(request(port));
 allowed=true;assert.equal((await x.call(rec,'start')).status,200);assert.equal(prompts,2);
 const data=JSON.parse(await fs.readFile(authority,'utf8'));assert.equal(data.approvals[0].folder,rec.folder);assert.match(data.approvals[0].sha256,/^[a-f0-9]{64}$/);
 assert.deepEqual(JSON.parse(await fs.readFile(projection,'utf8')),forged);
 await x.call(rec,'stop');await fs.writeFile(projection,'{}');
 const {createNativeProcesses}=require('../native-process.cjs');const controller=createNativeProcesses({dist:x.dist,editorOrigin:origin});await controller.syncStatus();await controller.close();
 assert.deepEqual(JSON.parse(await fs.readFile(projection,'utf8')),forged);
 const catalog=await(await fetch(x.base.slice(0,-1))).json();assert.equal((await x.write(rec.id,{expected_catalog:catalog},'DELETE')).status,200);
 assert.deepEqual(JSON.parse(await fs.readFile(authority,'utf8')),{schema_version:2,approvals:[]});assert.deepEqual(JSON.parse(await fs.readFile(projection,'utf8')),{schema_version:2,plugins:[]});
});

test('N-13: runtime replacement preserves consent; shutdown works with missing service file',async t=>{
 const x=await setup(t,async()=>{assert.fail('Stored release approval must persist');});const p=await freePort();const rec=await x.install('preserved-native',fixture(p,'hello'));await authorize(x.dist,rec.id);
 const runtime=path.join(x.dist,'runtime'),registry='.supersplat-native-approvals.json',backup=runtime+'-old';
 const bytes=await fs.readFile(path.join(runtime,registry));await fs.rename(runtime,backup);await fs.mkdir(runtime);await fs.copyFile(path.join(backup,registry),path.join(runtime,registry));
 assert.deepEqual(await fs.readFile(path.join(runtime,registry)),bytes);
 assert.equal((await x.call(rec,'start')).status,200);await fs.unlink(path.join(x.dist,'plugins',rec.folder,'native/service.mjs'));
 await x.b.closeNative();await assert.rejects(request(p));
});


test('N-14: stop interrupts pending authorization and queued starts, without waiting for dialog timeout', {timeout:10000}, async t=>{
 let entered;const waiting=new Promise(r=>entered=r);let prompts=0;
 const x=await setup(t,({signal})=>{prompts++;return new Promise(resolve=>{signal.addEventListener('abort',()=>resolve(true),{once:true});entered();});});
 const port=await freePort(),rec=await x.install('cancel-pending',fixture(port,'hello'));
 const pending=x.call(rec,'start');await waiting;
 const state=await(await x.call(rec,'status')).json();assert.equal(state.state,'starting');
 const stale=await x.call(rec,'stop',{folder:'different'});assert.equal(stale.status,409);
 const result=await x.call(rec,'stop');assert.equal(result.status,200,await result.clone().text());assert.equal((await result.json()).state,'stopped');
 const cancelled=await pending;assert.equal(cancelled.status,403);assert.equal((await cancelled.json()).code,'NATIVE_AUTH_CANCELLED');assert.equal(prompts,1);
 await assert.rejects(request(port));assert.deepEqual(JSON.parse(await fs.readFile(path.join(x.dist,'runtime','.supersplat-native-approvals.json'),'utf8')),{schema_version:2,approvals:[]});
 assert.deepEqual(JSON.parse(await fs.readFile(path.join(x.dist,'plugins','native-approvals.json'),'utf8')),{schema_version:2,plugins:[]});
});

test('N-15: disconnected HTTP start cancels local consent and cannot launch', {timeout:10000}, async t=>{
 let entered,aborted;const waiting=new Promise(r=>entered=r),cancelled=new Promise(r=>aborted=r);
 const x=await setup(t,({signal})=>new Promise(resolve=>{signal.addEventListener('abort',()=>{aborted();resolve(true);},{once:true});entered();}));
 const port=await freePort(),rec=await x.install('disconnect-consent',fixture(port,'hello'));
 const controller=new AbortController();
 const pending=fetch(x.base+`native/${rec.id}/start`,{method:'POST',headers:{Origin:origin,'Content-Type':'application/json','X-SuperSplat-Plugin-Manager':'1'},body:JSON.stringify({folder:rec.folder}),signal:controller.signal});
 const rejection=assert.rejects(pending,{name:'AbortError'});await waiting;controller.abort();await rejection;await cancelled;
 assert.equal((await x.call(rec,'stop')).status,200);
 await assert.rejects(request(port));assert.deepEqual(JSON.parse(await fs.readFile(path.join(x.dist,'runtime','.supersplat-native-approvals.json'),'utf8')),{schema_version:2,approvals:[]});
});

test('N-16: browser native start forwards AbortSignal without adding HTTP fields',async()=>{
 const {localPluginApi}=await import('../custom-editor.js');const saved=global.fetch,controller=new AbortController();
 try{global.fetch=async(_url,options)=>{assert.equal(options.signal,controller.signal);assert.deepEqual(JSON.parse(options.body),{folder:'release'});return new Response(JSON.stringify({state:'running'}));};assert.equal((await localPluginApi.native('test','release','start',{signal:controller.signal})).state,'running');}finally{global.fetch=saved;}
});


test('N-17: deployment creates both empty approval files and preserves authority on redeployment',async t=>{
 const temp=await fs.mkdtemp(path.join(os.tmpdir(),'spm-approval-init-'));t.after(()=>removeFixture(temp));
 const dist=path.join(temp,'dist'),runtime=path.join(dist,'runtime'),plugins=path.join(dist,'plugins');
 await fs.mkdir(plugins,{recursive:true});await fs.mkdir(runtime);
 const {initializeApprovalState}=require('../native-process.cjs');
 const authority=path.join(runtime,'.supersplat-native-approvals.json'),projection=path.join(plugins,'native-approvals.json');
 await fs.writeFile(projection,JSON.stringify({schema_version:2,plugins:[{id:'forged',folder:'forged',approval_recorded:true}]}));
 await initializeApprovalState(dist);
 assert.deepEqual(JSON.parse(await fs.readFile(authority,'utf8')),{schema_version:2,approvals:[]});
 assert.deepEqual(JSON.parse(await fs.readFile(projection,'utf8')),{schema_version:2,plugins:[]});
 const approved={id:'example',folder:'example_20261117T100000000Z',sha256:'a'.repeat(64)};
 await fs.writeFile(authority,JSON.stringify({schema_version:1,approvals:[approved]}));const before=await fs.readFile(authority);
 await fs.unlink(projection);await initializeApprovalState(dist);
 assert.notDeepEqual(await fs.readFile(authority),before);assert.equal(JSON.parse(await fs.readFile(authority,'utf8')).schema_version,2);
 assert.deepEqual(JSON.parse(await fs.readFile(projection,'utf8')),{schema_version:2,plugins:[{id:approved.id,folder:approved.folder,approval_recorded:true}]});
 await fs.writeFile(authority,'invalid');await assert.rejects(initializeApprovalState(dist));assert.equal(await fs.readFile(authority,'utf8'),'invalid');
});
