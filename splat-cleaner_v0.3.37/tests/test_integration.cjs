const {test}=require('node:test');
const assert=require('node:assert/strict');
const {pathToFileURL}=require('node:url');
const path=require('node:path');
const load=import(pathToFileURL(path.join(__dirname,'..','index.js')).href);
function matrix(values=[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1]){
    return {data:Float32Array.from(values),clone(){return matrix(Array.from(this.data));},
        equals(rhs){return this.data.every((x,i)=>x===rhs.data[i]);},
        mul2(a,b){this.data=Float32Array.from(a.data);return this;}};
}
function fixture({N=4,malformed=false,nonuniform=false,opacities=null}={}){
    const instances={count:N,flags:new Uint8Array(N),sourceRow:Uint32Array.from({length:N},(_,i)=>i),palette:new Uint32Array(N),
        transformIndex(i){return 0;},
        clearBits(ranges,bit){ranges.forEach(i=>{this.flags[i]&=~bit;});},
        setBits(ranges,bit){ranges.forEach(i=>{this.flags[i]|=bit;});},flush(){this.flushed=(this.flushed||0)+1;}};
    const sourcePool={acquire(layer,layout,count){return {data:new ArrayBuffer(count*layout.stride),count,
        _values:{},field(name){return this._values[name];},release(){this.released=true;}};}};
    const meta={chunkSize:2,layouts:{position:{stride:12},geometric:{stride:32,fields:{scale:{components:3,type:'float32',byteOffset:16},opacity:{components:1,type:'float32',byteOffset:28}}}}};
    const source={meta,async read(req){
        if(malformed&&req.geometric)throw Error('Unsupported geometric source');
        if(req.position){const values=new Float32Array(req.position.data);for(let i=0;i<req.count;i++){
            const idx=req.indices[req.indexOffset+i];values.set([idx,0,0],i*3);
        }}
        if(req.geometric){req.geometric._values.scale=Float32Array.from({length:req.count*3},(_,i)=>-2);
            req.geometric._values.opacity=Float32Array.from({length:req.count},(_,i)=>opacities ? opacities[req.indices[req.indexOffset+i]] : i%2?0.01:0.7);}
    }};
    const world=matrix(nonuniform?[2,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1]:undefined);
    const splat={name:'test',visible:true,instances,worldTransform:world,
        transformPalette:{getTransform(){/* identity */}},resource:{source,sourcePool},
        createLayer(ranges,name){return {worldTransform:world.clone(),name,ranges,destroy(){this.destroyed=true;}};}};
    const functions=new Set(['scene.write','show.exportPopup']);
    const callbacks=new Map();
    const events={functions,on(name,fn){if(!callbacks.has(name))callbacks.set(name,new Set());callbacks.get(name).add(fn);
        return {off(){callbacks.get(name).delete(fn);}};},fire(name,...args){for(const fn of callbacks.get(name)||[])fn(...args);},
        invoke(name){if(name==='lockedClr')return {a:1,clone(){return {a:this.a}},copy(c){this.a=c.a;}};throw Error('unknown event');}};
    const scene={elements:[splat],events,forceRender:false,commandQueue:{enqueue(fn){return fn();}}};
    splat.scene=scene;
    return {scene,splat,instances,events};
}

test('SC-15 chunk source reads source-row aligned decoded size/opacity',async()=>{
    const {__testing}=await load;
    const {splat}=fixture();
    // This historical fixture contains linear test opacity; opt in explicitly.
    const data=await __testing.readModel(splat,()=>false,()=>{},{opacityEncoding:'linear'});
    assert.deepEqual(Array.from(data.centers.x),[0,1,2,3]);
    assert.ok(data.sizes && data.opacities);
    assert.ok(Math.abs(data.sizes[0]-Math.exp(-2))<1e-6);
    assert.deepEqual(Array.from(data.opacities).map(v=>Math.round(v*100)),[70,1,70,1]);
});

test('SC-15 unsupported geometric data disables only attribute filters',async()=>{
    const {__testing}=await load;
    const {splat}=fixture({malformed:true});
    const data=await __testing.readModel(splat,()=>false,()=>{});
    assert.equal(data.sizes,null);assert.equal(data.opacities,null);
    assert.equal(data.centers.x.length,4);
});

test('SC-15 nonuniform transforms disable size but preserve opacity and world centers',async()=>{
    const {__testing}=await load;
    const {splat}=fixture({nonuniform:true});
    const data=await __testing.readModel(splat,()=>false,()=>{});
    assert.equal(data.sizes,null);assert.ok(data.opacities);
    assert.deepEqual(Array.from(data.centers.x),[0,2,4,6]);
});

test('SC-08 preview conserves all nonfilter native flags and exact restoration',async()=>{
    const {__testing}=await load;
    const {scene,splat,instances}=fixture();
    instances.flags.set([0,1,2,4]);
    const data=await __testing.readModel(splat,()=>false,()=>{});
    const preview=new __testing.Preview(splat,data);
    preview.setHidden(scene,Uint8Array.from([1,0,0,1]));
    assert.deepEqual(Array.from(instances.flags),[2,1,2,6]);
    preview.restore(scene);
    assert.deepEqual(Array.from(instances.flags),[0,1,2,4]);
});

test('SC-11 external flag edits prevent false restoration',async()=>{
    const {__testing}=await load;
    const {scene,splat,instances}=fixture();
    const data=await __testing.readModel(splat,()=>false,()=>{});
    const preview=new __testing.Preview(splat,data);
    preview.setHidden(scene,Uint8Array.from([1,0,0,0]));
    instances.flags[2]|=4;
    assert.throws(()=>preview.restore(scene),/modified outside/);
});

test('SC-09 native full-model subset export is independent of view-mask',async()=>{
    const {__testing}=await load;
    const {splat}=fixture();
    const selection={candidates:Uint8Array.from([1,0,0,0])};
    const {layers,count}=__testing.makeExportLayers(splat,selection);
    assert.equal(count,3);assert.deepEqual(layers[0].ranges.runs,[[1,3]]);
    layers[0].destroy();assert.equal(layers[0].destroyed,true);
});

test('SC-14 unrelated model visibility restored on isolate cleanup',async()=>{
    const {__testing}=await load;
    const {scene,splat}=fixture();
    const sibling={...splat,visible:true,scene};scene.elements.push(sibling);
    const isolation=__testing.isolationFor(scene,splat);
    assert.equal(sibling.visible,false);
    isolation.restore();assert.equal(sibling.visible,true);
});

test('SC-11 plugin activates/deactivates without editing native scene or requiring a DOM at import',async()=>{
    const {activate}=await load;
    const {scene,events}=fixture();
    const previous=global.window;
    global.window={scene};
    try {
        const active=await activate({editor:{},uiHost:{append(){}}});
        assert.equal(active.isRunning(),false);
        await active.deactivate();
        assert.equal(active.isRunning(),false);
    } finally { global.window=previous; }
});

test('SC-24 SNS candidate selection accepts external full-instance candidate mask',async()=>{
    const {__testing}=await load;
    const {splat}=fixture();
    const data=await __testing.readModel(splat,()=>false,()=>{});
    const {analyzeDensity,computeSelection}=await import(pathToFileURL(path.join(__dirname,'..','core.mjs')).href);
    const density=await analyzeDensity(data.centers,{resolution:8});
    const selection=computeSelection(data.centers,density,{
        roi:{x:{min:0,max:3},y:{min:0,max:0},z:{min:0,max:0}},
        density:'all',snsEnabled:true},{snsMask:Uint8Array.from([1,0,0,1])});
    assert.equal(selection.candidateCount,2);
    assert.equal(selection.ruleCounts.sns,2);
});

test('SC-25 SNS mask is independent of legacy scalar size and nonuniform transform validation',async()=>{
    const {__testing}=await load;
    const {splat}=fixture({nonuniform:true});
    const data=await __testing.readModel(splat,()=>false,()=>{});
    const {analyzeDensity,computeSelection}=await import(pathToFileURL(path.join(__dirname,'..','core.mjs')).href);
    const density=await analyzeDensity(data.centers,{resolution:8});
    assert.equal(data.sizes,null);
    const selection=computeSelection(data.centers,density,{
        roi:{x:{min:0,max:6},y:{min:0,max:0},z:{min:0,max:0}},
        density:'all',snsEnabled:true},{snsMask:Uint8Array.from([0,1,0,0])});
    assert.equal(selection.candidateCount,1);
});

test('SC-26 opacity above 1 remains available (linear merged-Gaussian contract)',async()=>{
    const {__testing}=await load;
    const {splat}=fixture({opacities:[0.01,1.4,0.8,2.2]});
    const result=await __testing.readModel(splat,()=>false,()=>{},{opacityEncoding:'linear'});
    assert.ok(result.opacities);
    assert.ok(Math.abs(result.opacities[1]-1.4)<1e-6);
    assert.match(result.attributeStatus.opacity,/2 values > 1/);
});

test('SC-27 negative/nonfinite opacity fails closed without disabling density',async()=>{
    const {__testing}=await load;
    for(const [bad,mode] of [[-0.1,'linear'],[NaN,'logit'],[Infinity,'linear']]) {
        const {splat}=fixture({opacities:[0.5,0.2,bad,0.7]});
        const result=await __testing.readModel(splat,()=>false,()=>{},{opacityEncoding:mode});
        assert.equal(result.opacities,null);
        assert.equal(result.centers.x.length,4);
    }
});

test('SC-28 XYZ axis values display as 3 decimals, full precision retained for computation',async()=>{
    const {__testing}=await load;
    assert.equal(__testing.display3(-7142.142108984375),'-7142.142');
    assert.equal(__testing.display3(250.72720336914062),'250.727');
    assert.equal(__testing.display3(0),'0.000');
    assert.equal(__testing.round3(134.726011),134.726);
    const domain={min:-7142.142108984375,max:250.72720336914062};
    const full={...domain};
    assert.deepEqual(__testing.reviseRoiInterval(full,domain,'min',full.min),full);
});

test('SC-29 XYZ interval endpoints are clamped and ordered',async()=>{
    const {__testing}=await load;
    const domain={min:0,max:10};
    assert.deepEqual(__testing.reviseRoiInterval({min:2,max:8},domain,'min',12),{min:8,max:8});
    assert.deepEqual(__testing.reviseRoiInterval({min:2,max:8},domain,'max',-2),{min:2,max:2});
    assert.deepEqual(__testing.reviseRoiInterval({min:2,max:8},domain,'min',-10),{min:0,max:8});
    assert.throws(()=>__testing.reviseRoiInterval({min:2,max:8},domain,'min',NaN),/finite/);
});

test('SC-30 XYZ dual-handle controls and axis reset are present',async()=>{
    const {__testing}=await load;
    const markup=__testing.panelHTML();
    assert.match(markup,/sc-roi-details/);
    for(const axis of ['x','y','z']) {
        const axisMarkup=__testing.axisMarkup(axis);
        for(const name of ['min-handle','max-handle','slider','selected','reset','domain','current'])
            assert.ok(axisMarkup.includes(`sc-${axis}-${name}`),name);
    }
});

test('SC-37 invalid linear opacity is diagnosed with instance and source-row location',async()=>{
    const {__testing}=await load;
    const {splat}=fixture({opacities:[0.2,0.5,NaN,0.9]});
    const data=await __testing.readModel(splat,()=>false,()=>{});
    assert.equal(data.opacities,null);
    assert.match(data.attributeStatus.opacity,/instance 2 \(source row 2\): NaN/);
    assert.ok(data.centers.x.length===4);
});

test('SC-38 compact popup contains resizable scroll layout, separate floater rule, and persistent footer',async()=>{
    const {__testing}=await load;
    const html=__testing.panelHTML();
    for(const id of ['sc-scroll','sc-footer','sc-header','sc-floater-details','sc-find-components',
        'sc-floater-enabled','sc-component-max','sc-rules-details','sc-roi-details'])
        assert.ok(html.includes(`id="${id}"`),`missing ${id}`);
    assert.match(html,/overflow-y:auto/);
    assert.match(html,/scrollbar-gutter:stable/);
    const source=require('node:fs').readFileSync(path.join(__dirname,'..','index.js'),'utf8');
    assert.match(source,/resize:both/);
    assert.match(source,/flex-direction:column/);
});

test('SC-41 legacy SplatTransform logit opacity is decoded with explicit mode', async () => {
    const {__testing}=await load;
    const {splat}=fixture({opacities:[-4.059717,0,4,-12]});
    const decoded=await __testing.readModel(splat,()=>false,()=>{},{opacityEncoding:'logit'});
    assert.ok(decoded.opacities);
    assert.ok(Math.abs(decoded.opacities[0]-1/(1+Math.exp(4.059717)))<1e-6);
    assert.equal(decoded.opacities[1],0.5);
    assert.match(decoded.attributeStatus.opacity,/raw logit.*legacy v3.10.2/);
    const linear=await __testing.readModel(splat,()=>false,()=>{},{opacityEncoding:'linear'});
    assert.equal(linear.opacities,null);
    assert.match(linear.attributeStatus.opacity,/invalid linear opacity/);
});

test('SC-42 new component and opacity controls are present; export starts disabled', async () => {
    const {__testing}=await load;
    const html=__testing.panelHTML();
    assert.match(html,/id="sc-component-select"/);
    assert.match(html,/id="sc-opacity-encoding"/);
    assert.match(html,/value="logit"/);
    assert.match(html,/<option value="logit">Raw logit/);
    assert.match(html,/id="sc-export"[^>]*disabled/);
});


test('SC-43 explicit logit supports zero/one opacity endpoints and rejects NaN', async()=>{
    const {__testing}=await load;
    const {splat}=fixture({opacities:[-Infinity,Infinity,-4.059717,0]});
    const result=await __testing.readModel(splat,()=>false,()=>{},{opacityEncoding:'logit'});
    assert.ok(result.opacities);
    assert.equal(result.opacities[0],0);
    assert.equal(result.opacities[1],1);
    assert.ok(Math.abs(result.opacities[2]-0.01696)<0.001);
    const bad=fixture({opacities:[0,NaN,1,-1]});
    const invalid=await __testing.readModel(bad.splat,()=>false,()=>{},{opacityEncoding:'logit'});
    assert.equal(invalid.opacities,null);
    assert.match(invalid.attributeStatus.opacity,/instance 1/);
});

test('SC-44 explicit legacy logit produces usable low-opacity candidate selection', async()=>{
    const {__testing}=await load;
    const {splat}=fixture({opacities:[-5,-4.059717,0,5]});
    const result=await __testing.readModel(splat,()=>false,()=>{},{opacityEncoding:'logit'});
    const {analyzeDensity,computeSelection}=
        await import(pathToFileURL(path.join(__dirname,'..','core.mjs')).href);
    const density=await analyzeDensity(result.centers,{resolution:8});
    const selection=computeSelection(result.centers,density,{
        roi:{x:{min:0,max:3},y:{min:0,max:0},z:{min:0,max:0}}, density:'all',
        opacityEnabled:true,opacityThreshold:0.01,opacityEncoding:'logit'
    },{opacity:result.opacities});
    assert.equal(selection.ruleCounts.opacity,1);
    assert.deepEqual(Array.from(selection.candidates),[1,0,0,0]);
});

test('SC-45 view dropdown only offers Original, Candidates and Cleaned',async()=>{
    const {__testing}=await load;
    const html=__testing.panelHTML();
    const options=html.match(/<select id="sc-view">([^<]*<option[^]*?)<\/select>/)?.[1] || '';
    assert.ok(options.includes('Original'));
    assert.ok(options.includes('Candidates'));
    assert.ok(options.includes('Cleaned'));
    assert.ok(!options.includes('Density selection'));
    assert.ok(html.includes('<select id="sc-density">'), 'Density still exists as a region filter');
});


test('SC-48 whole-scope removal override is absent from standard UI',async()=>{
    const {__testing}=await load;
    const html=__testing.panelHTML();
    assert.doesNotMatch(html,/id="sc-entire"|Select entire XYZ\/density scope/);
    assert.match(html,/id="sc-opacity-mode"/);
    assert.match(html,/id="sc-view"/);
});

test('SC-49 View updates reuse the applied selection; manual parameter edits invalidate export readiness',async()=>{
    const file=await require('node:fs/promises').readFile(require('node:path').join(__dirname,'../index.js'),'utf8');
    assert.match(file,/async function applyPreview\(reuseSelection=false, expectedRevision=selectionRevision\)/);
    assert.match(file,/const config=reuseSelection && choice \? choice\.config : readConfig\(\)/);
    assert.match(file,/if\(choice\)runApply\(true\)/);
    assert.match(file,/invalidateAppliedSelection\('Selection parameter changed\. Click Apply \/ Preview manually\.'/);
    assert.match(file,/choice\.selection\.retainedCount>0/);
});

test('SC-52 v3.11.1 linear geometric opacity default preserves alpha without sigmoid',async()=>{
    const {__testing}=await load;
    const {splat}=fixture({opacities:[0,.01,.5,1]});
    const data=await __testing.readModel(splat,()=>false,()=>{});
    assert.ok(data.opacities);
    assert.deepEqual(Array.from(data.opacities),Array.from(Float32Array.from([0,.01,.5,1])));
    assert.match(data.attributeStatus.opacity,/available \(linear\)/);
    const html=__testing.panelHTML();
    assert.match(html,/<option value="linear">Linear \(default for v3\.11\.1/);
});
