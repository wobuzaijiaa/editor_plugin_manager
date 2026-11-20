/** SplatTransform filterFloaters adapter — source-aligned with v3.11.1.
 * Reads the Editor's instance-aligned geometric source only when requested.
 * No custom floater algorithm is implemented here.
 */
import { assert, tick } from './core.mjs';
import { runNativeFloaters, detectNativeSplatTransform } from './native-floaters.mjs';
import { PARAMETERS } from './native-protocol.mjs';

const NAMES = ['x','y','z','rot_0','rot_1','rot_2','rot_3','scale_0','scale_1','scale_2','opacity','_cleaner_instance_id'];

export function retainedIdsToMask(total, ids) {
    assert(Number.isSafeInteger(total) && total > 0 && total <= 0xffffffff, 'Invalid original instance count.');
    assert(ArrayBuffer.isView(ids) || Array.isArray(ids), 'SplatTransform must return retained instance IDs.');
    assert(Number.isSafeInteger(ids.length) && ids.length >= 0 && ids.length <= total, 'SplatTransform returned too many retained rows.');
    const candidate = new Uint8Array(total).fill(1), seen = new Uint8Array(total);
    for (let j=0;j<ids.length;j++) {
        const id=ids[j];
        assert(Number.isInteger(id) && id>=0 && id<total && !seen[id],
            `SplatTransform returned an invalid or duplicate instance ID at result row ${j}.`);
        seen[id]=1; candidate[id]=0;
    }
    return candidate;
}

function normalizedQuaternion(w,x,y,z) {
    const norm=Math.hypot(w,x,y,z);
    assert(Number.isFinite(norm) && norm>1e-10, 'Gaussian rotation is nonfinite or degenerate.');
    return [w/norm,x/norm,y/norm,z/norm];
}

function multiplyQuaternion(a,b) {
    const [aw,ax,ay,az]=a, [bw,bx,by,bz]=b;
    return normalizedQuaternion(aw*bw-ax*bx-ay*by-az*bz,
        aw*bx+ax*bw+ay*bz-az*by,
        aw*by-ax*bz+ay*bw+az*bx,
        aw*bz+ax*by-ay*bx+az*bw);
}

/** Derive proper rigid orientation and uniform scale from a column-major Mat4. */
export function worldRotationScale(matrix) {
    const m=matrix.data || matrix;
    assert(m?.length===16 && Array.from(m).every(Number.isFinite), 'Invalid world transform matrix.');
    const cx=[m[0],m[1],m[2]],cy=[m[4],m[5],m[6]],cz=[m[8],m[9],m[10]];
    const lens=[Math.hypot(...cx),Math.hypot(...cy),Math.hypot(...cz)];
    const s=(lens[0]+lens[1]+lens[2])/3;
    assert(s>1e-10 && lens.every(v=>Math.abs(v-s)<s*1e-4) &&
        Math.abs(m[3])<1e-6 && Math.abs(m[7])<1e-6 && Math.abs(m[11])<1e-6 && Math.abs(m[15]-1)<1e-6,
        'SplatTransform floater analysis supports only rigid/uniform world transforms.');
    const dot=(a,b)=>a[0]*b[0]+a[1]*b[1]+a[2]*b[2];
    assert(Math.abs(dot(cx,cy))<s*s*1e-4 && Math.abs(dot(cx,cz))<s*s*1e-4 && Math.abs(dot(cy,cz))<s*s*1e-4,
        'Sheared world transform is not supported for SplatTransform floaters.');
    const [a,b,c,d,e,f,g,h,i]=[m[0]/s,m[4]/s,m[8]/s,m[1]/s,m[5]/s,m[9]/s,m[2]/s,m[6]/s,m[10]/s];
    const det=a*(e*i-f*h)-b*(d*i-f*g)+c*(d*h-e*g);
    assert(det>0.999 && det<1.001, 'Mirrored world transform is not supported for SplatTransform floaters.');
    let w,x,y,z;
    const tr=a+e+i;
    if (tr>0) {
        const t=Math.sqrt(1+tr)*2;
        w=t/4;x=(h-f)/t;y=(c-g)/t;z=(d-b)/t;
    } else if(a>e && a>i) {
        const t=Math.sqrt(1+a-e-i)*2;
        w=(h-f)/t;x=t/4;y=(b+d)/t;z=(c+g)/t;
    } else if(e>i) {
        const t=Math.sqrt(1+e-a-i)*2;
        w=(c-g)/t;x=(b+d)/t;y=t/4;z=(f+h)/t;
    } else {
        const t=Math.sqrt(1+i-a-e)*2;
        w=(d-b)/t;x=(c+g)/t;y=(f+h)/t;z=t/4;
    }
    return { scale:s, quaternion:normalizedQuaternion(w,x,y,z) };
}

/** No extra geometry is decoded during ordinary Analyze. Called only on explicit GPU floater request. */
export async function readFloaterColumns(splat, analyzed, {cancelled=()=>false, progress=()=>{}, opacityEncoding='linear'}={}) {
    assert(analyzed?.centers && analyzed?.transformMap, 'Analyze the model before SplatTransform floater inspection.');
    assert(['logit','linear'].includes(opacityEncoding), 'Unrecognized opacity interpretation.');
    const {source,sourcePool}=splat.resource, n=splat.instances.count;
    assert(n===analyzed.centers.x.length && n>0 && n<=0xffffffff, 'Instance count changed; reanalyze.');
    const layout=source.meta.layouts.geometric, fields=layout?.fields||{};
    for (const [key,components] of [['rotation',4],['scale',3],['opacity',1]])
        assert(fields[key]?.type==='float32' && fields[key]?.components===components,
            `Source geometric.${key} float32×${components} unavailable for SplatTransform.`);
    const columns={
        x:new Float32Array(analyzed.centers.x),y:new Float32Array(analyzed.centers.y),z:new Float32Array(analyzed.centers.z),
        rot_0:new Float32Array(n),rot_1:new Float32Array(n),rot_2:new Float32Array(n),rot_3:new Float32Array(n),
        scale_0:new Float32Array(n),scale_1:new Float32Array(n),scale_2:new Float32Array(n),
        opacity:new Float32Array(n),_cleaner_instance_id:new Uint32Array(n)
    };
    for(const a of ['x','y','z'])
        assert(columns[a].every(Number.isFinite), 'Editor-world Gaussian centers cannot be represented in float32 for SplatTransform.');
    const tr=new Map();
    for (const [id,matrix] of analyzed.transformMap) tr.set(id,worldRotationScale(matrix));
    for(let offset=0;offset<n;offset+=source.meta.chunkSize) {
        assert(!cancelled(), 'SplatTransform geometry read cancelled.');
        const count=Math.min(source.meta.chunkSize,n-offset);
        // Position buffer included for compatibility with the reviewed chunk-source read contracts.
        const position=sourcePool.acquire('position',source.meta.layouts.position,count);
        const geo=sourcePool.acquire('geometric',layout,count);
        try {
            await source.read({indices:splat.instances.sourceRow,indexOffset:offset,count,position,geometric:geo});
            const rot=geo.field('rotation'),scale=geo.field('scale'),opacity=geo.field('opacity');
            assert(rot?.length===count*4 && scale?.length===count*3 && opacity?.length===count,
                'Incomplete geometric source fields for SplatTransform.');
            for(let j=0;j<count;j++) {
                const k=offset+j, id=splat.instances.transformIndex(k), transform=tr.get(id);
                assert(transform, 'Transform palette changed; reanalyze.');
                const q=normalizedQuaternion(rot[j*4],rot[j*4+1],rot[j*4+2],rot[j*4+3]);
                const worldQ=multiplyQuaternion(transform.quaternion,q);
                for (let c=0;c<4;c++) columns[`rot_${c}`][k]=worldQ[c];
                for (let c=0;c<3;c++) {
                    const v=scale[j*3+c]+Math.log(transform.scale);
                    assert(Number.isFinite(v) && Number.isFinite(Math.exp(v)) && Math.exp(v)>0,
                        `Invalid Gaussian scale at instance ${k}.`);
                    columns[`scale_${c}`][k]=v;
                }
                const alpha=opacity[j];
                if (opacityEncoding==='logit') {
                    assert(!Number.isNaN(alpha), `Invalid Gaussian opacity at instance ${k}.`);
                    columns.opacity[k]=alpha;
                } else {
                    // DataTable filterFloaters uses logit opacity; v3.11.1 geometric
                    // ChunkSource supplies linear opacity. 0/1 endpoints can
                    // be represented as +/-Infinity, but >1 cannot be represented.
                    assert(alpha>=0 && alpha<=1 && Number.isFinite(alpha),
                        `Linear opacity outside [0,1] at instance ${k}; cannot apply GPU floater filter.`);
                    columns.opacity[k]=alpha===0?-Infinity:alpha===1?Infinity:Math.log(alpha/(1-alpha));
                }
                columns._cleaner_instance_id[k]=k;
            }
        } finally {position.release();geo.release();}
        progress(offset+count,n);
        await tick();
    }
    assert(!cancelled(), 'SplatTransform geometry read cancelled.');
    return columns;
}

// Preserve the existing logical ABI: geometry columns + settings -> Uint8Array.
// Runtime metadata is optional and separate from the mask.
export async function runSplatTransformFloaters(columns, settings, options={}) {
    for(const name of NAMES) assert(columns?.[name]?.length===columns.x.length, `Missing SplatTransform ${name} column.`);
    for(const [key,value] of Object.entries(PARAMETERS)) assert(settings?.[key]===value, `Native Floaters requires fixed ${key}=${value}.`);
    const info=options.info??await detectNativeSplatTransform(options);
    const {candidate,...metadata}=await runNativeFloaters(columns,info,options);
    options.onMetadata?.(metadata);
    return candidate;
}
