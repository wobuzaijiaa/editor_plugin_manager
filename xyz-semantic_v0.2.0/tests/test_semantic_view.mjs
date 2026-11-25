import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IDENTITY } from '../semantic-core.js';
import { screenToPlane, projectXZ } from '../semantic-view.js';
const top = [1,0,0,0,0,0,1,0,0,1,0,0,0,0,0,1];
const frame = {view:{data:Float32Array.from(top)},projection:{data:Float32Array.from(IDENTITY)},ortho:true};
test('SEM-05 screen-plane ray mapping on orthographic top camera is stable',()=>{
    assert.deepEqual(screenToPlane(100,50,200,100,frame,IDENTITY,0),[0,0]);
    assert.deepEqual(screenToPlane(150,25,200,100,frame,IDENTITY,0),[0.5,0.5]);
    assert.deepEqual(projectXZ([0.5,0.5],0,IDENTITY,frame,200,100),[150,25]);
});
test('SEM-05 viewport resizing preserves local coordinates',()=>{
    const a=screenToPlane(150,25,200,100,frame,IDENTITY,0);
    const b=screenToPlane(300,50,400,200,frame,IDENTITY,0);
    assert.deepEqual(a,b);
});
test('SEM-05 tilt and non-orthographic editing fail closed',()=>{
    assert.throws(()=>screenToPlane(100,50,200,100,{...frame,ortho:false},IDENTITY,0),/orthographic/);
    const tilt=[1,0,0,0,0,0,1,0,0,-1,0,0,0,0,0,1];
    assert.throws(()=>screenToPlane(100,50,200,100,frame,tilt,0),/tilted/);
});
