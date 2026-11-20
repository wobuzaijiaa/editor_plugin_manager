// Standard binary PLY exchange. No vendor or graphics dependencies.
import fs from 'node:fs/promises';
import {setImmediate as yieldTurn} from 'node:timers/promises';
import {MAX_ROWS,geometryByteLength} from '../native-protocol.mjs';
import {openGeometry} from './scf2-reader.mjs';
const ID='_cleaner_instance_id';
export const PROPERTIES=Object.freeze(['x','y','z','nx','ny','nz','f_dc_0','f_dc_1','f_dc_2','opacity','scale_0','scale_1','scale_2','rot_0','rot_1','rot_2','rot_3',ID]);
export const PLY_STRIDE=PROPERTIES.length*4;
const BLOCK=8192, HEADER_LIMIT=65536;
const TYPES={float:[4,'readFloatLE'],float32:[4,'readFloatLE'],double:[8,'readDoubleLE'],float64:[8,'readDoubleLE'],uint:[4,'readUInt32LE'],uint32:[4,'readUInt32LE'],int:[4,'readInt32LE'],int32:[4,'readInt32LE'],uchar:[1,'readUInt8'],uint8:[1,'readUInt8'],char:[1,'readInt8'],int8:[1,'readInt8'],short:[2,'readInt16LE'],int16:[2,'readInt16LE'],ushort:[2,'readUInt16LE'],uint16:[2,'readUInt16LE']};
export function plyHeader(count){return Buffer.from(['ply','format binary_little_endian 1.0',`element vertex ${count}`,...PROPERTIES.map(k=>`property ${k===ID?'uint':'float'} ${k}`),'end_header',''].join('\n'));}
// Inverse of the vendor's PLY-to-engine Rz(pi) convention, applied AFTER live TRS.
// (-z rotation) * (w,x,y,z) = (z,y,-x,-w); quaternion sign is immaterial.
export function worldToPly(row,out={}){
    out.x=-row.x;out.y=-row.y;out.z=row.z;
    out.rot_0=row.rot_3;out.rot_1=row.rot_2;out.rot_2=-row.rot_1;out.rot_3=-row.rot_0;
    for(const k of ['scale_0','scale_1','scale_2','opacity',ID])out[k]=row[k];
    return out;
}
async function readExact(fd,buf,length,position){let done=0;while(done<length){const {bytesRead}=await fd.read(buf,done,length-done,position+done);if(!bytesRead)throw Error('Truncated PLY');done+=bytesRead;}}
async function writeExact(fd,buf,length){let done=0;while(done<length){const {bytesWritten}=await fd.write(buf,done,length-done,null);if(!bytesWritten)throw Error('Incomplete PLY write');done+=bytesWritten;}}
export async function writeInputPly(input,output,signal){
    const reader=openGeometry(input);let fd;
    try{
        signal?.throwIfAborted();fd=await fs.open(output,'wx');const head=plyHeader(reader.count);await writeExact(fd,head,head.length);
        const block=Buffer.alloc(BLOCK*PLY_STRIDE),row={},ply={};
        for(let base=0;base<reader.count;base+=BLOCK){
            signal?.throwIfAborted();const n=Math.min(BLOCK,reader.count-base);
            for(let j=0;j<n;j++){reader.getRow(base+j,row);worldToPly(row,ply);for(let k=0;k<PROPERTIES.length;k++){const key=PROPERTIES[k],offset=j*PLY_STRIDE+k*4;if(key===ID)block.writeUInt32LE(ply[key],offset);else block.writeFloatLE(ply[key]??0,offset);}}
            await writeExact(fd,block,n*PLY_STRIDE);await yieldTurn();
        }
        signal?.throwIfAborted();return reader.count;
    }finally{reader.close();await fd?.close();}
}
export async function openPly(file,maxCount=MAX_ROWS){
    const fd=await fs.open(file,'r');try{
        const {size}=await fd.stat();const h=Buffer.alloc(Math.min(size,HEADER_LIMIT));await readExact(fd,h,h.length,0);
        const match=/(?:^|\n)end_header\r?\n/.exec(h.toString('latin1'));if(!match)throw Error('Missing or oversized PLY header');
        const headerBytes=match.index+match[0].length;
        const lines=h.subarray(0,headerBytes).toString('ascii').trim().split(/\r?\n/);
        if(lines.shift()!=='ply'||lines.shift()!=='format binary_little_endian 1.0')throw Error('Unsupported PLY format');
        let count,stride=0;const properties=new Map();
        for(const line of lines){const t=line.trim().split(/\s+/);if(['comment','obj_info','end_header'].includes(t[0]))continue;
            if(t[0]==='element'&&t.length===3&&t[1]==='vertex'&&count===undefined&&/^\d+$/.test(t[2])){count=Number(t[2]);continue;}
            if(t[0]!=='property'||t.length!==3||count===undefined||!Object.hasOwn(TYPES,t[1])||properties.has(t[2])||properties.size>=256)throw Error('Unsupported or duplicate PLY element/property');
            const [bytes,read]=TYPES[t[1]];properties.set(t[2],{offset:stride,read,type:t[1]});stride+=bytes;
        }
        if(!Number.isSafeInteger(count)||count<1||count>maxCount||!stride||size!==headerBytes+stride*count)throw Error('Invalid PLY count or file size');
        if(!['uint','uint32'].includes(properties.get(ID)?.type))throw Error('Missing or invalid UInt32 retained ID property');
        return {fd,count,stride,properties,headerBytes};
    }catch(e){await fd.close();throw e;}
}
// The output is only a retained-ID carrier. Geometry correctness is tested at
// the input adapter / vendor compatibility boundary, not per retained row.
export async function readRetainedMask(output,instanceCount,signal){
    if(!Number.isSafeInteger(instanceCount)||instanceCount<1||instanceCount>MAX_ROWS)throw Error('Invalid original instance count');
    signal?.throwIfAborted();
    const ply=await openPly(output,instanceCount);
    try{
        const mask=Buffer.alloc(instanceCount,1),block=Buffer.alloc(BLOCK*ply.stride);
        const idOffset=ply.properties.get(ID).offset;
        for(let base=0;base<ply.count;base+=BLOCK){
            signal?.throwIfAborted();const n=Math.min(BLOCK,ply.count-base);
            await readExact(ply.fd,block,n*ply.stride,ply.headerBytes+base*ply.stride);
            for(let j=0;j<n;j++){
                const id=block.readUInt32LE(j*ply.stride+idOffset);
                if(id>=instanceCount||mask[id]!==1)throw Error('Invalid or duplicate retained ID');
                mask[id]=0;
            }
            await yieldTurn();
        }
        signal?.throwIfAborted();return {count:instanceCount,kept:ply.count,candidates:instanceCount-ply.count,mask};
    }finally{await ply.fd.close();}
}
// Conservative free-space gate; no guarantee against concurrent disk consumption.
export async function requireStorage(dir,required){const stat=await fs.statfs(dir,{bigint:true});if(stat.bavail*stat.bsize<BigInt(required))throw Error(`Insufficient temporary disk space: require ${required} bytes`);}
// Peak live files: SCF2 + input PLY, OR two PLYs + mask after SCF2 removal.
// The processor gate measures additional free space with SCF2 already on disk.
export const storageBytes=(n,includeUpload=true)=>{
    const upload=geometryByteLength(n);
    const peak=Math.max(upload+n*PLY_STRIDE+HEADER_LIMIT,n*(2*PLY_STRIDE+1)+2*HEADER_LIMIT);
    return peak-(includeUpload?0:upload)+64*1024*1024;
};
