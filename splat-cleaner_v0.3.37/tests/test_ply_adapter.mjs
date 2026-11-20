import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {writeInputPly,openPly,readRetainedMask,worldToPly,requireStorage,storageBytes,PLY_STRIDE} from '../native/ply-adapter.mjs';
import {smokeFixture} from '../native/processor.mjs';
import {geometryByteLength,GEOMETRY} from '../native-protocol.mjs';
import {readFloaterColumns} from '../floater-adapter.mjs';
async function job(t){const dir=await fs.mkdtemp(path.join(os.tmpdir(),'ply32-test-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));const input=path.join(dir,'geometry.bin'),output=path.join(dir,'input.ply');await fs.writeFile(input,smokeFixture());return {dir,input,output};}
test('PLY-01 exact header, 72-byte records, uint32 IDs, asymmetric position and quaternion conversion',async t=>{
 const {input,output}=await job(t);const b=await fs.readFile(input);const v=[1.25,-3.5,8,.5,.5,.5,.5,-1,-2,-3,2];for(let k=0;k<v.length;k++)b.writeFloatLE(v[k],8+k*4);await fs.writeFile(input,b);
 await writeInputPly(input,output);const p=await openPly(output);try{assert.equal(p.count,28);assert.equal(p.stride,72);assert.equal(p.properties.size,18);const r=Buffer.alloc(72);await p.fd.read(r,0,72,p.headerBytes);const get=k=>r[p.properties.get(k).read](p.properties.get(k).offset);assert.deepEqual(['x','y','z'].map(get),[-1.25,3.5,8]);assert.deepEqual(['rot_0','rot_1','rot_2','rot_3'].map(get),[.5,.5,-.5,-.5]);assert.deepEqual(['scale_0','scale_1','scale_2'].map(get),[-1,-2,-3]);assert.equal(get('opacity'),2);assert.equal(get('_cleaner_instance_id'),0);for(const k of ['nx','ny','nz','f_dc_0','f_dc_1','f_dc_2'])assert.equal(get(k),0);}finally{await p.fd.close();}
 const result=await readRetainedMask(output,28);assert.equal(result.candidates,0);assert.ok(result.mask.every(v=>v===0));
});
test('PLY-02 coordinate roundtrip after live TRS and individual palette transform geometry',async()=>{
 const m={data:Float32Array.of(0,2,0,0,-2,0,0,0,0,0,2,0,7,8,9,1)};
 const source={meta:{chunkSize:1,layouts:{position:{},geometric:{fields:{rotation:{type:'float32',components:4},scale:{type:'float32',components:3},opacity:{type:'float32',components:1}}}}},async read(){}};
 const model={instances:{count:1,sourceRow:Uint32Array.of(2),transformIndex:()=>7},resource:{source,sourcePool:{acquire(){return {field:k=>({rotation:Float32Array.of(.5,.5,.5,.5),scale:Float32Array.of(-1,-2,-3),opacity:Float32Array.of(.25)})[k],release(){}};}}}};
 const analyzed={centers:{x:Float64Array.of(3),y:Float64Array.of(10),z:Float64Array.of(15)},transformMap:new Map([[7,m]])};
 const c=await readFloaterColumns(model,analyzed);const row=Object.fromEntries(Object.keys(c).map(k=>[k,c[k][0]])),p=worldToPly(row);assert.deepEqual([-p.x,-p.y,p.z],[3,10,15]);assert.deepEqual([-p.rot_3,-p.rot_2,p.rot_1,p.rot_0],[row.rot_0,row.rot_1,row.rot_2,row.rot_3]);assert.ok(Math.abs(p.scale_2-(-3+Math.log(2)))<1e-6);assert.equal(p._cleaner_instance_id,0);
});
test('PLY-03 malformed size and incorrect ID type rejected',async t=>{const {input,output}=await job(t);await writeInputPly(input,output);const b=await fs.readFile(output);await fs.writeFile(output,b.subarray(0,-1));await assert.rejects(openPly(output),/size/);const end=b.indexOf('end_header\n')+11;await fs.writeFile(output,Buffer.concat([Buffer.from(b.subarray(0,end).toString().replace('property uint _cleaner_instance_id','property float _cleaner_instance_id')),b.subarray(end)]));await assert.rejects(openPly(output),/UInt32/);});
test('PLY-04 bounded writer cancels during multi-block preparation',async t=>{const {input,output}=await job(t);const n=100000,b=Buffer.alloc(geometryByteLength(n));b.write('SCF2');b.writeUInt32LE(n,4);for(let i=0;i<n;i++){b.writeFloatLE(1,8+i*48+12);b.writeUInt32LE(i,8+i*48+44);}await fs.writeFile(input,b);const controller=new AbortController();const active=writeInputPly(input,output,controller.signal);setTimeout(()=>controller.abort(),5);await assert.rejects(active,{name:'AbortError'});await fs.rm(output,{force:true});});
test('PLY-05 disk gate checks future input/output and mask storage',async t=>{const {dir}=await job(t);assert.equal(PLY_STRIDE,72);const n=10439890;assert.equal(storageBytes(n),145*n+2*65536+64*1024*1024);assert.equal(storageBytes(n,false),storageBytes(n)-geometryByteLength(n));await requireStorage(dir,1);await assert.rejects(requireStorage(dir,Number.MAX_SAFE_INTEGER),/Insufficient temporary disk space/);});
test('PLY-06 input writer preserves fully opaque and transparent endpoints',async t=>{
 const {input,output}=await job(t);const b=await fs.readFile(input);b.writeFloatLE(Infinity,8+40);b.writeFloatLE(-Infinity,8+48+40);await fs.writeFile(input,b);await writeInputPly(input,output);const ply=await openPly(output);try{const rows=Buffer.alloc(2*ply.stride);await ply.fd.read(rows,0,rows.length,ply.headerBytes);const offset=ply.properties.get('opacity').offset;assert.equal(rows.readFloatLE(offset),Infinity);assert.equal(rows.readFloatLE(ply.stride+offset),-Infinity);}finally{await ply.fd.close();}
});
test('PLY-07 output reader needs IDs only, even with missing geometry or nonfinite unused attributes',async t=>{
 const {input,output}=await job(t);await fs.unlink(input);const header=Buffer.from('ply\nformat binary_little_endian 1.0\nelement vertex 2\nproperty double unused\nproperty uint _cleaner_instance_id\nproperty uchar extra\nend_header\n');const b=Buffer.alloc(26);b.writeDoubleLE(NaN,0);b.writeUInt32LE(3,8);b.writeUInt32LE(0,21);await fs.writeFile(output,Buffer.concat([header,b]));const r=await readRetainedMask(output,4);assert.deepEqual([...r.mask],[0,1,1,0]);assert.equal(r.kept,2);
});
test('PLY-08 cancelled result reading rejects instead of publishing a mask',async t=>{
 const {input,output}=await job(t);await writeInputPly(input,output);const c=new AbortController();c.abort();await assert.rejects(readRetainedMask(output,28,c.signal),{name:'AbortError'});
});
