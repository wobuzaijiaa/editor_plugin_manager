import test from 'node:test';
import assert from 'node:assert/strict';
import {analyzeSnsBidirectionalSupport as archived} from './fixtures/sns-support-v0311.mjs';
import {analyzeSnsSupport,analyzeSnsBidirectionalSupport as current,gaussianMetric,insideSnsEllipsoid} from '../sns-support.mjs';
import {createSnsReverseSearch,reverseQuantizer,packReverseSource,reverseGpuPlan} from '../sns-reverse-gpu.mjs';
import {reverseGpuDouble,limits} from './fixtures/reverse-gpu-double.mjs';
const I=[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1],S=[1,0,0,0,.4,1,0,0,0,0,1.2,0,0,0,0,1];
function fixture(p,scales,{k=3,locked=[],invalid=[],quats=[],transforms=[]}={}){
 const n=p.length,centers=Object.fromEntries(['x','y','z'].map((a,i)=>[a,Float64Array.from(p,v=>v[i])]));
 const geometry={k,inverse:new Float32Array(n*9),radii:new Float64Array(n),valid:new Uint8Array(n),locked:new Uint8Array(n)};
 for(let i=0;i<n;i++){geometry.locked[i]=locked.includes(i)?1:0;if(invalid.includes(i))continue;const scale=scales[i]??1;const metric=gaussianMetric(quats[i]??[1,0,0,0],(Array.isArray(scale)?scale:[scale,scale,scale]).map(Math.log),transforms[i]??I,k);assert.ok(metric);geometry.inverse.set(metric.inverse,9*i);geometry.radii[i]=metric.radius;geometry.valid[i]=1;}
 return {centers,geometry};
}
const keys=['candidateMask','inconclusiveMask','supportCount','validCount','invalidCount','candidateCount','supportedCount','inconclusiveCount','lockedExcluded','outgoingCandidateCount','reverseSupportedCount','reverseInconclusiveCount','reverseBudgetLimitedSources','reverseComparisons'];
const same=(r,ref)=>{for(const key of keys)assert.deepEqual(r[key],ref[key],key);assert.equal(r.candidateCount,r.outgoingCandidateCount-r.reverseSupportedCount-r.reverseInconclusiveCount);};
const compare=async(f,opts={},mockOpts={},gpuOpts={})=>{
 const ref=await archived(f.centers,f.geometry,opts),cpu=await current(f.centers,f.geometry,opts);same(cpu,ref);assert.equal(cpu.reverseNodeVisits,ref.reverseNodeVisits);
 const mock=reverseGpuDouble(mockOpts);const r=await current(f.centers,f.geometry,{...opts,accelerateReverse:c=>createSnsReverseSearch(c,{gpu:mock.gpu,...gpuOpts})});same(r,ref);assert.equal(mock.stats.buffers,mock.stats.bufferDestroyed);assert.equal(mock.stats.devices,mock.stats.destroyed);assert.equal(mock.stats.scopes,0);return {r,mock,ref};
};
test('REVGPU-01 archived asymmetric support and true isolation; accepted GPU leaf replay',async()=>{
 const f=fixture([[0,0,0],[10,0,0],[100,0,0]],[.1,4,.1]);const {r}=await compare(f,{cellWidth:2});assert.deepEqual([...r.candidateMask],[0,0,1]);assert.equal(r.reverseSupportedCount,1);assert.ok(r.reverseAcceleration.replayed_sources>0);assert.equal(r.reverseAcceleration.backend,'webgpu+cpu');
});
test('REVGPU-02 distinct incoming-only support and mutual deduplication, locked/invalid/Stage1-inconclusive sources',async()=>{
 const p=[[0,0,0],[.5,0,0],[4,0,0],[5,0,0],[100,0,0],[10000,0,0],[20000,0,0]],f=fixture(p,[.3,.3,2,2,100,.01,.01],{locked:[2,6],invalid:[3]});
 for(const m of [1,2,3,50])await compare(f,{minSupport:m,cellWidth:.5,maxCellsPerQuery:1024});
});
test('REVGPU-03 sparse multilevel tree, seeded anisotropy, transformed geometry and all k/m limits',async()=>{
 let seed=54321;const rand=()=>((seed=Math.imul(seed,1664525)+1013904223|0)>>>0)/2**32;
 const p=Array.from({length:220},(_,i)=>[i%18+rand()*.1,Math.floor(i/18)*1.1+rand()*.1,rand()*3]);
 const scales=p.map((_,i)=>i%9===0?[2,.3,1]:[.04,.03,.08]),quats=p.map(()=>{const a=rand()*Math.PI;return [Math.cos(a),0,0,Math.sin(a)];});
 for(const k of [1,3,5,10])for(const m of [1,2,5,50]){const f=fixture(p,scales,{k,quats,transforms:p.map((_,i)=>i%2?S:I),locked:[5,21],invalid:[7,13]});const {r}=await compare(f,{k,minSupport:m,cellWidth:5});assert.ok(r.reverseAcceleration?.replayed_sources>0);}
});
test('REVGPU-04 tiny reference budgets preserve uncertainty and later rescue; exact masks/counts',async()=>{
 const p=[[0,0,0],...Array.from({length:80},(_,i)=>[i+1,i%3,0]),...Array.from({length:80},(_,i)=>[1000+i,i%2,0])],f=fixture(p,[30,...p.slice(1).map(()=>.02)]);
 for(const cap of [1,3,10,33,65])for(const m of [1,2]){const {r}=await compare(f,{cellWidth:1,minSupport:m,maxReverseNodesPerQuery:cap,maxReverseComparisonsPerQuery:cap});assert.ok(r.reverseBudgetLimitedSources>0);}
});
test('REVGPU-05 oversized static tree query uses CPU, after replay active candidate counts remain exact',async()=>{
 const p=Array.from({length:1100},(_,i)=>[i,0,0]);const f=fixture(p,p.map((_,i)=>i===999?500:.01));const {r}=await compare(f,{cellWidth:1,maxCellsPerQuery:10});assert.ok(r.reverseAcceleration.cpu_sources>0);assert.ok(r.reverseAcceleration.replayed_sources>0);assert.ok(r.reverseSupportedCount>0);
});
test('REVGPU-06 cancellation and resource cleanup; reject failed or corrupted batch before replay',async()=>{
 const p=Array.from({length:81},(_,i)=>[i,0,0]),f=fixture(p,p.map((_,i)=>i===40?5:.01));const opts={cellWidth:1};
 const {r}=await compare(f,opts,{failAt:2,failMessage:'Device was lost before MapAsync completed'},{batch:16});assert.equal(r.reverseAcceleration.device_lost,true);assert.ok(r.reverseAcceleration.replayed_sources>0);assert.ok(r.reverseAcceleration.cpu_sources>0);
 await compare(f,opts,{scopeErrorAt:2},{batch:16});await compare(f,opts,{corrupt:true},{batch:16});
 let cancelled=false;const mock=reverseGpuDouble({cancel:()=>cancelled=true});await assert.rejects(current(f.centers,f.geometry,{...opts,cancelled:()=>cancelled,accelerateReverse:c=>createSnsReverseSearch(c,{gpu:mock.gpu})}),/cancelled/);assert.equal(mock.stats.buffers,mock.stats.bufferDestroyed);
});
test('REVGPU-07 device storage rejection and skip reverse GPU after outgoing device loss',async()=>{
 const f=fixture([[0,0,0],[10,0,0],[100,0,0]],[.1,4,.1]);const {r,mock}=await compare(f,{cellWidth:2},{limitOverride:{maxStorageBufferBindingSize:16}});assert.equal(r.reverseAcceleration.backend,'cpu');assert.equal(mock.stats.devices,0);
 const ref=await archived(f.centers,f.geometry,{cellWidth:2});const result=await current(f.centers,f.geometry,{cellWidth:2,accelerate:async()=>({diagnostics:{device_lost:true}}),accelerateReverse:()=>{throw Error('must not run');}});same(result,ref);
});
test('REVGPU-08 conservative integer bounds include all CPU radial overlaps at boundary/extreme coordinate scales',()=>{
 let seed=12;const rand=()=>((seed=Math.imul(seed,1664525)+1013904223|0)>>>0)/2**32;let hits=0;
 for(let i=0;i<15000;i++){const base=(rand()-.5)*10**(rand()*200-100),r=10**(rand()*200-100),x=base+(rand()-.5)*r;
  const c={x:Float64Array.of(x),y:Float64Array.of(0),z:Float64Array.of(0)},g={valid:Uint8Array.of(1),radii:Float64Array.of(r)},point=x+(rand()-.5)*2*r,root={lo:[Math.min(x,point)-r,0,0],hi:[Math.max(x,point)+r,0,0]},q=reverseQuantizer(root),packed=new Uint32Array(8);
  if(!packReverseSource(c,g,0,q,packed,0))continue;const d=point-x;if(d*d<=r*r){hits++;const v=q(point,0);assert.ok(v>=packed[0]&&v<=packed[3]);}
 }assert.ok(hits>10000);
 assert.throws(()=>reverseGpuPlan(100, {...limits,maxBufferSize:16}),/limits/);
});
test('REVGPU-09 independent brute force oracle for exact unbounded bidirectional support',async()=>{
 const p=Array.from({length:117},(_,i)=>[i%13,Math.floor(i/13),i%4*.1]),f=fixture(p,p.map((_,i)=>i%7===0?1:.12),{locked:[11],invalid:[3]});
 for(const m of [1,2,7,50]){
  const {r}=await compare(f,{minSupport:m,cellWidth:5});const {centers:c,geometry:g}=f;
  for(let i=0;i<p.length;i++){
   const count=p.filter((_,j)=>g.valid[j]&&i!==j&&(insideSnsEllipsoid(c,i,j,g,3)||insideSnsEllipsoid(c,j,i,g,3))).length;
   assert.equal(r.candidateMask[i],Number(g.valid[i]&&!g.locked[i]&&count<m));
  }
 }
});

test('REVGPU-10 optional reference audit compares instance membership even when candidate totals match',async()=>{
 const {compareSnsResults}=await import('../sns-support.mjs');const f=fixture([[0,0,0],[10,0,0],[100,0,0]],[.1,4,.1]);
 const ref=await current(f.centers,f.geometry,{cellWidth:2});assert.equal((await compareSnsResults(ref,ref)).match,true);
 const other={...ref,candidateMask:Uint8Array.of(1,0,0)};const d=await compareSnsResults(other,ref);assert.equal(d.match,false);assert.equal(d.differences.candidateMask,2);assert.deepEqual(d.first_candidate_differences,[0,2]);
});

test('REVGPU-11 GPU pilot begins at CPU sample offset and stops when measured overhead is excessive',async()=>{
 const n=20000,f=fixture(Array.from({length:n},(_,i)=>[i,0,0]),Array(n).fill(.01));
 const root={lo:[100,0,0],hi:[101,0,0],start:0,end:2,remaining:2};
 const mock=reverseGpuDouble();const backend=createSnsReverseSearch({...f,root,maxReverseNodesPerQuery:16384,maxReverseComparisonsPerQuery:100000,startOffset:8192,cpuSampleMs:0},{gpu:mock.gpu});
 let count=0;for await(const b of backend.batches){assert.equal(b.offset,8192+count);count+=b.count;}
 assert.equal(count,8192);assert.match(backend.diagnostics.reason,/pilot slower/);assert.ok(backend.diagnostics.hybrid_sample_ms>=0);assert.equal(mock.stats.buffers,mock.stats.bufferDestroyed);
});
