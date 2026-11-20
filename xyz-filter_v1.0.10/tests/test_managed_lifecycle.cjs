'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const code=fs.readFileSync(path.join(__dirname,'../index.js'),'utf8');

// A data URL is a real ESM import with no node package.json dependency. The
// imported plugin must have no import-time side effects.
const load=()=>import('data:text/javascript;base64,'+Buffer.from(code).toString('base64'));

class FakeElement {
  constructor(tag){this.tag=tag;this.children=[];this.style={};this.hidden=false;this.removed=false;this.onclick=null;this.disabled=false;this.textContent='';}
  append(...items){this.children.push(...items);}
  setAttribute(){}
  addEventListener(kind,callback){this[`on${kind}`]=callback;}
  remove(){this.removed=true;}
}

test('XYZ-M01 import has no startup side effects; activate/open/deactivate use manager host',async()=>{
  const oldWindow=global.window,oldDocument=global.document;
  try {
    delete global.window;delete global.document;
    const module=await load();
    assert.equal(typeof module.activate,'function');
    assert.equal(Object.keys(module).length,1,'Only activate is exported');
    const subscriptions=[];
    const scene={elements:[],events:{functions:new Map([['render.image',()=>{}]]),on(name,fn){const h={name,fn,off(){h.offCalled=true;}};subscriptions.push(h);return h;}},
      camera:{captureFrame(){}},commandQueue:{async enqueue(fn){return fn();}}};
    global.window={scene};
    global.document={createElement(tag){return new FakeElement(tag)}};
    const host=new FakeElement('host');
    const handle=await module.activate({editor:{viewport:{captureFrame(){}}},uiHost:host,plugin:{name:'XYZ Filter'}});
    assert.equal(subscriptions.length,3,'baseline, add, and removal listeners');
    assert.equal(subscriptions[0].name,'scene.elementAdded');
    assert.equal(host.children.length,0,'activation must not open panel automatically');
    await handle.open();
    assert.equal(host.children.length,1,'open adds controls to managed host');
    assert.equal(host.children[0].children[0].children[0].textContent,'XYZ Filter');
    assert.equal(handle.isRunning(),true,'opened main panel is Running');
    const body=host.children[0].children[1];
    assert.equal(body.children[1].children.length,2,'Close and Refresh models on same row');
    assert.equal(body.children[1].children[0].textContent,'Close');
    assert.equal(body.children[1].children[1].textContent,'Refresh models');
    assert.equal(body.children[2].children.length,1,'Loaded Model row contains selector only');
    body.children[1].children[1].onclick();
    assert.equal(handle.isRunning(),true,'Refresh models does not close or reinitialize plugin');
    const min=host.children[0].children[0].children[1];
    min.onclick();
    assert.equal(host.children[0].children[1].style.display,'none');
    assert.equal(handle.isRunning(),true,'minimize is not Close/Deactivate');
    min.onclick();
    assert.notEqual(host.children[0].children[1].style.display,'none');
    host.children[0].children[1].children[1].children[0].onclick();
    assert.equal(handle.isRunning(),false,'Close makes activated plugin Closed');
    assert.equal(host.children[0].style.display,'none','Close hides flex panel at CSS level');
    await handle.open();
    assert.equal(host.children[0].style.display,'flex','reopen shows the panel at CSS level');
    assert.equal(handle.isRunning(),true,'reopening changes status to Running');
    await handle.open();
    assert.equal(host.children.length,1,'repeated open does not duplicate panels');
    host.children[0].children[1].children[1].children[0].onclick();
    await handle.deactivate();
    assert.equal(handle.isRunning(),false,'deactivated plugin must report no ongoing work');
    assert.equal(subscriptions[0].offCalled,true,'initial transform listener disposed');
    assert.equal(host.children[0].removed,true,'plugin panel removed');
    await assert.rejects(handle.open(),/inactive/);
    await handle.deactivate();
  } finally {if(oldWindow===undefined) delete global.window;else global.window=oldWindow;
    if(oldDocument===undefined) delete global.document;else global.document=oldDocument;}
});

test('XYZ-M02 restores original baseline semantics for existing and newly loaded models',async()=>{
  const codePrefix=code.split('// === MANAGED PLUGIN ENTRY ===')[0];
  const vm=require('node:vm');
  const ctx=vm.createContext({console,Number,Array,Map,Set,WeakMap,Error,Promise,Float64Array});
  vm.runInContext(codePrefix+'\n;globalThis.track=trackInitialModelTransforms;',ctx);
  const I=[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1];
  const matrix=data=>({data:Float32Array.from(data),clone(){return matrix(this.data)},mul2(a,b){this.data.set(a.data);return this;},equals(b){return [...this.data].every((v,i)=>v===b.data[i])}});
  const listeners=[];
  const scene={elements:[],events:{on(name,fn){const h={name,fn,off(){h.offCalled=true}};listeners.push(h);return h}}};
  const make=()=>({scene,instances:{count:1,transformIndex(){return 0;}},resource:{source:{}},worldTransform:matrix(I),transformPalette:{getTransform(_id,dst){dst.data.set(I)}}});
  const existing=make();scene.elements.push(existing);
  const tracker=ctx.track(scene);
  assert.deepEqual(Array.from(tracker.userAdjustment([existing])),I,
    'original standalone samples an existing layer at initialization');
  const translated=I.slice();translated[12]=7.5;existing.worldTransform=matrix(translated);
  assert.deepEqual(Array.from(tracker.userAdjustment([existing])),translated,
    'post-activation model translation is calculated from initial transform');
  const newLayer=make();scene.elements.push(newLayer);listeners[0].fn(newLayer);
  assert.deepEqual(Array.from(tracker.userAdjustment([newLayer])),I);
  tracker.dispose(); assert(listeners[0].offCalled);
});
