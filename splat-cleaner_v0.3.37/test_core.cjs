const {test} = require('node:test');
const assert = require('node:assert/strict');
const {pathToFileURL} = require('node:url');
const path = require('node:path');
const core = import(pathToFileURL(path.join(__dirname,'..','core.mjs')).href);
const centers = points => ({x:Float64Array.from(points.map(p=>p[0])),y:Float64Array.from(points.map(p=>p[1])),z:Float64Array.from(points.map(p=>p[2]))});
const full = v => ({x:{min:0,max:v},y:{min:0,max:v},z:{min:0,max:v}});

test('SC-01 density analysis classifies occupied voxels and preserves tie semantics', async()=>{
    const {analyzeDensity} = await core;
    const points=[];
    for(let i=0;i<90;i++)points.push([i%3*.002,Math.floor(i/3)%3*.002,Math.floor(i/9)*.002]);
    for(let i=0;i<10;i++)points.push([10+i*.1,10,10]);
    const d=await analyzeDensity(centers(points),{resolution:32});
    assert.equal(d.classes.length,100);
    assert.equal(d.classCounts.reduce((a,b)=>a+b),100);
    assert.ok(d.occupiedCells>0);
    assert.equal(d.method,'voxel_3x3x3_center_occupancy');
    assert.ok(d.cutoffs[0]<=d.cutoffs[1]);
    assert.equal('voxelIds' in d,false,'Do not retain a 4N byte voxel id array after analysis');
});

test('SC-01b uniform occupancy is medium, not automatically sparse',async()=>{
    const {analyzeDensity}=await core;
    const d=await analyzeDensity(centers([[0,0,0],[1,1,1]]),{resolution:8});
    assert.deepEqual(d.classCounts,[0,2,0]);
});

test('SC-10 invalid coordinates and degenerate geometry fail explicitly',async()=>{
    const {analyzeDensity}=await core;
    await assert.rejects(analyzeDensity(centers([[0,0,0],[NaN,0,0]])),/Nonfinite/);
    await assert.rejects(analyzeDensity(centers([[1,1,1],[1,1,1]])),/degenerate/);
});

test('SC-06 ROI / density class intersection controls scope; no implicit removals',async()=>{
    const {computeSelection} = await core;
    const c=centers([[0,0,0],[1,1,1],[2,2,2],[3,3,3]]);
    const density={classes:Uint8Array.from([0,1,2,2])};
    const r=computeSelection(c,density,{roi:full(2),density:'dense',sizeEnabled:false,opacityEnabled:false,selectEntireScope:false});
    assert.equal(r.scopedCount,1);
    assert.equal(r.candidateCount,0);
    assert.equal(r.retainedCount,4);
});

test('SC-07 size/opacity union counts overlapping candidates once',async()=>{
    const {computeSelection}=await core;
    const c=centers([[0,0,0],[1,1,1],[2,2,2],[3,3,3],[4,4,4]]);
    const d={classes:new Uint8Array(5)};
    const config={roi:full(5),density:'all',sizeEnabled:true,sizePercentile:50,opacityEnabled:true,opacityThreshold:.05};
    const r=computeSelection(c,d,config,{sizes:Float32Array.from([1,2,3,4,5]),opacity:Float32Array.from([1,1,1,0.01,0.01])});
    assert.equal(r.sizeResolvedThreshold,3);
    assert.equal(r.ruleCounts.size,2);
    assert.equal(r.ruleCounts.opacity,2);
    assert.equal(r.candidateCount,2);
    assert.deepEqual(Array.from(r.candidates),[0,0,0,1,1]);
});

test('SC-03 sparse useful large splat remains unless specifically selected',async()=>{
    const {computeSelection}=await core;
    const c=centers([[0,0,0],[1,1,1],[2,2,2],[3,3,3]]);
    const d={classes:Uint8Array.from([0,0,2,2])};
    const cfg={roi:full(4),density:'dense',sizeEnabled:false,opacityEnabled:false,selectEntireScope:false};
    const r=computeSelection(c,d,cfg,{sizes:Float32Array.from([999,100,1,2])});
    assert.equal(r.candidates[0],0);assert.equal(r.candidates[1],0);
});

test('SC-05 candidates are opt-in; SC-09 outside-ROI export retention',async()=>{
    const {computeSelection,subsetRuns,previewHidden}=await core;
    const c=centers([[0,0,0],[1,1,1],[2,2,2],[3,3,3]]);
    const d={classes:Uint8Array.from([0,0,1,2])};
    const r=computeSelection(c,d,{roi:full(1),density:'all',opacityEnabled:true,opacityThreshold:0.05},
        {opacity:Float32Array.from([0.01,0.01,0.5,0.5])});
    assert.deepEqual(Array.from(r.candidates),[1,1,0,0]);
    assert.deepEqual(subsetRuns(r.candidates).runs,[[2,2]]);
    assert.deepEqual(Array.from(previewHidden(r,'cleaned',false)),[1,1,0,0]);
    assert.deepEqual(Array.from(previewHidden(r,'original',true)),[0,0,1,1]);
    assert.throws(()=>previewHidden(r,'density',true),/Unknown visualization mode/);
    assert.deepEqual(Array.from(previewHidden(r,'candidates',false)),[0,0,1,1]);
});

test('SC-12 report has distinct preview/export semantics and count invariants',async()=>{
    const {buildReport,computeSelection}=await core;
    const c=centers([[0,0,0],[1,1,1],[2,2,2]]);
    const d={classes:Uint8Array.from([0,1,2]),resolution:64,cutoffs:[1,3],classCounts:[1,1,1],occupiedCells:3,method:'voxel_3x3x3_center_occupancy'};
    const config={roi:full(1),density:'all',sizeEnabled:false,opacityEnabled:true,opacityThreshold:0.05,sizePercentile:99};
    const selection=computeSelection(c,d,config,{opacity:Float32Array.from([0.01,0.02,0.8])});
    const report=buildReport({modelName:'test',filename:'cleaned.sog',format:'sog',density:d,config,selection,total:3,attributeStatus:{size:'disabled',opacity:'disabled'}});
    assert.equal(report.selected_gaussian_instances,1);
    assert.equal(report.candidate_gaussian_instances,2);
    assert.equal(report.mapping_status,'not_assessed');
    assert.equal(report.matrix_application_to_exported_model,'do_not_apply_again');
});

test('SC-13 moderate synthetic density performance completes without kNN',async()=>{
    const {analyzeDensity}=await core;
    const n=200_000,c={x:new Float64Array(n),y:new Float64Array(n),z:new Float64Array(n)};
    for(let i=0;i<n;i++){c.x[i]=i%500;c.y[i]=Math.floor(i/500)%200;c.z[i]=Math.floor(i/100000);}
    const start=performance.now();
    const d=await analyzeDensity(c);
    const elapsed=performance.now()-start;
    assert.equal(d.classes.length,n);
    assert.ok(elapsed<20000,`Synthetic 200k benchmark unexpectedly slow: ${elapsed}ms`);
    console.log(`Synthetic 200k density benchmark: ${elapsed.toFixed(0)} ms (Node, not WebGPU)`);
});

test('SC-18 density remains independent of SNS neighborhood analysis',async()=>{
    const {analyzeDensity}=await core;
    const c=centers([[0,0,0],[7,7,7]]),d=await analyzeDensity(c,{resolution:8});
    assert.equal(d.classes.length,2);
    assert.equal(d.voxelWidth,7/8);
    assert.equal('spacingProxyByVoxel' in d,false);
});

test('SC-19 SNS candidates are supplied by a completed scale-aware neighborhood search',async()=>{
    const {computeSelection}=await core;
    const c=centers([[0,0,0],[1,0,0],[2,0,0],[3,0,0]]);
    const d={classes:new Uint8Array(4)};
    const cfg={roi:full(3),density:'all',snsEnabled:true};
    const r=computeSelection(c,d,cfg,{snsMask:Uint8Array.from([1,0,1,0])});
    assert.deepEqual([...r.candidates],[1,0,1,0]);
    assert.equal(r.ruleCounts.sns,2);
    assert.deepEqual([...computeSelection(c,d,{...cfg,snsEnabled:false}).candidates],[0,0,0,0]);
});

test('SC-20 SNS combines with opacity using OR, respecting ROI and export membership',async()=>{
    const {computeSelection,subsetRuns,previewHidden}=await core;
    const c=centers([[0,0,0],[1,0,0],[2,0,0],[3,0,0],[4,0,0]]);
    const d={classes:new Uint8Array(5)};
    const cfg={roi:full(3),density:'all',snsEnabled:true,opacityEnabled:true,opacityThreshold:.05};
    const r=computeSelection(c,d,cfg,{snsMask:Uint8Array.from([0,1,0,0,1]),
        opacity:Float32Array.from([.5,.5,.01,.5,.5])});
    assert.deepEqual([...r.candidates],[0,1,1,0,0]);
    assert.equal(r.ruleCounts.sns,1);
    assert.equal(r.ruleCounts.opacity,1);
    assert.deepEqual(subsetRuns(r.candidates).runs,[[0,1],[3,2]]);
    assert.deepEqual([...previewHidden(r,'cleaned',false)],[0,1,1,0,0]);
});

test('SC-21 SNS fails closed without complete instance-aligned mask',async()=>{
    const {computeSelection}=await core;
    const c=centers([[0,0,0],[1,0,0],[2,0,0]]);
    const d={classes:new Uint8Array(3)};
    const cfg={roi:full(2),density:'all',snsEnabled:true};
    assert.throws(()=>computeSelection(c,d,cfg),/Run scale-normalized support/);
    assert.throws(()=>computeSelection(c,d,cfg,{snsMask:Uint8Array.from([1,0])}),/Run scale-normalized support/);
    assert.throws(()=>computeSelection(c,d,cfg,{snsMask:Uint8Array.from([1,2,0])}),/Invalid SNS candidate/);
});

test('SC-22 SNS export report states exact new method and distinguishes candidate counts',async()=>{
    const {computeSelection,buildReport}=await core;
    const c=centers([[0,0,0],[1,0,0],[2,0,0]]);
    const d={classes:new Uint8Array(3),method:'voxel_3x3x3_center_occupancy',resolution:64,
        cutoffs:[1,1],classCounts:[3,0,0],occupiedCells:3};
    const cfg={roi:full(2),density:'all',snsEnabled:true,snsK:3,snsMinNeighbors:1};
    const s=computeSelection(c,d,cfg,{snsMask:Uint8Array.from([1,0,0])});
    const report=buildReport({modelName:'m',filename:'m.sog',format:'sog',density:d,
        config:cfg,selection:s,total:3,attributeStatus:{size:'available',opacity:'disabled'},
        sns:{method:'oriented_ellipsoid_center_support',k:2,min_neighbors:1,inconclusive:0}});
    assert.equal(report.tool_version,require('../plugin.json').version);
    assert.equal(report.version,2);
    assert.equal(report.selection.scale_normalized_support.k_standard_deviations,3);
    assert.equal(report.selection.scale_normalized_support.minimum_neighbors,1);
    assert.equal(report.analysis.scale_normalized_support.method,'oriented_ellipsoid_center_support');
    assert.equal(report.candidate_by_rule.sns,1);
    assert.equal(report.selected_gaussian_instances,2);
});

test('SC-23 SNS candidate masking remains linear in instance count',async()=>{
    const {computeSelection}=await core;
    const n=200_000,c={x:new Float64Array(n),y:new Float64Array(n),z:new Float64Array(n)};
    const d={classes:new Uint8Array(n)};
    const mask=new Uint8Array(n);mask[0]=1;mask[199999]=1;
    const t=performance.now();
    const r=computeSelection(c,d,{roi:{x:{min:0,max:1},y:{min:0,max:1},z:{min:0,max:1}},
        density:'all',snsEnabled:true},{snsMask:mask});
    assert.equal(r.candidateCount,2);
    assert.ok(performance.now()-t<20000);
});

test('SC-31 detached voxel groups identify geometric candidates and preserve the main component',async()=>{
    const {analyzeComponents,computeSelection,subsetRuns}=await core;
    const points=[];
    for(let i=0;i<500;i++) points.push([(i%25)*.01,Math.floor(i/25)*.01,0]);
    for(let i=0;i<4;i++) points.push([20+i*.005,0,0]);
    points.push([-7142,0,0]);
    const c=centers(points), a=await analyzeComponents(c);
    assert.equal(a.componentCount,3,'central geometry, detached group and distant extreme should not merge');
    assert.equal(a.sizes[a.largestId],500);
    assert.deepEqual(Array.from(a.sizes).sort((x,y)=>x-y),[1,4,500]);
    assert.ok(a.voxelWidth<1,'extreme model X bound must not determine entire connectivity resolution');
    const d={classes:new Uint8Array(c.x.length)};
    const r=computeSelection(c,d,{roi:{x:{min:-7200,max:30},y:{min:-1,max:1},z:{min:-1,max:1}},
        density:'all',floaterEnabled:true,maxComponentGaussians:10},{components:a});
    assert.equal(r.candidateCount,5);
    assert.equal(r.ruleCounts.floaters,5);
    assert.equal(r.selectedFloaterComponents,2);
    assert.equal(r.retainedCount,500);
    assert.equal(subsetRuns(r.candidates).count,500);
});

test('SC-32 floater selection respects ROI while components use full model',async()=>{
    const {analyzeComponents,computeSelection}=await core;
    const pts=[];
    for(let i=0;i<250;i++)pts.push([(i%25)*.01,Math.floor(i/25)*.01,0]);
    pts.push([5,0,0],[5.003,0,0],[-1000,0,0]);
    const c=centers(pts), components=await analyzeComponents(c);
    const d={classes:new Uint8Array(pts.length)};
    const config={roi:{x:{min:4,max:6},y:{min:-1,max:1},z:{min:-1,max:1}},density:'all',
        floaterEnabled:true,maxComponentGaussians:5};
    const r=computeSelection(c,d,config,{components});
    assert.deepEqual(Array.from(r.candidates.slice(250)),[1,1,0]);
    assert.equal(r.candidateCount,2);
});

test('SC-33 floater filter is opt-in, validates component evidence and bounds',async()=>{
    const {computeSelection}=await core;
    const c=centers([[0,0,0],[1,0,0],[2,0,0]]),d={classes:new Uint8Array(3)};
    const cfg={roi:full(3),density:'all',floaterEnabled:true,maxComponentGaussians:4};
    assert.equal(computeSelection(c,d,{...cfg,floaterEnabled:false}).candidateCount,0);
    assert.throws(()=>computeSelection(c,d,cfg),/Find spatial components/);
    const components={labels:Uint32Array.from([0,0,1]),sizes:Uint32Array.from([2,1]),largestId:0};
    assert.deepEqual(Array.from(computeSelection(c,d,cfg,{components}).candidates),[0,0,1]);
    assert.throws(()=>computeSelection(c,d,{...cfg,maxComponentGaussians:0},{components}),/component-size/);
    assert.throws(()=>computeSelection(c,d,{...cfg,maxComponentGaussians:1.5},{components}),/component-size/);
});

test('SC-34 export report records floater parameters and approximate component limitations',async()=>{
    const {buildReport,computeSelection}=await core;
    const c=centers([[0,0,0],[1,0,0],[9,0,0]]);
    const density={classes:new Uint8Array(3),resolution:64,cutoffs:[1,2],classCounts:[0,3,0],occupiedCells:2,method:'voxel'};
    const components={labels:Uint32Array.from([0,0,1]),sizes:Uint32Array.from([2,1]),largestId:0,
        componentCount:2,voxelWidth:.5,occupiedCells:2,coarseningPasses:0,
        method:'robust_extent_voxel_26_connected_components',limitation:'not proof of floaters'};
    const config={roi:{x:{min:0,max:10},y:{min:0,max:0},z:{min:0,max:0}},density:'all',
        floaterEnabled:true,maxComponentGaussians:1};
    const selection=computeSelection(c,density,config,{components});
    const r=buildReport({modelName:'sample',filename:'cleaned.ply',format:'ply',density,config,selection,total:3,
        attributeStatus:{size:'available',opacity:'disabled'},components});
    assert.equal(r.tool_version,require('../plugin.json').version);
    assert.equal(r.selection.floater_components.selected_components_in_scope,1);
    assert.equal(r.analysis.connected_components.component_count,2);
    assert.equal(r.selected_gaussian_instances,2);
    assert.equal(r.selection.floater_components.largest_component_always_preserved,true);
});

test('SC-35 sparse component analysis is bounded and cancellable',async()=>{
    const {analyzeComponents}=await core;
    const pts=Array.from({length:3000},(_,i)=>[i%100,Math.floor(i/100),0]);
    const c=centers(pts);
    await assert.rejects(analyzeComponents(c,{cancelled:()=>true}),/cancelled/);
    const a=await analyzeComponents(c,{maxOccupiedCells:1000,divisions:48});
    assert.ok(a.occupiedCells<=1000);
    assert.equal(a.labels.length,3000);
    assert.equal(Array.from(a.sizes).reduce((sum,v)=>sum+v,0),3000);
});

test('SC-36 component analysis synthetic 200k performance does not perform kNN',async()=>{
    const {analyzeComponents}=await core;
    const n=200000, c={x:new Float64Array(n),y:new Float64Array(n),z:new Float64Array(n)};
    for(let i=0;i<n;i++) {c.x[i]=(i%400)*.01;c.y[i]=(Math.floor(i/400)%250)*.01;c.z[i]=Math.floor(i/100000)*.05;}
    const start=performance.now();
    const a=await analyzeComponents(c);
    const elapsed=performance.now()-start;
    assert.equal(a.labels.length,n);
    assert.ok(elapsed<20000,`Synthetic component analysis too slow: ${elapsed.toFixed(0)}ms`);
    console.log(`Synthetic 200k component analysis: ${elapsed.toFixed(0)} ms (Node; not browser/WebGPU)`);
});

test('SC-39 a manually selected detached group can exceed the small-component threshold', async () => {
    const {analyzeComponents,computeSelection}=await core;
    const pts=[];
    for(let i=0;i<500;i++)pts.push([i%25*.01,Math.floor(i/25)*.01,0]);
    for(let i=0;i<22;i++)pts.push([30+i%11*.005,Math.floor(i/11)*.005,0]);
    pts.push([-1000,0,0]);
    const c=centers(pts), components=await analyzeComponents(c);
    const id=Array.from(components.sizes).findIndex(n=>n===22);
    assert.ok(id>=0);
    const d={classes:new Uint8Array(pts.length)};
    const cfg={roi:{x:{min:-1001,max:31},y:{min:-1,max:1},z:{min:-1,max:1}},density:'all',
        floaterEnabled:false,maxComponentGaussians:1,selectedComponentId:id};
    const r=computeSelection(c,d,cfg,{components});
    assert.equal(r.candidateCount,22);
    assert.equal(r.ruleCounts.floaters,22);
    assert.equal(r.selectedFloaterComponents,1);
    assert.equal(r.candidates[522],0);
    assert.throws(()=>computeSelection(c,d,{...cfg,selectedComponentId:components.largestId},{components}),/protected main component/);
});

test('SC-40 manually chosen and small-group rules combine by union, not duplicate counts', async () => {
    const {computeSelection}=await core;
    const c=centers([[0,0,0],[0.1,0,0],[10,0,0],[20,0,0]]);
    const components={labels:Uint32Array.from([0,0,1,2]),sizes:Uint32Array.from([2,1,1]),largestId:0};
    const d={classes:new Uint8Array(4)};
    const cfg={roi:full(30),density:'all',floaterEnabled:true,maxComponentGaussians:1,selectedComponentId:1};
    const r=computeSelection(c,d,cfg,{components});
    assert.equal(r.candidateCount,2);
    assert.equal(r.selectedFloaterComponents,2);
    assert.deepEqual(Array.from(r.candidates),[0,0,1,1]);
    const report=(await core).buildReport({modelName:'x',filename:'a.ply',format:'ply',density:d,
        config:cfg,selection:r,total:4,attributeStatus:{size:'available',opacity:'disabled'},components:{...components,
            componentCount:3,voxelWidth:1,occupiedCells:3,coarseningPasses:0,method:'mock',limitation:'test'}});
    assert.equal(report.selection.floater_components.explicitly_selected_component_id,1);
});


test('SC-46 ROI and density only constrain enabled rules, never remove whole scope',async()=>{
    const {computeSelection,previewHidden}=await core;
    const c=centers([[0,0,0],[1,1,1],[2,2,2]]), density={classes:Uint8Array.from([0,1,2])};
    // A stale legacy selectEntireScope field is intentionally ignored.
    const r=computeSelection(c,density,{roi:full(2),density:'all',selectEntireScope:true});
    assert.equal(r.scopedCount,3);
    assert.equal(r.candidateCount,0);
    assert.equal(r.retainedCount,3);
    assert.deepEqual([...previewHidden(r,'original',false)],[0,0,0]);
    assert.deepEqual([...previewHidden(r,'candidates',false)],[1,1,1]);
    assert.deepEqual([...previewHidden(r,'cleaned',false)],[0,0,0]);
    assert.deepEqual(Object.keys(r.ruleCounts).sort(),['floaters','opacity','size','sns','splatTransformFloaters']);
});

test('SC-47 opacity-only candidates produce separate original/candidate/cleaned masks',async()=>{
    const {computeSelection,previewHidden,subsetRuns}=await core;
    const c=centers([[0,0,0],[1,0,0],[2,0,0],[3,0,0]]), density={classes:new Uint8Array(4)};
    const r=computeSelection(c,density,{roi:full(2),density:'all',opacityEnabled:true,opacityThreshold:0.01},
        {opacity:Float32Array.from([0.005,0.5,0.009,0.002])});
    assert.deepEqual([...r.candidates],[1,0,1,0]);
    assert.equal(r.candidateCount,2);
    assert.equal(r.retainedCount,2);
    assert.deepEqual([...previewHidden(r,'original',false)],[0,0,0,0]);
    assert.deepEqual([...previewHidden(r,'candidates',false)],[0,1,0,1]);
    assert.deepEqual([...previewHidden(r,'cleaned',false)],[1,0,1,0]);
    assert.deepEqual([...previewHidden(r,'original',true)],[0,0,0,1]);
    assert.deepEqual(subsetRuns(r.candidates).runs,[[1,1],[3,1]]);
});

