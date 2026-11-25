import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IDENTITY, newDocument, addFloor, addRoom, editRoom, locateSemanticCamera, insideConvexPolygonXZ } from '../semantic-core.js';

const box = { x:{min:-2,max:20}, y:{min:-1,max:7}, z:{min:-2,max:15} };
const sample = () => {
    let doc=newDocument('m1','Office Building', IDENTITY, 'sem1');
    doc=addFloor(doc,{floor_id:'EG',name:'EG',y_min:0,y_max:3,view_y_max:2.6});
    doc=addFloor(doc,{floor_id:'OG',name:'OG',y_min:3,y_max:6,view_y_max:5.6});
    doc=addRoom(doc,'EG',{room_id:'roomA',name:'Living Room',polygon_xz:[[0,0],[6,0],[6,6],[0,6]]});
    doc=addRoom(doc,'EG',{room_id:'roomB',name:'Small Room',polygon_xz:[[3,3],[5,3],[5,5],[3,5]]});
    return doc;
};
const find=(doc,position,matrix=IDENTITY,bounds=box)=>locateSemanticCamera(doc,matrix,bounds,position);

test('SEM-70 camera-position lookup returns room, floor, building and exterior without view focus',()=>{
    const doc=sample();
    const room=find(doc,[1,1.5,2]);
    assert.deepEqual([room.level,room.floorName,room.roomName],['room','EG','Living Room']);
    assert.equal(room.label,'Office Building / EG / Living Room');
    assert.equal(room.source,'camera_position');
    assert.equal(find(doc,[12,1,9]).label,'Office Building / EG');
    assert.equal(find(doc,[12,6.5,9]).label,'Office Building');
    assert.equal(find(doc,[12,18,9]).label,'Office Building / Exterior');
    assert.equal(find(doc,[21,1,9]).level,'exterior');
    // The camera is physically high above the house in top-down orthographic
    // view; do not misrepresent its view target as an interior location.
    assert.equal(find(doc,[3,30,3]).level,'exterior');
});

test('SEM-71 overlapping convex rooms choose the smaller polygon, boundary included',()=>{
    const doc=sample();
    assert.equal(find(doc,[4,1,4]).roomName,'Small Room');
    assert.equal(find(doc,[0,1,0]).roomName,'Living Room');
    assert(insideConvexPolygonXZ([0,3],[[0,0],[6,0],[6,6],[0,6]]));
    assert(!insideConvexPolygonXZ([8,3],[[0,0],[6,0],[6,6],[0,6]]));
    assert.equal(find(doc,[5,1,5]).roomName,'Small Room');
    assert.equal(find(doc,[2,3.5,2]).label,'Office Building / OG');
});

test('SEM-72 model-anchored lookup handles transform changes without modifying the document',()=>{
    const doc=sample();
    const translated=[...IDENTITY];translated[12]=100;translated[13]=5;translated[14]=-10;
    const room=find(doc,[101,6.5,-8],translated);
    assert.equal(room.roomName,'Living Room');
    assert.deepEqual(room.cameraLocal.map(v=>Math.round(v*100)/100),[1,1.5,2]);
    assert.equal(find(doc,[1,1.5,2],translated).level,'exterior');
    assert.equal(doc.model.semantic_to_model[12],0,'tracking is read-only');
});

test('SEM-73 lookup reflects room edits immediately and rejects malformed camera data',()=>{
    const initial=sample();
    const before=find(initial,[2,1,2]);
    assert.equal(before.roomName,'Living Room');
    const edited=editRoom(initial,'EG','roomA',{polygon_xz:[[7,7],[9,7],[9,9],[7,9]]});
    assert.equal(find(edited,[2,1,2]).level,'floor');
    assert.equal(find(initial,[2,1,2]).roomName,'Living Room');
    assert.throws(()=>find(initial,[NaN,1,2]),/Camera position/);
    assert.throws(()=>find(initial,[1,2]),/Camera position/);
});

test('SEM-74 deterministic tie-break for equal-size overlapping rooms',()=>{
    let doc=sample();
    doc=addRoom(doc,'EG',{room_id:'AAA',name:'Stable Winner',polygon_xz:[[3,3],[5,3],[5,5],[3,5]]});
    assert.equal(find(doc,[4,1,4]).roomName,'Stable Winner');
});
