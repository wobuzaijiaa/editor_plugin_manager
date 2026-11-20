import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {__testing} from '../index.js';
import {analyzeDensity,analyzeComponents,computeSelection} from '../core.mjs';
import {analyzeSnsBidirectionalSupport,gaussianMetric,readSnsGeometry} from '../sns-support.mjs';
import {autoVoxelResolution} from '../auto-voxel.mjs';
const read = name=>readFileSync(new URL('../'+name,import.meta.url),'utf8');
const pts = p=>Object.fromEntries(['x','y','z'].map((a,i)=>[a,Float64Array.from(p,v=>v[i])]));
const I=[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1];

test('CAP-01 UI range and defaults; existing single SNS and Apply controls',()=>{
    const html=read('index.js');
    assert.match(html,/id="sc-sns-k" type="number" min="1" max="10" step="0.5" value="3"/);
    assert.match(html,/id="sc-sns-m" type="number" min="1" max="50" step="1" value="1"/);
    assert.match(html,/id="sc-component-max" type="number" min="1" max="1000000" step="10" value="500"/);
    for(const id of ['sc-apply','sc-sns-find'])assert.equal(html.match(new RegExp(`id="${id}"`,'g')).length,1);
    assert.deepEqual(__testing.validatedSnsParameters('10','50'),{k:10,m:50});
    for(const [k,m] of [[10.5,1],[3,51],[3,1.5],[9.7,1]])assert.throws(()=>__testing.validatedSnsParameters(k,m));
    assert.equal(__testing.MAX_UNVALIDATED_GPU_FLOATERS,undefined);
});
test('CAP-02 actual SNS search supports m=50 and k=10, counts do not overflow',async()=>{
    const n=51, k=10,c=pts(Array.from({length:n},(_,i)=>[i/10,0,0]));
    const g=gaussianMetric([1,0,0,0],[0,0,0],I,k);
    const geometry={k,inverse:new Float32Array(n*9),radii:new Float64Array(n).fill(g.radius),valid:new Uint8Array(n).fill(1),locked:new Uint8Array(n)};
    for(let i=0;i<n;i++)geometry.inverse.set(g.inverse,9*i);
    const r=await analyzeSnsBidirectionalSupport(c,geometry,{k,minSupport:50});
    assert.equal(r.candidateCount,0);assert.equal(r.supportedCount,n);assert.ok(r.supportCount.every(v=>v===50));
    assert.equal(r.outgoingCellBudget,16384);assert.equal(r.outgoingComparisonBudget,100000);
    assert.equal(r.reverseNodeBudget,16384);assert.equal(r.reverseComparisonBudget,100000);
    await assert.rejects(analyzeSnsBidirectionalSupport(c,geometry,{k,minSupport:51}),/1–50/);
    await assert.rejects(readSnsGeometry(null,null,{k:10.5}),/1–10/);
});
test('CAP-03 expanded default density and component resolution remain valid and configurable',async()=>{
    const c=pts(Array.from({length:1000},(_,i)=>[i%10,Math.floor(i/10)%10,Math.floor(i/100)]));
    const d=await analyzeDensity(c);assert.equal(d.resolution,128);assert.equal(d.classCounts.reduce((a,b)=>a+b,0),1000);
    const old=await analyzeDensity(c,{resolution:64});assert.equal(old.resolution,64);
    // Effective divisions depend on N; dense enough input to distinguish 48 vs 96.
    const n=270000,large={x:new Float64Array(n),y:new Float64Array(n),z:new Float64Array(n)};
    for(let i=0;i<n;i++){large.x[i]=i%100;large.y[i]=Math.floor(i/100)%100;large.z[i]=Math.floor(i/10000);}
    const comp=await analyzeComponents(large);assert.ok(comp.resolutionDivisions>48&&comp.resolutionDivisions<=96);assert.equal(comp.sizes.reduce((a,b)=>a+b,0),n);
    assert.ok(comp.occupiedCells<=500000);
});
test('CAP-04 1M component threshold is accepted by computeSelection and tint eligibility',()=>{
    const c=pts([[0,0,0],[1,0,0],[2,0,0]]),d={classes:new Uint8Array(3)},component={labels:Uint32Array.of(0,0,1),sizes:Uint32Array.of(2,1),largestId:0};
    const config={roi:{x:{min:0,max:2},y:{min:0,max:0},z:{min:0,max:0}},density:'all',floaterEnabled:true,maxComponentGaussians:1_000_000};
    const s=computeSelection(c,d,config,{components:component});assert.deepEqual([...s.candidates],[0,0,1]);
    assert.throws(()=>computeSelection(c,d,{...config,maxComponentGaussians:1_000_001},{components:component}),/1000000/);
    assert.equal(__testing.methodTintEligible('floaters',{data:{centers:c},density:d,components:component,componentMax:1_000_000}),true);
});
test('CAP-05 fixed voxel defaults independent of diagnostic grid size',()=>{
    const n=1000,c={x:new Float32Array(n),y:new Float32Array(n),z:new Float32Array(n),scale_0:new Float32Array(n).fill(-9),scale_1:new Float32Array(n).fill(-9),scale_2:new Float32Array(n).fill(-9)};
    for(let i=0;i<n;i++){c.x[i]=i%10;c.y[i]=Math.floor(i/10)%10;c.z[i]=Math.floor(i/100);}
    const a=autoVoxelResolution(c);assert.equal(a.voxelResolution,0.05);assert.equal(a.scaleSampleLimit,8192);assert.ok(a.estimatedGridCells>2_000_000);
    const b=autoVoxelResolution(c,{sampleSize:16384});assert.equal(b.estimatedGridCells,a.estimatedGridCells);assert.equal(b.voxelResolution,a.voxelResolution);
    assert.equal(a.opacityCutoff,.1);assert.equal(a.minContribution,1/255);
});
test('NATIVE-CTRL preflight on each click before base analysis, cache lookup or geometry; native failure isolated',()=>{
 const src=read('index.js'),fn=src.slice(src.indexOf('async function doSplatTransformFloaters()'),src.indexOf('async function doExport()'));
 const preflight=fn.indexOf('await detectNativeSplatTransform(');assert.ok(preflight>=0);
 for(const marker of ['await doAnalyze()','if(stMask && stDetails','await readFloaterColumns(','await restore('])assert.ok(preflight<fn.indexOf(marker),marker);
 assert.match(fn,/runtime_identity===info.identity/);assert.match(fn,/stDetails.gpu_backend===info.gpu_backend/);assert.match(fn,/saved.gpuBackend===config.gpuBackend/);assert.match(fn,/info.gpu_backend===config.gpuBackend/);assert.match(fn,/execution_backend:'system_splat_transform_cli_ply'/);assert.match(fn,/if\(fresh\)/);
 assert.doesNotMatch(fn,/gpuUnavailable=true|checkFloaterCapacity|loadSplatTransformBridge/);assert.match(src,/outgoing_search_limits:/);
 assert.equal((fn.match(/await runSplatTransformFloaters\(/g)||[]).length,1);
});
