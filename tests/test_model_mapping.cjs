// Regression: raw world mapping used by the relative post-load adjustment calculation.
// Exercises the exact API helper used in snapshot capture with independent
// point-transform arithmetic and a palette mock that writes only 12 matrix cells.
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const assert = require('node:assert/strict');
const source = fs.readFileSync(path.join(__dirname, '../external/custom-editor.js'), 'utf8');
const ctx = vm.createContext({console, Float32Array, Float64Array, Uint8Array,
    Number, Array, Map, Set, Error, Promise, setTimeout, clearTimeout, performance});
vm.runInContext(source.split('async function initialize()')[0] +
    '\n;globalThis.api = {commonMapping, transformOf, toRows, sectionMetadata, snapshotView};', ctx);
const {commonMapping, toRows, sectionMetadata, snapshotView} = ctx.api;
const I = [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1];
const t = (x,y,z) => [1,0,0,0, 0,1,0,0, 0,0,1,0, x,y,z,1];
const rz = a => {const c=Math.cos(a),s=Math.sin(a);return [c,s,0,0, -s,c,0,0, 0,0,1,0, 0,0,0,1];};
const scale = (x,y,z) => [x,0,0,0, 0,y,0,0, 0,0,z,0, 0,0,0,1];
const mul = (a,b) => {const r=Array(16).fill(0);for(let c=0;c<4;c++)for(let j=0;j<4;j++)for(let k=0;k<4;k++)r[c*4+j]+=a[k*4+j]*b[c*4+k];return r;};
const apply = (m,p) => [0,1,2].map(j => m[j]*p[0] + m[4+j]*p[1] + m[8+j]*p[2] + m[12+j]);
const approx=(a,b,eps=1e-5) => {assert.equal(a.length,b.length);for(let i=0;i<a.length;i++)assert(Math.abs(a[i]-b[i])<eps, `matrix/point mismatch index ${i}: ${a[i]} vs ${b[i]}`);};
const rows = m => [0,1,2,3].map(r=>[0,1,2,3].map(c=>m[c*4+r]));
const flattenRows=(rows)=>[0,1,2,3].flatMap(r=>[0,1,2,3].map(c=>rows[c][r]));
const mat = values => ({data:Float32Array.from(values), clone(){return mat(this.data);},
  mul2(a,b){this.data.set(mul(a.data,b.data));return this;},
  equals(b){return this.data.every((v,i)=>Math.abs(v-b.data[i])<1e-6);}});
// Source-verified TransformPalette.getTransform copies *only* 12 cells.
const paletteIndices=[0,4,8,12,1,5,9,13,2,6,10,14];
const makeSplat=(world,palette=I,paletteIds=[0])=>({
  worldTransform:mat(world),
  instances:{count:paletteIds.length,transformIndex(i){return paletteIds[i];}},
  transformPalette:{getTransform(_id,dst){for(const j of paletteIndices)dst.data[j]=palette[j];}}
});
const M_initial = rz(Math.PI);
const unchanged = makeSplat(M_initial);
const m0=commonMapping([unchanged]);
assert(m0,'raw mapping must include the imported orientation as input to relative calculation');
approx(m0.data,M_initial);
approx(flattenRows(toRows(m0.data)),M_initial);
// Two independent test points expose row-major/column-major mistakes.
const referencePoints = [[1,2,3],[-4,5,-6],[2.3,-1.5,0.25],[0,0,0]];
for(const p of referencePoints)approx(apply(m0.data,p),[-p[0],-p[1],p[2]]);
const pivot=[3,-2,1];
const U=mul(t(4,-7,2),mul(t(...pivot),mul(rz(0.52),mul(scale(1.3,0.8,2.1),t(...pivot.map(v=>-v))))));
const M_current=mul(U,M_initial);
const moved=makeSplat(M_current);
const mc=commonMapping([moved]);
assert(mc,'raw current model state includes the current transform');
approx(mc.data,M_current);
// Explicit independent point logic: first initial import rotation, then
// translate to pivot, scale, rotate and translate to final position.
for(const p of referencePoints){
  const original=[-p[0],-p[1],p[2]];
  const centered=original.map((v,i)=>v-pivot[i]);
  const scaled=[centered[0]*1.3,centered[1]*0.8,centered[2]*2.1];
  const rotated=[Math.cos(.52)*scaled[0]-Math.sin(.52)*scaled[1],Math.sin(.52)*scaled[0]+Math.cos(.52)*scaled[1],scaled[2]];
  const expected=rotated.map((v,i)=>v+pivot[i]+[4,-7,2][i]);
  approx(apply(mc.data,p),expected);
}
// The initial orientation is not treated as an extra user adjustment.
// M_current * inverse(M_initial) = U, so U * M_initial = M_current.
approx(mul(M_current,M_initial),U); // Rz(180) is its own inverse
// Palette offset is part of actual rendered mapping, not omitted.
const P=t(.25,-.5,1.25);
const paletted=makeSplat(M_current,P,[1,1]);
const mp=commonMapping([paletted]);
assert(mp,'uniform palette transform must remain expressible');
approx(mp.data,mul(M_current,P));
for(const p of referencePoints)approx(apply(mp.data,p),apply(M_current,apply(P,p)));
// Independently different per-instance mappings cannot be declared uniform.
const paletteHeterogeneous=makeSplat(M_current,P,[0,1]);
paletteHeterogeneous.transformPalette.getTransform=(index,dst)=>{for(const j of paletteIndices)dst.data[j]=(index===0?I:P)[j];};
assert.equal(commonMapping([paletteHeterogeneous]),null);
assert.equal(commonMapping([unchanged,moved]),null,'multiple layers are unsupported by the legacy uniform-mapping contract');
const range={x:{min:-10,max:10},y:{min:-5,max:2},z:{min:1,max:5}};
for(const [axis,rotation] of [
 ['X',{x:0,y:Math.SQRT1_2,z:0,w:Math.SQRT1_2}],
 ['Y',{x:-Math.SQRT1_2,y:0,z:0,w:Math.SQRT1_2}],
 ['Z',{x:0,y:0,z:0,w:1}]
]) {
  const metadata=sectionMetadata({ranges:range,section_id:`Section ${axis}`,
    model_to_snapshot:toRows(mc.data),mapping_status:'declared_uniform'},snapshotView(rotation));
  assert.equal(metadata.portviewer_section.axis,axis);
  assert.equal(metadata.portviewer_floor.axis,axis);
  const key=axis.toLowerCase();
  assert.equal(metadata.portviewer_floor[`${key}_min`],range[key].min);
  assert.equal(metadata.portviewer_floor[`${key}_max`],range[key].max);
  assert.equal(metadata.portviewer_floor.floor_id,`Section ${axis}`);
  for(const other of ['x','y','z'].filter(x=>x!==key)){
    assert.equal(`${other}_min` in metadata.portviewer_floor,false);
    assert.equal(`${other}_max` in metadata.portviewer_floor,false);
  }
  assert.equal(metadata.portviewer_floor.mapping_status,'declared_uniform');
  approx(flattenRows(metadata.portviewer_floor.model_to_snapshot),M_current);
  assert.equal('model_to_snapshot' in metadata.portviewer_section, false);
  assert.equal('mapping_status' in metadata.portviewer_section, false);
  assert.equal((JSON.stringify(metadata).match(/"model_to_snapshot"/g)||[]).length, 1);
}
// No invented uniform matrix when the real instance transforms are mixed.
const unknown=sectionMetadata({ranges:range,section_id:'unknown',model_to_snapshot:null,
  mapping_status:'unknown_per_gaussian_or_multiple_models'},snapshotView({x:0,y:0,z:0,w:1}));
assert.equal(unknown.portviewer_floor.model_to_snapshot,null);
assert.equal(unknown.portviewer_floor.mapping_status,'unknown_per_gaussian_or_multiple_models');
console.log('PASS model-mapping: raw source orientation, general rotation, pivot, scale, palette transforms, row serialization, single JSON matrix, unsupported states');
