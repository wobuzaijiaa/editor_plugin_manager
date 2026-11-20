'use strict';
const {removeFixture,fixtureScope,listen,closeServer,closeBackend,freePort}=require('./fixture-utils.cjs');
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const net=require('node:net');
const {createManagementServer}=require('../management-server.cjs');
const {initializeApprovalState}=require('../native-process.cjs');
const origin='http://127.0.0.1:4321';
function pluginMeta(id,port){return {id,name:id,classification:'Fixture',version:'1.0.0',author:'test',date:'2026-11-18',description:'Managed loopback native test',entry:'./index.js',native_service:{entry:'./native/service.mjs',port:{required:true,preferred:port}}};}
function service(mode='normal') {return `import net from 'node:net';
const argv=process.argv;const port=Number(argv[argv.indexOf('--port')+1]);
const fail=()=>{if(process.connected)process.send({type:'native-start-error',code:'PORT_IN_USE',port},()=>process.disconnect());};
if(${JSON.stringify(mode)}==='forced-conflict')fail();
else{
 // A generic native port may implement an arbitrary TCP protocol. Manager
 // monitoring must not initiate unsolicited connections to the service.
 const server=net.createServer(socket=>{
   socket.on('error',()=>{});
   if(${JSON.stringify(mode)}==='connection-sensitive')process.exit(72);
   socket.end('owned');
 });
 const stop=()=>server.close(()=>{if(process.connected)process.disconnect();});
 process.on('disconnect',stop);process.on('message',m=>{if(m?.type==='native-stop')stop();});
 server.on('error',e=>{if(e.code==='EADDRINUSE')fail();else process.disconnect();});
 server.listen(port,'127.0.0.1',()=>{if(process.connected)process.send({type:'native-ready',port:${mode==='wrong-port'?'port+1':'port'}});});
}`;}
async function setup(t,confirmNative){
 const home=await fs.mkdtemp(path.join(os.tmpdir(),'spm-managed-port-'));
 const scope=fixtureScope(t,home);
 const dist=path.join(home,'dist'),plugins=path.join(dist,'plugins');
 await fs.mkdir(plugins,{recursive:true});
 await fs.writeFile(path.join(plugins,'manifest.json'),JSON.stringify({schema_version:1,plugins:[]}));
 const b=await createManagementServer({dist,port:0,editorOrigin:origin,confirmNative});
 scope.defer(()=>closeBackend(b.server,b.closeNative));
 await listen(b.server);
 const base=`http://127.0.0.1:${b.server.address().port}/api/plugins/`;
 const write=(url,body,method='POST')=>fetch(base+url,{method,headers:{Origin:origin,'Content-Type':'application/json','X-SuperSplat-Plugin-Manager':'1'},body:JSON.stringify(body)});
 const install=async(id,port,mode='normal')=>{
  const files={'plugin.json':JSON.stringify(pluginMeta(id,port)),'index.js':'export function activate(){}','native/service.mjs':service(mode)};
  const r=await write('install',{files:Object.entries(files).map(([filepath,data])=>({path:filepath,data_base64:Buffer.from(data).toString('base64')}))});
  assert.equal(r.status,201,await r.clone().text());return (await r.json()).plugin;
 };
 const call=async(rec,action)=>{const r=await write(`native/${rec.id}/${action}`,{folder:rec.folder});return {status:r.status,body:await r.json()};};
 const registry=async()=>JSON.parse(await fs.readFile(path.join(dist,'runtime','.supersplat-native-approvals.json'),'utf8'));
 const projection=async()=>JSON.parse(await fs.readFile(path.join(plugins,'native-approvals.json'),'utf8'));
 return {dist,b,base,install,call,registry,projection,scope};
}
test('PORT-01: schema-v1 migrated without inventing port and port declarations validated',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'spm-v1-port-'));t.after(()=>removeFixture(root));
 const dist=path.join(root,'dist');await fs.mkdir(path.join(dist,'runtime'),{recursive:true});await fs.mkdir(path.join(dist,'plugins'));
 const record={id:'legacy',folder:'legacy_20261118T100000000Z',sha256:'a'.repeat(64)};
 await fs.writeFile(path.join(dist,'runtime','.supersplat-native-approvals.json'),JSON.stringify({schema_version:1,approvals:[record]}));
 await initializeApprovalState(dist);
 assert.deepEqual(await fs.readFile(path.join(dist,'runtime','.supersplat-native-approvals.json'),'utf8').then(JSON.parse),{schema_version:2,approvals:[record]});
 assert.deepEqual(JSON.parse(await fs.readFile(path.join(dist,'runtime','.supersplat-native-approvals.json.schema-v1.backup'),'utf8')),{schema_version:1,approvals:[record]});
 assert.deepEqual(await fs.readFile(path.join(dist,'plugins','native-approvals.json'),'utf8').then(JSON.parse),{schema_version:2,plugins:[{id:record.id,folder:record.folder,approval_recorded:true}]});
 const {validateMetadata}=await import('../custom-editor.js');
 assert.equal(validateMetadata(pluginMeta('managed',3015)).native_service.port.preferred,3015);
 for(const value of [null,0,65536,'3015',3.5]){
  const meta=pluginMeta('invalid',3015);meta.native_service.port.preferred=value;assert.throws(()=>validateMetadata(meta),/port/);
 }
});
test('PORT-02: two plugins cannot claim same approved port even while first is stopped',async t=>{
 const port=await freePort(),other=await freePort();let calls=0;
 const x=await setup(t,async()=>({approved:true,port:++calls===1?port:other}));
 const a=await x.install('native-alpha',port),b=await x.install('native-beta',port);
 let r=await x.call(a,'start');assert.equal(r.status,200,JSON.stringify(r.body));assert.equal(r.body.port,port);
 assert.equal((await x.call(a,'stop')).body.state,'stopped');
 r=await x.call(b,'start');assert.equal(r.status,200,JSON.stringify(r.body));assert.equal(r.body.port,other);
 const assigned=(await x.registry()).approvals;assert.deepEqual(new Set(assigned.map(p=>p.port)),new Set([port,other]));
 assert.equal((await x.projection()).plugins.length,2);
});
test('PORT-03: previously approved port occupied later prompts for a new authorized port',async t=>{
 const original=await freePort(),replacement=await freePort();let prompts=0;
 const x=await setup(t,async()=>({approved:true,port:++prompts===1?original:replacement}));
 const rec=await x.install('native-recovery',original);
 assert.equal((await x.call(rec,'start')).status,200);assert.equal((await x.call(rec,'stop')).status,200);
 const external=net.createServer();await listen(external,original);
 try{
  const r=await x.call(rec,'start');assert.equal(r.status,200,JSON.stringify(r.body));assert.equal(r.body.port,replacement);assert.equal(prompts,2);
  assert.equal((await x.registry()).approvals[0].port,replacement);
  assert.equal((await x.projection()).plugins[0].port,replacement);
 }finally{await closeServer(external);}
});
test('PORT-04: cancelled reassignment preserves last approved port without starting a service',async t=>{
 const original=await freePort(),prompts=[];
 const x=await setup(t,async({reason})=>{prompts.push(reason);return prompts.length===1?{approved:true,port:original}:false;});
 const rec=await x.install('native-cancel',original);
 assert.equal((await x.call(rec,'start')).status,200);assert.equal((await x.call(rec,'stop')).status,200);
 const external=net.createServer();await listen(external,original);
 try{
  const result=await x.call(rec,'start');assert.equal(result.status,403);assert.equal(result.body.code,'NATIVE_AUTH_CANCELLED');
  assert.equal((await x.registry()).approvals[0].port,original);
  assert.equal((await x.projection()).plugins[0].port,original);
  assert.equal((await x.call(rec,'status')).body.state,'stopped');
 }finally{await closeServer(external);}
});
test('PORT-05: incorrect native-ready port is rejected and no approval committed',async t=>{
 const selected=await freePort();const x=await setup(t,async()=>({approved:true,port:selected}));
 const rec=await x.install('native-mismatch',selected,'wrong-port');
 const result=await x.call(rec,'start');assert.equal(result.status,409);assert.equal(result.body.code,'NATIVE_PORT_MISMATCH');
 assert.deepEqual((await x.registry()).approvals,[]);
 assert.equal((await x.call(rec,'status')).body.state,'stopped');
});
test('PORT-06: native bind error retries only with explicit consent and preserves approval on failure',async t=>{
 const port=await freePort();let approvals=0;
 const x=await setup(t,async()=>{approvals++;return {approved:true,port};});
 const rec=await x.install('native-failed-bind',port,'forced-conflict');
 const r=await x.call(rec,'start');assert.equal(r.status,409);assert.equal(r.body.code,'NATIVE_PORT_CONFLICT');
 assert.equal(approvals,5);assert.deepEqual((await x.registry()).approvals,[]);
 assert.equal((await x.call(rec,'status')).body.state,'stopped');
});
test('PORT-07: explicit reassignment stops old listener, commits new port, and release removal clears assignment',async t=>{
 const original=await freePort(),replacement=await freePort();let calls=0;
 const x=await setup(t,async()=>({approved:true,port:++calls===1?original:replacement}));
 const rec=await x.install('native-reassigned',original);
 assert.equal((await x.call(rec,'start')).status,200);
 const switched=await x.call(rec,'reassign');assert.equal(switched.status,200,JSON.stringify(switched.body));assert.equal(switched.body.port,replacement);
 const closed=net.createServer();await listen(closed,original);await closeServer(closed);
 assert.equal((await x.registry()).approvals[0].port,replacement);
 const catalog=await(await fetch(x.base.slice(0,-1))).json();
 const deleted=await fetch(x.base+rec.id,{method:'DELETE',headers:{Origin:origin,'Content-Type':'application/json','X-SuperSplat-Plugin-Manager':'1'},body:JSON.stringify({expected_catalog:catalog})});
 assert.equal(deleted.status,200,await deleted.text());assert.deepEqual((await x.registry()).approvals,[]);
 assert.deepEqual((await x.projection()).plugins,[]);
});
test('PORT-08: concurrent starts serialize pending assignments without duplicate ports',async t=>{
 const original=await freePort(),alternative=await freePort();let secondAttempts=0;
 const x=await setup(t,async({record})=>({approved:true,port:record.id==='native-concurrent-a'?original:++secondAttempts===1?original:alternative}));
 const a=await x.install('native-concurrent-a',original),b=await x.install('native-concurrent-b',original);
 const [r1,r2]=await Promise.all([x.call(a,'start'),x.call(b,'start')]);
 assert.equal(r1.status,200,JSON.stringify(r1.body));assert.equal(r2.status,200,JSON.stringify(r2.body));
 assert.deepEqual(new Set([r1.body.port,r2.body.port]),new Set([original,alternative]));
 assert.equal((await x.registry()).approvals.length,2);
});
test('PORT-09: configured Editor and active Manager ports cannot be assigned',async t=>{
 let attempts=0;
 const x=await setup(t,async()=>({approved:true,port:attempts++%2===0?4321:x.b.server.address().port}));
 const rec=await x.install('native-core-conflict',4321);
 const res=await x.call(rec,'start');assert.equal(res.status,409);assert.equal(res.body.code,'NATIVE_PORT_CONFLICT');
 assert.deepEqual((await x.registry()).approvals,[]);
});

// Listener monitoring is deliberately read-only. Reachability is not PID proof;
// the Manager's child handle and native-ready handshake remain the ownership check.
test('PORT-10: read-only listener inventory reports the actual listening port and verified release',async t=>{
 const port=await freePort();
 const x=await setup(t,async()=>({approved:true,port}));
 const rec=await x.install('native-observed',port);
 let list=await fetch(x.base+'native/listeners').then(r=>r.json());
 assert.deepEqual(list.services,[]);
 const started=await x.call(rec,'start');assert.equal(started.status,200,JSON.stringify(started.body));
 assert.equal(started.body.listener,'listening');
 const status=await x.call(rec,'status');assert.equal(status.body.listener,'listening');
 list=await fetch(x.base+'native/listeners').then(r=>r.json());
 assert.equal(list.services.length,1);assert.equal(list.services[0].id,rec.id);
 assert.equal(list.services[0].port,port);assert.equal(list.services[0].listener,'listening');
 assert.equal(list.services[0].state,'running');assert.ok(list.services[0].pid>0);
 assert.ok(list.events.some(e=>e.id===rec.id&&e.listener==='listening')); 
 const stopped=await x.call(rec,'stop');assert.equal(stopped.status,200,JSON.stringify(stopped.body));
 assert.equal(stopped.body.state,'stopped');assert.equal(stopped.body.listener,'released');
 const portCheck=net.createServer();await listen(portCheck,port);await closeServer(portCheck);
 list=await fetch(x.base+'native/listeners').then(r=>r.json());
 assert.equal(list.services[0].state,'stopped');assert.equal(list.services[0].listener,'released');
 assert.ok(list.events.some(e=>e.id===rec.id&&e.listener==='released')); 
});
// This fixture deliberately leaves a descendant-owned listener behind.
// The descendant binds BEFORE native-ready, so there is no close/rebind gap
// that could falsely satisfy the Manager's port-release inspection on Windows.
function lingeringService(){return `import {spawn} from 'node:child_process';
const argv=process.argv;const port=Number(argv[argv.indexOf('--port')+1]);
const code=[
 "const net=require('node:net');",
 "const port=Number(process.argv[1]);",
 "const srv=net.createServer(c=>{c.on('error',()=>{});c.on('data',data=>{if(data.toString()==='stop')srv.close();c.end();});});",
 "srv.on('error',e=>{if(process.send)process.send({type:'failed',code:e.code});process.exit(1);});",
 "srv.listen(port,'127.0.0.1',()=>{if(process.send)process.send({type:'bound'});});"
].join('\\n');
let ready=false;
const keeper=spawn(process.execPath,['-e',code,String(port)],{
  stdio:['ignore','ignore','ignore','ipc'],windowsHide:true,detached:true
});
keeper.on('message',m=>{
 if(m?.type!=='bound')process.exit(74);
 ready=true;
 // The TCP listener outlives this Manager-owned service intentionally.
 if(keeper.connected)keeper.disconnect();
 keeper.unref();
 if(process.connected)process.send({type:'native-ready',port});
});
keeper.on('error',()=>process.exit(75));
keeper.on('exit',()=>{if(!ready)process.exit(76);});
const stop=()=>{if(process.connected)process.disconnect();process.exit(0);};
process.on('message',m=>{if(m?.type==='native-stop')stop();});
process.on('disconnect',()=>process.exit(0));
`;}
test('PORT-11: descendant/other listener still bound after child exit produces incomplete stop, never port-based killing',async t=>{
 const port=await freePort();
 const x=await setup(t,async()=>({approved:true,port}));
 const plugin=pluginMeta('native-leftover',port);
 const files={'plugin.json':JSON.stringify(plugin),'index.js':'export function activate(){}','native/service.mjs':lingeringService()};
 const r=await x.call.bind(x); // use the same validated installation API
 const resp=await fetch(x.base+'install',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json','X-SuperSplat-Plugin-Manager':'1'},body:JSON.stringify({files:Object.entries(files).map(([filepath,data])=>({path:filepath,data_base64:Buffer.from(data).toString('base64')}))})});
 assert.equal(resp.status,201,await resp.clone().text());const rec=(await resp.json()).plugin;
 x.scope.defer(async()=>{
  // The fixture-created descendant listens for this explicit test-only cleanup message.
  try{await new Promise((resolve,reject)=>{
   const c=net.createConnection({host:'127.0.0.1',port},()=>c.end('stop'));
   c.setTimeout(2000,()=>c.destroy(Error('Fixture keeper shutdown timed out')));
   c.once('close',resolve);c.once('error',reject);
  });}catch{}
 });
 const started=await r(rec,'start');
 assert.equal(started.status,200,JSON.stringify(started.body));
 assert.equal(started.body.listener,'listening','Fixture descendant must bind before native-ready');
 const stopped=await r(rec,'stop');
 assert.equal(stopped.status,409,JSON.stringify(stopped.body));
 assert.equal(stopped.body.code,'NATIVE_PORT_NOT_RELEASED');
 const list=await fetch(x.base+'native/listeners').then(resp=>resp.json());
 assert.equal(list.services[0].state,'stopped');
 assert.equal(list.services[0].listener,'occupied');
 // After the owned child exits, the Manager refuses to terminate a port's unknown listener.
 assert.equal((await r(rec,'stop')).status,409);
 await assert.rejects(()=>x.b.closeNative(),/Native shutdown incomplete/);
 await new Promise((resolve,reject)=>{
  const c=net.createConnection({host:'127.0.0.1',port},()=>c.end('stop'));
   c.setTimeout(2000,()=>c.destroy(Error('Fixture keeper shutdown timed out')));
  c.once('close',resolve);c.once('error',reject);
 });
 let free=false;for(let i=0;i<30;i++){
  const check=net.createServer();try{await new Promise((resolve,reject)=>{check.once('error',reject);check.listen(port,'127.0.0.1',()=>check.close(resolve));});free=true;break;}
  catch{await new Promise(r=>setTimeout(r,80));}
 }
 assert.equal(free,true,'Fixture descendant must release port after explicit cleanup');
 const done=await r(rec,'stop');assert.equal(done.status,200,JSON.stringify(done.body));
 assert.equal(done.body.listener,'released');
 await x.b.closeNative(); // previously failed shutdown can be retried after explicit safe cleanup
});
test('PORT-12: Manager close waits for owned port release and cannot claim shutdown early',async t=>{
 const port=await freePort(),x=await setup(t,async()=>({approved:true,port}));
 const rec=await x.install('native-close-observed',port);
 assert.equal((await x.call(rec,'start')).status,200);
 const result=await x.b.closeNative();assert.equal(result,undefined);
 const check=net.createServer();await listen(check,port);await closeServer(check);
 const status=await x.call(rec,'status');assert.equal(status.body.state,'stopped');assert.equal(status.body.listener,'released');
});

// A native service may not tolerate unexpected TCP connections from a generic
// monitor. The Manager must use native-ready IPC + non-connecting bind checks.
test('PORT-13: listener monitoring does not connect to native application sockets',async t=>{
 const port=await freePort();
 const x=await setup(t,async()=>({approved:true,port}));
 const rec=await x.install('native-sensitive',port,'connection-sensitive');
 const started=await x.call(rec,'start');
 assert.equal(started.status,200,JSON.stringify(started.body));
 for(let i=0;i<3;i++){
  const status=await x.call(rec,'status');
  assert.equal(status.body.state,'running',JSON.stringify(status.body));
  assert.equal(status.body.listener,'listening',JSON.stringify(status.body));
  const inventory=await fetch(x.base+'native/listeners').then(r=>r.json());
  assert.equal(inventory.services[0].listener,'listening');
 }
 const stopped=await x.call(rec,'stop');
 assert.equal(stopped.status,200,JSON.stringify(stopped.body));
 assert.equal(stopped.body.listener,'released');
});
