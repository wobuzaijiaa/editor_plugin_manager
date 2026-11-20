const {test}=require('node:test');
const assert=require('node:assert/strict');
const path=require('node:path');
const {pathToFileURL}=require('node:url');
const ad=import(pathToFileURL(path.join(__dirname,'..','floater-adapter.mjs')).href);
const core=import(pathToFileURL(path.join(__dirname,'..','core.mjs')).href);
const identity=()=>Float32Array.from([1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1]);
const mat=arr=>({data:arr});
function input({withRotation=true,world=identity(),logit=true}={}) {
    const n=3;
    const meta={chunkSize:2,layouts:{position:{stride:12},geometric:{stride:32,fields:{
        rotation:withRotation?{components:4,type:'float32'}:undefined,
        scale:{components:3,type:'float32'},opacity:{components:1,type:'float32'}
    }}}};
    const row=Uint32Array.from([2,0,1]);
    const model={instances:{count:n,sourceRow:row,palette:new Uint32Array(n),transformIndex:()=>0},resource:{
        sourcePool:{acquire(){return {_fields:{},data:new ArrayBuffer(32),field(k){return this._fields[k];},release(){this.released=true;}};}},
        source:{meta,async read(req){
            if (req.geometric) {
                const inds=Array.from({length:req.count},(_,j)=>req.indices[req.indexOffset+j]);
                req.geometric._fields.rotation=Float32Array.from(inds.flatMap(()=>[1,0,0,0]));
                req.geometric._fields.scale=Float32Array.from(inds.flatMap(i=>[i/10,i/10,i/10]));
                req.geometric._fields.opacity=Float32Array.from(inds.map(i=>logit?i/2:0.5));
            }
        }}
    }};
    const analyzed={centers:{x:Float64Array.from([10,20,30]),y:Float64Array.from([1,2,3]),z:Float64Array.from([0,0,0])},transformMap:new Map([[0,mat(world)]])};
    return {model,analyzed};
}
test('ST-01 retained indices create exact original-instance candidate mask',async()=>{
    const {retainedIdsToMask}=await ad;
    assert.deepEqual(Array.from(retainedIdsToMask(4,Uint32Array.from([3,0,2]))),[0,1,0,0]);
    assert.deepEqual(Array.from(retainedIdsToMask(3,Uint32Array.from([0,1,2]))),[0,0,0]);
});
test('ST-02 duplicate, invalid, and noninteger IDs fail closed',async()=>{
    const {retainedIdsToMask}=await ad;
    for (const ids of [[0,0],[0,3],[0,-1],[0,1.5],[0,NaN]]) assert.throws(()=>retainedIdsToMask(3,ids),/invalid or duplicate/);
    assert.throws(()=>retainedIdsToMask(3,[0,1,2,3]),/too many/);
});
test('ST-03 uniform world rotation, scale, and translation are decoded',async()=>{
    const {worldRotationScale}=await ad;
    const m=Float32Array.from([0,2,0,0,-2,0,0,0,0,0,2,0,7,8,9,1]);
    const {scale,quaternion:q}=worldRotationScale(m);
    assert.equal(scale,2);
    assert.ok(Math.abs(q[0]-Math.SQRT1_2)<1e-6);
    assert.ok(Math.abs(q[3]-Math.SQRT1_2)<1e-6);
});
test('ST-04 nonuniform and reflected transforms are explicitly unavailable',async()=>{
    const {worldRotationScale}=await ad;
    const nonuniform=identity(); nonuniform[0]=2;
    assert.throws(()=>worldRotationScale(nonuniform),/rigid\/uniform/);
    const mirrored=identity();mirrored[0]=-1;
    assert.throws(()=>worldRotationScale(mirrored),/Mirrored/);
});
test('ST-05 reads instance-aligned geometry, source-row ordering, and world rotation',async()=>{
    const {readFloaterColumns}=await ad;
    const m=Float32Array.from([0,2,0,0,-2,0,0,0,0,0,2,0,7,8,9,1]);
    const {model,analyzed}=input({world:m});
    const c=await readFloaterColumns(model,analyzed,{opacityEncoding:'logit'});
    assert.deepEqual(Array.from(c._cleaner_instance_id),[0,1,2]);
    assert.deepEqual(Array.from(c.x),[10,20,30]);
    assert.ok(Math.abs(c.scale_0[0]-(0.2+Math.log(2)))<1e-6,'Uses source row #2 for instance #0');
    assert.ok(Math.abs(c.rot_0[0]-Math.SQRT1_2)<1e-6);
    assert.ok(Math.abs(c.rot_3[0]-Math.SQRT1_2)<1e-6);
    assert.deepEqual(Array.from(c.opacity),[1,0,0.5]);
});
test('ST-06 missing quaternion geometry fails closed',async()=>{
    const {readFloaterColumns}=await ad;
    const {model,analyzed}=input({withRotation:false});
    await assert.rejects(readFloaterColumns(model,analyzed,{opacityEncoding:'logit'}),/geometric.rotation/);
});
test('ST-07 linear opacity is converted back into SplatTransform logit',async()=>{
    const {readFloaterColumns}=await ad;
    const {model,analyzed}=input({logit:false});
    const c=await readFloaterColumns(model,analyzed,{opacityEncoding:'linear'});
    assert.ok(Array.from(c.opacity).every(x=>x===0));
});
test('ST-10 only in-scope GPU candidates are selected; outside ROI is retained',async()=>{
    const {computeSelection}=await core;
    const centers={x:Float64Array.from([0,1,2,3]),y:new Float64Array(4),z:new Float64Array(4)};
    const density={classes:new Uint8Array(4)};
    const roi={x:{min:1,max:2},y:{min:0,max:0},z:{min:0,max:0}};
    const cfg={roi,density:'all',splatTransformEnabled:true};
    const r=computeSelection(centers,density,cfg,{splatTransformMask:Uint8Array.from([1,1,0,1])});
    assert.deepEqual(Array.from(r.candidates),[0,1,0,0]);
    assert.equal(r.ruleCounts.splatTransformFloaters,1);
    assert.equal(r.retainedCount,3);
});
test('ST-11 enabled rule with missing GPU output cannot silently select zero',async()=>{
    const {computeSelection}=await core;
    const centers={x:Float64Array.from([0,1]),y:new Float64Array(2),z:new Float64Array(2)};
    const density={classes:new Uint8Array(2)};
    const roi={x:{min:0,max:1},y:{min:0,max:0},z:{min:0,max:0}};
    assert.throws(()=>computeSelection(centers,density,{roi,splatTransformEnabled:true}),/Run SplatTransform/);
});
test('ST-12 JSON provenance identifies GPU floater method and independent selection',async()=>{
    const {buildReport,computeSelection}=await core;
    const centers={x:Float64Array.from([0,1]),y:new Float64Array(2),z:new Float64Array(2)};
    const density={classes:new Uint8Array(2),method:'test',resolution:64,cutoffs:[0,0],classCounts:[0,2,0],occupiedCells:2};
    const roi={x:{min:0,max:1},y:{min:0,max:0},z:{min:0,max:0}};
    const cfg={roi,density:'all',splatTransformEnabled:true};
    const selection=computeSelection(centers,density,cfg,{splatTransformMask:Uint8Array.from([0,1])});
    const parameters={voxelResolution:.05,opacityCutoff:.1,minContribution:1/255};
    const report=buildReport({modelName:'test',filename:'clean.ply',format:'ply',density,config:cfg,selection,total:2,
        attributeStatus:{size:'disabled',opacity:'disabled'},splatTransform:{method:'splat_transform_3.11.1_filterFloaters',parameters}});
    assert.equal(report.tool_version,require('../plugin.json').version);
    assert.equal(report.candidate_by_rule.splatTransformFloaters,1);
    assert.deepEqual(report.selection.splat_transform_floaters.parameters,parameters);
    assert.equal(report.analysis.splat_transform_floaters.method,'splat_transform_3.11.1_filterFloaters');
});

