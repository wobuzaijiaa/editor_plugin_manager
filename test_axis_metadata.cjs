const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const assert = require('node:assert/strict');
const src=fs.readFileSync(path.join(__dirname,'../external/custom-editor.js'),'utf8');
const ctx=vm.createContext({console,Float32Array,Float64Array,Uint8Array,Uint32Array,Number,Array,Map,Set,Error,Promise,setTimeout,clearTimeout,performance});
vm.runInContext(src.split('async function initialize()')[0]+'\n;globalThis.api={snapshotView,sectionMetadata,relativeModelMatrix,toRows};',ctx);
const {snapshotView,sectionMetadata,relativeModelMatrix,toRows}=ctx.api;
const t=Math.SQRT1_2;
const directions=[
    [{x:0,y:t,z:0,w:t},'X','-X'],
    [{x:0,y:-t,z:0,w:t},'X','+X'],
    [{x:-t,y:0,z:0,w:t},'Y','-Y'],
    [{x:t,y:0,z:0,w:t},'Y','+Y'],
    [{x:0,y:0,z:0,w:1},'Z','-Z'],
    [{x:0,y:1,z:0,w:0},'Z','+Z']
];
const ranges={x:{min:-2,max:4},y:{min:-7,max:0},z:{min:3,max:9}};
const I=[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1];
const preview={ranges,section_id:'Section A',model_to_snapshot:toRows(relativeModelMatrix(I,I)),mapping_status:'declared_uniform'};
for(const [quaternion,axis,direction] of directions){
    const view=snapshotView(quaternion);
    assert.equal(view.axis,axis);
    assert.equal(view.direction,direction);
    const out=sectionMetadata(preview,view);
    const floor=out.portviewer_floor;
    assert.equal(floor.axis,axis);
    assert.equal(floor.coordinate_frame,'editor_world');
    const k=axis.toLowerCase();
    assert.equal(floor[`${k}_min`],ranges[k].min);
    assert.equal(floor[`${k}_max`],ranges[k].max);
    assert.equal(floor.floor_id,'Section A');
    assert.equal(floor.vertical_confirmed,false,'no vertical confirmation was performed');
    assert.equal(floor.geometry_validation,'not_verified');
    assert.equal(out.portviewer_section.section_id,'Section A');
    assert.equal(out.portviewer_section.range_min,ranges[k].min);
    for(const other of ['x','y','z'].filter(v=>v!==k)) assert.equal(`${other}_min` in floor,false);
    assert.equal((JSON.stringify(out).match(/"model_to_snapshot"/g)||[]).length,1);
    assert.equal(floor.model_to_snapshot.length,4);
    assert.equal(floor.mapping_status,'declared_uniform');
    assert.equal(out.portviewer_xyz_filter.y_min,ranges.y.min);
}
const originalKeys=['version','axis','coordinate_frame','y_min','y_max','floor_id','vertical_confirmed','model_id','association_basis','geometry_validation','model_to_snapshot','mapping_status'];
const y=sectionMetadata(preview,{axis:'Y',direction:'-Y',coordinate_frame:'editor_world'}).portviewer_floor;
assert.deepEqual(Object.keys(y),originalKeys);
console.log('PASS adaptive axis: six cardinal views, correct bounds/identifier/frame, exact original Y schema, single post-load matrix');
