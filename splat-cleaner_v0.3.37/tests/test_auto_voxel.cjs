const test=require('node:test');
const assert=require('node:assert/strict');
const {pathToFileURL}=require('node:url');
const {resolve}=require('node:path');
const promise=import(pathToFileURL(resolve(__dirname,'..','auto-voxel.mjs')).href);
function fixture(n=1200,s=0.03, factor=1) {
    const c={x:new Float32Array(n),y:new Float32Array(n),z:new Float32Array(n),
        scale_0:new Float32Array(n),scale_1:new Float32Array(n),scale_2:new Float32Array(n)};
    for(let i=0;i<n;i++){
        c.x[i]=factor*((i%100)/10);c.y[i]=factor*((Math.floor(i/100)%12)/10);
        c.z[i]=factor*(i%7)/100;
        c.scale_0[i]=Math.log(s*factor*0.1);c.scale_1[i]=Math.log(s*factor);c.scale_2[i]=Math.log(s*factor*4);
    }
    return c;
}
test('AUTO-01 fixed voxel policy matches all upstream defaults',async()=>{
    const {autoVoxelResolution}=await promise;
    const result=autoVoxelResolution(fixture());
    assert.equal(result.voxelResolution,0.05);
    assert.equal(result.opacityCutoff,0.1);assert.equal(result.minContribution,1/255);
    assert.equal(result.policy,'splat_transform_default_fixed_v1');
    assert(Number.isFinite(result.estimatedGridCells)&&result.estimatedGridCells>0);
    assert(!('maxEstimatedGridCells' in result));
    assert(!('initialMaxAxisCells' in result));
});
test('AUTO-02 uniform model scaling changes diagnostics but not fixed world-space width',async()=>{
    const {autoVoxelResolution}=await promise;
    const a=autoVoxelResolution(fixture(1000,0.02,1));
    const b=autoVoxelResolution(fixture(1000,0.02,7));
    assert.equal(a.voxelResolution,0.05);
    assert.equal(b.voxelResolution,0.05);
    assert(Math.abs(a.medianMiddleScale*7-b.medianMiddleScale)/b.medianMiddleScale<1e-5);
    assert(b.estimatedGridCells>a.estimatedGridCells);
});
test('AUTO-03 extreme logarithmic scales and malformed arrays fail closed',async()=>{
    const {autoVoxelResolution}=await promise;
    const c=fixture();c.scale_1[0]=NaN;
    assert.throws(()=>autoVoxelResolution(c),/Invalid Gaussian log-scale/);
    assert.throws(()=>autoVoxelResolution({x:new Float32Array(1)}),/Incomplete instance-aligned/);
    c.scale_1[0]=1000;
    assert.throws(()=>autoVoxelResolution(c),/Invalid Gaussian radius/);
    c.scale_1[0]=-3;c.x[0]=Infinity;
    assert.throws(()=>autoVoxelResolution(c),/Invalid Gaussian center/);
});
test('AUTO-04 large grids are diagnostic only and never trigger automatic coarsening',async()=>{
    const {autoVoxelResolution}=await promise;
    const c=fixture(50_000,0.0001);
    for(let i=0;i<c.x.length;i++){c.x[i]=i%1000;c.y[i]=Math.floor(i/1000);c.z[i]=i%100;}
    const result=autoVoxelResolution(c);
    assert(result.estimatedGridCells>1_000_000_000);
    assert.equal(result.voxelResolution,0.05);
    // Historical grid budget options no longer affect the policy.
    assert.deepEqual(autoVoxelResolution(c,{maxCells:100000,maxAxisCells:1}),result);
});
test('AUTO-05 coincident centers retain Gaussian extent diagnostics',async()=>{
    const {autoVoxelResolution}=await promise;
    const c=fixture(20);c.x.fill(1);c.y.fill(2);c.z.fill(3);
    const result=autoVoxelResolution(c);
    assert.equal(result.voxelResolution,0.05);
    assert(result.estimatedGaussianExtent.every(x=>x>0));
});
test('AUTO-06 translation does not change fixed voxel width',async()=>{
    const {autoVoxelResolution}=await promise;
    const c=fixture(),a=autoVoxelResolution(c);
    c.x=c.x.map(x=>x+50);c.y=c.y.map(y=>y-14);
    const b=autoVoxelResolution(c);
    assert.equal(a.voxelResolution,0.05);
    assert.equal(b.voxelResolution,0.05);
    assert.equal(a.medianMiddleScale,b.medianMiddleScale);
});
test('AUTO-07 scale sampling affects diagnostics only; invalid options fail closed',async()=>{
    const {autoVoxelResolution}=await promise;
    const c=fixture();const a=autoVoxelResolution(c,{sampleSize:10});
    assert.equal(a.scaleSampleLimit,10);assert.equal(a.voxelResolution,0.05);
    for(const sampleSize of [0,-1,0.5,NaN,Infinity])
        assert.throws(()=>autoVoxelResolution(c,{sampleSize}),/Invalid Gaussian scale sample limit/);
});
