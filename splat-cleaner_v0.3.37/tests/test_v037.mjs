import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {__testing} from '../index.js';
import {computeSelection,previewHidden,RULE_BITS,candidateMaskForRule} from '../core.mjs';
const {methodTintEligible,methodSelectedForTint,canAutoRefreshMethodToggle,CandidatesTintAppearance,inspectionCandidateMask,candidatePreviewMasks,sameCenters,Preview,
    parseMethodTintStyle,applyLockDisplayColor,applySelectedDisplayColor} = __testing;
const centers={x:new Float64Array([0,1,2,3,4,5]),y:new Float64Array(6),z:new Float64Array(6)};
const data={centers,sizes:new Float32Array([1,1,1,1,1,10]),opacities:new Float32Array([0.1,0.8,0.8,0.1,0.8,0.8])};
const density={classes:new Uint8Array(6)};
const snsMask=new Uint8Array([1,0,1,0,0,0]);
const stMask=new Uint8Array([0,1,0,1,0,0]);
const components={labels:new Int32Array([0,0,0,1,1,1]),sizes:new Uint32Array([3,3]),largestId:0};
const config={roi:{x:{min:0,max:5},y:{min:0,max:0},z:{min:0,max:0}},density:'all',
    sizeEnabled:false,sizePercentile:99,opacityEnabled:false,opacityThreshold:0.5,opacityEncoding:'linear',
    snsEnabled:false,snsK:null,snsMinNeighbors:null,floaterEnabled:false,maxComponentGaussians:100,
    selectedComponentId:null,splatTransformEnabled:true};
const attrs={sizes:data.sizes,opacity:data.opacities,snsMask,splatTransformMask:stMask,components};
const selected=computeSelection(centers,density,config,attrs);
const arr=mask=>[...mask];
const cache={data,density,components,snsMask,snsDetails:{k:3,min_neighbors:1},stMask,stDetails:{method:'gpu'},
    snsParameters:{k:3,m:1},opacityThreshold:.5,opacityEncoding:'linear',analyzedOpacityEncoding:'linear',componentMax:100};

test('AS-01 cached method eligibility is independent of rule checkbox states',()=>{
    for(const method of ['size','opacity','sns','floaters','splatTransformFloaters'])
        assert.equal(methodTintEligible(method,cache),true,method);
    assert.equal(methodTintEligible('unknown',cache),false);
});
test('AS-02 absent or stale method results disable only their own method',()=>{
    assert.equal(methodTintEligible('sns',{...cache,snsMask:null}),false);
    assert.equal(methodTintEligible('sns',{...cache,snsParameters:{k:3,m:2}}),false);
    assert.equal(methodTintEligible('splatTransformFloaters',{...cache,opacityEncoding:'logit'}),false);
    assert.equal(methodTintEligible('opacity',{...cache,opacityEncoding:'logit'}),false);
    assert.equal(methodTintEligible('size',{...cache,opacityEncoding:'logit'}),true);
    assert.equal(methodTintEligible('sns',{...cache,opacityEncoding:'logit'}),true);
    assert.equal(methodTintEligible('floaters',{...cache,componentMax:0}),false);
});
test('AS-03 frozen OR candidate mask is unchanged by inspection of an unchecked method',()=>{
    const frozen=selected.candidates.slice(),bits=selected.ruleBits.slice();
    const viewed=inspectionCandidateMask(selected,'sns',centers,density,config,attrs);
    assert.deepEqual(arr(frozen),[0,1,0,1,0,0]);
    assert.deepEqual(arr(viewed),[1,0,1,0,0,0]);
    assert.deepEqual(arr(selected.candidates),arr(frozen));
    assert.deepEqual(arr(selected.ruleBits),arr(bits));
    assert.equal(config.snsEnabled,false);
});
test('AS-04 original view can inspect disabled method cached candidates',()=>{
    assert.deepEqual(arr(inspectionCandidateMask(selected,'opacity',centers,density,config,attrs)),[1,0,0,1,0,0]);
    assert.deepEqual(arr(inspectionCandidateMask(selected,'size',centers,density,config,attrs)),[0,0,0,0,0,1]);
});
test('AS-05 Candidates view shows only current OR candidates with intersection tint',()=>{
    const inspect=inspectionCandidateMask(selected,'opacity',centers,density,config,attrs);
    const masks=candidatePreviewMasks(selected,RULE_BITS.opacity,inspect);
    assert.deepEqual(arr(masks.hidden),[1,0,1,0,1,1]);
    assert.deepEqual(arr(masks.highlight),[0,0,0,1,0,0]);
    assert.deepEqual(arr(previewHidden(selected,'candidates',false)),arr(masks.hidden));
});
test('AS-06 unchecked method with no overlap shows empty highlight, not new Candidates',()=>{
    const masks=candidatePreviewMasks(selected,RULE_BITS.sns,inspectionCandidateMask(selected,'sns',centers,density,config,attrs));
    assert.deepEqual(arr(masks.highlight),[0,0,0,0,0,0]);
    assert.deepEqual(arr(selected.candidates),[0,1,0,1,0,0]);
});
test('AS-07 enabled rule attribution remains byte-identical in both inspection modes',()=>{
    const mask=inspectionCandidateMask(selected,'splatTransformFloaters',centers,density,config,attrs);
    assert.deepEqual(arr(mask),arr(candidateMaskForRule(selected,RULE_BITS.splatTransformFloaters)));
    assert.deepEqual(arr(candidatePreviewMasks(selected,RULE_BITS.splatTransformFloaters).highlight),arr(mask));
});
test('AS-08 all cleaning methods unchecked keeps tinted method eligible but zero Candidates',()=>{
    const none=computeSelection(centers,density,{...config,splatTransformEnabled:false},attrs);
    assert.deepEqual(arr(none.candidates),[0,0,0,0,0,0]);
    assert.equal(methodTintEligible('sns',cache),true);
    const overlay=inspectionCandidateMask(none,'sns',centers,density,{...config,splatTransformEnabled:false},attrs);
    assert.deepEqual(arr(overlay),[1,0,1,0,0,0]);
    assert.deepEqual(arr(candidatePreviewMasks(none,RULE_BITS.sns,overlay).highlight),[0,0,0,0,0,0]);
});
test('AS-09 center compatibility detects actual changes, preserving same input',()=>{
    const duplicate={centers:{x:centers.x.slice(),y:centers.y.slice(),z:centers.z.slice()}};
    assert.equal(sameCenters(data,duplicate),true);
    duplicate.centers.y[2]=1;
    assert.equal(sameCenters(data,duplicate),false);
    assert.equal(sameCenters(data,{centers:{...centers,z:new Float64Array(3)}}),false);
    assert.equal(sameCenters(data,null),false);
});
test('AS-10 color controls modify native color only, not candidate masks',()=>{
    class Color {constructor(r,g,b,a){Object.assign(this,{r,g,b,a});} copy(c){Object.assign(this,c);return this;}}
    const base=new Color(0.2,0.3,0.4,0.5),locked=new Color(0,0,0,0),selectedColor=new Color(0,0,0,0);
    const tint=parseMethodTintStyle('#3366cc',0.65);
    const frozen=arr(selected.candidates);
    applyLockDisplayColor(locked,base,'method-tint',true,tint);
    applySelectedDisplayColor(selectedColor,base,true,tint);
    assert.equal(locked.a,0.65);assert.equal(selectedColor.b,204/255);
    applyLockDisplayColor(locked,base,'binary',true,tint);assert.equal(locked.a,0);
    assert.deepEqual(arr(selected.candidates),frozen);
});
test('AS-11 Preview restores original locked/selected flags after Candidates highlight',()=>{
    const flags=new Uint8Array([0,1,0,0,1,0]);
    const instances={count:6,flags,sourceRow:new Uint32Array([0,1,2,3,4,5]),palette:new Uint8Array(6),
        clearBits(indices,bit){indices.forEach(i=>{this.flags[i]&=~bit;});},
        setBits(indices,bit){indices.forEach(i=>{this.flags[i]|=bit;});},flush(){}};
    const matrix={clone(){return this;},equals(other){return this===other;}};
    const splat={instances,visible:true,worldTransform:matrix};
    const scene={elements:[splat],forceRender:false};
    splat.scene=scene;splat.resource={source:{}};
    const preview=new Preview(splat,{transformMap:new Map()});
    const {hidden,highlight}=candidatePreviewMasks(selected,RULE_BITS.opacity,
        inspectionCandidateMask(selected,'opacity',centers,density,config,attrs));
    preview.setHidden(scene,hidden,highlight);
    preview.verify(scene);
    preview.restore(scene);
    assert.deepEqual(arr(instances.flags),[0,1,0,0,1,0]);
});
test('AS-12 plugin report version and package metadata updated',()=>{
    const manifest=JSON.parse(readFileSync(new URL('../plugin.json',import.meta.url),'utf8'));
    assert.equal(manifest.version,'0.3.37');
    const core=readFileSync(new URL('../core.mjs',import.meta.url),'utf8');
    assert.match(core,/tool_version: '0\.3\.37'/);
});
test('AS-13 source retains separate SNS and GPU mask slots',()=>{
    const source=readFileSync(new URL('../index.js',import.meta.url),'utf8');
    assert.match(source,/let stMask=null, stDetails=null, snsMask=null, snsDetails=null/);
    assert.match(source,/const preserveMethods=reusableBefore && sameCenters\(previousData,nextData\)/);
    assert.match(source,/if\(!preserveMethods\)/);
    assert.match(source,/restore\(\{preserveInspection:true\}\)/);
    assert.match(source,/if\(entry\.enabled\(config\)\) return candidateMaskForRule/);
});

// v0.3.6 adds a UI selection gate without invalidating any independent detector cache.
test('MT-01 unchecked methods cannot be offered by Method Tint',()=>{
    for(const method of ['size','opacity','sns','floaters'])
        assert.equal(methodSelectedForTint(method,config),false,method);
    assert.equal(methodSelectedForTint('splatTransformFloaters',config),true);
    assert.equal(methodSelectedForTint('unknown',config),false);
    assert.equal(methodTintEligible('sns',cache),true,'Unselected SNS remains cached');
});
test('MT-02 checkboxes gate only their corresponding inspection methods',()=>{
    for(const [method,key] of [['size','sizeEnabled'],['opacity','opacityEnabled'],
        ['sns','snsEnabled'],['floaters','floaterEnabled'],
        ['splatTransformFloaters','splatTransformEnabled']]) {
        const rule={...config,splatTransformEnabled:false,[key]:true};
        for(const other of Object.keys({size:1,opacity:1,sns:1,floaters:1,splatTransformFloaters:1}))
            assert.equal(methodSelectedForTint(other,rule),other===method,`${method} / ${other}`);
    }
    assert.equal(methodSelectedForTint('floaters',{...config,selectedComponentId:1}),true,
        'Explicit detached component selection counts as a checked method');
});
function mockAppearance(selectionColor=false,blend=0.25) {
    const current={'view.selectionColor':selectionColor,'view.splatsSelectionBlend':blend};
    const updates=[];
    const events={functions:new Map(Object.keys(current).map(k=>[k,()=>current[k]])),invoke:key=>current[key],fire:(key,value)=>{
        updates.push([key,value]);
        if(key==='view.setSelectionColor')current['view.selectionColor']=value;
        else if(key==='view.setSplatsSelectionBlend')current['view.splatsSelectionBlend']=value;
    }};
    return {events,current,updates};
}
test('MT-03 Candidates tint colors Gaussian fills and restores original appearance',()=>{
    const {events,current,updates}=mockAppearance(false,0.25);
    const owner=new CandidatesTintAppearance(events);
    owner.enable(0.8);
    assert.equal(current['view.selectionColor'],true);
    assert.equal(current['view.splatsSelectionBlend'],0.8);
    owner.verify();
    owner.restore();
    assert.equal(current['view.selectionColor'],false);
    assert.equal(current['view.splatsSelectionBlend'],0.25);
    assert.deepEqual(updates,[['view.setSelectionColor',true],['view.setSplatsSelectionBlend',0.8],
        ['view.setSelectionColor',false],['view.setSplatsSelectionBlend',0.25]]);
});
test('MT-04 highlight opacity changes only rendering weight',()=>{
    const {events,current}=mockAppearance(false,0);
    const owner=new CandidatesTintAppearance(events);
    const frozen=arr(selected.candidates);
    owner.enable(0.8);
    owner.enable(0.35);
    assert.equal(current['view.splatsSelectionBlend'],0.35);
    assert.deepEqual(arr(selected.candidates),frozen);
    owner.restore();
    assert.equal(current['view.splatsSelectionBlend'],0);
});
test('MT-05 original Editor enabled appearance remains unchanged after tint exits',()=>{
    const {events,updates}=mockAppearance(true,1);
    const owner=new CandidatesTintAppearance(events);
    owner.enable(1);
    owner.restore();
    assert.deepEqual(updates,[]);
});
test('MT-06 externally modified appearance is never overwritten',()=>{
    const {events,current}=mockAppearance(false,0.6);
    const owner=new CandidatesTintAppearance(events);
    owner.enable(0.8);
    current['view.splatsSelectionBlend']=0.4;
    assert.throws(()=>owner.verify(),/outside Splat Cleaner/);
    assert.throws(()=>owner.restore(),/outside Splat Cleaner/);
    assert.equal(current['view.splatsSelectionBlend'],0.4);
});
test('MT-07 v0.3.6 rendering path retained: tint through native Gaussian appearance, not just center flags',()=>{
    const source=readFileSync(new URL('../index.js',import.meta.url),'utf8');
    assert.match(source,/candidatesAppearance\.enable\(tintStyle\.a\)/);
    assert.match(source,/view\.setSelectionColor/);
    assert.match(source,/view\.setSplatsSelectionBlend/);
    assert.match(source,/return methodSelectedForTint\(method,selectedRules\) && analysisCurrent\(\)/);
    assert.match(source,/candidatesAppearance\.restore\(\)/);
});

// v0.3.7: method-checkbox changes are derived from cached detector arrays.
const automaticGate={hasChoice:true,analysisValid:true,busy:false,applying:false,
    activeExport:false,restoring:false,gpuUnavailable:false,restoreError:null};
test('WF-01 first Apply / Preview remains manual after Analyze',()=>{
    assert.equal(canAutoRefreshMethodToggle({...automaticGate,hasChoice:false}),false);
    assert.equal(canAutoRefreshMethodToggle(automaticGate),true);
});
test('WF-02 method toggles never bypass invalid analyses or source changes',()=>{
    assert.equal(canAutoRefreshMethodToggle({...automaticGate,analysisValid:false}),false);
    assert.equal(canAutoRefreshMethodToggle({...automaticGate,gpuUnavailable:true}),false);
    assert.equal(canAutoRefreshMethodToggle({...automaticGate,restoreError:'external conflict'}),false);
});
test('WF-03 method toggles cannot run during export, restore or unrelated analysis',()=>{
    assert.equal(canAutoRefreshMethodToggle({...automaticGate,activeExport:true}),false);
    assert.equal(canAutoRefreshMethodToggle({...automaticGate,restoring:true}),false);
    assert.equal(canAutoRefreshMethodToggle({...automaticGate,busy:true,applying:false}),false);
    assert.equal(canAutoRefreshMethodToggle({...automaticGate,busy:true,applying:true}),true,
        'A toggle during a serialized Apply is deferred and replayed');
});
test('WF-04 toggles recompute OR results from unchanged detector masks',()=>{
    const snsBefore=snsMask.slice(),gpuBefore=stMask.slice();
    const a=computeSelection(centers,density,{...config,snsEnabled:true,snsK:3,snsMinNeighbors:1},attrs);
    const b=computeSelection(centers,density,{...config,splatTransformEnabled:false,snsEnabled:true,snsK:3,snsMinNeighbors:1},attrs);
    const c=computeSelection(centers,density,config,attrs);
    assert.deepEqual(arr(a.candidates),[1,1,1,1,0,0]);
    assert.deepEqual(arr(b.candidates),[1,0,1,0,0,0]);
    assert.deepEqual(arr(c.candidates),arr(selected.candidates));
    assert.deepEqual(arr(snsMask),arr(snsBefore));assert.deepEqual(arr(stMask),arr(gpuBefore));
});
test('WF-05 original/Candidates/Cleaned views reuse new selection consistently',()=>{
    const next=computeSelection(centers,density,{...config,splatTransformEnabled:false,snsEnabled:true,snsK:3,snsMinNeighbors:1},attrs);
    assert.deepEqual(arr(previewHidden(next,'candidates',false)),[0,1,0,1,1,1]);
    assert.deepEqual(arr(previewHidden(next,'cleaned',false)),[1,0,1,0,0,0]);
    assert.deepEqual(arr(previewHidden(next,'original',false)),[0,0,0,0,0,0]);
});
test('WF-06 source routes checkbox changes automatically but scope/threshold edits manually',()=>{
    const source=readFileSync(new URL('../index.js',import.meta.url),'utf8');
    for(const id of ['sc-size-enabled','sc-sns-enabled','sc-floater-enabled','sc-st-enabled'])
        assert.match(source,new RegExp('methodIDs=new Set\\([\\s\\S]*?'+id));
    for(const id of ['sc-density','sc-size-p','sc-opacity','sc-component-max','sc-component-select'])
        assert.match(source,new RegExp('manualConfigIDs=new Set\\([\\s\\S]*?'+id));
    assert.match(source,/if\(methodIDs\.has\(event\.target\.id\)\) \{[\s\S]*?onMethodCheckboxChanged\(\)/);
    assert.match(source,/if\(before==='restrict-sns' \|\| after==='restrict-sns'\)/);
    assert.match(source,/else if\(manualConfigIDs\.has\(event\.target\.id\)\)/);
    assert.match(source,/if\(applyingSelection\)restoreAfterApply=true/);
});
test('WF-07 export disabled while method update or restoration is pending',()=>{
    const source=readFileSync(new URL('../index.js',import.meta.url),'utf8');
    assert.match(source,/!methodRefreshPending && !restoreAfterApply && !gpuUnavailable/);
    assert.match(source,/assert\(!activeExport && !busy && !methodRefreshPending && !restoreAfterApply/);
    assert.match(source,/if\(expectedRevision!==selectionRevision\)return false/);
});
test('WF-08 automatic method updates are coalesced and serialized without cache history',()=>{
    const source=readFileSync(new URL('../index.js',import.meta.url),'utf8');
    assert.match(source,/queueMicrotask\(\(\)=>\{/);
    assert.match(source,/while\(automatic && methodRefreshPending && choice\)/);
    assert.match(source,/methodRefreshPending=false;\s*\+\+selectionRevision/);
    assert.doesNotMatch(source,/methodChoiceHistory|savedSelections|selectionCacheMap/);
});

// Source contract from the supplied SuperSplat v3.9.1 index.js.map.
function modernAppearance(alpha=1,enabled=false) {
    const model={selectionAlpha:alpha}, other={selectionAlpha:0.47};
    const color={clone(){return this;},copy(){}};
    const current={'view.selectionColor':enabled,'view.outlineSelection':false,selection:model,selectedClr:color};
    const calls=[];
    const events={functions:new Map(Object.keys(current).map(k=>[k,()=>current[k]])),
        invoke(key){assert.ok(Object.hasOwn(current,key),`Missing function: ${key}`);return current[key];},
        fire(key,value){assert.equal(key,'view.setSelectionColor');calls.push([key,value]);current['view.selectionColor']=value;}};
    return {model,other,color,current,events,calls,scene:{events}};
}
test('MT-08 v3.9.1 reads and restores exact model selectionAlpha without obsolete events',()=>{
    const {model,other,current,events,scene,color,calls}=modernAppearance(0.65);
    assert.equal(__testing.candidatesTintRendererReady(scene,model),color);
    const owner=new CandidatesTintAppearance(events,model);
    owner.enable(0.8);owner.verify();
    assert.equal(model.selectionAlpha,0.8);assert.equal(current['view.selectionColor'],true);
    owner.enable(0.35);assert.equal(model.selectionAlpha,0.35);
    // Restoration still targets the owned model after the Editor switches selection.
    current.selection=other;owner.restore();
    assert.equal(model.selectionAlpha,0.65);assert.equal(other.selectionAlpha,0.47);
    assert.deepEqual(calls,[['view.setSelectionColor',true],['view.setSelectionColor',false]]);
});
test('MT-09 v3.9.1 external alpha change is not overwritten during restoration',()=>{
    const {events,model,current}=modernAppearance();const owner=new CandidatesTintAppearance(events,model);
    owner.enable(0.8);model.selectionAlpha=0.4;
    assert.throws(()=>owner.verify(),/outside Splat Cleaner/);
    assert.throws(()=>owner.restore(),/outside Splat Cleaner/);
    assert.equal(model.selectionAlpha,0.4);assert.equal(current['view.selectionColor'],true);
});
test('MT-10 legacy blend wins even if the model has selectionAlpha, with or without a registry',()=>{
    for(const hasRegistry of [true,false]) {
        const {events,current}=mockAppearance(false,0.25);const model={selectionAlpha:1};
        if(!hasRegistry)delete events.functions;
        const owner=new CandidatesTintAppearance(events,model);owner.enable(0.8);
        assert.equal(current['view.splatsSelectionBlend'],0.8);assert.equal(model.selectionAlpha,1);
        owner.restore();assert.equal(current['view.splatsSelectionBlend'],0.25);
    }
});
test('MT-11 missing modern contract and inactive model or outline fail before writes',()=>{
    const {model,other,scene,current,calls}=modernAppearance();
    assert.throws(()=>__testing.candidatesTintRendererReady(scene,other),/active Editor/);
    current['view.outlineSelection']=true;
    assert.throws(()=>__testing.candidatesTintRendererReady(scene,model),/Outline/);
    current['view.outlineSelection']=false;delete model.selectionAlpha;
    assert.throws(()=>__testing.candidatesTintRendererReady(scene,model),/selection alpha/);
    assert.deepEqual(calls,[]);
});
test('MT-12 v3.9.1 preserves existing enabled tint and alpha without unnecessary writes',()=>{
    const {events,model,calls}=modernAppearance(0.8,true);const owner=new CandidatesTintAppearance(events,model);
    owner.enable(0.8);owner.restore();assert.equal(model.selectionAlpha,0.8);assert.deepEqual(calls,[]);
});
