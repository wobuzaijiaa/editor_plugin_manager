import {test} from 'node:test';
import assert from 'node:assert/strict';
import {semanticFileName,semanticOutputStem,createSemanticWriter,readSemanticJson} from '../semantic-io.js';
import {newDocument,addFloor,addRoom,IDENTITY,validateDocument} from '../semantic-core.js';
import {snapshotPolygonLayout,annotateSemanticSnapshotPng} from '../semantic-view.js';

test('SEM-40 output names use the semantic hierarchy and UTC timestamp, not IDs',()=>{
  const time=new Date('2026-11-25T11:43:11.311Z');
  assert.equal(semanticFileName('Office Building'), 'semantic_Office_Building.json');
  assert.equal(semanticOutputStem('Office','EG','Living Room',time),
      'Office_EG_Living_Room_20261125T114311311Z');
  assert.equal(semanticOutputStem('Office',null,null,time), 'Office_20261125T114311311Z');
  assert(!semanticFileName('../../bad\\name:').includes('/'));
});
test('SEM-41 schema v1 retains legacy import and adds persistent document/floor/room timestamps',()=>{
  const doc=newDocument('model-id','Office',IDENTITY,'document-immutable');
  assert.equal(doc.document_id,'document-immutable');
  assert(doc.created_at);assert(doc.updated_at);
  const floor=addFloor(doc,{floor_id:'f1',name:'EG',y_min:0,y_max:3,view_y_max:2.7});
  assert(floor.floors[0].created_at);
  const room=addRoom(floor,'f1',{room_id:'r1',name:'Kitchen',polygon_xz:[[0,0],[2,0],[2,2],[0,2]]});
  assert(room.floors[0].rooms[0].updated_at);
  const old=structuredClone(doc);delete old.document_id;delete old.created_at;delete old.updated_at;
  assert.deepEqual(validateDocument(old),old,'unmigrated v0.1.6 file remains readable');
  assert.throws(()=>validateDocument({...doc,created_at:'yesterday'}),/created_at/);
});
test('SEM-42 auto saves are serial, retain snapshots and recover after a rejected write',async()=>{
  const doc=newDocument('m','Office',IDENTITY,'id');
  const output=[];let fail=false;
  const handle={name:'semantic_Office.json',createWritable:async()=>({
    async write(json){if(fail)throw Error('disk error');await Promise.resolve();output.push(JSON.parse(json));},
    async close(){},async abort(){}
  })};
  const write=createSemanticWriter();
  const [a,b]=await Promise.all([write(handle,doc),write(handle,{...doc,updated_at:'2026-11-25T14:00:00.000Z'})]);
  assert.equal(a,'semantic_Office.json');assert.equal(b,'semantic_Office.json');
  assert.equal(output.length,2);
  assert.equal(output[1].updated_at,'2026-11-25T14:00:00.000Z');
  fail=true;await assert.rejects(write(handle,doc),/disk error/);
  fail=false;await write(handle,doc);assert.equal(output.length,3);
  assert.deepEqual(await readSemanticJson({size:JSON.stringify(doc).length,text:async()=>JSON.stringify(doc)}),doc);
});
test('SEM-43 polygon projection for captured snapshot uses offscreen matrices and room name',()=>{
  const unit=[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1];
  const view=[...unit];view[13]=-1;
  const meta={view_matrix:view,projection_matrix:unit,image_width:1000,image_height:600};
  const overlay={semantic_to_world:unit,floor:{y_min:0,y_max:2},rooms:[
    {room_id:'r1',name:'Living Room',polygon_xz:[[-.5,-.5],[.5,-.5],[.5,.5],[-.5,.5]]}
  ]};
  const layout=snapshotPolygonLayout(meta,overlay);
  assert.equal(layout.length,1);assert.equal(layout[0].name,'Living Room');
  assert.equal(layout[0].points.length,4);assert.deepEqual(layout[0].center,[500,300]);
  assert.deepEqual(snapshotPolygonLayout(meta,{...overlay,rooms:[]}),[]);
});
test('SEM-44 semantic PNG annotator draws both outlines and labels into encoded output',async()=>{
  const priorDocument=globalThis.document,priorBitmap=globalThis.createImageBitmap;
  const calls=[];
  const canvas={width:0,height:0,getContext:()=>({
    drawImage:()=>calls.push('image'),beginPath:()=>calls.push('begin'),moveTo:()=>calls.push('move'),
    lineTo:()=>calls.push('line'),closePath:()=>{},stroke:()=>calls.push('stroke'),
    fillRect:()=>calls.push('box'),measureText:()=>({width:100}),fillText:t=>calls.push(`text:${t}`)
  }),toBlob:cb=>cb(new Blob([Uint8Array.from([137,80,78,71,1])]))};
  const unit=[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1];
  const meta={view_matrix:unit,projection_matrix:unit,image_width:100,image_height:100};
  const overlay={semantic_to_world:unit,floor:{y_min:0,y_max:2},rooms:[
    {room_id:'r1',name:'Living Room',polygon_xz:[[-.2,-.2],[.2,-.2],[.2,.2],[-.2,.2]]}
  ]};
  globalThis.document={createElement:()=>canvas};globalThis.createImageBitmap=async()=>({close(){}});
  try {
    const png=await annotateSemanticSnapshotPng(Uint8Array.of(1,2,3),meta,overlay);
    assert(png instanceof Uint8Array);assert.equal(png[0],137);
    assert(calls.includes('stroke'));assert(calls.includes('text:Living Room'));
  } finally {globalThis.document=priorDocument;globalThis.createImageBitmap=priorBitmap;}
});
