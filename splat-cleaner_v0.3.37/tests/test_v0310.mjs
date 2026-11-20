import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {activate} from '../index.js';
import {analyzeSnsSupport,analyzeSnsBidirectionalSupport,gaussianMetric,insideSnsEllipsoid} from '../sns-support.mjs';
import {computeSelection,subsetRuns,buildReport,RULE_BITS,candidateMaskForRule} from '../core.mjs';
const I=[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1];
const pts=p=>Object.fromEntries(['x','y','z'].map((a,i)=>[a,Float64Array.from(p,v=>v[i])]));
const iso=s=>[s,s,s];
function geom(scales,{k=3,quats=[],transforms=[],locked=[],invalid=[]}={}){
    const n=scales.length,inverse=new Float32Array(9*n),radii=new Float64Array(n),valid=new Uint8Array(n),flags=new Uint8Array(n);
    for(let i=0;i<n;i++){
        if(locked.includes(i))flags[i]=1;
        if(invalid.includes(i))continue;
        const metric=gaussianMetric(quats[i]??[1,0,0,0],scales[i].map(Math.log),transforms[i]??I,k);
        assert.ok(metric);inverse.set(metric.inverse,i*9);radii[i]=metric.radius;valid[i]=1;
    }
    return {inverse,radii,valid,locked:flags,k};
}
const run=analyzeSnsBidirectionalSupport;
const mask=r=>[...r.candidateMask];
const partition=(r,n)=>assert.equal(r.supportedCount+r.candidateCount+r.inconclusiveCount+r.lockedExcluded,n);
test('REV-01 asymmetric coverage rescues a small Gaussian beyond its own search box',async()=>{
    const c=pts([[0,0,0],[10,0,0],[100,0,0]]),g=geom([iso(.1),iso(4),iso(.1)]);
    const o=await analyzeSnsSupport(c,g,{cellWidth:2}),r=await run(c,g,{cellWidth:2});
    assert.deepEqual(mask(o),[1,0,1]);assert.deepEqual(mask(r),[0,0,1]);
    assert.equal(r.reverseSupportedCount,1);assert.equal(r.reverseInconclusiveCount,0);partition(r,3);
});
test('REV-02 isolated, mutual and coincident centers; no self support or added candidates',async()=>{
    const c=pts([[0,0,0],[0,0,0],[10,0,0],[11,0,0],[100,0,0]]),g=geom(Array.from({length:5},()=>iso(.5)));
    const o=await analyzeSnsSupport(c,g,{cellWidth:1}),r=await run(c,g,{cellWidth:1});
    assert.deepEqual(mask(r),[0,0,0,0,1]);assert.deepEqual(mask(r),mask(o));partition(r,5);
    const single=await run(pts([[0,0,0]]),geom([iso(1)]));assert.deepEqual(mask(single),[1]);
});
test('REV-03 m>1 accumulates incoming-only distinct neighbors, not mutual duplicates',async()=>{
    const c=pts([[0,0,0],[.5,0,0],[4,0,0]]),g=geom([iso(.3),iso(.3),iso(2)]);
    const r=await run(c,g,{cellWidth:1,minSupport:2});
    assert.deepEqual(mask(r),[0,0,0]);assert.deepEqual([...r.supportCount],[2,2,2]);
    const mutual=await run(pts([[0,0,0],[.5,0,0]]),geom([iso(1),iso(1)]),{minSupport:2});
    assert.deepEqual(mask(mutual),[1,1]);assert.deepEqual([...mutual.supportCount],[1,1]);partition(mutual,2);
});
test('REV-04 invalid geometry cannot cover; locked sources can; locked candidates remain protected',async()=>{
    const c=pts([[0,0,0],[5,0,0],[20,0,0],[25,0,0],[100,0,0]]),g=geom([iso(.1),iso(2),iso(.1),iso(2),iso(.1)],{locked:[1,4],invalid:[3]});
    const r=await run(c,g,{cellWidth:2});assert.deepEqual(mask(r),[0,0,1,0,0]);
    assert.equal(r.reverseSupportedCount,1);assert.equal(r.invalidCount,1);assert.equal(r.lockedExcluded,1);partition(r,5);
});
test('REV-05 large covering source inconclusive in Stage 1 may still support a confirmed candidate',async()=>{
    const c=pts([[0,0,0],[100,0,0],[10000,0,0]]),g=geom([iso(100),iso(.01),iso(.01)]);
    const r=await run(c,g,{cellWidth:.1,maxCellsPerQuery:64});
    assert.deepEqual(mask(r),[0,0,1]);assert.deepEqual([...r.inconclusiveMask],[1,0,0]);assert.equal(r.reverseSupportedCount,1);
});
test('REV-06 reverse comparison exhaustion retains uncertainty and later positive support wins',async()=>{
    const c=pts([[0,0,0],[1,0,0],[2,0,0],[2.1,0,0],[100,0,0]]),g=geom([iso(1),iso(.01),iso(.01),iso(.1),iso(.01)]);
    const full=await run(c,g,{cellWidth:.1,maxCellsPerQuery:1000000});
    const bounded=await run(c,g,{cellWidth:.1,maxCellsPerQuery:1000000,maxReverseComparisonsPerQuery:1});
    assert.ok(bounded.reverseBudgetLimitedSources>0);assert.ok(bounded.reverseInconclusiveCount>0);
    assert.equal(bounded.candidateMask[2],0);assert.equal(bounded.inconclusiveMask[2],0,'later source resolves prior uncertainty');
    for(let i=0;i<5;i++)assert.ok(bounded.candidateMask[i]<=full.candidateMask[i]);partition(bounded,5);
});
test('REV-07 node budget marks potentially affected subtrees, not spatially disjoint candidates',async()=>{
    const p=[[0,0,0],...Array.from({length:40},(_,i)=>[i+1,0,0]),...Array.from({length:40},(_,i)=>[1000+i,0,0])];
    const c=pts(p),g=geom([iso(20),...p.slice(1).map(()=>iso(.02))]);
    const r=await run(c,g,{cellWidth:1,maxReverseNodesPerQuery:3});
    assert.equal(r.reverseBudgetLimitedSources,1);assert.equal(r.reverseInconclusiveCount,20);assert.equal(r.reverseSupportedCount,20);
    assert.equal(r.candidateCount,40);assert.ok(r.candidateMask.slice(41).every(v=>v===1));partition(r,p.length);
});
test('REV-08 brute-force directed-union oracle across k, m, transforms and anisotropy',async()=>{
    let seed=12345;const rand=()=>((seed=Math.imul(seed,1664525)+1013904223|0)>>>0)/2**32;
    const n=75,p=Array.from({length:n},()=>[rand()*12,rand()*5,rand()*2]);
    const scales=p.map(()=>[.02+rand()*2,.02+rand(),.02+rand()*.5]);
    const quats=p.map(()=>{const a=rand()*Math.PI;return [Math.cos(a),0,0,Math.sin(a)];});
    const shear=[1,0,0,0,.4,1,0,0,0,0,1.2,0,0,0,0,1],transforms=p.map((_,i)=>i%3?shear:I);
    const c=pts(p);
    for(const k of [1,3,5,10]){
        const g=geom(scales,{k,quats,transforms,locked:[5],invalid:[2,67]});
        for(const m of [1,2,5,10,50]){
            const r=await run(c,g,{k,minSupport:m,cellWidth:20});
            const expected=p.map((_,i)=>{
                if(!g.valid[i]||g.locked[i])return 0;
                const count=p.filter((_,j)=>i!==j&&g.valid[j]&&(insideSnsEllipsoid(c,i,j,g,k)||insideSnsEllipsoid(c,j,i,g,k))).length;
                return Number(count<m);
            });
            assert.deepEqual(mask(r),expected,`k=${k}, m=${m}`);assert.equal(r.reverseInconclusiveCount,0);partition(r,n);
        }
    }
});
test('REV-09 no-candidate shortcut, cancellation and invalid reverse budgets',async()=>{
    const c=pts([[0,0,0],[.2,0,0]]),g=geom([iso(1),iso(1)]),stages=[];
    const r=await run(c,g,{progress:(_d,_t,s)=>stages.push(s)});assert.equal(r.reverseNodeVisits,0);assert.deepEqual([...new Set(stages)],['outgoing']);
    await assert.rejects(run(c,g,{maxReverseNodesPerQuery:0}),/Invalid reverse/);
    let cancel=false;await assert.rejects(run(pts([[0,0,0],[10,0,0]]),geom([iso(.1),iso(.1)]),{progress:(_d,_t,s)=>{if(s==='index')cancel=true;},cancelled:()=>cancel}),/cancelled/);
    cancel=false;await assert.rejects(run(pts([[0,0,0],[10,0,0]]),geom([iso(.1),iso(.1)]),{progress:(_d,_t,s)=>{if(s==='reverse')cancel=true;},cancelled:()=>cancel}),/cancelled/);
});
test('REV-10 sparse candidate tree prunes disjoint regions without an all-pairs scan',async()=>{
    const n=4096,p=Array.from({length:n},(_,i)=>[i*10,0,0]);
    const r=await run(pts(p),geom(p.map(()=>iso(.1))),{cellWidth:1});
    assert.equal(r.candidateCount,n);assert.equal(r.reverseInconclusiveCount,0);
    assert.ok(r.reverseComparisons<n*32);assert.ok(r.reverseNodeVisits<n*20);
});
test('REV-11 refined mask integrates with unchanged scope, OR, attribution and report',async()=>{
    const c=pts([[0,0,0],[10,0,0],[100,0,0],[200,0,0]]),g=geom([iso(.1),iso(4),iso(.1),iso(.1)]),r=await run(c,g,{cellWidth:2});
    const roi={x:{min:0,max:100},y:{min:0,max:0},z:{min:0,max:0}},d={classes:new Uint8Array(4),bounds:roi};
    const cfg={roi,density:'all',snsEnabled:true,snsK:3,snsMinNeighbors:1,opacityEnabled:true,opacityThreshold:.1,sizeEnabled:false,sizePercentile:99};
    const s=computeSelection(c,d,cfg,{snsMask:r.candidateMask,opacity:Float32Array.of(.01,.9,.9,.01)});
    assert.deepEqual([...s.ruleBits],[2,0,4,0]);assert.deepEqual([...candidateMaskForRule(s,RULE_BITS.sns)],[0,0,1,0]);
    assert.deepEqual(subsetRuns(s.candidates).runs,[[1,1],[3,1]]);
    const report=buildReport({density:d,config:cfg,selection:s,total:4,attributeStatus:{},sns:{method:'bidirectional_oriented_ellipsoid_center_support'}});
    assert.equal(report.tool_version,'0.3.37');assert.equal(report.selection.scale_normalized_support.method,'bidirectional_oriented_ellipsoid_center_support');
    assert.equal(report.candidate_by_rule.sns,1);
});

// Small DOM double: drives real controller handlers, not a browser renderer.
function controllerFixture(){
    const nodes=new Map();let root;
    class El {
        constructor(){this.style={};this.listeners=new Map();this.options=[];this.value='';this.checked=false;this.disabled=false;this.textContent='';}
        addEventListener(k,fn){if(!this.listeners.has(k))this.listeners.set(k,[]);this.listeners.get(k).push(fn);}
        removeEventListener(){} setAttribute(){} remove(){}
        append(o){this.options.push(o);} replaceChildren(...o){this.options=o;this.value=o[0]?.value??'';}
        querySelector(k){return nodes.get(k.slice(1));}
        set innerHTML(html){for(const m of html.matchAll(/<([\w-]+)\b([^>]*\bid="([^"]+)"[^>]*)>/g)){
            const [,tag,attr,id]=m,e=new El();e.id=id;e.disabled=/\bdisabled\b/.test(attr);e.checked=/\bchecked\b/.test(attr);e.value=attr.match(/\bvalue="([^"]*)"/)?.[1]??'';nodes.set(id,e);
            if(tag==='select'){const start=m.index+m[0].length,body=html.slice(start,html.indexOf('</select>',start));e.options=[...body.matchAll(/<option value="([^"]*)"/g)].map(v=>({value:v[1],disabled:false}));e.value=e.options[0]?.value??'';}
        }}
    }
    const n=5,positions=[0,1,2,3,100];let reads=0;
    const matrix=()=>({data:Float32Array.from(I),clone:matrix,equals(rhs){return this.data.every((v,i)=>v===rhs.data[i]);},mul2(){return this;}});
    const instances={count:n,flags:new Uint8Array(n),sourceRow:Uint32Array.from({length:n},(_,i)=>i),palette:new Uint32Array(n),transformIndex(){return 0;}};
    const source={meta:{chunkSize:5,layouts:{position:{stride:12},geometric:{stride:32,fields:{scale:{components:3,type:'float32'},rotation:{components:4,type:'float32'},opacity:{components:1,type:'float32'}}}}},async read(req){
        reads++;const ids=Array.from({length:req.count},(_,j)=>req.indices[req.indexOffset+j]);
        if(req.position)new Float32Array(req.position.data).set(ids.flatMap(i=>[positions[i],0,0]));
        if(req.geometric){req.geometric.values={scale:Float32Array.from(ids.flatMap(i=>Array(3).fill(Math.log(i===0?2:.01)))),rotation:Float32Array.from(ids.flatMap(()=>[1,0,0,0])),opacity:Float32Array.from(ids.map(()=>.8))};}
    }};
    const model={name:'controller fixture',visible:true,instances,worldTransform:matrix(),transformPalette:{getTransform(){}},resource:{source,sourcePool:{acquire(_kind,layout,count){return {data:new ArrayBuffer(layout.stride*count),field(name){return this.values[name]},release(){}}}}}};
    const scene={elements:[model],events:{functions:new Set(['scene.write','show.exportPopup']),on(){return {off(){}};}},commandQueue:{enqueue(fn){return fn();}}};model.scene=scene;
    return {scene,document:{createElement(tag){const e=new El();if(tag==='section')root=e;return e;},getElementById(){return null;}},Option:class{constructor(text,value){this.text=text;this.value=value;}},get:id=>nodes.get(id),reads:()=>reads,
        change(id,value,checked=false){const e=nodes.get(id);if(checked)e.checked=value;else e.value=String(value);for(const fn of e.listeners.get('change')??[])fn({target:e});for(const fn of root.listeners.get('change')??[])fn({target:e});}};
}
const waitFor=async fn=>{for(let i=0;i<200;i++){if(fn())return;await new Promise(r=>setTimeout(r,2));}throw Error('Controller condition not reached');};
test('REV-12 real controller: one analysis and Apply, refined cache, invalidation, checkbox refresh',async()=>{
    const f=controllerFixture(),prior={window:global.window,document:global.document,Option:global.Option};
    global.window={scene:f.scene};global.document=f.document;global.Option=f.Option;
    let active;try{
        globalThis.__splatCleanerVerifySnsHistory=true;
        active=await activate({editor:{},uiHost:{append(){}}});await active.open();const get=f.get;
        assert.equal(get('sc-sns-oversized-find'),undefined);assert.equal(get('sc-sns-oversized-enabled'),undefined);
        await get('sc-analyze').onclick();const baseReads=f.reads();
        f.change('sc-size-enabled',true,true);get('sc-apply').onclick();await waitFor(()=>!get('sc-export').disabled);
        await get('sc-sns-find').onclick();assert.equal(f.reads(),baseReads+1);
        assert.equal(get('sc-export').disabled,true,'fresh analysis clears a no-preview Original choice');
        assert.equal(get('sc-sns-enabled').disabled,false);assert.equal(get('sc-sns-enabled').checked,false);
        assert.match(get('sc-sns-status').textContent,/Reverse coverage: 3 supported, 0 inconclusive/);
        assert.match(get('sc-sns-status').textContent,/CPU reference matched/);
        assert.match(get('sc-sns-status').textContent,/Historical v0\.3\.10 CPU: 1 candidate/);
        f.change('sc-size-enabled',false,true);f.change('sc-sns-enabled',true,true);
        assert.equal(get('sc-export').disabled,true);get('sc-apply').onclick();await waitFor(()=>!get('sc-export').disabled);
        assert.match(get('sc-counts').textContent,/Candidates: 1/);
        const before=f.reads();await get('sc-sns-find').onclick();assert.equal(f.reads(),before);
        f.change('sc-sns-enabled',false,true);await waitFor(()=>/Candidates: 0/.test(get('sc-counts').textContent));
        f.change('sc-sns-enabled',true,true);await waitFor(()=>!get('sc-export').disabled);assert.equal(f.reads(),before);
        await get('sc-analyze').onclick();assert.equal(get('sc-sns-enabled').disabled,false);const after=f.reads();
        await get('sc-sns-find').onclick();assert.equal(f.reads(),after);
        f.change('sc-sns-m',2);assert.equal(get('sc-sns-enabled').disabled,true);assert.equal(get('sc-export').disabled,true);
        await get('sc-sns-find').onclick();assert.equal(f.reads(),after+1);assert.equal(get('sc-sns-enabled').checked,false);
        f.change('sc-sns-enabled',true,true);get('sc-apply').onclick();await waitFor(()=>!get('sc-export').disabled);
        assert.match(get('sc-counts').textContent,/Candidates: 4/);
        f.change('sc-sns-k',4);assert.equal(get('sc-sns-enabled').disabled,true);assert.equal(get('sc-export').disabled,true);
    }finally{try{await active?.deactivate();}finally{delete globalThis.__splatCleanerVerifySnsHistory;for(const [k,v] of Object.entries(prior)){if(v===undefined)delete global[k];else global[k]=v;}}}
});
test('REV-13 panel/control and original selection contract have no oversized or extra Apply',()=>{
    const s=readFileSync(new URL('../index.js',import.meta.url),'utf8');
    assert.equal([...s.matchAll(/id="sc-apply"/g)].length,1);assert.equal([...s.matchAll(/id="sc-sns-find"/g)].length,1);
    assert.doesNotMatch(s,/snsOversized|sc-sns-max-neighbors|Analyze SNS Oversized/);
    assert.deepEqual(Object.values(RULE_BITS),[1,2,4,8,16]);
});
test('REV-14 bounded reverse queries are conservative relative to full directed-union oracle',async()=>{
    const p=Array.from({length:96},(_,i)=>[i%24,(i%7)*.9,Math.floor(i/24)*3]);
    const c=pts(p),g=geom(p.map((_,i)=>iso(i%13===0?3:.08)),{invalid:[8,17],locked:[0,15]});
    for(const m of [1,3,10]){
        const full=await run(c,g,{cellWidth:20,minSupport:m});
        for(const cap of [1,3,10]){
            const bounded=await run(c,g,{cellWidth:20,minSupport:m,maxReverseNodesPerQuery:cap,maxReverseComparisonsPerQuery:cap});
            for(let i=0;i<p.length;i++)assert.ok(bounded.candidateMask[i]<=full.candidateMask[i],`m=${m}, cap=${cap}, i=${i}`);
            partition(bounded,p.length);
        }
    }
});

test('Preview validity diagnostic: controller rejects changed world matrix and reports exact reason without rereading geometry',async()=>{
    const f=controllerFixture(),prior={window:global.window,document:global.document,Option:global.Option};
    global.window={scene:f.scene};global.document=f.document;global.Option=f.Option;
    const warnings=[],oldWarn=console.warn;console.warn=(...args)=>warnings.push(args.join(' '));
    let active;try{
        active=await activate({editor:{},uiHost:{append(){}}});await active.open();const get=f.get;
        await get('sc-analyze').onclick();f.change('sc-size-enabled',true,true);
        get('sc-apply').onclick();await waitFor(()=>!get('sc-export').disabled);
        const before=f.reads();f.scene.elements[0].worldTransform.data[12]=.001;
        get('sc-apply').onclick();await waitFor(()=>get('sc-progress').textContent.includes('[WORLD_CHANGED]'));
        assert.equal(get('sc-export').disabled,true);assert.equal(f.reads(),before);
        const message=warnings.find(m=>m.startsWith('[Splat Cleaner] Preview validity: '));assert.ok(message);
        const info=JSON.parse(message.slice(message.indexOf('{')));assert.equal(info.code,'WORLD_CHANGED');assert.equal(info.saved[12],0);
        assert.equal(info.current[12],f.scene.elements[0].worldTransform.data[12]);
    }finally{try{await active?.deactivate();}finally{console.warn=oldWarn;for(const [k,v] of Object.entries(prior)){if(v===undefined)delete global[k];else global[k]=v;}}}
});

test('SNS-O-07 controller opacity filter is manual Apply; no SNS reanalysis',async()=>{
    const f=controllerFixture(),prior={window:global.window,document:global.document,Option:global.Option};
    global.window={scene:f.scene};global.document=f.document;global.Option=f.Option;
    let active;try{
        active=await activate({editor:{},uiHost:{append(){}}});await active.open();const get=f.get;
        assert.equal(get('sc-opacity-mode').value,'off');
        assert.equal(get('sc-opacity').value,'0.01');
        await get('sc-analyze').onclick();await get('sc-sns-find').onclick();
        const before=f.reads(),raw=get('sc-sns-status').textContent;
        f.change('sc-sns-enabled',true,true);get('sc-apply').onclick();await waitFor(()=>!get('sc-export').disabled);
        assert.match(get('sc-counts').textContent,/Candidates: 1/);
        f.change('sc-opacity-mode','restrict-sns');assert.equal(get('sc-export').disabled,true);
        get('sc-apply').onclick();await waitFor(()=>/Candidates: 0/.test(get('sc-counts').textContent));
        assert.equal(f.reads(),before);assert.equal(get('sc-sns-status').textContent,raw);
        f.change('sc-opacity',1);assert.equal(get('sc-export').disabled,true);
        get('sc-apply').onclick();await waitFor(()=>!get('sc-export').disabled);assert.equal(f.reads(),before);
        f.change('sc-opacity','');get('sc-apply').onclick();await waitFor(()=>/Opacity threshold/.test(get('sc-progress').textContent));
        assert.equal(get('sc-export').disabled,true);
        f.change('sc-opacity',1);get('sc-apply').onclick();await waitFor(()=>!get('sc-export').disabled);
        f.change('sc-opacity-encoding','logit');assert.equal(get('sc-export').disabled,true);assert.equal(get('sc-opacity').disabled,true);
        get('sc-apply').onclick();await waitFor(()=>/Opacity encoding changed/.test(get('sc-progress').textContent));
        assert.equal(get('sc-export').disabled,true);
        await get('sc-analyze').onclick();const after=f.reads();await get('sc-sns-find').onclick();assert.equal(f.reads(),after);
        get('sc-apply').onclick();await waitFor(()=>!get('sc-export').disabled);
        f.change('sc-opacity-mode','off');get('sc-apply').onclick();await waitFor(()=>!get('sc-export').disabled);
        assert.equal(f.reads(),after);assert.equal(get('sc-sns-status').textContent,raw);
    }finally{try{await active?.deactivate();}finally{for(const [k,v] of Object.entries(prior)){if(v===undefined)delete global[k];else global[k]=v;}}}
});

test('SNS-O-09 unified UI modes preserve caches, reset parent dependency and route refresh correctly',async()=>{
    const f=controllerFixture(),prior={window:global.window,document:global.document,Option:global.Option};
    global.window={scene:f.scene};global.document=f.document;global.Option=f.Option;
    let active;try{
        active=await activate({editor:{},uiHost:{append(){}}});await active.open();const get=f.get;
        const mode=get('sc-opacity-mode');const restriction=()=>mode.options.find(o=>o.value==='restrict-sns');
        assert.equal(mode.value,'off');assert.equal(restriction().disabled,true);
        assert.equal(get('sc-opacity').disabled,true);assert.equal(get('sc-sns-opacity-enabled'),undefined);
        await get('sc-analyze').onclick();await get('sc-sns-find').onclick();
        const reads=f.reads(),raw=get('sc-sns-status').textContent;
        f.change('sc-sns-enabled',true,true);get('sc-apply').onclick();await waitFor(()=>!get('sc-export').disabled);
        assert.equal(restriction().disabled,false);
        f.change('sc-opacity-mode','independent');await waitFor(()=>!get('sc-export').disabled);
        f.change('sc-opacity',1);assert.equal(get('sc-export').disabled,true);
        get('sc-apply').onclick();await waitFor(()=>/Candidates: 5/.test(get('sc-counts').textContent));
        f.change('sc-opacity-mode','restrict-sns');assert.equal(get('sc-export').disabled,true);
        assert.match(get('sc-counts').textContent,/Selection settings changed/);
        get('sc-apply').onclick();await waitFor(()=>!get('sc-export').disabled);
        assert.match(get('sc-counts').textContent,/Candidates: 1/);
        assert.equal(get('sc-inspect-method').options.find(o=>o.value==='opacity').disabled,true);
        f.change('sc-sns-enabled',false,true);assert.equal(mode.value,'off');assert.equal(restriction().disabled,true);
        await waitFor(()=>/Candidates: 0/.test(get('sc-counts').textContent));
        assert.equal(get('sc-opacity').value,'1');
        f.change('sc-sns-enabled',true,true);await waitFor(()=>!get('sc-export').disabled);assert.equal(mode.value,'off');
        f.change('sc-opacity-mode','independent');await waitFor(()=>/Candidates: 5/.test(get('sc-counts').textContent));
        f.change('sc-sns-enabled',false,true);assert.equal(mode.value,'independent');
        await waitFor(()=>/Selection calculated/.test(get('sc-progress').textContent));
        assert.match(get('sc-counts').textContent,/Candidates: 5/);
        f.change('sc-opacity-mode','off');await waitFor(()=>/Candidates: 0/.test(get('sc-counts').textContent));
        f.change('sc-sns-enabled',true,true);await waitFor(()=>!get('sc-export').disabled);
        f.change('sc-opacity-mode','restrict-sns');get('sc-apply').onclick();await waitFor(()=>!get('sc-export').disabled);
        assert.equal(f.reads(),reads);assert.equal(get('sc-sns-status').textContent,raw);
        f.change('sc-sns-k',4);assert.equal(mode.value,'off');assert.equal(restriction().disabled,true);assert.equal(get('sc-opacity').value,'1');
    }finally{try{await active?.deactivate();}finally{for(const [k,v] of Object.entries(prior)){if(v===undefined)delete global[k];else global[k]=v;}}}
});
