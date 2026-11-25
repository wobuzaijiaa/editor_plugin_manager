'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../index.js'), 'utf8');

class Element {
    constructor(id = '') { this.id=id; this.children=[]; this.nodes={}; this.value=''; this.textContent=''; this.checked=false;
        this.disabled=false; this.removed=false; this.style={}; this.listeners={}; this.dataset={}; }
    append(...children) { this.children.push(...children); }
    replaceChildren(...children) { this.children=[...children]; }
    remove() { this.removed=true; }
    setAttribute() {}
    addEventListener(name, handler) { this.listeners[name]=handler; }
    get valueAsNumber() {return Number(this.value);}
}
class Panel extends Element {
    set innerHTML(html) {
        this.html=html;
        for (const found of html.matchAll(/<\w+[^>]*\sid="([\w-]+)"[^>]*>/g)) this.nodes[found[1]]=new Element(found[1]);
    }
    querySelector(selector) { return this.nodes[selector.slice(1)]; }
    querySelectorAll() { return Object.values(this.nodes); }
}
const I=[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1];
const mat=data=>({data:Float32Array.from(data),clone(){return mat(this.data);},mul2(a){this.data.set(a.data);return this;},equals(b){return this.data.every((v,i)=>v===b.data[i]);}});
function setup() {
    const handlers=new Map();
    const color={a:.05,clone(){return {a:this.a};},copy(v){this.a=v.a;}};
    const scene={elements:[],forceRender:false,events:{functions:new Map([['render.image',()=>{}]]),
        on(name,fn){const list=handlers.get(name)||[];list.push(fn);handlers.set(name,list);return {off(){const n=list.indexOf(fn);if(n>=0)list.splice(n,1);}};},
        invoke(name){if(name==='timeline.playing')return false;if(name==='lockedClr')return color;return null;}},
        camera:{captureFrame(){}},commandQueue:{async enqueue(fn){return await fn();}}};
    function fire(name,model){for(const fn of [...(handlers.get(name)||[])])fn(model);}
    function make(name) {
        const original=[1,1,1];
        const instances={flags:Uint8Array.from(original),count:3,sourceRow:Uint32Array.from([0,1,2]),palette:Uint32Array.from([0,0,0]),
            transformIndex(){return 0;},clearBits(range,bit){range.forEach(i=>this.flags[i]&=~bit);},
            setBits(range,bit){range.forEach(i=>this.flags[i]|=bit);},flush(){if(this.disposed)throw Error('GPU buffer destroyed');}};
        return {name,scene,visible:true,instances,worldTransform:mat(I),transformPalette:{getTransform(id,out){out.data.set(I);}},
            resource:{sourcePool:{acquire(_p,_l,n){return {data:new ArrayBuffer(n*12),release(){}};}},
                source:{meta:{chunkSize:3,layouts:{position:{}}},async read({position,count}){
                    const out=new Float32Array(position.data);for(let i=0;i<count;i++)out.set([i*10,i*10,i*10],3*i);
                }}}};
    }
    function add(model){scene.elements.push(model);model.scene=scene;fire('scene.elementAdded',model);}
    function remove(model){const i=scene.elements.indexOf(model);if(i>=0)scene.elements.splice(i,1);
        fire('scene.elementRemoved',model);model.scene=null;model.instances.disposed=true;}
    const host=new Element('host');
    const document={createElement(tag){return tag==='section'?new Panel():new Element(tag);},
        getElementById(id){return host.children.find(e=>e.id===id&&!e.removed)||null;},
        body:{append(node){host.append(node);}}};
    const alerts=[];
    const window={scene,alert(msg){alerts.push(msg);},showDirectoryPicker(){return Promise.resolve({});}};
    const ctx=vm.createContext({document,window,console,Float32Array,Float64Array,Uint8Array,Uint32Array,
        TextEncoder,Map,Set,WeakMap,Promise,Array,Number,Error,performance,setTimeout,clearTimeout});
    vm.runInContext(source.replace('export async function activate','async function activate')+
        '\n;globalThis.api={activate,openPreview,filteredExportReport,modelAttached,isolateModel};',ctx);
    const tick=()=>new Promise(r=>setTimeout(r,15));
    return {scene,make,add,remove,color,document,window,host,alerts,ctx,tick};
}

test('XYZ-S01 another model is imported while filtering, without invalidating selected target',async()=>{
    const f=setup(),A=f.make('A'),B=f.make('B');f.add(A);f.add(B);
    const tracker={userAdjustment(){return I.slice();}};
    const preview=f.ctx.api.openPreview(f.scene,tracker,null,A);await f.tick();
    const p=f.host.children[0];assert.equal(p.nodes.target.textContent.includes('A'),true);
    assert.equal(A.visible,true);assert.equal(B.visible,false,'other model isolated');
    p.nodes.enabled.checked=true;p.nodes.enabled.onchange();await f.tick();
    const C=f.make('C');f.add(C);await f.tick();
    assert.equal(C.visible,false,'newly imported model also excluded');
    p.nodes['x-max'].value='10';p.nodes['x-max'].onchange();await f.tick();
    assert.match(p.nodes.status.textContent,/Filter active/);
    assert.deepEqual([...B.instances.flags],[1,1,1]);assert.deepEqual([...C.instances.flags],[1,1,1]);
    f.remove(B);p.nodes['x-min'].value='0';p.nodes['x-min'].onchange();await f.tick();
    assert.match(p.nodes.status.textContent,/Filter active/,'removing an unrelated model does not invalidate preview');
    p.nodes.close.onclick();await preview;
    assert.equal(C.visible,true,'other live model visibility restored');
    assert.deepEqual([...A.instances.flags],[1,1,1]);
    assert.equal(f.color.a,.05);assert.equal(f.alerts.length,0);
});

test('XYZ-S02 deleting selected model closes preview and never writes disposed GPU buffer',async()=>{
    const f=setup(),A=f.make('A'),B=f.make('B');f.add(A);f.add(B);
    const task=f.ctx.api.openPreview(f.scene,{userAdjustment(){return I.slice();}},null,A);await f.tick();
    const p=f.host.children[0];p.nodes.enabled.checked=true;p.nodes.enabled.onchange();await f.tick();
    f.remove(A);await task;
    assert.equal(p.removed,true);assert.equal(B.visible,true);
    assert.deepEqual(f.alerts,[],'deletion must not escalate to a restoration failure');
    assert.equal(f.color.a,.05);
});

test('XYZ-S03 selected-model export metadata remains single-model; changed surviving flags fail closed',async()=>{
    const f=setup(),A=f.make('A'),B=f.make('B');f.add(A);f.add(B);
    const r={x:{min:0,max:20},y:{min:0,max:20},z:{min:0,max:20}};
    const centers={x:Float64Array.from([0,10,20]),y:Float64Array.from([0,10,20]),z:Float64Array.from([0,10,20])};
    const ctx=f.ctx;
    vm.runInContext(';globalThis.makeMask = (s,c) => new PreviewMask(s,c);',ctx);
    const mask=ctx.makeMask(A,centers);
    const report=ctx.api.filteredExportReport([mask],r,{filename:'A.ply',serializeSettings:{}},'ply','',I);
    assert.equal(report.source_layers.length,1);
    assert.equal(report.source_model_name,'A');
    assert.equal(report.mapping_status,'declared_uniform');
    mask.apply(r);A.instances.flags[0]|=4;
    assert.throws(()=>mask.restore(f.scene),/outside XYZ preview/);
});

test('XYZ-S04 multiple loaded models require selection; XYZ controls appear without a separate preview button',async()=>{
    const f=setup(),A=f.make('A'),B=f.make('B');f.add(A);f.add(B);
    const handle=await f.ctx.api.activate({editor:{viewport:{captureFrame(){}}},uiHost:f.host,plugin:{name:'XYZ'}});
    await handle.open();
    const main=f.host.children[0],body=main.children[1],selector=body.children[2].children[0].children[0];
    assert.equal(selector.value,'','two-model scene has no ambiguous default');
    assert.match(body.children[3].textContent,/Select a loaded model/);
    assert.equal(body.children[1].children.length,2,'Close and Refresh models share one actions row; no preview-open button');
    assert.equal(body.children[1].children[0].textContent,'Close');
    assert.equal(body.children[1].children[1].textContent,'Refresh models');
    assert.equal(body.children[2].children.length,1,'Loaded Model row contains only the selector');
    selector.value='1';selector.onchange();await f.tick();
    const preview=body.children[4].children[0];
    assert.equal(f.host.children.length,1,'no separate preview popup');
    assert.match(preview.nodes.target.textContent,/B/);
    body.children[1].children[0].listeners.click();await f.tick();
    assert.equal(main.hidden,true);
    await handle.deactivate();
});

test('XYZ-S05 preview snapshot for two loaded models uses only the selected model',async()=>{
    const f=setup(),A=f.make('A'),B=f.make('B');f.add(A);f.add(B);
    const task=f.ctx.api.openPreview(f.scene,{userAdjustment(){return I.slice();}},null,A);await f.tick();
    const p=f.host.children[0];
    p.nodes.enabled.checked=true;p.nodes.enabled.onchange();await f.tick();
    f.ctx.recordScene=()=>({selectedVisible:A.visible,otherVisible:B.visible});
    vm.runInContext(`captureSnapshot = async (_s,metadata,_w,_h,_d,_id,_frame,verify,modelName) => {
        verify(); globalThis.snapshotCheck={metadata,modelName,scene:recordScene()};
        verify();return {image:'one.png'};
    }`,f.ctx);
    await p.nodes.snapshot.onclick();
    assert.equal(f.ctx.snapshotCheck.modelName,'A');
    assert.equal(f.ctx.snapshotCheck.metadata.source_model_name,'A');
    assert.equal(f.ctx.snapshotCheck.metadata.model_to_snapshot[0][0],1);
    assert.equal(f.ctx.snapshotCheck.scene.selectedVisible,true);
    assert.equal(f.ctx.snapshotCheck.scene.otherVisible,false);
    assert.match(p.nodes.status.textContent,/Snapshot saved/);
    p.nodes.close.onclick();await task;
    assert.equal(B.visible,true);
});

test('XYZ-S06 scene change during capture reports failure instead of false snapshot success',async()=>{
    const f=setup(),A=f.make('A');f.add(A);
    const task=f.ctx.api.openPreview(f.scene,{userAdjustment(){return I.slice();}},null,A);await f.tick();
    const p=f.host.children[0];
    f.ctx.addDuringCapture=()=>f.add(f.make('B'));
    vm.runInContext(`captureSnapshot = async (_s,_metadata,_w,_h,_d,_id,_frame,verify) => {
        verify();addDuringCapture();verify();return {image:'should_not_be_saved.png'};
    }`,f.ctx);
    await p.nodes.snapshot.onclick();
    assert.match(p.nodes.status.textContent,/Snapshot failed: Scene changed during snapshot capture/);
    p.nodes.close.onclick();await task;
    assert.equal(f.scene.elements[1].visible,true,'added model visibility restored after preview');
});

test('XYZ-S07 unfiltered Snapshot remains selected-model isolated when controls initialize automatically',async()=>{
    const f=setup(),A=f.make('A'),B=f.make('B');f.add(A);f.add(B);
    const handle=await f.ctx.api.activate({editor:{viewport:{captureFrame(){}}},uiHost:f.host,plugin:{name:'XYZ'}});
    await handle.open();
    const main=f.host.children[0],body=main.children[1];
    const select=body.children[2].children[0].children[0];
    select.value='0';select.onchange();await f.tick();
    const preview=body.children[4].children[0];
    f.ctx.recordScene=()=>({A:A.visible,B:B.visible});
    vm.runInContext(`captureSnapshot=async (_s,m,_w,_h,_d,_sid,_capture,verify,name)=>{
        verify(); globalThis.standalone={visibility:recordScene(),name,metadata:m};
        verify(); return {image:'selected-model.png'};
    }`,f.ctx);
    preview.nodes['snapshot-slot'].children[0].listeners.click();await f.tick();
    assert(f.ctx.standalone, `Expected capture; status: ${preview.nodes.status.textContent}`);
    assert.equal(f.ctx.standalone.name,'A');
    assert.equal(f.ctx.standalone.visibility.A,true);
    assert.equal(f.ctx.standalone.visibility.B,false);
    assert.equal(f.ctx.standalone.metadata.ranges,undefined,'unfiltered snapshot does not fabricate XYZ range metadata');
    await handle.deactivate();
    assert.equal(B.visible,true,'snapshot isolation is restored');
});

test('XYZ-S08 managed merged window preserves filtered capture behind its one Snapshot button',async()=>{
    const f=setup(),A=f.make('A'),B=f.make('B');f.add(A);f.add(B);
    const handle=await f.ctx.api.activate({editor:{viewport:{captureFrame(){}}},uiHost:f.host,plugin:{name:'XYZ'}});
    await handle.open();
    const main=f.host.children[0],body=main.children[1];
    const select=body.children[2].children[0].children[0];
    select.value='0';select.onchange();
    const actions=body.children[1].children;
    assert.equal(actions.length,2,'Close and Refresh models share the top action row');
    assert.equal(actions[0].textContent,'Close');
    assert.equal(actions[1].textContent,'Refresh models');
    await f.tick();
    const container=body.children[4], preview=container.children[0];
    assert.equal(f.host.children.length,1,'the preview is not a second popup');
    assert.equal(preview.id,'custom-xyz-semantic-preview');
    assert.equal(preview.nodes.snapshot,undefined,'only one Top-Down Snapshot control is rendered');
    assert.match(main.style.cssText,/left:24px;bottom:24px/);
    assert.match(main.style.cssText,/resize:both/);
    assert.match(body.style.cssText,/overflow-y:auto/);
    assert.match(preview.style.cssText,/position:static/);
    preview.nodes.enabled.checked=true;preview.nodes.enabled.onchange();await f.tick();
    preview.nodes['x-max'].value='10.000';preview.nodes['x-max'].onchange();await f.tick();
    const context=f.ctx;
    vm.runInContext(`captureSnapshot=async (_s,metadata,_w,_h,_d,_sid,_capture,verify,name)=>{
        verify();globalThis.mergedCapture={metadata,name};verify();return {image:'filtered.png'};
    }`,context);
    preview.nodes['snapshot-slot'].children[0].listeners.click();await f.tick();
    assert(context.mergedCapture,'Snapshot below Clear filter should route to preview capture');
    assert.equal(context.mergedCapture.name,'A');
    assert.equal(context.mergedCapture.metadata.ranges.x.max,10);
    assert.equal(context.mergedCapture.metadata.source_model_name,'A');
    assert.equal(context.mergedCapture.metadata.mapping_status,'declared_uniform');
    assert.match(preview.nodes.status.textContent,/Snapshot saved/);
    actions[0].listeners.click();await f.tick();
    assert.equal(container.children[0].removed,true,'nested preview removed on main Close');
    assert.equal(B.visible,true,'unrelated model restored');
    assert.deepEqual([...A.instances.flags],[1,1,1],'preview mask restored');
    assert.equal(main.hidden,true,'Close hides panel after restoration');
    assert.equal(handle.isRunning(),false);
    await handle.deactivate();
});

test('XYZ-S09 selecting a second model restores the previous preview before rebinding',async()=>{
    const f=setup(),A=f.make('A'),B=f.make('B');f.add(A);f.add(B);
    const handle=await f.ctx.api.activate({editor:{viewport:{captureFrame(){}}},uiHost:f.host,plugin:{name:'XYZ'}});
    await handle.open();
    const body=f.host.children[0].children[1];
    const select=body.children[2].children[0].children[0];
    select.value='0';select.onchange();await f.tick();
    const first=body.children[4].children[0];
    assert.equal(first.nodes.target.textContent.includes('A'),true);
    assert.equal(B.visible,false,'A preview isolates B');
    select.value='1';select.onchange();
    await f.tick();await f.tick();
    const second=body.children[4].children[0];
    assert.equal(first.removed,true,'A preview must be removed before B preview starts');
    assert.equal(second.nodes.target.textContent.includes('B'),true);
    assert.equal(A.visible,false,'B preview isolates A');
    assert.equal(B.visible,true,'B is the selected model');
    assert.deepEqual([...A.instances.flags],[1,1,1],'switch restores previous model flags');
    await handle.deactivate();
    assert.equal(A.visible,true,'deactivation restores A visibility');
    assert.equal(B.visible,true,'deactivation preserves B visibility');
});

test('XYZ-S10 a single loaded model automatically displays the merged XYZ controls',async()=>{
    const f=setup(),A=f.make('A');f.add(A);
    const handle=await f.ctx.api.activate({editor:{viewport:{captureFrame(){}}},uiHost:f.host,plugin:{name:'XYZ'}});
    await handle.open();await f.tick();
    const main=f.host.children[0],body=main.children[1],preview=body.children[4].children[0];
    assert.equal(preview.id,'custom-xyz-semantic-preview');
    assert.equal(preview.nodes.enabled.checked,false,'no filter is enabled by default');
    assert.equal(body.children[1].children.length,2,'Close and Refresh models without a preview-open button');
    const slots=preview.nodes['snapshot-slot'].children;
    assert.equal(slots.length,1,'Snapshot is inside the inline preview after Clear filter');
    assert.match(slots[0].textContent,/Top-Down Snapshot/);
    assert.equal(slots[0].style.cssText.includes('background'),true,'Snapshot button retains main styling');
    assert.equal(preview.nodes.close,undefined,'only the merged window Close is shown');
    await handle.deactivate();
});
