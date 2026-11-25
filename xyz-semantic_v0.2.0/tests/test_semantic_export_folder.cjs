'use strict';
const {test}=require('node:test');const assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'../index.js'),'utf8');
const ctx=vm.createContext({console,window:{},Array,Map,Set,Number,Error,Float64Array,Uint8Array,Uint32Array,TextEncoder,structuredClone,setTimeout,clearTimeout});
vm.runInContext(source.split('// === MANAGED PLUGIN ENTRY ===')[0]+'\n;globalThis.exportFilteredModel = exportFilteredModel;',ctx);
const centers={x:Float64Array.from([0,1,2]),y:Float64Array.from([0,0,0]),z:Float64Array.from([0,0,0])};
const ranges={x:{min:0,max:2},y:{min:0,max:0},z:{min:0,max:0}};
const mat={equals(){return true;}};
const splat={name:'Office',visible:true,worldTransform:mat,createLayer(){return {worldTransform:mat,destroy(){}};}};
const mask={centers,splat,instances:{count:3},verify(){}};
const files=new Map(),folders=new Map();
function makeFolder(){return {files,async getFileHandle(name,opts){
    if(!opts?.create && !files.has(name)){const e=Error('not found');e.name='NotFoundError';throw e;}
    if(opts?.create && !files.has(name))files.set(name,[]);
    return {createWritable:async()=>({write:async x=>files.set(name,x),close:async()=>{},abort:async()=>{}})};
  },async removeEntry(name){files.delete(name)} };}
const parent={async getDirectoryHandle(name,opts){
    if(folders.has(name))return folders.get(name);
    if(!opts?.create){const e=Error('not found');e.name='NotFoundError';throw e;}
    const folder=makeFolder();folders.set(name,folder);return folder;
  }};
const scene={elements:[splat],events:{functions:new Map([['scene.write',true],['show.exportPopup',true]]),async invoke(name,...args){
    if(name==='scene.getExportDirectory')return parent;
    if(name==='show.exportPopup')return {filename:'user-ignored.ply',compressedPly:false,shBands:3,directory:parent,
      fileTarget:{handle:{createWritable(){throw Error('incorrect native target');}},discard(){throw Error('wrong discard');}}};
    if(name==='scene.write'){const [format,opts,stream]=args;
      assert.equal(opts.filename,'Office_EG_Living_Room_20261125T114311311Z.ply');
      assert(stream);await stream.write(Uint8Array.of(1,2,3));await stream.close();return true;}
    throw Error(`Unexpected ${name}`);
  }}};
splat.scene=scene;splat.instances=mask.instances;splat.resource={source:true};
const context={sectionId:'r1',userAdjustment:()=>null,semantic:{target_type:'room',room_id:'r1'},
 semanticOutputStem:'Office_EG_Living_Room_20261125T114311311Z'};
test('SEM-45 native semantic export creates named folder with model and matching report',async()=>{
  const result=await ctx.exportFilteredModel(scene,[mask],ranges,'ply',()=>true,context);
  assert.equal(result.modelExported,true);
  assert.equal(folders.size,1);
  assert(files.has(`${context.semanticOutputStem}.ply`));
  assert(files.has(`${context.semanticOutputStem}.export.json`));
  const report=JSON.parse(new TextDecoder().decode(files.get(`${context.semanticOutputStem}.export.json`)));
  assert.equal(report.model_file,`${context.semanticOutputStem}.ply`);
  assert.equal(report.semantic.room_id,'r1');
  assert(!files.has('user-ignored.ply'));
  await assert.rejects(()=>ctx.exportFilteredModel(scene,[mask],ranges,'ply',()=>true,context),/already exists/);
});
