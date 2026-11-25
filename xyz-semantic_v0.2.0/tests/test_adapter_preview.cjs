'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');const vm=require('node:vm');const path=require('node:path');
const raw=fs.readFileSync(path.join(__dirname,'../index.js'),'utf8');
class Element {
  constructor(id=''){this.id=id;this.style={};this.attrs={};this.listeners={};this.children=[];
    this.dataset={};this.checked=false;this.disabled=false;this.value='';this.textContent='';this.removed=false;}
  setAttribute(k,v){this.attrs[k]=v;}
  addEventListener(k,fn){this.listeners[k]=fn;}
  append(...els){this.children.push(...els);}
  get valueAsNumber(){return this.value===''?NaN:Number(this.value);}
  remove(){this.removed=true;}
  getBoundingClientRect(){return{left:0,width:100};}
  setPointerCapture(id){this.capture=id;}
  hasPointerCapture(id){return this.capture===id;}
  releasePointerCapture(){this.capture=null;}
  closest(selector){return selector==='[data-handle]'&&this.dataset.handle?this:null;}
}
class Panel extends Element {
  set innerHTML(html){this.html=html;this.nodes={};for(const m of html.matchAll(/<\w+[^>]*\sid="([\w-]+)"[^>]*>/g)){
    const el=new Element(m[1]);const h=m[0].match(/data-handle="(min|max)"/);if(h)el.dataset.handle=h[1];this.nodes[m[1]]=el;}}
  querySelector(sel){return this.nodes[sel.slice(1)];}
  querySelectorAll(){return Object.values(this.nodes);}
}
const tick=()=>new Promise(r=>setTimeout(r,12));
test('XYZ-M03 managed deactivate closes live XYZ preview and restores Gaussian flags',async()=>{
  const host={nodes:[],append(node){this.nodes.push(node);}};
  const document={createElement(tag){return tag==='section'?new Panel():new Element();},
    getElementById(id){return host.nodes.find(n=>n.id===id&&!n.removed)||null;}};
  const I=[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1];
  function matrix(data){return{data:Float32Array.from(data),clone(){return matrix(this.data);},mul2(a,b){this.data.set(a.data);return this;},equals(b){return [...this.data].every((v,i)=>v===b.data[i]);}};}
  const original=[1,1,1];
  const instances={flags:Uint8Array.from(original),count:3,sourceRow:Uint32Array.from([0,1,2]),palette:Uint32Array.from([0,0,0]),transformIndex(){return 0;},
    clearBits(r,b){r.forEach(i=>this.flags[i]&=~b);},setBits(r,b){r.forEach(i=>this.flags[i]|=b);},flush(){}};
  const events=[];
  const color={a:.05,clone(){return{a:this.a,copy(o){this.a=o.a;}}},copy(other){this.a=other.a;}};
  const scene={elements:[],events:{functions:new Map([['render.image',()=>{}]]),
    on(name,fn){const listener={name,fn,off(){listener.closed=true;}};events.push(listener);return listener;},
    invoke(name){if(name==='timeline.playing')return false;if(name==='lockedClr')return color;return null;}},
    camera:{captureFrame(){}},commandQueue:{async enqueue(fn){return fn();}},forceRender:false};
  const splat={scene,visible:true,instances,worldTransform:matrix(I),transformPalette:{getTransform(_i,out){out.data.set(I);}},
    resource:{sourcePool:{acquire(_p,_l,n){return {data:new ArrayBuffer(n*12),release(){}};}},source:{meta:{chunkSize:3,layouts:{position:{}}},
      async read({count,position}){const dst=new Float32Array(position.data);for(let i=0;i<count;i++) dst.set([i*10,i*10,i*10],3*i);}}}};
  scene.elements.push(splat);
  const window={scene,alert(){throw Error('Unexpected window.alert from preview cleanup');}};
  const ctx=vm.createContext({document,window,console,Float32Array,Float64Array,Uint8Array,Uint32Array,TextEncoder,
    Number,Array,Map,Set,Error,Promise,setTimeout,clearTimeout,performance});
  vm.runInContext(raw.replace('export async function activate','async function activate')+'\n;globalThis.activatePlugin=activate;',ctx);
  const handle=await ctx.activatePlugin({editor:{viewport:{captureFrame(){}}},plugin:{name:'XYZ'},uiHost:host});
  await handle.open();
  assert.equal(handle.isRunning(),true,'opened XYZ controls report Running');
  assert.equal(host.nodes.length,1);
  const main=host.nodes[0];
  const buttons=main.children[1].children[1].children;
  assert.equal(buttons.length,2,'Close and Refresh models share the action row; no redundant preview-open button');
  assert.equal(buttons[0].textContent,'Close');
  assert.equal(buttons[1].textContent,'Refresh models');
  assert.equal(main.children[1].children[2].children.length,1,'Loaded Model remains on its own row');
  await tick(); // Preview initializes automatically for the single loaded model.
  const preview=main.children[1].children[4].children[0];assert.equal(host.nodes.length,1,'preview is embedded in main window');assert.equal(preview.id,'custom-xyz-semantic-preview');
  assert.equal(preview.nodes.snapshot,undefined,'one Snapshot control is mounted below Clear filter');
  assert.equal(preview.nodes['snapshot-slot'].children.length,1);
  preview.nodes['enabled'].checked=true;preview.nodes['enabled'].onchange();
  await tick();
  preview.nodes['x-max'].value='10.000';preview.nodes['x-max'].onchange();
  await tick();
  assert.deepEqual([...instances.flags],[1,1,3],'mask excludes the third Gaussian');
  buttons[0].listeners.click();
  await tick();
  assert.equal(main.hidden,true,'main Close restores active preview and marks merged panel hidden');
  assert.equal(main.style.display,'none','main Close also hides inline flex layout (visible v1.0.7 regression)');
  assert.deepEqual([...instances.flags],original,'Close restores original Gaussian flags');
  assert.equal(handle.isRunning(),false,'closed main panel reports Closed');
  await handle.open();
  assert.equal(main.style.display,'flex','reopen restores the flex layout');
  assert.equal(main.hidden,false,'reopen clears hidden state');
  await tick();
  assert(main.children[1].children[4].children.some(p=>p.id==='custom-xyz-semantic-preview'&&!p.removed), 'reopen starts a fresh XYZ preview');
  main.children[1].children[1].children[0].listeners.click();
  await tick();
  assert.equal(main.style.display,'none','repeated Close still hides the complete window');
  await handle.deactivate();
  assert.deepEqual([...instances.flags],original,'manager deactivation restores original Gaussian flags');
  assert.equal(handle.isRunning(),false,'forced preview cleanup reports Closed');
  assert(preview.removed,'preview DOM removed');
  assert(main.removed,'main controls removed');
  assert(events.some(e=>e.name==='scene.elementAdded'&&e.closed),'baseline listener disposed');

  // Repeat with a deliberately broken native restoration. The first Force
  // Deactivate must fail, and a retry must NEVER misreport cleanup success.
  const second=await ctx.activatePlugin({editor:{viewport:{captureFrame(){}}},plugin:{name:'XYZ'},uiHost:host});
  await second.open();
  const otherMain=host.nodes[1];
  await tick();
  const otherPreview=otherMain.children[1].children[4].children[0];
  otherPreview.nodes['enabled'].checked=true;
  otherPreview.nodes['enabled'].onchange();
  await tick();
  const normalClear=instances.clearBits;
  instances.clearBits=()=>{throw Error('deliberate Gaussian restore failure');};
  await assert.rejects(second.deactivate(),/restore cleanly/i);
  assert.throws(()=>second.isRunning(),/restore|cleanup/i);
  await assert.rejects(second.deactivate(),/restore cleanly/i,
    'repeated force cleanup must not claim success after an incomplete restoration');
  instances.clearBits=normalClear;
});
