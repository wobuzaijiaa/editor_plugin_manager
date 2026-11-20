const {test}=require('node:test');
const assert=require('node:assert/strict');
const path=require('node:path');
const {pathToFileURL}=require('node:url');
const {readFile}=require('node:fs/promises');
const root=path.resolve(__dirname,'..');
const imp=name=>import(pathToFileURL(path.join(root,name)).href);
const i=imp('index.js'),core=imp('core.mjs'),sns=imp('sns-support.mjs'),voxel=imp('auto-voxel.mjs');
const identity=Float32Array.from([1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1]);
const centers=points=>({x:Float64Array.from(points.map(p=>p[0])),y:Float64Array.from(points.map(p=>p[1])),z:Float64Array.from(points.map(p=>p[2]))});
function geometry(points,k,scale=1){
    return sns.then(({gaussianMetric})=>{
        const n=points.length,inverse=new Float32Array(n*9),radii=new Float64Array(n);
        for(let x=0;x<n;x++){
            const g=gaussianMetric([1,0,0,0],[scale,scale,scale].map(Math.log),identity,k);
            inverse.set(g.inverse,x*9);radii[x]=g.radius;
        }
        return {inverse,radii,valid:new Uint8Array(n).fill(1),locked:new Uint8Array(n),k};
    });
}
test('R31-01 adjustable numeric SNS inputs validate k=3,m=1 and reject off-step values',async()=>{
    const {__testing}=await i;
    assert.deepEqual(__testing.validatedSnsParameters('3','1'),{k:3,m:1});
    assert.deepEqual(__testing.validatedSnsParameters('2.5','4'),{k:2.5,m:4});
    for(const args of [['2.3','1'],['0','1'],['10.5','1'],['3','0'],['3','51'],['3','1.5']])
        assert.throws(()=>__testing.validatedSnsParameters(...args));
});
test('R31-02 changing k changes support; changing m counts more than one neighbor in a cell',async()=>{
    const {analyzeSnsSupport}=await sns;
    const p=[[0,0,0],[2.5,0,0],[10,0,0]],c=centers(p);
    const two=await analyzeSnsSupport(c,await geometry(p,2),{k:2,cellWidth:1});
    const three=await analyzeSnsSupport(c,await geometry(p,3),{k:3,cellWidth:1});
    assert.equal(two.candidateMask[0],1);
    assert.equal(three.candidateMask[0],0);
    assert.equal(three.inconclusiveCount,0);
    await assert.rejects(analyzeSnsSupport(c,await geometry(p,2),{k:3}),/different k/);
    const q=[[0,0,0],[0.1,0,0],[0.2,0,0]],g=await geometry(q,3);
    const twoNeighbors=await analyzeSnsSupport(centers(q),g,{k:3,minSupport:2,cellWidth:4});
    assert.deepEqual(Array.from(twoNeighbors.candidateMask),[0,0,0]);
    const threeNeighbors=await analyzeSnsSupport(centers(q),g,{k:3,minSupport:3,cellWidth:4});
    assert.deepEqual(Array.from(threeNeighbors.candidateMask),[1,1,1]);
});
test('R31-03 independent SNS and GPU masks compose via OR and scope; overlap counted once',async()=>{
    const {computeSelection,previewHidden,subsetRuns}=await core;
    const p=[[0,0,0],[1,0,0],[2,0,0],[3,0,0],[4,0,0]],c=centers(p);
    const density={classes:new Uint8Array(5)};
    const scope={x:{min:0,max:3},y:{min:0,max:0},z:{min:0,max:0}};
    const snsMask=Uint8Array.from([1,0,1,0,1]);
    const splatTransformMask=Uint8Array.from([0,0,1,1,1]);
    const both=computeSelection(c,density,{roi:scope,density:'all',snsEnabled:true,splatTransformEnabled:true},
        {snsMask,splatTransformMask});
    assert.deepEqual(Array.from(both.candidates),[1,0,1,1,0]);
    assert.equal(both.candidateCount,3);
    assert.equal(both.ruleCounts.sns,2);
    assert.equal(both.ruleCounts.splatTransformFloaters,2);
    assert.equal(both.snsGpuOverlap,1);
    assert.deepEqual(subsetRuns(both.candidates).runs,[[1,1],[4,1]]);
    assert.deepEqual(Array.from(previewHidden(both,'original',false)),[0,0,0,0,0]);
    assert.deepEqual(Array.from(previewHidden(both,'cleaned',false)),[1,0,1,1,0]);
    assert.deepEqual(Array.from(previewHidden(both,'candidates',false)),[0,1,0,0,1]);
    const gpuOnly=computeSelection(c,density,{roi:scope,density:'all',splatTransformEnabled:true},{splatTransformMask});
    assert.deepEqual(Array.from(gpuOnly.candidates),[0,0,1,1,0]);
    const snsOnly=computeSelection(c,density,{roi:scope,density:'all',snsEnabled:true},{snsMask});
    assert.deepEqual(Array.from(snsOnly.candidates),[1,0,1,0,0]);
});
test('R31-04 failed native GPU flush reverts CPU flags and never retries restore upload',async()=>{
    const {__testing}=await i;
    const flags=Uint8Array.from([0,1,2,4]);
    let uploads=0;
    const instances={count:flags.length,flags,sourceRow:Uint32Array.from([0,1,2,3]),palette:new Uint32Array(4),
        clearBits(r,bit){r.forEach(i=>this.flags[i]&=~bit)},setBits(r,bit){r.forEach(i=>this.flags[i]|=bit)},
        flush(){uploads++;throw new TypeError("Failed to execute 'writeBuffer' on 'GPUQueue': parameter 1 is not of type 'GPUBuffer'.")}};
    const matrix=()=>({data:identity,clone(){return matrix()},equals(other){return Array.from(this.data).every((v,j)=>v===other.data[j]);},
        mul2(){return this;}});
    const scene={elements:[]},splat={visible:true,instances,worldTransform:matrix(),
        transformPalette:{getTransform(){}},resource:{source:{}},scene};scene.elements.push(splat);
    const preview=new __testing.Preview(splat,{transformMap:new Map([[0,matrix()]])});
    assert.throws(()=>preview.setHidden(scene,Uint8Array.from([1,0,0,1])),/GPUBuffer/);
    assert.deepEqual(Array.from(flags),[0,1,2,4]);
    assert.equal(preview.uploadFailed,true);
    assert.throws(()=>preview.restore(scene),/reload the Editor/);
    assert.equal(uploads,1);
});
test('R31-05 GPU floater policy uses upstream defaults with no fixed instance ceiling',async()=>{
    const {autoVoxelResolution}=await voxel;
    const n=4,columns={x:Float32Array.from([0,1,2,3]),y:new Float32Array(n),z:new Float32Array(n),
        scale_0:Float32Array.from({length:n},()=>Math.log(.02)),scale_1:Float32Array.from({length:n},()=>Math.log(.02)),
        scale_2:Float32Array.from({length:n},()=>Math.log(.02))};
    const r=autoVoxelResolution(columns);
    assert.equal(r.policy,'splat_transform_default_fixed_v1');
    assert.equal(r.voxelResolution,0.05);
    assert.equal(r.opacityCutoff,0.1);assert.equal(r.minContribution,1/255);
    const {__testing}=await i;
    assert.equal(__testing.MAX_UNVALIDATED_GPU_FLOATERS,undefined);
});
test('R31-06 analysis does not auto-enable cleaning rules; status poll does not throw',async()=>{
    const source=await readFile(path.join(root,'index.js'),'utf8');
    assert.doesNotMatch(source,/get\('sc-sns-enabled'\)\.checked\s*=\s*true/);
    assert.doesNotMatch(source,/get\('sc-st-enabled'\)\.checked\s*=\s*true/);
    assert.match(source,/isRunning\(\)\s*\{\s*\/\//);
    assert.match(source,/gpuUnavailable=true/);
    assert.match(source,/const \{k,m\}=snsParameters\(\)/);
});
test('R31-07 all-invalid geometry has consistent inconclusive mask and count',async()=>{
    const {analyzeSnsSupport}=await sns;
    const n=3,c=centers([[0,0,0],[1,0,0],[2,0,0]]);
    const g={inverse:new Float32Array(n*9),radii:new Float64Array(n),valid:new Uint8Array(n),locked:new Uint8Array(n),k:3};
    const r=await analyzeSnsSupport(c,g,{k:3});
    assert.equal(r.inconclusiveCount,3);
    assert.deepEqual(Array.from(r.inconclusiveMask),[1,1,1]);
    assert.deepEqual(Array.from(r.candidateMask),[0,0,0]);
});
