// Contract test: snapshot and model-export sidecar record the identical U,
// while the exported model already contains edits after native load reversal.
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const assert = require('node:assert/strict');
const code=fs.readFileSync(path.join(__dirname,'../external/custom-editor.js'),'utf8');
const ctx=vm.createContext({console,Number,Array,Map,Set,Float64Array,Uint8Array,Error,Promise,setTimeout,clearTimeout});
vm.runInContext(code.split('async function initialize()')[0]+ '\n;globalThis.api={matMul4,relativeModelMatrix,toRows,sectionMetadata,filteredExportReport};',ctx);
const {matMul4,relativeModelMatrix,toRows,sectionMetadata,filteredExportReport}=ctx.api;
const I=[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1];
const F=[-1,0,0,0,0,-1,0,0,0,0,1,0,0,0,0,1];
const T=(x,y,z)=>[1,0,0,0,0,1,0,0,0,0,1,0,x,y,z,1];
const R=(r)=>{const c=Math.cos(r),s=Math.sin(r); return [c,s,0,0,-s,c,0,0,0,0,1,0,0,0,0,1]};
const mul=(a,b)=>Array.from(matMul4(a,b));
const apply=(m,p)=>[0,1,2].map(i=>m[i]*p[0]+m[4+i]*p[1]+m[8+i]*p[2]+m[12+i]);
const near=(a,b)=>{ assert.equal(a.length,b.length); for(let i=0;i<a.length;i++)assert(Math.abs(a[i]-b[i])<1e-5,`${i}: ${a[i]} != ${b[i]}`) };
const range={x:{min:-6,max:6},y:{min:-7,max:8},z:{min:-9,max:10}};
const centers={x:Float64Array.from([0,1,2]),y:Float64Array.from([0,0,0]),z:Float64Array.from([0,0,0])};
const mask={centers,splat:{name:'original.ply'},instances:{count:3}};
function pair(matrix){
  const rows=toRows(matrix);
  const snapshot=sectionMetadata({ranges:range,section_id:'Level A',model_to_snapshot:rows,mapping_status:'declared_uniform'},
    {axis:'Y',direction:'-Y',coordinate_frame:'editor_world'});
  const report=filteredExportReport([mask],range,{filename:'facility.sog',serializeSettings:{},sogIterations:10},'sog','Level A',matrix);
  const equal=(a,b)=>assert.equal(JSON.stringify(a),JSON.stringify(b));
  equal(snapshot.portviewer_floor.model_to_snapshot,report.model_to_snapshot);
  assert.equal(snapshot.portviewer_floor.vertical_confirmed,false);
  assert.equal(snapshot.portviewer_floor.geometry_validation,'not_verified');
  assert.equal(report.geometry_validation,'not_verified');
  equal(snapshot.portviewer_xyz_filter,report.portviewer_xyz_filter);
  assert.equal(report.model_adjustment_baked_into_export,true);
  assert.equal(report.matrix_application_to_exported_model,'do_not_apply_again');
  assert.equal(report.model_to_snapshot_semantics,'post_load_user_adjustment_only');
  assert.equal(report.matrix_input_frame,'post_load_editor_world');
  assert.equal(report.matrix_output_frame,'adjusted_editor_world');
  assert.equal((JSON.stringify(snapshot).match(/"model_to_snapshot"/g)||[]).length,1);
  assert.equal((JSON.stringify(report).match(/"model_to_snapshot"/g)||[]).length,1);
  return report;
}
// Initial SuperSplat import rotation is never exported as a user adjustment.
const unchanged=relativeModelMatrix(F,F);
near(unchanged,I);pair(unchanged);
// Translation + rotation after import: record only U in both JSON files.
const U=mul(T(2,-3,4),R(.42));
const adjusted=relativeModelMatrix(mul(U,F),F);
near(adjusted,U);pair(adjusted);
// Native exporter: file-space transform F^-1 U F, NOT U. Reimport F
// cancels the export reversal. The report must not instruct applying U twice.
for(const p of [[1,2,3],[0,0,0],[-2,0,5]]) {
  const filePoint=apply(mul(F,mul(U,F)),p); // F == inverse(F) here
  const reimported=apply(F,filePoint);
  const editorAdjusted=apply(mul(U,F),p);
  near(reimported,editorAdjusted);
}
console.log('PASS export/snapshot contract: one identical U, no-edit identity, Y/XYZ fields, explicit baked warning, reimport convention');
