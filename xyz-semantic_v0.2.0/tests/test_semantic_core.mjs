import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    IDENTITY, inverse4, multiply4, transformPoint, validatePolygon, validateDocument,
    newDocument, addFloor, editFloor, removeFloor, addRoom, editRoom, removeRoom,
    semanticWorldMatrix, worldBoundsForTarget, semanticProvenance, horizontalAlignment
} from '../semantic-core.js';

const floor = {floor_id:'floor-a',name:'Ground Floor',y_min:0,y_max:4,view_y_max:3};
const rect = [[0,0],[4,0],[4,3],[0,3]];
const make = () => addRoom(addFloor(newDocument('model-001','Building A',[...IDENTITY]),floor),'floor-a',
    {room_id:'room-101',name:'Room 101',polygon_xz:rect});
const domain = {x:{min:-5,max:10},y:{min:-2,max:6},z:{min:-3,max:9}};
const hit = (m,p) => transformPoint(m,p).map(n=>Math.round(n*1e9)/1e9);

test('SEM-01 document schema, roundtrip and explicit permanent model binding',()=>{
    const doc=make();
    const copy=validateDocument(JSON.parse(JSON.stringify(doc)));
    assert.deepEqual(copy,doc);
    assert.equal(copy.model.model_id,'model-001');
    assert.equal(copy.floors[0].rooms[0].room_id,'room-101');
    assert.throws(()=>validateDocument({...doc,schema_version:2}),/schema_version/);
    assert.throws(()=>newDocument('','Building',IDENTITY),/model_id/);
    assert.throws(()=>newDocument('x','Building',[0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,1]),/singular/);
});

test('SEM-02 floor height invariants and edit retains room geometry',()=>{
    const doc=make();
    const next=editFloor(doc,'floor-a',{name:'F0',y_max:5,view_y_max:4.5});
    assert.equal(doc.floors[0].y_max,4);
    assert.equal(next.floors[0].name,'F0');
    assert.deepEqual(next.floors[0].rooms[0].polygon_xz,rect);
    assert.throws(()=>editFloor(doc,'floor-a',{view_y_max:4.1}),/view_y_max/);
    assert.throws(()=>editFloor(doc,'floor-a',{y_min:4}),/view_y_max/);
    assert.equal(removeFloor(doc,'floor-a').floors.length,0);
});

test('SEM-03 convex triangles and irregular polygons accepted; concave and stars rejected',()=>{
    assert.deepEqual(validatePolygon([[0,0],[5,0],[2,3]]),[[0,0],[5,0],[2,3]]);
    assert.equal(validatePolygon([[0,0],[5,0],[6,2],[3,4],[0,2]]).length,5);
    assert.throws(()=>validatePolygon([[0,0],[4,0],[1,1],[4,4],[0,4]]),/convex/);
    assert.throws(()=>validatePolygon([[0,0],[4,4],[0,4],[4,0]]),/convex|intersect/);
    assert.throws(()=>validatePolygon([[0,0],[4,0],[4,4],[0,4],[0,0]]),/zero-length|collinear/);
    assert.throws(()=>validatePolygon([[0,0],[1,0],[2,0],[0,1]]),/collinear/);
    const star = [[0,3],[1.77,-2.43],[-2.85,.93],[2.85,.93],[-1.77,-2.43]];
    assert.throws(()=>validatePolygon(star),/convex|intersect/);
});

test('SEM-04 neighboring polygon gaps and overlaps allowed',()=>{
    let doc=make();
    doc=addRoom(doc,'floor-a',{room_id:'room-102',name:'Office',polygon_xz:[[3.8,0],[7,0],[7,2],[3.8,2]]});
    doc=addRoom(doc,'floor-a',{room_id:'room-103',name:'Storage',polygon_xz:[[8,0],[9,0],[9,1],[8,1]]});
    assert.equal(doc.floors[0].rooms.length,3);
});

test('SEM-06 stable room ID across edit, rename and removal',()=>{
    const doc=make();
    const edited=editRoom(doc,'floor-a','room-101',{name:'Office 101',polygon_xz:[[0,0],[5,0],[5,3],[0,3]]});
    assert.equal(edited.floors[0].rooms[0].room_id,'room-101');
    assert.equal(doc.floors[0].rooms[0].name,'Room 101');
    assert.throws(()=>editRoom(edited,'floor-a','room-101',{polygon_xz:[[0,0],[5,0],[2,1],[5,3],[0,3]]}),/convex/);
    assert.equal(removeRoom(edited,'floor-a','room-101').floors[0].rooms.length,0);
});

test('SEM-01 duplicated floor and room IDs rejected',()=>{
    const doc=make();
    assert.throws(()=>addFloor(doc,{...floor,name:'Again'}),/Duplicate floor/);
    assert.throws(()=>addRoom(doc,'floor-a',{room_id:'room-101',name:'Again',polygon_xz:rect}),/Duplicate room/);
});

test('SEM-08 room bounds approximate polygon XZ with full and ceiling-free Y',()=>{
    const doc=make();
    const room={type:'room',floorId:'floor-a',roomId:'room-101'};
    assert.deepEqual(worldBoundsForTarget(doc,IDENTITY,domain,room,'view'),
        {x:{min:0,max:4},y:{min:0,max:3},z:{min:0,max:3}});
    assert.deepEqual(worldBoundsForTarget(doc,IDENTITY,domain,room,'export'),
        {x:{min:0,max:4},y:{min:0,max:4},z:{min:0,max:3}});
    assert.deepEqual(worldBoundsForTarget(doc,IDENTITY,domain,{type:'floor',floorId:'floor-a'},'view'),
        {x:{min:-5,max:10},y:{min:0,max:3},z:{min:-3,max:9}});
});

test('SEM-15 affine mapping preserves semantic anchoring after model translation/rotation/scale',()=>{
    const bind = [0,-1,0,0,1,0,0,0,0,0,1,0,5,3,-2,1]; // world Z rotation -90, translation
    const inverse=inverse4(bind); assert(inverse);
    const doc=newDocument('model-a','Building',inverse);
    assert.deepEqual(hit(semanticWorldMatrix(doc,bind),[3,2,1]),[3,2,1]);
    const translation=[...bind];translation[12]+=2;translation[13]+=8;
    assert.deepEqual(hit(semanticWorldMatrix(doc,translation),[3,2,1]),[5,10,1]);
    const scaled=[...bind];for (const i of [0,1,4,5,10])scaled[i]*=2;
    assert(horizontalAlignment(semanticWorldMatrix(doc,scaled)));
    assert.deepEqual(hit(multiply4(bind,inverse),[4,6,8]),[4,6,8]);
});

test('SEM-08 world AABB stays conservative under model rotation',()=>{
    const doc=make(), rotate=[0,0,-1,0,0,1,0,0,1,0,0,0,0,0,0,1];
    const b=worldBoundsForTarget(doc,rotate,domain,{type:'room',floorId:'floor-a',roomId:'room-101'},'export');
    assert.deepEqual(b,{x:{min:0,max:3},y:{min:0,max:4},z:{min:-4,max:0}});
});

test('SEM-13 additive provenance identifies bounding selection vs polygon clipping',()=>{
    const doc=make(), target={type:'room',floorId:'floor-a',roomId:'room-101'};
    const bounds=worldBoundsForTarget(doc,IDENTITY,domain,target,'export');
    const meta=semanticProvenance(doc,target,'export',bounds);
    assert.equal(meta.model_id,'model-001');
    assert.equal(meta.room_id,'room-101');
    assert.match(meta.selection_method,/aabb/);
    assert.equal(meta.range_purpose,'full_height_export');
    assert.deepEqual(meta.world_xyz_bounds,bounds);
});

test('SEM-30 convex hull recovery excludes interior/duplicate unordered clicks and validates the result',async()=>{
    const { convexHull } = await import('../semantic-core.js');
    const drawn=[[0,0],[4,4],[4,0],[0,4],[2,2],[0,0],[1,1]];
    const hull=convexHull(drawn);
    assert.equal(hull.length,4);
    assert.deepEqual(hull,validatePolygon(hull));
    assert.throws(()=>convexHull([[0,0],[1,0],[2,0]]),/convex|area|collinear|vertices/);
});
