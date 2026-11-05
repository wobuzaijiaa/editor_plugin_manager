const fs=require('node:fs');const vm=require('node:vm');const path=require('node:path');const assert=require('node:assert/strict');
const src=fs.readFileSync(path.join(__dirname,'../external/custom-editor.js'),'utf8');
class Element{
 constructor(id=''){this.id=id;this.style={};this.attrs={};this.listeners={};this.dataset={};this.checked=false;this.disabled=false;this.value='';this.textContent='';}
 setAttribute(k,v){this.attrs[k]=v;}
 addEventListener(k,fn){this.listeners[k]=fn;}
 get valueAsNumber(){return this.value===''?NaN:Number(this.value);}
 getBoundingClientRect(){return {left:0,width:100};}
 setPointerCapture(id){this.capture=id;}
 hasPointerCapture(id){return this.capture===id;}
 releasePointerCapture(){this.capture=null;}
 closest(s){return s==='[data-handle]'&&this.dataset.handle?this:null;}
 remove(){this.removed=true;}
}
class Panel extends Element{
 set innerHTML(html){this.html=html;this.nodes={};for(const m of html.matchAll(/<\w+[^>]*\sid="([\w-]+)"[^>]*>/g)){
   const el=new Element(m[1]);const h=m[0].match(/data-handle="(min|max)"/);if(h)el.dataset.handle=h[1];this.nodes[m[1]]=el;}}
 querySelector(sel){return this.nodes[sel.substring(1)];}
 querySelectorAll(){return Object.values(this.nodes);}
}
const document={panel:null,createElement(name){return name==='section'?new Panel():new Element();},getElementById(id){return id==='custom-xyz-preview'&&this.panel&&!this.panel.removed?this.panel:null;},body:{append(p){document.panel=p;}}};
const errors=[];const fakeDirectory={};const fakeWindow={alert(e){errors.push(String(e));},
 showDirectoryPicker(){this.pickerCalls=(this.pickerCalls||0)+1;return Promise.resolve(fakeDirectory);}};
const ctx=vm.createContext({console,document,window:fakeWindow,Float32Array,Float64Array,Uint8Array,Uint32Array,TextEncoder,
 Number,Array,Map,Set,Error,Promise,setTimeout,clearTimeout,performance});
vm.runInContext(src.split('async function initialize()')[0]+'\n;globalThis.api={openPreview,matMul4};',ctx);
const {openPreview,matMul4}=ctx.api;
function matrix(data){return{data:Float32Array.from(data),clone(){return matrix(this.data);},mul2(a,b){this.data.set(matMul4(a.data,b.data));return this;},equals(b){return this.data.every((x,i)=>x===b.data[i]);}};}
const ID=[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1];
const scene={elements:[],forceRender:false,events:{invoke(name){if(name==='timeline.playing')return false;if(name==='lockedClr')return color;return null;}},commandQueue:{async enqueue(fn){return await fn();}}};
const color={a:.05,clone(){return{a:this.a,copy(o){this.a=o.a;}};},copy(c){this.a=c.a;}};
const original=[1,1,3];const instances={flags:Uint8Array.from(original),count:3,sourceRow:Uint32Array.from([0,1,2]),palette:Uint32Array.from([0,0,0]),transformIndex(){return 0;},clearBits(r,b){r.forEach(i=>this.flags[i]&=~b);},setBits(r,b){r.forEach(i=>this.flags[i]|=b);},flush(){}};
const splat={scene,visible:true,instances,worldTransform:matrix(ID),transformPalette:{getTransform(id,out){out.data.set(ID);}},resource:{sourcePool:{acquire(p,l,n){return{data:new ArrayBuffer(n*12),release(){}};}},source:{meta:{chunkSize:3,layouts:{position:{}}},async read({count,position}){let out=new Float32Array(position.data);for(let i=0;i<count;i++)out.set([0+i*10,30+i*10,0+i*10],3*i);}}}};
scene.elements=[splat];
const tick=()=>new Promise(r=>setTimeout(r,8));
(async()=>{
 const job=openPreview(scene,{userAdjustment(){return ID.slice();}});await tick();const p=document.panel;assert(p,'panel should render');
 const n=id=>p.nodes[id];
 assert(p.style.cssText.includes('bottom:102px'),'bottom-right location');
 assert.equal((p.html.match(/type="number" step="1"/g)||[]).length,6,'all three axes use numeric spinner steps of 1 model unit');
 for(const axis of ['x','y','z']){
   assert(n(`${axis}-min`)&&n(`${axis}-max`)&&n(`${axis}-slider`)&&n(`${axis}-min-handle`)&&n(`${axis}-max-handle`)&&n(`${axis}-reset`),`${axis}: all controls`);
   assert(n(`${axis}-min`).value.match(/^-?\d+\.\d{3}$/),'min shows 3 decimals');
   assert(n(`${axis}-max`).value.match(/^-?\d+\.\d{3}$/),'max shows 3 decimals');
 }
 assert.equal(n('x-domain').textContent,'Full X: 0.000 to 20.000');
 assert.equal(n('y-domain').textContent,'Full Y: 30.000 to 50.000');
 assert.equal(n('z-domain').textContent,'Full Z: 0.000 to 20.000');
 n('enabled').checked=true;n('enabled').onchange();await tick();
 // Different X and Z restrictions act as intersection, not OR.
 n('x-max').value='10.000';n('x-max').onchange();await tick();
 assert.deepEqual([...instances.flags],[1,1,3], 'X excludes last instance');
 n('z-min').value='10.000';n('z-min').onchange();await tick();
 assert.deepEqual([...instances.flags],[3,1,3],'XYZ intersection excludes first and third');
 // Verify independent reset, with filter remaining enabled.
 n('z-reset').onclick();await tick();
 assert.deepEqual([...instances.flags],[1,1,3], 'Z reset includes first again');
 // Validate zero-width Z interval by drag to max.
 const slider=n('z-slider'), minHandle=n('z-min-handle');
 slider.listeners.pointerdown({button:0,pointerId:6,target:minHandle,clientX:0,preventDefault(){}});
 slider.listeners.pointermove({pointerId:6,clientX:100});
 slider.listeners.pointerup({pointerId:6,clientX:100});await tick();
 assert.equal(n('z-min').value,'20.000');assert.equal(n('z-max').value,'20.000');
 assert.equal(n('z-selected').style.width,'0%','handles may coincide');
 assert.deepEqual([...instances.flags],[3,3,3],'with x <= 10 and z == 20, no eligible center');
 // Typed numeric input and keyboard are preserved.
 n('z-min-handle').listeners.keydown({key:'ArrowLeft',preventDefault(){}});await tick();
 assert.equal(n('z-min').value,'19.000','keyboard arrows move by 1 model unit');
 n('z-min').value='10.000';n('z-min').onchange();await tick();
 assert.equal(n('z-min').value,'10.000');
 // The preview hands the post-load user adjustment and XYZ ranges to captureSnapshot, which resolves
 // the selected orthographic axis using the actual captured camera quaternion.
 vm.runInContext('captureSnapshot = async (_s,m,_w,_h,d,label)=>{globalThis.capturedMetadata=m;globalThis.destination=d;globalThis.label=label;return {image:"topdown_unlabeled_20261104T100000000Z.png"};}',ctx);
 await n('snapshot').onclick();
 assert.equal(fakeWindow.pickerCalls,1,'picker invoked directly by snapshot click');
 assert.equal(ctx.destination,fakeDirectory);
 assert.equal(ctx.label,'');
 assert.equal(n('status').textContent,'Snapshot saved in folder: topdown_unlabeled_20261104T100000000Z');
 assert(ctx.capturedMetadata);
 assert.equal(ctx.capturedMetadata.ranges.y.min,30);
 assert.equal(ctx.capturedMetadata.ranges.x.max,10);
 assert.equal(ctx.capturedMetadata.ranges.z.min,10);
 assert.equal(ctx.capturedMetadata.model_to_snapshot[0][0],1);
 assert.equal(ctx.capturedMetadata.section_id,'');
 // Filtered-model export UI passes current ranges to native export bridge;
 // the bridge is independently tested with mock scene.write and cleanup.
 vm.runInContext('exportFilteredModel = async (_s,_m,r,f,ready,reportCtx)=>{globalThis.exportRequest={ranges:r,format:f,ready:ready(),reportCtx};return {modelExported:true,report:{delivery:"browser_download_requested",filename:"filtered.export.json"}};}',ctx);
 n('export-format').value='ply';
 n('export-filtered').onclick();await tick();
 assert.equal(ctx.exportRequest.format,'ply');
 assert.equal(ctx.exportRequest.ranges.x.max,10);
 assert.equal(ctx.exportRequest.ranges.z.min,10);
 assert.equal(ctx.exportRequest.ready,true);
 assert.equal(ctx.exportRequest.reportCtx.sectionId,'');
 assert.equal(ctx.exportRequest.reportCtx.userAdjustment([splat])[0],1);
 assert.equal(n('status').textContent,'Model exported; JSON report download requested: filtered.export.json');
 assert.equal(n('export-filtered').disabled,false);
 // Drag an interior selected range as a unit: width must remain unchanged.
 n('x-min').value='5.000';n('x-min').onchange();await tick();
 const xbar=n('x-slider'), selected=n('x-selected');
 xbar.listeners.pointerdown({button:0,pointerId:8,target:selected,clientX:50,preventDefault(){}});
 xbar.listeners.pointermove({pointerId:8,clientX:75});
 xbar.listeners.pointerup({pointerId:8,clientX:75});await tick();
 assert.equal(n('x-min').value,'10.000');
 assert.equal(n('x-max').value,'15.000');
 // Clear returns full visibility, without changing selected ranges.
 n('reset').onclick();await tick();
 assert.equal(n('enabled').checked,false);
 assert.deepEqual([...instances.flags],original,'Clear filter restores original bits');
 n('close').onclick();await job;
 assert(p.removed);assert.deepEqual([...instances.flags],original);
 assert.equal(color.a,.05);assert.deepEqual(errors,[]);
 console.log('PASS UI: XYZ panels, 3 decimal fields and 1-unit stepping, intersection mask, zero-width, reset, keyboard, input, snapshot metadata, close restoration');
})().catch(e=>{console.error(e);process.exitCode=1;});
