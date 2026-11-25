import { test } from 'node:test';
import assert from 'node:assert/strict';
import { attachSemanticUI, semanticYFromWorldRange } from '../semantic-ui.js';
import { IDENTITY } from '../semantic-core.js';

class Element {
    constructor(tag='div') {
        this.tagName=tag;this.style={};this.dataset={};this.attrs={};this.children=[];
        this.textContent='';this.value='';this.checked=false;this.disabled=false;this.listeners=new Map();
    }
    append(...items) { for (const item of items) { this.children.push(item);item.parent=this; } }
    prepend(...items) { for (const item of items.reverse()) { this.children.unshift(item);item.parent=this; } }
    replaceChildren(...items) {this.children=[];this.append(...items);}
    setAttribute(k,v){this.attrs[k]=String(v);}
    getAttribute(k){return this.attrs[k]??null;}
    addEventListener(k,fn){this.listeners.set(k,fn);}
    removeEventListener(k,fn){if(this.listeners.get(k)===fn)this.listeners.delete(k);}
    getBoundingClientRect(){return {left:0,top:0,width:300,height:240};}
    get firstChild(){return this.children[0]??null;}
    remove(){if(this.parent){const i=this.parent.children.indexOf(this);if(i>=0)this.parent.children.splice(i,1);}}
}
function walk(root){return [root,...root.children.flatMap(walk)];}
function byText(root, text){const result=walk(root).find(e=>e.tagName==='button'&&e.textContent===text);
    assert(result,`Missing button: ${text}`);return result;}
function byAria(root, name){const result=walk(root).find(e=>e.attrs['aria-label']===name);
    assert(result,`Missing control: ${name}`);return result;}

// Range capture must preserve model-local Y, including translations/scaling.
test('SEM-16 XYZ world slider Y range maps into semantic floor Y without precision loss',()=>{
    const translatedScaled=[2,0,0,0,0,2,0,0,0,0,2,0,12,20,-3,1];
    const ys=semanticYFromWorldRange({min:22.123456,max:25.998765},translatedScaled);
    assert(Math.abs(ys.min-1.061728)<1e-10);assert(Math.abs(ys.max-2.9993825)<1e-10);
    assert.deepEqual(semanticYFromWorldRange({min:0,max:2.9},IDENTITY),{min:0,max:2.9});
    assert.throws(()=>semanticYFromWorldRange({min:2,max:1},IDENTITY),/Invalid live/);
});

test('SEM-17 creating or selecting a saved floor enables Room/Area authoring without secondary previews',async()=>{
    const priorDocument=globalThis.document,priorWindow=globalThis.window;
    const priorRAF=globalThis.requestAnimationFrame,priorCancel=globalThis.cancelAnimationFrame;
    const body=new Element('body');
    const fakeDoc={body,createElement:tag=>new Element(tag),createElementNS:(_ns,tag)=>new Element(tag),
        addEventListener(){},removeEventListener(){}};
    globalThis.document=fakeDoc;
    globalThis.window={confirm:()=>true,
        showSaveFilePicker: async ()=>({name:'semantic_Building.json',createWritable:async()=>({write:async()=>{},close:async()=>{},abort:async()=>{}})})};
    globalThis.requestAnimationFrame=()=>1;
    globalThis.cancelAnimationFrame=()=>{};
    const canvas=new Element('canvas');
    const pose=()=>({position:{clone(){return {set(){return this;}}}},target:{clone(){return {set(){return this;}}}}});
    const scene={canvas,events:{invoke:key=>key==='camera.getPose'?pose():null},camera:{ortho:false}};
    let previewRanges={x:{min:0,max:10},y:{min:0,max:5},z:{min:0,max:10}};
    const rangeObservers=new Set();
    const preview={full:structuredClone(previewRanges),worldCenters:{x:Float64Array.from([0,10]),
        y:Float64Array.from([0,5]),z:Float64Array.from([0,10])},
        getRanges:()=>structuredClone(previewRanges),enabled:()=>true,busy:()=>false,
        onRangesChanged:fn=>{rangeObservers.add(fn);return ()=>rangeObservers.delete(fn);},
        setRanges:async bounds=>{previewRanges=structuredClone(bounds);
            for(const fn of rangeObservers)fn(previewRanges.y,true);}};
    const holder=new Element('holder');
    try {
        const ui=attachSemanticUI({scene,editor:{viewport:{setCamera:async()=>{},info:()=>({viewToken:'same'})}},
            target:{name:'Building'},preview,holder,modelToWorld:()=>IDENTITY});
        const modelID=byAria(holder,'Permanent model ID');modelID.value='model-id-001';
        await byText(holder,'Bind Current Model').onclick();
        const draw=byText(holder,'Draw Room');
        assert.equal(draw.disabled,true,'no floor exists yet');
        // The semantic three-mode controller connects to the ONE XYZ preview.
        assert.equal(walk(holder).filter(e=>e.tagName==='button'&&e.textContent.startsWith('Preview ')).length,0);
        byText(holder,'New Floor').onclick();
        await byText(holder,'Full Floor').onclick();
        await new Promise(resolve=>setImmediate(resolve));
        assert.equal(byText(holder,'Full Floor').attrs['aria-pressed'],'true');
        // Mimic a direct native slider drag; floor fields update without Capture.
        previewRanges.y={min:0.5,max:2.9};
        for(const fn of rangeObservers)fn(previewRanges.y,true);
        assert.equal(walk(holder).filter(e=>e.tagName==='input'&&e.value==='2.900').length>0,true);
        byText(holder,'Create Floor').onclick();
        assert.equal(draw.disabled,false,'new floor must be selected immediately');
        const floorChoice=byAria(holder,'Floor for room authoring');
        assert.equal(floorChoice.disabled,false);
        const floorID=floorChoice.value;
        assert(floorID,'new floor appears in room-floor selector');
        const hierarchy=byAria(holder,'Building floor room hierarchy');
        const navigate=byText(holder,'Top View / Navigate');
        const restore=byText(holder,'Restore XYZ View');
        assert.equal(navigate.parent,restore.parent,'navigation buttons must share one row');
        const operations=hierarchy.parent.children[hierarchy.parent.children.indexOf(hierarchy)+1];
        assert.equal(navigate.parent.parent,operations,
            'navigation is grouped immediately below the semantic hierarchy');
        const isolate=walk(operations).find(e=>e.tagName==='input'&&e.type==='checkbox'&&
            e.parent?.textContent?.includes('Isolate selected Building'));
        assert(isolate,'tree-adjacent controls contain semantic isolation');
        assert.equal(isolate.disabled,false,'floor and building isolation are available');
        assert(walk(operations).includes(byAria(holder,'Semantic snapshot resolution')),
            'snapshot resolution belongs to tree-adjacent operations');
        assert(walk(operations).includes(byText(holder,'Semantic Model Export...')),
            'semantic export belongs to tree-adjacent operations');
        const priorLive=structuredClone(previewRanges);
        isolate.checked=true;isolate.onchange();await new Promise(resolve=>setImmediate(resolve));
        assert.equal(previewRanges.y.min,0.5,'floor isolation uses the saved floor lower bound');
        assert(previewRanges.y.max<=2.9,'floor isolation uses the ceiling-free view upper bound');
        byText(hierarchy,'Building: Building').onclick();await new Promise(resolve=>setImmediate(resolve));
        assert.deepEqual(previewRanges,preview.full,
            'building isolation applies the selected model full XYZ domain');
        assert.equal(isolate.disabled,false,'building isolation remains enabled');
        isolate.checked=false;isolate.onchange();await new Promise(resolve=>setImmediate(resolve));
        assert.deepEqual(previewRanges,priorLive,
            'disabling semantic isolation restores the original live XYZ preview');
        assert.equal(byText(holder,'Draw Room').parent.parent,
            byText(holder,'Remove Room').parent.parent,
            'room authoring and management buttons belong to the same visual group');
        assert.equal(byAria(holder,'Semantic snapshot resolution').value,'2048x2048',
            'square high-resolution snapshot is available by default');
        byText(hierarchy,'Building: Building').onclick();
        await new Promise(resolve=>setImmediate(resolve));
        assert.equal(draw.disabled,true,'building selection does not silently count as floor selection');
        floorChoice.value=floorID;floorChoice.onchange();
        await new Promise(resolve=>setImmediate(resolve));
        assert.equal(draw.disabled,false,'selecting saved floor next to Room/Area enables drawing');
        await byText(holder,'Ceiling-Free').onclick();await new Promise(resolve=>setImmediate(resolve));
        previewRanges.y={min:0.5,max:2.7};for(const fn of rangeObservers)fn(previewRanges.y,true);
        assert.equal(byText(holder,'Ceiling-Free').attrs['aria-pressed'],'true');
        assert.equal(walk(holder).filter(e=>e.tagName==='input'&&e.value==='2.700').length>0,true);
        await byText(holder,'Wall Slice').onclick();await new Promise(resolve=>setImmediate(resolve));
        previewRanges.y={min:1.1,max:1.5};for(const fn of rangeObservers)fn(previewRanges.y,true);
        assert.equal(byText(holder,'Wall Slice').attrs['aria-pressed'],'true');
        assert.equal(walk(holder).filter(e=>e.tagName==='input'&&e.value==='1.100').length>0,true);
        assert.equal(walk(holder).filter(e=>e.tagName==='input'&&e.value==='1.500').length>0,true);
        await byText(holder,'Ceiling-Free').onclick();await new Promise(resolve=>setImmediate(resolve));
        assert.deepEqual(previewRanges.y,{min:0.5,max:2.7},'switching back restores the saved live view range');
        const viewField=walk(holder).find(e=>e.tagName==='input'&&e.value==='2.700');
        assert(viewField,'ceiling-free bound is visible in form');
        viewField.value='2.600';viewField.listeners.get('input')?.();viewField.listeners.get('change')?.();
        await new Promise(resolve=>setImmediate(resolve));
        assert.deepEqual(previewRanges.y,{min:0.5,max:2.6},'editing the Y field drives the same XYZ preview');
        await byText(holder,'Wall Slice').onclick();await new Promise(resolve=>setImmediate(resolve));
        assert.deepEqual(previewRanges.y,{min:1.1,max:1.5},'switching back to Wall Slice preserves its Y interval');
        byText(holder,'Draw Room').onclick();await new Promise(resolve=>setImmediate(resolve));
        assert.deepEqual(previewRanges.y,{min:1.1,max:1.5},'beginning polygon drawing preserves the live wall slice');
        await ui.dispose();assert.equal(rangeObservers.size,0,'live listeners removed when plugin closes');
    } finally {
        globalThis.document=priorDocument;globalThis.window=priorWindow;
        globalThis.requestAnimationFrame=priorRAF;globalThis.cancelAnimationFrame=priorCancel;
    }
});
