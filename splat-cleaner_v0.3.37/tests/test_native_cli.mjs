import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {openGeometry} from '../native/scf2-reader.mjs';
import {createService,detect,runProcessor} from '../native/service.mjs';
import {encodeGeometry,detectNativeSplatTransform,runNativeFloaters} from '../native-floaters.mjs';
import {STRIDE,HEADER_BYTES} from '../native-protocol.mjs';
import {fixture} from './fixtures/native-cli-fixture.mjs';
async function wire(f){const bytes=Buffer.from(await (await encodeGeometry(f.columns)).arrayBuffer());const input=path.join(f.root,'geometry.bin');await fs.writeFile(input,bytes);return {bytes,input};}
test('SCF2 reader preserves all columns and rejects corrupt input',async t=>{
 const f=await fixture(t),{bytes,input}=await wire(f);let r=openGeometry(input);try{for(let i=0;i<r.count;i++){const row={};r.getRow(i,row);for(const k of Object.keys(f.columns))assert.equal(row[k],f.columns[k][i]);}}finally{r.close();}
 for(const corrupt of [b=>b.writeUInt32LE(42,HEADER_BYTES+STRIDE-4),b=>b.writeFloatLE(NaN,HEADER_BYTES)]){let b=Buffer.from(bytes);corrupt(b);await fs.writeFile(input,b);r=openGeometry(input);try{assert.throws(()=>r.getRow(0,{}));}finally{r.close();}}
 await fs.writeFile(input,bytes.subarray(0,-1));assert.throws(()=>openGeometry(input),/size/);
});
test('CLI version detection rejects package metadata mismatch',async t=>{const f=await fixture(t);await f.mode('bad-version');await assert.rejects(detect(f.pkg),/version does not match/);});
test('installed CLI subprocess preserves exact IDs and rejects bad results and GPU errors',async t=>{
 const f=await fixture(t),{bytes}=await wire(f);const info=await detect(f.pkg);assert.equal(info.gpu_backend,'vulkan');assert.equal(info.version,'3.11.2');assert.equal(info.commit,'6f64293');assert.match(info.cli,/cli\.mjs$/);
 const run=async mode=>{await f.mode(mode);const dir=await fs.mkdtemp(path.join(f.root,'job-'));const input=path.join(dir,'geometry.bin'),output=path.join(dir,'mask.bin');await fs.writeFile(input,bytes);const promise=runProcessor(['--run',info.cli,input,output,info.version,info.commit]);return {promise,output};};
 const ok=await run('ok');await ok.promise;assert.deepEqual([...await fs.readFile(ok.output)],Array.from({length:28},(_,i)=>i===1?1:0));
 for(const mode of ['sign','rotation','position','opacity','ids-only']){const r=await run(mode);await r.promise;assert.deepEqual([...await fs.readFile(r.output)],[...await fs.readFile(ok.output)]);}
 await assert.rejects(fs.stat(path.join(path.dirname(ok.output),'geometry.bin')),{code:'ENOENT'});
 for(const mode of ['truncated','duplicate','range','missing','empty','loss','error','nonzero','no-output','bad-version']){const r=await run(mode);await assert.rejects(r.promise,/exited with code/);await assert.rejects(fs.stat(r.output),{code:'ENOENT'});}
});
test('loopback service returns binary mask, rejects wrong origin, cleans spool and cancels owned computation',async t=>{
 const f=await fixture(t),spool=path.join(f.root,'spool');await fs.mkdir(spool);const origin='http://127.0.0.1:3013';const s=createService({packageDir:f.pkg,tempRoot:spool,origins:[origin]});await new Promise(r=>s.listen(0,'127.0.0.1',r));t.after(()=>{s.abortJobs();s.closeAllConnections();return new Promise(r=>s.close(r));});
 const port=s.address().port,fetchImpl=(url,opts={})=>fetch(url,{...opts,headers:{...opts.headers,Origin:origin}});
 assert.equal((await fetch(`http://127.0.0.1:${port}/status`)).status,403);
 let info=await detectNativeSplatTransform({port,fetchImpl});const result=await runNativeFloaters(f.columns,info,{fetchImpl});assert.deepEqual([...result.candidate],Array.from({length:28},(_,i)=>i===1?1:0));
 const poll=async fn=>{for(let i=0;i<200;i++){try{if(await fn())return;}catch{}await new Promise(r=>setTimeout(r,20));}throw Error('Condition not reached');};
 await poll(async()=>!(await fs.readdir(spool)).length);await f.mode('slow');info=await detectNativeSplatTransform({port,fetchImpl});const abort=new AbortController();const pending=runNativeFloaters(f.columns,info,{fetchImpl,signal:abort.signal}).then(()=>null,e=>e);let active;await poll(async()=>{active=JSON.parse(await fs.readFile(path.join(f.root,'active.json'),'utf8'));return true;});abort.abort();assert.ok(await pending instanceof Error);await poll(async()=>!(await fs.readdir(spool)).length);assert.throws(()=>process.kill(active.pid,0),/ESRCH/);
});

test('installed CLI smoke worker yields expected synthetic mask',async t=>{
 const f=await fixture(t);await f.mode('smoke');const info=await detect(f.pkg);
 const output=await runProcessor(['--smoke',info.cli]);const line=output.split(/\r?\n/).find(l=>l.startsWith('SMOKE_RESULT '));
 const argv=JSON.parse(output.split(/\r?\n/).find(l=>l.startsWith('[Native Floaters] Original CLI: ')).slice('[Native Floaters] Original CLI: '.length));
 assert.deepEqual(argv.slice(2,4),['-g','0']);
 const result=JSON.parse(line.slice(13));assert.equal(result.count,28);assert.equal(result.candidates,1);assert.equal(result.mask[27],1);
});
test('calculation timeout cancels owned CLI without publishing a mask',async t=>{
 const f=await fixture(t);const {input}=await wire(f);const info=await detect(f.pkg);await f.mode('slow');const output=path.join(f.root,'mask.bin');
 await assert.rejects(runProcessor(['--run',info.cli,input,output,info.version,info.commit],{timeout:1500}),/timed out/);
 await assert.rejects(fs.stat(output),{code:'ENOENT'});const active=JSON.parse(await fs.readFile(path.join(f.root,'active.json'),'utf8'));assert.throws(()=>process.kill(active.pid,0),/ESRCH/);
});

test('explicit adapter 0 and backends propagate exactly to original CLI and backends have distinct identities',async t=>{
 const f=await fixture(t),{bytes}=await wire(f),ids=new Set();
 for(const backend of ['d3d12','vulkan']){
  const info=await detect(f.pkg,undefined,backend);ids.add(info.identity);assert.equal(info.gpu_backend,backend);
  await f.mode('ok',backend);const dir=await fs.mkdtemp(path.join(f.root,'backend-'));const input=path.join(dir,'geometry.bin'),output=path.join(dir,'mask.bin');await fs.writeFile(input,bytes);
  const log=await runProcessor(['--run',info.cli,input,output,info.version,info.commit,backend]);
  const argv=JSON.parse(log.split(/\r?\n/).find(l=>l.startsWith('[Native Floaters] Original CLI: ')).slice('[Native Floaters] Original CLI: '.length));
  assert.deepEqual(argv,[process.execPath,info.cli,'-g','0','--no-tty','--verbose','--memory','--gpu-backend',backend,'input.ply','--filter-floaters=0.05,0.1,0.00392156862745098','retained.ply']);
  assert.deepEqual([...await fs.readFile(output)],Array.from({length:28},(_,i)=>i===1?1:0));
 }
 assert.equal(ids.size,2);
 await assert.rejects(detect(f.pkg,undefined,'--help'),/GPU backend/);
 assert.throws(()=>createService({packageDir:f.pkg,gpuBackend:'--help'}),/GPU backend/);
});

test('Vulkan service rejects identity from explicit D3D12 backend and returns Vulkan metadata',async t=>{
 const f=await fixture(t),spool=path.join(f.root,'spool');await fs.mkdir(spool);await f.mode('ok','vulkan');
 const origin='http://127.0.0.1:3013';const s=createService({packageDir:f.pkg,tempRoot:spool,origins:[origin],gpuBackend:'vulkan'});await new Promise(r=>s.listen(0,'127.0.0.1',r));t.after(()=>{s.abortJobs();s.closeAllConnections();return new Promise(r=>s.close(r));});
 const port=s.address().port,fetchImpl=(url,opts={})=>fetch(url,{...opts,headers:{...opts.headers,Origin:origin}});
 const info=await detectNativeSplatTransform({port,fetchImpl});assert.equal(info.gpu_backend,'vulkan');
 const wrong=await detect(f.pkg,undefined,'d3d12');await assert.rejects(runNativeFloaters(f.columns,{...info,identity:wrong.identity},{fetchImpl}),/changed since preflight/);
 const result=await runNativeFloaters(f.columns,info,{fetchImpl});assert.equal(result.gpu_backend,'vulkan');assert.equal(result.candidate[1],1);assert.deepEqual(await fs.readdir(spool),[]);
 await f.mode('nonzero','vulkan');await assert.rejects(runNativeFloaters(f.columns,info,{fetchImpl}),/exited with code/);assert.deepEqual(await fs.readdir(spool),[]);
});

test('managed settings resolve only the exact installed release and validate backend',async t=>{
 const {readInstalledSettings}=await import('../native/service.mjs');const f=await fixture(t);const root=path.join(f.root,'splat-cleaner_test');await fs.mkdir(root);
 const save=async settings=>fs.writeFile(path.join(f.root,'manifest.json'),JSON.stringify({plugins:[{id:'splat-cleaner',folder:'unrelated',settings:{'floaters-gpu-backend':'d3d12'}},{id:'splat-cleaner',folder:path.basename(root),settings}]}));
 await save({'floaters-gpu-backend':'vulkan'});assert.deepEqual(await readInstalledSettings(root),{folder:path.basename(root),gpuBackend:'vulkan'});
 for(const settings of [{},{'floaters-gpu-backend':''},{'floaters-gpu-backend':'default'}]){await save(settings);assert.equal((await readInstalledSettings(root)).gpuBackend,'vulkan');}
 await save({'floaters-gpu-backend':'d3d12'});assert.equal((await readInstalledSettings(root)).gpuBackend,'d3d12');await save({'floaters-gpu-backend':'--verbose'});await assert.rejects(readInstalledSettings(root),/GPU backend/);
});

test('explicit Vulkan smoke passes adapter 0 and exact backend arguments with fixture',async t=>{
 const f=await fixture(t);await f.mode('smoke','vulkan');const info=await detect(f.pkg,undefined,'vulkan');
 const output=await runProcessor(['--smoke',info.cli,'vulkan']);const line=output.split(/\r?\n/).find(l=>l.startsWith('SMOKE_RESULT '));
 const argv=JSON.parse(output.split(/\r?\n/).find(l=>l.startsWith('[Native Floaters] Original CLI: ')).slice('[Native Floaters] Original CLI: '.length));
 assert.deepEqual(argv.slice(2,4),['-g','0']);
 const result=JSON.parse(line.slice(13));assert.equal(result.count,28);assert.equal(result.candidates,1);assert.equal(result.mask[27],1);
});
