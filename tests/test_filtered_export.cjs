const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const assert = require('node:assert/strict');
const source = fs.readFileSync(path.join(__dirname, '../external/custom-editor.js'), 'utf8');
const window = {};
const ctx = vm.createContext({
  console, window, Array, Map, Set, Number, Error, Float64Array, Uint8Array,
  Uint32Array, TextEncoder, setTimeout, clearTimeout
});
vm.runInContext(source.split('async function initialize()')[0] +
  '\n;globalThis.api={filteredSubsetRanges,createFilteredExportLayers,filteredExportOptions,filteredExportReport,modelReportName,saveFilteredExportReport,exportFilteredModel};', ctx);
const { filteredSubsetRanges, createFilteredExportLayers, filteredExportOptions, filteredExportReport,
  modelReportName, saveFilteredExportReport, exportFilteredModel } = ctx.api;
const centers = {
  x: Float64Array.from([0,1,2,3,4]), y: Float64Array.from([0,0,0,0,0]),
  z: Float64Array.from([0,0,0,0,0])
};
const range = {x:{min:1,max:3}, y:{min:0,max:0}, z:{min:0,max:0}};
const sub = filteredSubsetRanges(centers,range);
assert.equal(sub.count,3);
const runs=[]; sub.forEachRun((o,n)=>runs.push([o,n]));
assert.deepEqual(runs,[[1,3]]);
assert.equal(filteredSubsetRanges(centers,{...range,x:{min:5,max:6}}).count,0);
assert.equal(modelReportName('facility.compressed.ply'), 'facility.export.json');
assert.equal(modelReportName('facility.sog', '-2'), 'facility.export-2.json');
let destroyed=0, created=0;
const mat={equals(){return true;}};
const splat={name:'source.ply',visible:true,scene:null,worldTransform:mat,createLayer(r,n){
  created++;
  const output=[];r.forEachRun((first,count)=>{for(let i=first;i<first+count;i++)output.push(i);});
  return {name:n, worldTransform:mat,output,destroy(){destroyed++;}};
}};
const mask={centers,splat,instances:{count:5},verify(){}};
const scene={elements:[splat],events:{functions:new Map([['scene.write',true],['show.exportPopup',true]])}};
splat.scene=scene;splat.instances=mask.instances;splat.resource={source:true};
const userMatrix=[1,0,0,0,0,1,0,0,0,0,1,0,2,-3,4,1];
const reportContext = {sectionId:'L01',userAdjustment:()=>userMatrix};
const saved=[];
ctx.download=(data,filename,type)=>saved.push({data,filename,type});
function reportOfLastDownload(){return JSON.parse(new TextDecoder().decode(saved.at(-1).data));}
async function exercise() {
  const opts=filteredExportOptions('ply',{filename:'xyz.ply',compressedPly:true,shBands:2});
  assert.equal(opts.fileType,'compressedPly');
  assert.equal(opts.options.serializeSettings.shBands,2);
  let calls=0;
  scene.events.invoke=async (...args)=>{
    calls++;
    if(args[0]==='show.exportPopup')return {filename:'filtered.ply',compressedPly:true,shBands:3};
    if(args[0]==='scene.write'){
      assert.equal(args[1],'compressedPly');
      assert.equal(args[2].filename,'filtered.ply');
      assert.equal(args[4].splats.length,1);
      assert.deepEqual(args[4].splats[0].output,[1,2,3]);
      assert.equal(args[4].throwOnError,true);
      assert.equal(args[3],undefined);
      assert.equal(saved.length,0,'report must be emitted only after model write success');
      return true;
    }
    throw Error('Unexpected event: '+args[0]);
  };
  const success=await exportFilteredModel(scene,[mask],range,'ply',()=>true,reportContext);
  assert.equal(success.modelExported,true);
  assert.equal(success.report.delivery,'browser_download_requested');
  assert.equal(success.report.filename,'filtered.export.json');
  assert.equal(saved.length,1);
  const report=reportOfLastDownload();
  assert.equal(report.version,1);
  assert.equal(report.model_file,'filtered.ply');
  assert.equal(report.model_format,'compressedPly');
  assert.equal(report.source_gaussian_instances,5);
  assert.equal(report.selected_gaussian_instances,3);
  assert.equal(report.source_layers[0].selected_instances,3);
  assert.equal(report.portviewer_xyz_filter.x_min,1);
  assert.equal(report.portviewer_xyz_filter.x_max,3);
  assert.equal(report.section_id,'L01');
  assert.equal(report.export_options.sh_bands,3);
  assert.equal(report.model_to_snapshot[0][3],2);
  assert.equal(report.model_to_snapshot[1][3],-3);
  assert.equal(report.model_to_snapshot[2][3],4);
  assert.equal(report.mapping_status,'declared_uniform');
  assert.equal(report.geometry_validation,'not_verified');
  assert.equal(report.model_adjustment_baked_into_export,true);
  assert.equal(report.model_to_snapshot_semantics,'post_load_user_adjustment_only');
  assert.equal(report.matrix_input_frame,'post_load_editor_world');
  assert.equal(report.matrix_output_frame,'adjusted_editor_world');
  assert.equal(report.matrix_application_to_exported_model,'do_not_apply_again');
  assert.equal(report.export_coordinate_space,'normalized_ply_space');
  assert.equal(report.exported_geometry_transforms,'baked_by_native_exporter_with_initial_load_rotation_reversed');
  assert.equal((JSON.stringify(report).match(/"model_to_snapshot"/g)||[]).length,1);
  assert.equal(created,1);assert.equal(destroyed,1);

  scene.events.invoke=async (...args)=>{ if(args[0]==='show.exportPopup')return null; throw Error('unexpected write'); };
  assert.equal(await exportFilteredModel(scene,[mask],range,'ply',()=>true,reportContext),null);
  assert.equal(saved.length,1,'cancel must not emit report');
  assert.equal(created,1,'cancel must not create layers');

  scene.events.invoke=async (...args)=>{
    if(args[0]==='show.exportPopup')return {filename:'failure.spz'};
    if(args[0]==='scene.write')throw Error('simulated write failure');
  };
  await assert.rejects(()=>exportFilteredModel(scene,[mask],range,'spz',()=>true,reportContext),/simulated write failure/);
  assert.equal(created,2);assert.equal(destroyed,2,'failure must clean up subset layer');
  assert.equal(saved.length,1,'failed model export must not emit report');

  scene.events.invoke=async (...args)=>{
    if(args[0]==='show.exportPopup')return {filename:'failure.spz'};
    if(args[0]==='scene.write')return true;
  };
  await assert.rejects(()=>exportFilteredModel(scene,[mask],range,'spz',()=>false,reportContext),/XYZ filter was disabled/);
  assert.equal(created,2);
  await assert.rejects(()=>exportFilteredModel(scene,[mask],{...range,x:{min:9,max:10}},'spz',()=>true,reportContext),/No Gaussian centers/);
  assert.equal(created,2);

  // Zero/unknown mapping must be explicit, never a fabricated Identity.
  const unknown=filteredExportReport([mask],range,{filename:'f.sog',serializeSettings:{},sogIterations:10},'sog','',null);
  assert.equal(unknown.model_to_snapshot,null);
  assert.equal(unknown.mapping_status,'unknown_per_gaussian_or_multiple_models');
  assert.equal(unknown.geometry_validation,'not_verified');
  assert.equal(unknown.export_options.sog_iterations,10);
  assert.equal(Object.hasOwn(unknown.export_options,'sh_bands'),false);

  // In file-picker mode the report is created in the selected export folder;
  // a previous report is never overwritten without confirmation.
  const occupied=new Set(['facility.export.json']);
  let folderName=null, folderBytes=null;
  const directory={async getFileHandle(name,options){
    if(!options){
      if(occupied.has(name))return {name};
      const err=Error('not found');err.name='NotFoundError';throw err;
    }
    assert.equal(options.create,true);
    folderName=name;
    return {async createWritable(){return {
      async write(data){ folderBytes=data; },async close(){occupied.add(name);},async abort(){}
    };}};
  }};
  const folder=await saveFilteredExportReport(unknown,directory);
  assert.equal(folder.delivery,'saved_in_export_folder');
  assert.equal(folderName,'f.export.json');
  assert.equal(folder.filename,'f.export.json');
  assert.equal(JSON.parse(new TextDecoder().decode(folderBytes)).mapping_status,'unknown_per_gaussian_or_multiple_models');
  const conflictReport={...unknown,model_file:'facility.sog'};
  assert.equal((await saveFilteredExportReport(conflictReport,directory)).filename,'facility.export-2.json');

  // Folder write failure is reported accurately AFTER the model succeeds.
  const failingFolder={async getFileHandle(name,options){
    if(!options){const e=Error('not found');e.name='NotFoundError';throw e;}
    const e=Error('storage denied');e.name='NotAllowedError';throw e;
  }};
  window.showDirectoryPicker=()=>{};
  const goodChoice={filename:'facility.sog',directory:failingFolder,sogIterations:10,shBands:2};
  scene.events.invoke=async (...args)=>{
    if(args[0]==='scene.getExportDirectory')return failingFolder;
    if(args[0]==='show.exportPopup')return goodChoice;
    if(args[0]==='scene.write')return true;
    throw Error('bad invoke');
  };
  const partial=await exportFilteredModel(scene,[mask],range,'sog',()=>true,reportContext);
  assert.equal(partial.modelExported,true);
  assert.match(partial.reportError,/storage denied/);
  assert.equal(destroyed,3);
  console.log('PASS filtered export: subset selection, report format/metadata, postload matrix, cancel/error safeguards, same-folder writing, nonoverwrite, partial success');
}
exercise().catch(e=>{console.error(e);process.exitCode=1;});
