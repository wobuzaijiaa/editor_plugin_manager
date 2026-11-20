// Optional full cold-start integration against the proposed Manager v1.13 backend.
// Uses an isolated mock system CLI runtime, not the installed GPU runtime.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {fixture} from '../tests/fixtures/native-cli-fixture.mjs';
import {GEOMETRY,PARAMETERS} from '../native-protocol.mjs';
import {runSplatTransformFloaters} from '../floater-adapter.mjs';
import {detectNativeSplatTransform} from '../native-floaters.mjs';
import {computeSelection} from '../core.mjs';
const manager=path.resolve(process.argv[2]||'plugin-manager');
const plugin=fileURLToPath(new URL('../',import.meta.url));
const temp=await fs.mkdtemp(path.join(os.tmpdir(),'native-manager-test-'));const dist=path.join(temp,'dist'),runtime=path.join(dist,'runtime');
const origin='http://127.0.0.1:4327';let backend;
async function freePort(){const s=http.createServer();await new Promise((r,j)=>{s.once('error',j);s.listen(0,'127.0.0.1',r);});const p=s.address().port;await new Promise(r=>s.close(r));return p;}
async function poll(fn){let last;for(let i=0;i<250;i++){try{return await fn();}catch(e){last=e;await new Promise(r=>setTimeout(r,40));}}throw Error('Integration condition not reached',{cause:last});}
try{
    // The test must not communicate with an independently running real service.
    await assert.rejects(fetch('http://127.0.0.1:3015/status',{headers:{Origin:origin}}),'Stop any existing native service before the isolated test.');
    const f=await fixture(null,temp);
    await fs.mkdir(runtime,{recursive:true});await fs.mkdir(path.join(dist,'plugins'));await fs.writeFile(path.join(dist,'plugins','manifest.json'),'{"schema_version":1,"plugins":[]}');
    for(const f of ['management-server.cjs','management-core.cjs','native-process.cjs','plugin-compat.cjs','typescript-loader.cjs','custom-editor.js'])await fs.copyFile(path.join(manager,f),path.join(runtime,f));await fs.writeFile(path.join(runtime,'package.json'),'{"type":"module"}');
    const port=await freePort(),base=`http://127.0.0.1:${port}/api/plugins/`;
    // Test-only local consent provider in the isolated child process. No HTTP or production CLI bypass.
    const harness=`const fs=require('node:fs');const path=require('node:path');const [entry,dist,port,editorOrigin,temp]=process.argv.slice(1);
    require(entry).createManagementServer({dist,port:Number(port),editorOrigin,confirmNative:async({record})=>{
        fs.appendFileSync(path.join(temp,'consent-log'),record.folder+'\\n');
        return fs.existsSync(path.join(temp,'allow-consent')) ? {approved:true,port:Number(fs.readFileSync(path.join(temp,'port-choice'),'utf8'))} : false;
    }}).then(b=>b.server.listen(Number(port),'127.0.0.1')).catch(e=>{console.error(e);process.exitCode=1;});`;
    backend=spawn(process.execPath,['-e',harness,path.join(runtime,'management-server.cjs'),dist,String(port),origin,temp],{stdio:'inherit',env:{...process.env,PATH:temp,NPM_CONFIG_PREFIX:temp}});
    await poll(async()=>{const r=await fetch(base+'capabilities');assert.equal((await r.json()).native_service,1);});
    const files=[];async function walk(dir){for(const f of await fs.readdir(dir,{withFileTypes:true})){const p=path.join(dir,f.name);if(f.isDirectory())await walk(p);else files.push({path:path.relative(plugin,p).split(path.sep).join('/'),data_base64:(await fs.readFile(p)).toString('base64')});}}await walk(plugin);
    const write=(suffix,value)=>fetch(base+suffix,{method:'POST',headers:{Origin:origin,'Content-Type':'application/json','X-SuperSplat-Plugin-Manager':'1'},body:JSON.stringify(value)});
    const install=await write('install',{files});assert.equal(install.status,201,await install.clone().text());const rec=(await install.json()).plugin;
    for(const f of files)assert.equal((await fs.readFile(path.join(dist,'plugins',rec.folder,f.path))).toString('base64'),f.data_base64);
    // Fresh installation: no configuration edits must be necessary to select Vulkan.
    const fresh=JSON.parse(await fs.readFile(path.join(dist,'plugins','manifest.json'),'utf8'));
    assert.equal(fresh.plugins.find(p=>p.folder===rec.folder).settings['floaters-gpu-backend'],undefined);
    await f.mode('ok','vulkan');
    const start=()=>write('native/'+rec.id+'/start',{folder:rec.folder});const denied=await start();assert.equal(denied.status,403);assert.equal((await denied.json()).code,'NATIVE_AUTH_CANCELLED');
    await assert.rejects(fs.stat(path.join(temp,'.supersplat-native-approvals.json')),{code:'ENOENT'});
    await fs.writeFile(path.join(temp,'allow-consent'),'1');
    await fs.writeFile(path.join(temp,'port-choice'),'3015');
    await assert.rejects(fetch('http://127.0.0.1:3015/status',{headers:{Origin:origin}}));
    const fetchImpl=(url,opts={})=>fetch(url,{...opts,headers:{...opts.headers,Origin:origin}});
    const startService=async()=>{const r=await start();if(!r.ok)throw Error(await r.text());return r.json();};
    const stop=async()=>{const r=await write('native/'+rec.id+'/stop',{folder:rec.folder});assert.equal(r.status,200);assert.equal((await r.json()).state,'stopped');};
    const info=await detectNativeSplatTransform({fetchImpl,startService});assert.equal(info.gpu_backend,'vulkan');
    const columns={...Object.fromEntries(GEOMETRY.map(k=>[k,new Float32Array(3)])),x:Float32Array.of(1,2,3),rot_0:Float32Array.of(1,1,1),_cleaner_instance_id:Uint32Array.of(0,1,2)};
    const mask=await runSplatTransformFloaters(columns,PARAMETERS,{info,fetchImpl});assert.deepEqual([...mask],[0,1,0]);
    const selected=computeSelection(columns,{classes:new Uint8Array(3)},{roi:{x:{min:1,max:3},y:{min:0,max:0},z:{min:0,max:0}},density:'all',snsEnabled:true,splatTransformEnabled:true},{snsMask:Uint8Array.of(1,0,0),splatTransformMask:mask});assert.deepEqual([...selected.candidates],[1,1,0]);
    await stop();await assert.rejects(fetch('http://127.0.0.1:3015/status',{headers:{Origin:origin}}));
    // Legacy value saved via the unchanged Manager must also select explicit Vulkan.
    const current=JSON.parse(await fs.readFile(path.join(dist,'plugins','manifest.json'),'utf8'));
    const configured={...current,plugins:current.plugins.map(p=>p.folder===rec.folder?{...p,settings:{...p.settings,'floaters-gpu-backend':'default'}}:p)};
    const saved=await fetch(base+'config',{method:'PUT',headers:{Origin:origin,'Content-Type':'application/json','X-SuperSplat-Plugin-Manager':'1'},body:JSON.stringify({expected_catalog:current,catalog:configured})});
    assert.equal(saved.status,200,await saved.clone().text());
    // Previously approved 3015 becomes occupied after the service stops.
    // Manager must reauthorize a new port without contacting the unrelated listener.
    const custom=await freePort(),manifestPath=path.join(dist,'plugins','manifest.json');
    await fs.writeFile(path.join(temp,'port-choice'),String(custom));
    const occupied=http.createServer((_req,res)=>res.end('unrelated'));
    await new Promise(r=>occupied.listen(3015,'127.0.0.1',r));
    let customInfo;
    try{
        customInfo=await detectNativeSplatTransform({startService,fetchImpl});
        assert.equal(customInfo.port,custom);assert.equal(customInfo.gpu_backend,'vulkan');assert.equal(customInfo.identity,info.identity);
        assert.equal(await (await fetch('http://127.0.0.1:3015')).text(),'unrelated');
        const authority=JSON.parse(await fs.readFile(path.join(runtime,'.supersplat-native-approvals.json'),'utf8'));
        const projection=JSON.parse(await fs.readFile(path.join(dist,'plugins','native-approvals.json'),'utf8'));
        assert.equal(authority.schema_version,2);assert.equal(authority.approvals[0].port,custom);
        assert.equal(projection.schema_version,2);assert.equal(projection.plugins[0].port,custom);
    }finally{await new Promise(r=>occupied.close(r));}
    assert.deepEqual([...(await runSplatTransformFloaters(columns,PARAMETERS,{info:customInfo,fetchImpl}))],[0,1,0]);
    // Wait for the previous job's spool cleanup; the HTTP response precedes finally.
    await poll(async()=>{const r=await fetchImpl(`http://127.0.0.1:${custom}/status`);assert.equal((await r.json()).busy,false);return true;});
    // Keep the service alive across a second request, then interrupt an actual calculation child.
    await f.mode('slow','vulkan');
    const pending=runSplatTransformFloaters(columns,PARAMETERS,{info:customInfo,fetchImpl}).then(()=>null,e=>e);
    const active=await poll(async()=>JSON.parse(await fs.readFile(path.join(temp,'active.json'),'utf8')));
    await stop();assert.ok(await pending instanceof Error);assert.throws(()=>process.kill(active.pid,0),/ESRCH/);
    await assert.rejects(fs.stat(path.dirname(active.input)),/ENOENT/);
    await f.mode('ok');await assert.rejects(fetch(`http://127.0.0.1:${custom}/status`));
    // Backend removal owns the final protection even without browser cleanup.
    await detectNativeSplatTransform({startService,fetchImpl});
    const catalog=JSON.parse(await fs.readFile(manifestPath,'utf8'));
    const removal=await fetch(base+rec.id,{method:'DELETE',headers:{Origin:origin,'Content-Type':'application/json','X-SuperSplat-Plugin-Manager':'1'},body:JSON.stringify({expected_catalog:catalog})});assert.equal(removal.status,200,await removal.clone().text());await assert.rejects(fs.stat(path.join(dist,'plugins',rec.folder)),/ENOENT/);await assert.rejects(fetch(`http://127.0.0.1:${custom}/status`));
    // Reinstall to test parent shutdown independently.
    const reinstall=await write('install',{files});assert.equal(reinstall.status,201);const newRec=(await reinstall.json()).plugin;
    assert.deepEqual((await fs.readFile(path.join(temp,'consent-log'),'utf8')).trim().split('\n'),[rec.folder,rec.folder,rec.folder]);
    const finalInfo=await detectNativeSplatTransform({fetchImpl,startService:async()=>{const r=await write('native/'+rec.id+'/start',{folder:newRec.folder});assert.equal(r.status,200,await r.clone().text());return r.json();}});assert.equal(finalInfo.gpu_backend,'vulkan');assert.equal(finalInfo.identity,info.identity);
    assert.deepEqual((await fs.readFile(path.join(temp,'consent-log'),'utf8')).trim().split('\n'),[rec.folder,rec.folder,rec.folder,newRec.folder]);
    // Force the Manager to exit during a live mock CLI processor job (the Windows Stop contract).
    await fs.unlink(path.join(temp,'active.json'));await f.mode('slow');
    const finalPending=runSplatTransformFloaters(columns,PARAMETERS,{info:finalInfo,fetchImpl}).then(()=>null,e=>e);
    const finalActive=await poll(async()=>JSON.parse(await fs.readFile(path.join(temp,'active.json'),'utf8')));
    const closed=new Promise(r=>backend.once('close',r));backend.kill('SIGKILL');await closed;backend=null;
    await poll(async()=>{await assert.rejects(fetch(`http://127.0.0.1:${finalInfo.port}/status`,{headers:{Origin:origin}}));assert.throws(()=>process.kill(finalActive.pid,0),/ESRCH/);await assert.rejects(fs.stat(path.dirname(finalActive.input)),/ENOENT/);});
    assert.ok(await finalPending instanceof Error);
    console.log('PASS: fresh install selects explicit Vulkan / legacy default resolves to Vulkan / reinstall selects Vulkan; consistent effective backend identities; deployed Manager → simulated local consent (cancel / allow / reinstall) → approved installed native service → mock CLI processor → exact mask → existing SNS OR selection; default/custom ports, occupied port, active calculation cancellation, temporary-file cleanup, removal and forced parent shutdown during active calculation confirmed.');
}finally{if(backend&&backend.exitCode===null&&backend.signalCode===null){const closed=new Promise(r=>backend.once('close',r));backend.kill();await closed;}await fs.rm(temp,{recursive:true,force:true,maxRetries:4,retryDelay:100});}
