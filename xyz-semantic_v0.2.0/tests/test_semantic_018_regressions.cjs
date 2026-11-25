'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm'), path = require('node:path');
const src = fs.readFileSync(path.join(__dirname, '../index.js'), 'utf8');
const ctx = vm.createContext({console,window:{},Array,Map,Set,Number,Date,Error,
    Uint8Array,Float64Array,TextEncoder,structuredClone,setTimeout,clearTimeout});
vm.runInContext(src.split('// === MANAGED PLUGIN ENTRY ===')[0] + `
    globalThis.api = {cleanupUnusedNativeExportTarget, semanticSnapshotFitDistance,
        withSemanticSnapshotFraming};`, ctx);
const {cleanupUnusedNativeExportTarget:cleanup, semanticSnapshotFitDistance:fit,
    withSemanticSnapshotFraming:framed} = ctx.api;
function nativeTarget(size = 0, age = 0, same = true) {
    const removed=[];
    const handle={name:'native-placeholder.sog',getFile:async()=>({size,lastModified:Date.now()-age}),
        isSameEntry:async other=>same && other===handle};
    const directory={getFileHandle:async()=>handle,removeEntry:async name=>{removed.push(name)}};
    return {handle,directory,removed};
}
test('SEM-54 cleanup removes only the verified newly-created empty native placeholder', async()=>{
    const {handle,directory,removed}=nativeTarget();
    const result=await cleanup({handle},directory,Date.now()-100);
    assert.equal(result.cleaned,true);
    assert.deepEqual(removed,['native-placeholder.sog']);
});
test('SEM-55 cleanup refuses nonempty, historical, unmatched and unverifiable native targets', async()=>{
    for(const [size,age,same] of [[4,0,true],[0,300000,true],[0,0,false]]) {
        const {handle,directory,removed}=nativeTarget(size,age,same);
        const result=await cleanup({handle},directory,Date.now()-100);
        assert.equal(result.cleaned,false);
        assert.deepEqual(removed,[]);
    }
    const dir={removeEntry(){throw Error('must not delete')}};
    const result=await cleanup({handle:{name:'unknown.sog'}},dir,Date.now());
    assert.equal(result.cleaned,false);
});
test('SEM-56 snapshot fit respects output aspect ratio and model XZ bounds',()=>{
    const camera={sceneRadius:10,fovFactor:0.5,fov:60};
    const bounds={x:{min:0,max:8},y:{min:0,max:3},z:{min:0,max:12}};
    const square=fit(camera,bounds,2048,2048);
    const landscape=fit(camera,bounds,1920,1080);
    assert(square>0 && landscape>0);
    // Tall floor plan must fit vertically in both formats; width should
    // not spuriously clip the room after the aspect ratio changes.
    assert(landscape>square);
    const wide={x:{min:0,max:30},y:{min:0,max:3},z:{min:0,max:2}};
    assert(Math.abs(fit(camera,wide,2048,2048)-fit(camera,wide,1920,1080))<1e-10,
        'horizontal-FOV camera keeps normalized distance stable when horizontal bounds dominate');
});
const Vec3 = class {
    constructor(x,y,z){this.x=x;this.y=y;this.z=z;}
    clone(){return new Vec3(this.x,this.y,this.z)}
    set(x,y,z){this.x=x;this.y=y;this.z=z;return this}
};
function cameraScene() {
    const focalPointTween={value:{x:1,y:1.5,z:2}};
    const distanceTween={value:{distance:3}};
    const camera={ortho:true,sceneRadius:10,fovFactor:0.5,fov:60,
        focalPointTween,distanceTween,onUpdate(){},captureFrame(){return {position:new Vec3(0,10,0),
            rotation:{x:-Math.SQRT1_2,y:0,z:0,w:Math.SQRT1_2}}},
        setFocalPoint(value){Object.assign(focalPointTween.value,{x:value.x,y:value.y,z:value.z})},
        setDistance(value){distanceTween.value.distance=value}};
    return {camera,forceRender:false};
}
test('SEM-57 fit capture temporarily centers semantic region and restores camera even on failure',async()=>{
    const scene=cameraScene();const b={x:{min:10,max:14},y:{min:0,max:3},z:{min:20,max:24}};
    await assert.rejects(()=>framed(scene,b,2048,2048,async()=>{
        assert.deepEqual({...scene.camera.focalPointTween.value},{x:12,y:1.5,z:22});
        assert.notEqual(scene.camera.distanceTween.value.distance,3);
        throw new Error('capture failed');
    }),/capture failed/);
    assert.deepEqual({...scene.camera.focalPointTween.value},{x:1,y:1.5,z:2});
    assert.equal(scene.camera.distanceTween.value.distance,3);
});
test('SEM-58 fit capture refuses oblique camera without changing scene',async()=>{
    const scene=cameraScene();scene.camera.captureFrame=()=>({position:new Vec3(0,10,0),
        rotation:{x:0,y:0,z:0,w:1}});
    await assert.rejects(()=>framed(scene,{x:{min:0,max:2},y:{min:0,max:1},z:{min:0,max:2}},1920,1080,async()=>{}),/top-down/);
    assert.equal(scene.camera.distanceTween.value.distance,3);
});
