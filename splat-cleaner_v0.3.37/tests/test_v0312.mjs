import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {planSnsGpu,snsGpuShader,verifySnsWitnesses,accelerateSnsOutgoing,classifySnsGpuPair,snsCoordinateError,adjustSnsRetryBatch} from '../sns-gpu.mjs';
import {analyzeSnsSupport,analyzeSnsBidirectionalSupport,gaussianMetric} from '../sns-support.mjs';
const limits={maxBufferSize:2**28,maxStorageBufferBindingSize:2**27,maxStorageBuffersPerShaderStage:8,maxComputeWorkgroupsPerDimension:65535,maxComputeInvocationsPerWorkgroup:256,maxComputeWorkgroupSizeX:256,maxUniformBufferBindingSize:65536};
const I=[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1];
function fixture(p,scales,{k=3,locked=[],invalid=[],rotation=[1,0,0,0]}={}){
 const n=p.length,centers=Object.fromEntries(['x','y','z'].map((a,i)=>[a,Float64Array.from(p,v=>v[i])]));
 const geometry={k,inverse:new Float32Array(9*n),radii:new Float64Array(n),valid:new Uint8Array(n),locked:new Uint8Array(n)};
 for(let i=0;i<n;i++){geometry.locked[i]=locked.includes(i)?1:0;if(invalid.includes(i))continue;const scale=scales[i]??1;const metric=gaussianMetric(rotation,(Array.isArray(scale)?scale:[scale,scale,scale]).map(Math.log),I,k);assert.ok(metric);geometry.inverse.set(metric.inverse,i*9);geometry.radii[i]=metric.radius;geometry.valid[i]=1;}
 return {centers,geometry};
}
const same=(a,b)=>{for(const k of ['candidateMask','inconclusiveMask','supportCount','validCount','invalidCount','candidateCount','supportedCount','inconclusiveCount','lockedExcluded','reverseSupportedCount','reverseInconclusiveCount'])assert.deepEqual(a[k],b[k],k);};
// Emulates packed buffer I/O and shader traversal on CPU, NOT a WGSL compiler.
// Executes the same full-model sharded addressing, exact cell ordering and query
// budgets, so packing and orchestration failures cannot be hidden by fallback.
function fakeGPU({failAt=0,corrupt=false,limitOverride={},cancel=null,failMessage='mock map failure',forceRetryUnresolved=false}={}){
 const stats={devices:0,destroyed:0,buffers:0,bufferDestroyed:0,batches:0,maps:0,unmaps:0,scopes:0,fullRows:0,fullOccupied:0,fullDispatches:[]};let plan,resources;
 const gpu={async requestAdapter(){return {limits:{...limits,...limitOverride},async requestDevice({requiredLimits}){
    stats.devices++;assert.ok(requiredLimits.maxStorageBuffersPerShaderStage<=8);
    const device={limits:{...limits,...limitOverride},lost:new Promise(()=>{}),destroy(){stats.destroyed++;},pushErrorScope(){stats.scopes++;},async popErrorScope(){stats.scopes--;return null;},
    createBuffer({size}){stats.buffers++;const data=new ArrayBuffer(size);return {data,destroy(){stats.bufferDestroyed++;},async mapAsync(){stats.maps++;if(failAt===stats.batches)throw Error(failMessage);},getMappedRange(offset,size){return data.slice(offset,offset+size);},unmap(){stats.unmaps++;}};},
    createShaderModule({code}){assert.match(code,/fn cell_head/);const shard=Number(code.match(/let shard=index\/(\d+)u/)[1]);const np=[...code.matchAll(/var<storage,read> points\d+:/g)].length;const nc=[...code.matchAll(/var<storage,read> cells\d+:/g)].length;plan={shard,np,nc};return {async getCompilationInfo(){return {messages:[]};}};},
    async createComputePipelineAsync(){return {getBindGroupLayout(){return {};}};},createBindGroup({entries}){resources=entries.map(v=>v.resource.buffer);return {};},
    queue:{writeBuffer(buffer,offset,data,start=0,count=data.length){new Uint8Array(buffer.data,offset,count*data.BYTES_PER_ELEMENT).set(new Uint8Array(data.buffer,data.byteOffset+start*data.BYTES_PER_ELEMENT,count*data.BYTES_PER_ELEMENT));},submit(commands){for(const command of commands)command();}},
    createCommandEncoder(){let job,copy;return {beginComputePass(){return {setPipeline(){},setBindGroup(){},dispatchWorkgroups(groups){assert.ok(groups>0);job=()=>execute();},end(){}};},copyBufferToBuffer(src,a,dst,b,size){copy=()=>new Uint8Array(dst.data,b,size).set(new Uint8Array(src.data,a,size));},finish(){return ()=>{job();copy();};}};}};
    function execute(){
      stats.batches++;const {shard,np,nc}=plan, q=new Uint32Array(resources[np+nc].data),qf=new Float32Array(q.buffer),o=new Uint32Array(resources[np+nc+1].data),p=new Uint32Array(resources[np+nc+2].data),pf=new Float32Array(p.buffer);
      const [count,m,numCells,maxCells,maxCmp]=p,k2=pf[5],stride=m+1,NONE=0xffffffff;
      const load=(j,base)=>{const b=resources[base+Math.floor(j/shard)].data;return new Uint32Array(b,(j%shard)*16,4);};
      const pos=j=>new Float32Array(load(j,0).buffer,load(j,0).byteOffset,3);
      function lower(x,y,z){let lo=0,hi=numCells;while(lo<hi){const mid=lo+Math.floor((hi-lo)/2),c=load(mid,np),v=new Int32Array(c.buffer,c.byteOffset,3),cmp=v[0]-x||v[1]-y||v[2]-z;if(cmp<0)lo=mid+1;else hi=mid;}return lo;}
      if(p[7])stats.fullDispatches.push({count,maxCells,maxCmp});
      function head(x,y,z){let lo=0,hi=numCells;while(lo<hi){const mid=lo+Math.floor((hi-lo)/2),c=load(mid,np),v=new Int32Array(c.buffer,c.byteOffset,3),cmp=v[0]-x||v[1]-y||v[2]-z;if(!cmp)return c[3];if(cmp<0)lo=mid+1;else hi=mid;}return NONE;}
      for(let i=0;i<count;i++){const a=i*21,b=i*stride,id=q[a];o[b]=0;if(id===NONE)continue;let found=0,checked=0,visited=1,limited=false,ambiguous=false;const c=Array.from(pos(id)),r=qf[a+11],ints=new Int32Array(q.buffer,a*4,21),rows=[0,1,2].map(row=>Array.from(qf.subarray(a+12+row*3,a+15+row*3)));
       const scan=h=>{let j=h;while(j!==NONE&&found<m){const v=load(j,0),other=j;j=v[3];if(other===id)continue;if(checked>=maxCmp){limited=true;return;}checked++;const relation=classifySnsGpuPair(Array.from(pos(other)),c,rows,r,k2,pf[6]);if(relation===1)o[b+1+found++]=other;if(relation===2)ambiguous=true;}};
       scan(q[a+1]);const [cx,cy,cz,lx,hx,ly,hy,lz,hz]=ints.subarray(2,11);
       const boxValid=lx<=hx&&ly<=hy&&lz<=hz,total=(hx-lx+1)*(hy-ly+1)*(hz-lz+1);let complete=false;
       if(p[7]&&boxValid&&total<=maxCells){
        for(let x=lx;x<=hx&&found<m&&!limited;x++)for(let y=ly;y<=hy&&found<m&&!limited;y++){
         stats.fullRows++;let cursor=lower(x,y,lz);while(cursor<numCells&&found<m&&!limited){const cell=load(cursor,np),v=new Int32Array(cell.buffer,cell.byteOffset,3);if(v[0]!==x||v[1]!==y||v[2]>hz)break;cursor++;if(x===cx&&y===cy&&v[2]===cz)continue;stats.fullOccupied++;scan(cell[3]);}
        }complete=!limited&&found<m;
       }else{
        for(let x=lx;x<=hx&&found<m&&!limited&&visited<maxCells;x++)for(let y=ly;y<=hy&&found<m&&!limited&&visited<maxCells;y++)for(let z=lz;z<=hz&&found<m&&!limited&&visited<maxCells;z++){if(x===cx&&y===cy&&z===cz)continue;visited++;scan(head(x,y,z));}
        complete=boxValid&&visited===total&&!limited;
       }
       o[b]=found|(complete&&!ambiguous&&found<m?256:0)|(ambiguous?512:0)|(!complete&&found<m&&(boxValid||limited)?1024:0);
       if(p[7]&&forceRetryUnresolved)o[b]=1024;
       if(corrupt&&found===m)o[b+1]=id;
      } if(cancel)cancel();
    }return device;
 }}}};return {gpu,stats};
}
const run=(f,options={},fakeOptions={},backendOptions={})=>{const mock=fakeGPU(fakeOptions);return {mock,promise:analyzeSnsBidirectionalSupport(f.centers,f.geometry,{...options,accelerate:ctx=>accelerateSnsOutgoing(ctx,{gpu:mock.gpu,...backendOptions})})};};
test('GPU-SNS-01 capacity plan uses bounded buffers, 20M full occupancy fits 8 bindings at 128 MiB',()=>{const p=planSnsGpu(20_000_000,20_000_000,50,limits);assert.equal(p.storageBindings,8);assert.equal(p.pointSizes.length,3);assert.equal(p.cellSizes.length,3);assert.ok(p.largestStorageBytes<=2**27);assert.equal(p.batch,8192);assert.ok(p.bufferBytes>640_000_000);assert.throws(()=>planSnsGpu(20_000_000,20_000_000,50,{...limits,maxStorageBuffersPerShaderStage:7}),/bindings/);assert.throws(()=>planSnsGpu(100,100,1,{...limits,maxComputeWorkgroupSizeX:32}),/workgroup/);assert.equal((snsGpuShader(p).match(/var<storage/g)||[]).length,8);});
test('GPU-SNS-02 witness verification rejects self, duplicates, invalid geometry, out-of-range and false support',()=>{const {centers:c,geometry:g}=fixture([[0,0,0],[.1,0,0],[.2,0,0],[10,0,0],[.1,.1,0]],[],{invalid:[4]});assert.equal(verifySnsWitnesses(c,g,0,[1,2],2,3),true);for(const ids of [[0,1],[1,1],[1,3],[1,4],[1,9],[1]])assert.equal(verifySnsWitnesses(c,g,0,ids,2,3),false);});
test('GPU-SNS-03 mixed valid/invalid/locked, asymmetric coverage, neighbor cells and forced buffer shards',async()=>{const f=fixture([[0,0,0],[1,0,0],[2,0,0],[3,0,0],[100,0,0],[102,0,0],[1000,0,0],[1000.1,0,0],[1000.2,0,0],[1001,0,0]],[.1,1,.1,.1,.1,1,1,1,1,1],{locked:[5],invalid:[9]});for(const m of [1,2,3]){const opts={minSupport:m,cellWidth:1};const ref=await analyzeSnsBidirectionalSupport(f.centers,f.geometry,opts);const {promise,mock}=run(f,opts,{}, {maxShardEntries:4,maxBatch:3});const r=await promise;same(r,ref);assert.equal(r.outgoingAcceleration.backend,'webgpu+cpu');if(m===1)assert.ok(r.outgoingAcceleration.verified>0);assert.equal(r.outgoingAcceleration.fast_batches,4);assert.equal(mock.stats.batches,r.outgoingAcceleration.batches);assert.equal(mock.stats.destroyed,1);assert.equal(mock.stats.buffers,mock.stats.bufferDestroyed);assert.equal(mock.stats.scopes,0);}});
test('GPU-SNS-04 dense 50-neighbor threshold including batch tail',async()=>{const f=fixture(Array.from({length:52},(_,i)=>[i*.001,0,0]),[]);const opts={minSupport:50,cellWidth:3};const ref=await analyzeSnsBidirectionalSupport(f.centers,f.geometry,opts);const {promise}=run(f,opts,{}, {maxBatch:7});const r=await promise;same(r,ref);assert.equal(r.outgoingAcceleration.verified,52);assert.equal(r.outgoingAcceleration.batches,8);});
test('GPU-SNS-05 original CPU cell and comparison budget behavior remains authoritative',async()=>{const f=fixture([[0,0,0],[1,0,0],[2,0,0],[3,0,0],[100,1,0]],[.1,2,1,.5,1]);for(const opts of [{cellWidth:.01,maxCellsPerQuery:1},{cellWidth:1,maxComparisonsPerQuery:1,minSupport:2},{cellWidth:1,maxCellsPerQuery:40000,maxComparisonsPerQuery:200000}]){const ref=await analyzeSnsBidirectionalSupport(f.centers,f.geometry,opts);const {promise}=run(f,opts);const r=await promise;same(r,ref);assert.equal(r.outgoingAcceleration.backend,'webgpu+cpu');}});
test('GPU-SNS-06 wrong GPU witnesses never certify support; exact CPU fallback including large origin',async()=>{const f=fixture([[1e12,0,0],[1e12+.5,0,0],[1e12+10,0,0]],[]);const opts={cellWidth:1};const ref=await analyzeSnsBidirectionalSupport(f.centers,f.geometry,opts);const {promise}=run(f,opts,{corrupt:true});const r=await promise;same(r,ref);assert.equal(r.outgoingAcceleration.verified,0);});
test('GPU-SNS-07 map error discards prior batches, releases all buffers and completes CPU reference',async()=>{const f=fixture([[0,0,0],[.1,0,0],[.2,0,0],[.3,0,0],[100,0,0]],[]);const ref=await analyzeSnsBidirectionalSupport(f.centers,f.geometry);const {promise,mock}=run(f,{}, {failAt:2},{maxBatch:2});const r=await promise;same(r,ref);assert.equal(r.outgoingAcceleration.backend,'cpu');assert.equal(r.outgoingAcceleration.verified,0);assert.match(r.outgoingAcceleration.reason,/mock map failure/);assert.equal(mock.stats.batches,2);assert.equal(mock.stats.destroyed,1);assert.equal(mock.stats.buffers,mock.stats.bufferDestroyed);assert.equal(mock.stats.scopes,0);});
test('GPU-SNS-08 insufficient storage binding capacity falls back before device creation',async()=>{const f=fixture([[0,0,0],[1,0,0]],[]);const ref=await analyzeSnsBidirectionalSupport(f.centers,f.geometry);const {promise,mock}=run(f,{}, {limitOverride:{maxStorageBuffersPerShaderStage:3}});const r=await promise;same(r,ref);assert.equal(r.outgoingAcceleration.backend,'cpu');assert.equal(mock.stats.devices,0);});
test('GPU-SNS-09 cancellation propagates and GPU resources are destroyed',async()=>{const f=fixture([[0,0,0],[1,0,0]],[]);let stopped=false;const {promise,mock}=run(f,{cancelled:()=>stopped},{cancel:()=>stopped=true});await assert.rejects(promise,/cancelled/);assert.equal(mock.stats.destroyed,1);assert.equal(mock.stats.buffers,mock.stats.bufferDestroyed);});
test('GPU-SNS-10 controller alone enables auto GPU path; original UI and report fields retained',()=>{const source=readFileSync(new URL('../index.js',import.meta.url),'utf8');assert.match(source,/accelerate:gpuUnavailable\?null:accelerateSnsOutgoing/);assert.match(source,/outgoing_acceleration:/);assert.match(source,/timings_ms:/);for(const id of ['sc-apply','sc-sns-find'])assert.equal(source.match(new RegExp(`id="${id}"`,'g')).length,1);assert.doesNotMatch(source,/id="sc-sns-oversized/);});

// v0.3.14 complete bounded Stage 1 regressions. The same mock exercises the
// new status word and second dispatch pass; actual shader execution is separate.
test('GPU-SNS-11 complete zero-neighbor searches bypass CPU including locked references',async()=>{
 const f=fixture([[0,0,0],[20,0,0],[40,0,0]],[],{locked:[1]});const opts={cellWidth:3};
 const ref=await analyzeSnsBidirectionalSupport(f.centers,f.geometry,opts);
 const {promise}=run(f,opts);const r=await promise;same(r,ref);assert.equal(r.outgoingAcceleration.exact,3);assert.equal(r.outgoingAcceleration.cpu_fallback,0);assert.equal(r.candidateCount,2);assert.equal(r.lockedExcluded,1);
});
test('GPU-SNS-12 exact partial counts feed reverse search without double counting',async()=>{
 const f=fixture([[0,0,0],[.1,0,0],[1,0,0],[20,0,0]],[.05,.05,1,.1]);const opts={cellWidth:.5,minSupport:2};
 const ref=await analyzeSnsBidirectionalSupport(f.centers,f.geometry,opts);const {promise}=run(f,opts);const r=await promise;same(r,ref);assert.ok(r.outgoingAcceleration.exact>0);assert.equal(r.outgoingAcceleration.cpu_fallback,0);assert.ok(r.reverseSupportedCount>0);
});
test('GPU-SNS-13 larger complete boxes use the full-budget retry and resolve exact isolation',async()=>{
 const f=fixture(Array.from({length:70},(_,i)=>[i*20,0,0]),[]);const opts={cellWidth:.5};
 const ref=await analyzeSnsBidirectionalSupport(f.centers,f.geometry,opts);const {promise}=run(f,opts);const r=await promise;same(r,ref);
 assert.equal(r.outgoingAcceleration.fast_batches,1);assert.equal(r.outgoingAcceleration.full_queries,70);assert.equal(r.outgoingAcceleration.full_batches,1);assert.equal(r.outgoingAcceleration.exact,70);assert.equal(r.outgoingAcceleration.cpu_fallback,0);
});
test('GPU-SNS-14 exact comparison budget boundary and truncated search are distinct',async()=>{
 const f=fixture([[0,0,0],[.1,0,0],[.2,0,0]],[]);for(const budget of [1,2]){
 const opts={cellWidth:10,minSupport:3,maxComparisonsPerQuery:budget};const ref=await analyzeSnsBidirectionalSupport(f.centers,f.geometry,opts);const {promise}=run(f,opts);const r=await promise;same(r,ref);assert.equal(r.outgoingAcceleration.exact,budget===2?3:0);assert.equal(r.outgoingAcceleration.cpu_fallback,budget===2?0:3);
 }
});
test('GPU-SNS-15 near-boundary and lost local precision force CPU fallback, not isolation',async()=>{
 for(const f of [fixture([[0,0,0],[3,0,0]],[]),fixture([[0,0,0],[1e8,0,0],[1e8+.1,0,0]],[1,.1,.1])]){
 const opts={cellWidth:3};const ref=await analyzeSnsBidirectionalSupport(f.centers,f.geometry,opts);const {promise}=run(f,opts);const r=await promise;same(r,ref);assert.ok(r.outgoingAcceleration.cpu_fallback>=2);assert.ok(r.outgoingAcceleration.ambiguous>=2);
 }
});
test('GPU-SNS-16 full-pass failure discards complete negatives and previous positive witnesses',async()=>{
 const f=fixture([[0,0,0],[.1,0,0],[20,0,0],[40,0,0]],[1,1,1,.01]);const opts={cellWidth:.5};const ref=await analyzeSnsBidirectionalSupport(f.centers,f.geometry,opts);const {promise,mock}=run(f,opts,{failAt:2});const r=await promise;same(r,ref);assert.equal(r.outgoingAcceleration.backend,'cpu');assert.equal(r.outgoingAcceleration.verified,0);assert.equal(r.outgoingAcceleration.exact,0);assert.equal(mock.stats.buffers,mock.stats.bufferDestroyed);
});
test('GPU-SNS-17 float32 interval model never contradicts exact pair classification in seeded stress fixtures',()=>{
 let seed=341;const rand=()=>((seed=(Math.imul(seed,1664525)+1013904223)>>>0)/2**32);let certified=0,uncertain=0;
 for(let i=0;i<20000;i++){
  const origin=10**(rand()*16-8),base=Array.from({length:3},()=>rand()*origin),d=Array.from({length:3},()=> (rand()-.5)*10**(rand()*10-5));
  const point=base.map((v,j)=>v+d[j]),center=base,rows=Array.from({length:3},()=>Array.from({length:3},()=>Math.fround((rand()-.5)*10**(rand()*8-4)))),radius=10**(rand()*10-5),k2=9;
  const a=point.map(Math.fround),b=center.map(Math.fround),err=Math.fround(Math.max(...point.map((v,j)=>snsCoordinateError(v,a[j])),...center.map((v,j)=>snsCoordinateError(v,b[j])))*1.00001+1e-30);
  const delta=point.map((v,j)=>v-center[j]),u=rows.map(row=>row.reduce((v,x,j)=>v+x*delta[j],0)),inside=delta.reduce((v,x)=>v+x*x,0)<=radius*radius&&u.reduce((v,x)=>v+x*x,0)<=k2;
  const result=classifySnsGpuPair(a,b,rows,Math.fround(radius),k2,err);
  if(result===2)uncertain++;else{certified++;assert.equal(result,inside?1:0,`pair ${i}`);}
 }
 assert.ok(certified>10000);assert.ok(uncertain>0);
});

test('GPU-SNS-18 device loss is surfaced in fallback metadata and controller disables further GPU work',async()=>{
 const f=fixture([[0,0,0],[1,0,0]],[]),ref=await analyzeSnsBidirectionalSupport(f.centers,f.geometry);
 const {promise}=run(f,{}, {failAt:1,failMessage:'Device was lost before MapAsync completed'});const r=await promise;same(r,ref);
 assert.equal(r.outgoingAcceleration.device_lost,true);assert.equal(r.outgoingAcceleration.verified,0);assert.equal(r.outgoingAcceleration.exact,0);
 assert.match(readFileSync(new URL('../index.js',import.meta.url),'utf8'),/if\(result\.outgoingAcceleration\?\.device_lost\|\|result\.reverseAcceleration\?\.device_lost\)gpuUnavailable=true/);
});

// v0.3.15: targeted retry scheduling and occupied-row lookup regressions.
test('GPU-SNS-19 sparse row retry resolves exact counts with fewer host synchronizations',async()=>{
 const f=fixture(Array.from({length:130},(_,i)=>[20*i,0,0]),[]),opts={cellWidth:.5};
 const ref=await analyzeSnsBidirectionalSupport(f.centers,f.geometry,opts);
 const {promise,mock}=run(f,opts),r=await promise;same(r,ref);
 const d=r.outgoingAcceleration;assert.equal(d.full_resolved,130);assert.equal(d.full_queries,130);assert.equal(d.full_batches,2);assert.equal(mock.stats.maps,3);
 assert.equal(d.full_max_batch,128);assert.ok(mock.stats.fullRows>0);assert.equal(mock.stats.fullOccupied,0);
 assert.ok(d.full_max_cell_work<=64*16384);assert.ok(d.full_max_comparison_work<=64*100000);
});
test('GPU-SNS-20 occupied row traversal preserves cross-cell and partial counts',async()=>{
 const f=fixture([[0,0,0],[-2.8,0,0],[-2.6,.1,0],[-2.9,-.1,0],[20,20,20],[19.8,20,20],[20.2,20,20]],[1,.01,.01,.01,1,.01,.01]);
 const opts={cellWidth:.5,minSupport:3};const ref=await analyzeSnsBidirectionalSupport(f.centers,f.geometry,opts);
 const {promise,mock}=run(f,opts,{}, {maxShardEntries:4});const r=await promise;same(r,ref);
 assert.ok(mock.stats.fullOccupied>0);assert.ok(r.outgoingAcceleration.full_resolved>0);
});
test('GPU-SNS-21 low-resolution retry window stops and preserves CPU results',async()=>{
 const f=fixture(Array.from({length:150},(_,i)=>[i*20,0,0]),[]),opts={cellWidth:.5};
 const ref=await analyzeSnsBidirectionalSupport(f.centers,f.geometry,opts);
 const {promise,mock}=run(f,opts,{forceRetryUnresolved:true},{retryWindow:64});const r=await promise;same(r,ref);
 const d=r.outgoingAcceleration;assert.equal(d.full_queries,128);assert.equal(d.full_skipped,22);assert.equal(d.full_stop_reason,'low_resolution_rate');assert.equal(d.cpu_fallback,150);assert.equal(mock.stats.fullDispatches.length,1);
});
test('GPU-SNS-22 adaptive batch policy is bounded and reacts to measured elapsed time',()=>{
 assert.equal(adjustSnsRetryBatch(128,10,512),256);assert.equal(adjustSnsRetryBatch(512,10,512),512);assert.equal(adjustSnsRetryBatch(256,90,512),128);assert.equal(adjustSnsRetryBatch(64,100,512),64);assert.equal(adjustSnsRetryBatch(3,100,3),3);assert.equal(adjustSnsRetryBatch(128,35,512),128);
});
test('GPU-SNS-23 larger full boxes respect aggregate work and comparison cap',async()=>{
 const f=fixture(Array.from({length:130},(_,i)=>[i*20,0,0]),[]),opts={cellWidth:.25};
 const ref=await analyzeSnsBidirectionalSupport(f.centers,f.geometry,opts);
 const {promise,mock}=run(f,opts);const r=await promise;same(r,ref);const d=r.outgoingAcceleration;
 assert.equal(d.full_resolved,130);assert.ok(d.full_max_cell_work<=64*16384);assert.ok(d.full_max_batch<=Math.floor(64*16384/(25**3)));assert.equal(d.full_comparison_budget,8192);
 assert.ok(mock.stats.fullDispatches.every(x=>x.maxCmp===8192));
});
test('GPU-SNS-24 ambiguous truncated queries are sent to CPU without a retry',async()=>{
 const opts={cellWidth:.5,minSupport:1};
 // Make an exact boundary point in the own cell, with a box larger than the fast prefix.
 // A point at distance 3 in another cell may not be visited by the prefix, so use
 // a highly anisotropic ellipsoid whose short-axis boundary is inside its own cell.
 const g=fixture([[0,0,0],[0,.03,0],[20,0,0]],[[1,.01,.01],[1,.01,.01],1]);
 const ref=await analyzeSnsBidirectionalSupport(g.centers,g.geometry,opts);const {promise}=run(g,opts);const r=await promise;same(r,ref);
 assert.ok(r.outgoingAcceleration.full_ambiguous_skipped>=2);assert.ok(r.outgoingAcceleration.cpu_fallback>=2);
});

test('GPU-SNS-25 cancellation at adaptive retry entry releases resources without CPU result',async()=>{
 const f=fixture(Array.from({length:70},(_,i)=>[i*20,0,0]),[]);let stopped=false;
 const {promise,mock}=run(f,{cellWidth:.5,cancelled:()=>stopped,progress:(done,total,stage)=>{if(stage==='gpu-full-search')stopped=true;}});
 await assert.rejects(promise,/cancelled/);assert.equal(mock.stats.batches,1);assert.equal(mock.stats.destroyed,1);assert.equal(mock.stats.buffers,mock.stats.bufferDestroyed);assert.equal(mock.stats.scopes,0);
});

// v0.3.16: exercise both software GPU stages against the actual archived CPU
// implementation, not just against a shared new Stage 2 implementation.
import {createSnsReverseSearch} from '../sns-reverse-gpu.mjs';
import {reverseGpuDouble} from './fixtures/reverse-gpu-double.mjs';
import {analyzeSnsBidirectionalSupport as archivedCpu} from './fixtures/sns-support-v0311.mjs';
test('GPU-SNS-26 both GPU stages match archived CPU candidate, uncertainty and support arrays',async()=>{
 const p=Array.from({length:212},(_,i)=>[Math.floor(i/4)*10+(i%4)*.75,i%7*.1,0]);
 const f=fixture(p,p.map((_,i)=>i%4===0?1.1:.12),{locked:[0,8,20],invalid:[7,31]});
 for(const m of [1,2,5,50]){
   const opts={minSupport:m,cellWidth:.8};const ref=await archivedCpu(f.centers,f.geometry,opts);
   const og=fakeGPU(),rg=reverseGpuDouble();
   const r=await analyzeSnsBidirectionalSupport(f.centers,f.geometry,{...opts,accelerate:c=>accelerateSnsOutgoing(c,{gpu:og.gpu,maxBatch:37}),accelerateReverse:c=>createSnsReverseSearch(c,{gpu:rg.gpu,batch:31})});
   same(r,ref);assert.equal(r.outgoingCandidateCount,ref.outgoingCandidateCount);assert.ok(r.outgoingAcceleration.verified+r.outgoingAcceleration.exact>0);assert.ok(r.reverseAcceleration.replayed_sources>0);
 }
});

test('SNS17-10 terminal fallback reasons partition the unresolved queries including skipped retries',async()=>{
 const f=fixture(Array.from({length:150},(_,i)=>[i*20,0,0]),[]),opts={cellWidth:.5};
 const {promise}=run(f,opts,{forceRetryUnresolved:true},{retryWindow:64});const r=await promise,d=r.outgoingAcceleration;
 assert.equal(d.fallback_reasons.retry_truncated,128);assert.equal(d.fallback_reasons.retry_not_submitted,22);assert.equal(Object.values(d.fallback_reasons).reduce((a,b)=>a+b,0),d.cpu_fallback);assert.equal(r.outgoingCpuSearch.queries,d.cpu_fallback);
});
test('SNS17-11 terminal fallback reasons account for ambiguous, rejected witnesses and GPU failure',async()=>{
 const f=fixture([[0,0,0],[0,.03,0],[20,0,0]],[[1,.01,.01],[1,.01,.01],1]);const r=await run(f,{cellWidth:.5}).promise;assert.ok(r.outgoingAcceleration.fallback_reasons.numerical_ambiguity>=2);
 const g=fixture([[0,0,0],[.01,0,0],[50,0,0]],[]);const rejected=await run(g,{cellWidth:1},{corrupt:true}).promise;assert.ok(rejected.outgoingAcceleration.fallback_reasons.unverified_or_invalid_result>=2);
 const fail=await run(g,{cellWidth:1},{failAt:1}).promise;assert.equal(fail.outgoingAcceleration.fallback_reasons.gpu_failure,3);
 for(const q of [r,rejected,fail])assert.equal(Object.values(q.outgoingAcceleration.fallback_reasons).reduce((a,b)=>a+b,0),q.outgoingAcceleration.cpu_fallback);
});
