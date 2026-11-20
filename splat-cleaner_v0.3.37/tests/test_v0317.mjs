import test from 'node:test';
import assert from 'node:assert/strict';
import {analyzeSnsSupport,analyzeSnsBidirectionalSupport as run,gaussianMetric,compareSnsResults} from '../sns-support.mjs';
import {analyzeSnsBidirectionalSupport as legacy} from '../reference/sns-support-v0310.mjs';
import {auditSnsCompatibility,candidateTransitions,LEGACY_BUDGETS,CURRENT_BUDGETS} from '../sns-audit.mjs';
const I=[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1];
function fixture(p,s,{k=3,locked=[],invalid=[]}={}){
 const n=p.length,c=Object.fromEntries(['x','y','z'].map((a,i)=>[a,Float64Array.from(p,v=>v[i])]));
 const g={k,valid:new Uint8Array(n),locked:new Uint8Array(n),inverse:new Float32Array(9*n),radii:new Float64Array(n)};
 for(let i=0;i<n;i++){if(locked.includes(i))g.locked[i]=1;if(invalid.includes(i))continue;const a=s[i]??.1;const metric=gaussianMetric([1,0,0,0],(Array.isArray(a)?a:[a,a,a]).map(Math.log),I,k);assert.ok(metric);g.inverse.set(metric.inverse,9*i);g.radii[i]=metric.radius;g.valid[i]=1;}return [c,g];
}
async function same(a,b){assert.equal((await compareSnsResults(a,b)).match,true);for(const key of ['reverseNodeVisits','reverseComparisons','validCount','cellWidth'])assert.deepEqual(a[key],b[key],key);}
test('SNS17-01 historical reference: same budget and candidate membership, distinct incoming/mutual support',async()=>{
 const [c,g]=fixture([[0,0,0],[10,0,0],[100,0,0],[100.1,0,0],[200,0,0],[1000,0,0]],[.1,4,.2,.2,.1,.1],{locked:[1],invalid:[5]});
 for(const m of [1,2,5,10])await same(await run(c,g,{minSupport:m,...LEGACY_BUDGETS}),await legacy(c,g,{minSupport:m,...LEGACY_BUDGETS}));
});
test('SNS17-02 sparse CPU matches old traversal and literal v0.3.10 with same budgets on mixed bounds',async()=>{
 const p=Array.from({length:240},(_,i)=>[(i%20)*.63,Math.floor(i/20)*.64,(i%3)*.01]);
 const [c,g]=fixture(p,p.map((_,i)=>i%5===0?[1.1,.3,.5]:.08),{locked:[5,13,40],invalid:[7,42]});let sparse=0;
 for(const m of [1,2,5,10])for(const cellWidth of [.2,.4,1])for(const cap of [25,50000]){
  const opts={...LEGACY_BUDGETS,minSupport:m,cellWidth,maxComparisonsPerQuery:cap};const a=await run(c,g,opts);sparse+=a.outgoingCpuSearch.sparse_queries;
  await same(a,await run(c,g,{...opts,sparseCpu:false}));await same(a,await legacy(c,g,opts));
 }assert.ok(sparse>0);
});
test('SNS17-03 sparse traversal preserves comparison-budget cutoffs and own-cell priority',async()=>{
 const [c,g]=fixture([[0,0,0],[.02,0,0],[.04,0,0],[-1.9,0,0],[1.9,0,0],[2.1,0,0],[20,0,0]],[1,.01,.01,.01,.01,.01,1]);
 for(const m of [1,2,3,4,5,6])for(const maxComparisonsPerQuery of [1,2,3,10]){const o={cellWidth:.5,minSupport:m,maxComparisonsPerQuery};await same(await run(c,g,o),await run(c,g,{...o,sparseCpu:false}));}
});
test('SNS17-04 historical audit explains extra candidates without reverting current budgets',async()=>{
 const [c,g]=fixture([[0,0,0],[100,0,0],[200,0,0],[300,0,0],[400,0,0]],[.1,.1,.1,.1,1.05]);
 const r=await run(c,g);const {result,verification:v}=await auditSnsCompatibility(r,c,g,{includeHistory:true});
 assert.equal(v.match,true);assert.equal(v.historical.status,'compared');assert.equal(result,r);assert.equal(v.historical.reference.final_candidates,4);assert.equal(r.candidateCount,5);assert.equal(v.historical.current_vs_legacy.added_from_inconclusive,1);assert.equal(v.historical.current_vs_legacy.added_from_other_retained,0);assert.equal(v.historical.comparison.match,false);
});
test('SNS17-05 same-count membership mismatch selects current CPU (not historical budget result)',async()=>{
 const [c,g]=fixture([[0,0,0],[10,0,0],[100,0,0]],[.1,4,.1]);const r=await run(c,g);
 const corrupted={...r,candidateMask:Uint8Array.of(1,0,0)};const {result,verification:v}=await auditSnsCompatibility(corrupted,c,g,{includeHistory:true});assert.equal(v.match,false);assert.equal(v.differences.candidateMask,2);assert.equal(v.result_used,'cpu_reference');assert.deepEqual(result.candidateMask,r.candidateMask);assert.deepEqual(v.hybrid_vs_current_cpu.first_added,[0]);assert.deepEqual(v.hybrid_vs_current_cpu.first_removed,[2]);assert.equal(v.historical.comparison.match,true);
});
test('SNS17-06 historical k/m unsupported: audit current reference, never clamp',async()=>{
 const [c,g]=fixture([[0,0,0],[100,0,0]],[.1,.1],{k:6});const r=await run(c,g,{k:6,minSupport:11});const a=await auditSnsCompatibility(r,c,g,{k:6,minSupport:11,includeHistory:true});assert.equal(a.verification.match,true);assert.equal(a.verification.historical.status,'not_applicable');assert.equal(a.result,r);
});
test('SNS17-07 progress and exact CPU search counts distinguish fully resolved acceleration from fallback',async()=>{
 const [c,g]=fixture([[0,0,0],[10,0,0],[20,0,0]],[.1,.1,.1]);let stages=[];
 const a=await analyzeSnsSupport(c,g,{accelerate:async()=>({exact:new Uint8Array(3).fill(1),exactCounts:new Uint8Array(3)}),progress:(_d,_n,s)=>stages.push(s)});assert.equal(a.outgoingCpuSearch.queries,0);assert.deepEqual([...new Set(stages)],['outgoing-finalize']);
 stages=[];const b=await analyzeSnsSupport(c,g,{accelerate:async()=>({exact:Uint8Array.of(1,0,0),exactCounts:new Uint8Array(3)}),progress:(_d,_n,s)=>stages.push(s)});assert.equal(b.outgoingCpuSearch.queries,2);assert.equal(b.outgoingCpuSearch.candidates,2);assert.ok(stages.includes('outgoing-cpu-search'));assert.ok(stages.includes('outgoing-finalize'));
});
test('SNS17-08 cancellation before sparse directory and during membership verification',async()=>{
 const [c,g]=fixture([[0,0,0],[100,0,0]],[1,1]);let stop=false;
 await assert.rejects(analyzeSnsSupport(c,g,{cellWidth:.5,progress:(_d,_n,s)=>{if(s==='outgoing-cpu-directory')stop=true;},cancelled:()=>stop}),/cancelled/);
 const r=await run(c,g);await assert.rejects(candidateTransitions(r,r,{cancelled:()=>true}),/cancelled/);
});
test('SNS17-09 CPU budget counters account for every searched valid query',async()=>{
 const [c,g]=fixture([[0,0,0],[.01,0,0],[.02,0,0],[100,0,0],[1000,0,0]],[.1,.1,.1,100,.1],{locked:[4]});
 const r=await analyzeSnsSupport(c,g,{cellWidth:.1,minSupport:3,maxComparisonsPerQuery:1});const d=r.outgoingCpuSearch;assert.equal(d.queries,5);assert.ok(d.comparison_budget_limited>0);assert.ok(d.cell_budget_limited>0);assert.equal(d.queries,d.supported+d.candidates+d.locked_excluded+d.cell_budget_limited+d.comparison_budget_limited);
});
test('SNS17-12 avoid building a full sparse directory for a handful of unresolved queries',async()=>{
 const n=3000,[c,g]=fixture(Array.from({length:n},(_,i)=>[i*20,0,0]),Array(n).fill(1));const exact=new Uint8Array(n).fill(1);exact[0]=0;
 const o={cellWidth:.5,accelerate:async()=>({exact,exactCounts:new Uint8Array(n)})};const a=await analyzeSnsSupport(c,g,o),b=await analyzeSnsSupport(c,g,{...o,sparseCpu:false});assert.equal(a.outgoingCpuSearch.queries,1);assert.equal(a.outgoingCpuSearch.sparse_queries,0);assert.deepEqual(a.candidateMask,b.candidateMask);
});
