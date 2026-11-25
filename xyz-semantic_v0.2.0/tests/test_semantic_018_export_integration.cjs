'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'), vm=require('node:vm'), path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'../index.js'),'utf8');
const ctx=vm.createContext({console,window:{showDirectoryPicker(){}},Array,Map,Set,Number,Date,
    Error,Float64Array,Uint8Array,Uint32Array,TextEncoder,structuredClone,setTimeout,clearTimeout});
vm.runInContext(source.split('// === MANAGED PLUGIN ENTRY ===')[0]+'\n;globalThis.exportFilteredModel=exportFilteredModel;',ctx);
const bounds={x:{min:0,max:1},y:{min:0,max:0},z:{min:0,max:0}};
const centers={x:Float64Array.from([0,1]),y:Float64Array.from([0,0]),z:Float64Array.from([0,0])};
function fixture(nativeSize=0, nativeAge=0) {
  const root=new Map(),child=new Map(),removed=[];
  const nativeHandle={name:'unused-native.sog',getFile:async()=>({size:nativeSize,lastModified:Date.now()-nativeAge}),
    isSameEntry:async other=>other===nativeHandle};
  root.set(nativeHandle.name,nativeHandle);
  const folder={async getFileHandle(name,opts={}){
      if(!child.has(name)&&!opts.create){const e=Error('missing');e.name='NotFoundError';throw e;}
      if(!child.has(name))child.set(name,{bytes:undefined});
      return {createWritable:async()=>({write:async b=>{child.get(name).bytes=b},close:async()=>{},abort:async()=>{}})};
    },async removeEntry(name){child.delete(name)}};
  const parent={async getDirectoryHandle(_name,opts){
      if(!opts?.create){const e=Error('missing');e.name='NotFoundError';throw e;}return folder;
    },async getFileHandle(name){return root.get(name)},
    async removeEntry(name){removed.push(name);root.delete(name)}};
  const mat={equals:()=>true};
  const splat={name:'Office',visible:true,worldTransform:mat,instances:{count:2},
    resource:{source:true},createLayer(){return {worldTransform:mat,destroy(){}}}};
  const mask={splat,centers,instances:splat.instances,verify(){}};
  const scene={elements:[splat],events:{functions:new Map([['scene.write',true],['show.exportPopup',true]]),
    async invoke(name,...args){
      if(name==='scene.getExportDirectory')return parent;
      if(name==='show.exportPopup')return {filename:'unused-native.sog',directory:parent,
          fileTarget:{handle:nativeHandle},shBands:3};
      if(name==='scene.write'){
          const stream=args[2];assert(stream);
          await stream.write(new Uint8Array([1,2,3]));await stream.close();return true;
      }
      throw Error(name);
    }}};splat.scene=scene;
  const reportContext={userAdjustment:()=>null,sectionId:'f',
    semantic:{target_type:'floor',floor_id:'f'},semanticOutputStem:'Office_EG_20261125T100000000Z'};
  return {scene,mask,reportContext,root,child,removed};
}
test('SEM-59 end-to-end semantic model export removes unused empty native file only after saving model and report',async()=>{
  const f=fixture();const result=await ctx.exportFilteredModel(f.scene,[f.mask],bounds,'sog',()=>true,f.reportContext);
  assert.equal(result.modelExported,true);
  assert.equal(result.placeholder.cleaned,true);
  assert.deepEqual(f.removed,['unused-native.sog']);
  assert(f.child.has(`${f.reportContext.semanticOutputStem}.sog`));
  assert(f.child.has(`${f.reportContext.semanticOutputStem}.export.json`));
});
test('SEM-60 end-to-end semantic export retains an existing nonempty native target',async()=>{
  const f=fixture(128,3600000);const result=await ctx.exportFilteredModel(f.scene,[f.mask],bounds,'sog',()=>true,f.reportContext);
  assert.equal(result.modelExported,true);
  assert.equal(result.placeholder.cleaned,false);
  assert.equal(f.removed.length,0);
  assert(f.root.has('unused-native.sog'));
});
