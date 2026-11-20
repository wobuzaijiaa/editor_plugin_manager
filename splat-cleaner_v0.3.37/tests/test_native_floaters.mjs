import test from 'node:test';
import assert from 'node:assert/strict';
import {detectNativeSplatTransform,encodeGeometry,runNativeFloaters} from '../native-floaters.mjs';
import {runSplatTransformFloaters} from '../floater-adapter.mjs';
import {GEOMETRY,MAX_ROWS,PARAMETERS,PROTOCOL,STRIDE,HEADER_BYTES,geometryByteLength} from '../native-protocol.mjs';
const info={gpu_backend:'vulkan',protocol:PROTOCOL,available:true,version:'3.11.2',commit:'6f64293',maxRows:MAX_ROWS,identity:'a'.repeat(64)};
const mock=data=>async()=>new Response(JSON.stringify(data));
const cols=()=>({...Object.fromEntries(GEOMETRY.map(k=>[k,Float32Array.of(0,0,0)])),x:Float32Array.of(1,2,3),y:Float32Array.of(-2,-3,-4),z:Float32Array.of(3,4,5),rot_0:Float32Array.of(1,1,1),_cleaner_instance_id:Uint32Array.of(0,1,2)});
function reply(mask,headers={}){const b=Uint8Array.from(mask);return new Response(b,{headers:{'content-type':'application/octet-stream','content-length':String(b.byteLength),'X-Splat-Identity':info.identity,'X-Splat-Protocol':String(PROTOCOL),'X-Splat-Elapsed-Ms':'10','X-Splat-Instance-Count':'3','X-Splat-Candidate-Count':String(mask.reduce((s,v)=>s+v,0)),...headers}});}
test('native detection reports service absence and CLI absence',async()=>{await assert.rejects(detectNativeSplatTransform({fetchImpl:async()=>{throw Error('offline');}}),/service unavailable/);await assert.rejects(detectNativeSplatTransform({fetchImpl:mock({protocol:PROTOCOL,available:false,error:'not installed'})}),/not installed/);});
test('native detection checks protocol, version, capacity, busy and accepts warning',async()=>{for(const changed of [{protocol:1},{version:''},{maxRows:42},{busy:true},{identity:'bad'}])await assert.rejects(detectNativeSplatTransform({fetchImpl:mock({...info,...changed})}));assert.deepEqual(await detectNativeSplatTransform({fetchImpl:mock(info)}),{...info,endpoint:'http://127.0.0.1:3015'});assert.equal((await detectNativeSplatTransform({fetchImpl:mock({...info,version:'4.0.0',warning:'unvalidated'})})).warning,'unvalidated');});
test('wire preserves world geometry, exact IDs and opacity; no PLY conversion in browser',async()=>{const c=cols();c.opacity[0]=Infinity;const blob=await encodeGeometry(c);assert.equal(blob.size,geometryByteLength(3));const buf=await blob.arrayBuffer();assert.equal(new TextDecoder().decode(buf.slice(0,4)),'SCF2');assert.equal(new DataView(buf).getUint32(4,true),3);const b=new DataView(buf,HEADER_BYTES);assert.equal(b.getFloat32(0,true),1);assert.equal(b.getFloat32(4,true),-2);assert.equal(b.getFloat32(8,true),3);assert.equal(b.getFloat32(12,true),1);assert.equal(b.getFloat32(40,true),Infinity);assert.equal(b.getUint32(2*STRIDE+STRIDE-4,true),2);assert.throws(()=>geometryByteLength(MAX_ROWS+1),/exact ID/);assert.equal(c.x[0],1);});
test('native client returns service mask, correct wire headers and metadata',async()=>{const result=await runNativeFloaters(cols(),info,{fetchImpl:async(url,opts)=>{assert.match(url,/\/analyze$/);assert.equal(opts.headers['X-Splat-Identity'],info.identity);assert.ok(opts.body instanceof Blob);return reply([0,1,0]);}});assert.deepEqual([...result.candidate],[0,1,0]);assert.deepEqual(result.parameters,PARAMETERS);assert.equal(result.runtime_version,'3.11.2');});
test('bad masks, version drift and count mismatches fail closed',async()=>{for(const response of [reply([0,2,0]),reply([0,1]),reply([0,1,0],{'X-Splat-Identity':'b'}),reply([0,1,0],{'content-length':'4'}),reply([0,1,0],{'X-Splat-Candidate-Count':'2'}),reply([0,1,0],{'X-Splat-Instance-Count':'4'}),reply([0,1,0],{'X-Splat-Protocol':'1'}),new Response(JSON.stringify({error:'DEVICE_HUNG'}),{status:422})])await assert.rejects(runNativeFloaters(cols(),info,{fetchImpl:async()=>response}));});
test('cancelled encode does not send geometry; invalid data fails',async()=>{let calls=0;await assert.rejects(runNativeFloaters(cols(),info,{cancelled:()=>true,fetchImpl:async()=>{calls++;return reply([]);}}),/cancelled/);assert.equal(calls,0);const c=cols();c.x[0]=NaN;await assert.rejects(encodeGeometry(c),/Invalid geometry/);});
test('existing runSplatTransformFloaters(columns, settings) returns only Uint8Array; metadata separate',async()=>{let metadata;const result=await runSplatTransformFloaters(cols(),PARAMETERS,{info,fetchImpl:async()=>reply([0,1,0]),onMetadata:v=>{metadata=v;}});assert.ok(result instanceof Uint8Array);assert.deepEqual([...result],[0,1,0]);assert.equal(metadata.runtime_version,'3.11.2');assert.equal(metadata.candidate,undefined);await assert.rejects(runSplatTransformFloaters(cols(),{...PARAMETERS,voxelResolution:.1},{info}),/fixed voxelResolution/);});
test('candidate mask from service combines with existing SNS using unchanged OR selection',async()=>{const {computeSelection}=await import('../core.mjs');const c=cols();const mask=await runSplatTransformFloaters(c,PARAMETERS,{info,fetchImpl:async()=>reply([0,1,1])});const snsMask=Uint8Array.of(1,1,0);const density={classes:new Uint8Array(3)};const roi={x:{min:1,max:2},y:{min:-4,max:-2},z:{min:3,max:5}};const selected=computeSelection(c,density,{roi,density:'all',snsEnabled:true,splatTransformEnabled:true},{snsMask,splatTransformMask:mask});assert.deepEqual([...selected.candidates],[1,1,0]);assert.deepEqual([...snsMask],[1,1,0]);assert.deepEqual([...mask],[0,1,1]);});

const owned={state:'running',folder:'splat-cleaner_test',port:3025};
const ownedInfo={...info,release_folder:owned.folder,port:3025};
test('first Floaters click starts owned service before contacting selected port',async()=>{
 const calls=[];const got=await detectNativeSplatTransform({port:3025,startService:async()=>{calls.push('start');return owned;},fetchImpl:async(url)=>{calls.push(url);return new Response(JSON.stringify(ownedInfo));}});
 assert.deepEqual(calls,['start','http://127.0.0.1:3025/status']);assert.deepEqual(got,{...ownedInfo,endpoint:'http://127.0.0.1:3025'});
});
test('owned startup checks CLI and rejects mismatched release or port',async()=>{for(const value of [ownedInfo,{...ownedInfo,available:false,error:'not installed'},{...ownedInfo,busy:true},{...ownedInfo,protocol:1},{...ownedInfo,port:3015},{...ownedInfo,release_folder:'other'}]){let calls=0;const run=detectNativeSplatTransform({port:3025,startService:async()=>owned,fetchImpl:async url=>{calls++;assert.match(url,/\/status$/);return new Response(JSON.stringify(value));}});if(value===ownedInfo)await run;else await assert.rejects(run);assert.equal(calls,1);}});
test('denied launch or occupied port stops before contacting listener',async()=>{
 let calls=0;const offline=async()=>{calls++;throw Error('offline');};
 await assert.rejects(detectNativeSplatTransform({fetchImpl:offline}),/service unavailable/);assert.equal(calls,1);
 for(const message of ['not authorized','EADDRINUSE'])await assert.rejects(detectNativeSplatTransform({fetchImpl:offline,startService:async()=>{throw Error(message);}}),new RegExp(message));assert.equal(calls,1);
 await assert.rejects(detectNativeSplatTransform({fetchImpl:offline,startService:async()=>({state:'stopped'})}),/readiness/);assert.equal(calls,1);
});
test('cancellation prevents startup or retry',async()=>{const c=new AbortController();let calls=0;await assert.rejects(detectNativeSplatTransform({signal:c.signal,fetchImpl:async()=>{calls++;c.abort();throw Error('aborted');}}),/cancelled/);assert.equal(calls,1);await assert.rejects(detectNativeSplatTransform({signal:c.signal,fetchImpl:async()=>{calls++;}}),/cancelled/);assert.equal(calls,1);});

test('managed port and stop preferences are validated independently',async()=>{
 const {floaterSettings,validateNativePort,serviceURL}=await import('../native-protocol.mjs');
 assert.deepEqual(floaterSettings(),{autoStop:true,gpuBackend:'vulkan'});
 assert.deepEqual(floaterSettings({'floaters-auto-stop':false}),{autoStop:false,gpuBackend:'vulkan'});
 assert.throws(()=>floaterSettings({'floaters-auto-stop':'false'}),/shutdown/);
 assert.equal(validateNativePort(3025),3025);assert.equal(serviceURL(3025),'http://127.0.0.1:3025');
 for(const value of [0,65536,12.5,'3025','foo',1023])assert.throws(()=>validateNativePort(value),/port/);
});
test('custom endpoint transfers mask only to the confirmed port',async()=>{const result=await runNativeFloaters(cols(),{...info,endpoint:'http://127.0.0.1:3025'},{fetchImpl:async url=>{assert.equal(url,'http://127.0.0.1:3025/analyze');return reply([0,1,0]);}});assert.deepEqual([...result.candidate],[0,1,0]);});

test('local authorization cancellation reaches Cleaner without contacting the configured port',async()=>{
 const cancellation=Object.assign(Error('Native execution authorization cancelled.'),{code:'NATIVE_AUTH_CANCELLED',status:403});
 let contacts=0;
 await assert.rejects(detectNativeSplatTransform({port:3025,startService:async()=>{throw cancellation;},fetchImpl:async()=>{contacts++;}}),err=>err===cancellation);
 assert.equal(contacts,0);
});

test('managed discovery verifies approved projection before contacting native endpoint',async()=>{
 const calls=[];
 const confirmed=await detectNativeSplatTransform({
  startService:async()=>{calls.push('manager-start');return owned;},
  verifyAssignment:async(state,port)=>{calls.push('projection');assert.equal(state.folder,owned.folder);assert.equal(port,3025);},
  fetchImpl:async(url)=>{calls.push(url);return new Response(JSON.stringify(ownedInfo));}
 });
 assert.equal(confirmed.port,3025);
 assert.deepEqual(calls,['manager-start','projection','http://127.0.0.1:3025/status']);
 await assert.rejects(detectNativeSplatTransform({
  startService:async()=>owned,
  verifyAssignment:async()=>{throw Error('stale native approval projection');},
  fetchImpl:async()=>{assert.fail('Must never contact a listener on stale approval');}
 }),/stale native approval projection/);
 await assert.rejects(detectNativeSplatTransform({
  startService:async()=>({state:'running',folder:owned.folder}),
  fetchImpl:async()=>{assert.fail('Must never contact a listener without Manager-assigned port');}
 }),/readiness/);
});

test('GPU backend settings allow only supported values, empty and legacy default mean explicit Vulkan',async()=>{
 const {floaterSettings}=await import('../native-protocol.mjs');
 for(const v of ['default','d3d12','vulkan',''])assert.equal(floaterSettings({'floaters-gpu-backend':v}).gpuBackend,v==='d3d12'?'d3d12':'vulkan');
 for(const v of [null,1,'cpu','Vulkan','--gpu-backend vulkan','vulkan;whoami'])assert.throws(()=>floaterSettings({'floaters-gpu-backend':v}),/GPU backend/);
});
test('service preflight rejects missing and unrecognized backend metadata',async()=>{
 for(const v of [undefined,'default','cpu','--help'])await assert.rejects(detectNativeSplatTransform({fetchImpl:mock({...info,gpu_backend:v})}),/GPU backend/);
});
