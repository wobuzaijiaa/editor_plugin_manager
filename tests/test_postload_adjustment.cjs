// A captured initial import transform is a baseline, NOT a user adjustment.
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const assert = require('node:assert/strict');
const source = fs.readFileSync(path.join(__dirname, '../external/custom-editor.js'), 'utf8');
const ctx = vm.createContext({ console, Float32Array, Float64Array, Uint8Array,
    Number, Array, Map, Set, Error, Promise, setTimeout, clearTimeout });
vm.runInContext(source.split('async function initialize()')[0] +
    '\n;globalThis.api={relativeModelMatrix,trackInitialModelTransforms,matMul4,toRows,sectionMetadata};', ctx);
const { relativeModelMatrix, trackInitialModelTransforms, matMul4, toRows, sectionMetadata } = ctx.api;
const I = [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1];
const T = (x,y,z) => [1,0,0,0, 0,1,0,0, 0,0,1,0, x,y,z,1];
const Rz = angle => {const c=Math.cos(angle),s=Math.sin(angle); return [c,s,0,0,-s,c,0,0,0,0,1,0,0,0,0,1];};
const Rx = angle => {const c=Math.cos(angle),s=Math.sin(angle); return [1,0,0,0,0,c,s,0,0,-s,c,0,0,0,0,1];};
const S = (x,y,z) => [x,0,0,0,0,y,0,0,0,0,z,0,0,0,0,1];
const mul = (a,b) => Array.from(matMul4(a,b));
const apply = (m,p) => [0,1,2].map(j => m[j]*p[0]+m[4+j]*p[1]+m[8+j]*p[2]+m[12+j]);
const near = (a,b,eps=1e-5) => {
    assert(a && b, 'expected available matrix');
    assert.equal(a.length,b.length);
    for(let i=0;i<a.length;i++) assert(Math.abs(a[i]-b[i])<=eps,
       `Mismatch ${i}: ${a[i]} != ${b[i]}`);
};
const matrix = data => ({data:Float32Array.from(data), clone(){return matrix(this.data);},
    mul2(a,b){this.data.set(mul(a.data,b.data));return this;},
    equals(b){return this.data.every((x,i)=>Math.abs(x-b.data[i])<1e-6);}});
const paletteCells=[0,4,8,12,1,5,9,13,2,6,10,14];
function splat(scene, world, palette=I, ids=[0,0]) {
    return {scene,visible:true,instances:{count:ids.length,transformIndex(i){return ids[i];}},
      resource:{source:{}},worldTransform:matrix(world),
      transformPalette:{getTransform(_id,dst){for(const j of paletteCells)dst.data[j]=palette[j];}}};
}
function sceneMock() {
    const callbacks = new Map();
    const scene={elements:[],events:{on(name,cb){callbacks.set(name,cb);return {off(){callbacks.delete(name);}};}}};
    return {scene,added(s){s.scene=scene;scene.elements.push(s);callbacks.get('scene.elementAdded')(s);},
      removed(s){scene.elements.splice(scene.elements.indexOf(s),1);},listeners:callbacks};
}
const initial=Rz(Math.PI);
const a = sceneMock();
const tracking = trackInitialModelTransforms(a.scene); // listener before load
const model = splat(a.scene, initial);
a.added(model); // Scene.add has completed
near(tracking.userAdjustment([model]),I,0); // no user adjustment: EXACT identity
near(relativeModelMatrix(initial,initial),I,0);
// Camera view/pan/zoom and filtering do not modify entity mapping.
for(const direction of ['X','Y','Z']) near(tracking.userAdjustment([model]),I,0);
// User alignment: composed translation + rotation about a nonzero pivot + scale.
const pivot=[2,-3,1.5];
const U=mul(T(4,-7,2),mul(T(...pivot),mul(Rx(0.51),mul(Rz(-0.35),mul(S(1.3,.8,2.1),T(...pivot.map(v=>-v)))))));
const current=mul(U,initial);
model.worldTransform=matrix(current);
const adjusted=tracking.userAdjustment([model]);
near(adjusted,U,4e-5);
// Verify source points after loader orientation: U transforms POST-load points.
for(const p of [[1,2,3],[-2,5,-4],[0,0,0],[.6,-2.4,1.1]]) {
    near(apply(adjusted,apply(initial,p)),apply(current,p),5e-5);
}
// Matrix serialized as rows, including nonzero off-diagonal and translation.
const rows=toRows(adjusted);
near([0,1,2,3].flatMap(col=>[0,1,2,3].map(row=>rows[row][col])), U,4e-5);
// An accidental duplicate add event must not reset the baseline after edits.
a.listeners.get('scene.elementAdded')(model);
near(tracking.userAdjustment([model]),U,4e-5);
// Per-Gaussian nonuniform mappings cannot be represented as one U.
model.instances={count:2,transformIndex(i){return i;}};
model.transformPalette.getTransform=(id,dst)=>{for(const j of paletteCells)dst.data[j]=(id===0?I:T(1,0,0))[j];};
assert.equal(tracking.userAdjustment([model]),null);
assert.equal(tracking.userAdjustment([model,model]),null);
// Unknown initial state must not silently become Identity.
const missing=splat(a.scene,initial);
assert.equal(tracking.userAdjustment([missing]),null);
// Singular initial transformation cannot be inverted.
assert.equal(relativeModelMatrix(T(1,0,0),S(0,1,1)),null);
assert.equal(relativeModelMatrix(S(0,1,1),S(0,1,1)),null);
// Existing model before plugin startup: snapshot at hookup, subsequent edits tracked.
const b=sceneMock();
const existing=splat(b.scene,initial);b.scene.elements.push(existing);
const late=trackInitialModelTransforms(b.scene);
near(late.userAdjustment([existing]),I,0);
existing.worldTransform=matrix(mul(T(5,2,-1),initial));
near(late.userAdjustment([existing]),T(5,2,-1),5e-5);
// A reloaded different model gets its own baseline; first model remains unchanged.
const second=splat(b.scene,Rx(Math.PI/4));b.added(second);
near(late.userAdjustment([second]),I,0);
assert.equal(late.userAdjustment([existing,second]),null);
tracking.dispose();late.dispose();
// One canonical matrix remains in the original location.
const preview=sectionMetadata({ranges:{x:{min:0,max:1},y:{min:0,max:1},z:{min:0,max:1}},
    model_to_snapshot:rows,mapping_status:'declared_uniform'},
    {axis:'Z',direction:'-Z',coordinate_frame:'editor_world'});
assert.equal((JSON.stringify(preview).match(/"model_to_snapshot"/g)||[]).length,1);
near([0,1,2,3].flatMap(col=>[0,1,2,3].map(row=>preview.portviewer_floor.model_to_snapshot[row][col])),U,4e-5);
console.log('PASS post-load adjustment: no-edit identity, native import excluded, rotation/pivot/scale/translation, model reload, heterogeneous mappings, fail-closed, one JSON matrix');
