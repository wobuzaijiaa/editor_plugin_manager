/** Experimental complete bounded WebGPU outgoing SNS search.
 * GPU accepts only separated interval decisions; CPU verifies witnesses and
 * resolves uncertain or truncated queries. Stage 2 stays CPU-owned.
 * No Editor device ownership, no import-time GPU access, no dependencies.
 */
import {assert,tick} from './core.mjs';

const STRIDE=21; // id, head, current xyz, bounds xyz pairs, radius, 9 inverse coefficients
const MAX_BATCH=8192, UPLOAD_CHUNK=65536;
const U32_NONE=0xffffffff;
const BU={MAP_READ:1,COPY_SRC:4,COPY_DST:8,UNIFORM:64,STORAGE:128};
const MAX_SHARD_ENTRIES=8388608; // 128 MiB of vec4, even on larger adapters
const MAX_GPU_CELLS=256, MAX_GPU_COMPARISONS=2048;
// Retry policy: at most the old full-dispatch cell budget, and a smaller
// comparison budget. CPU retains the full reference budget for unresolved cases.
const RETRY_MAX_BATCH=512, RETRY_INITIAL_BATCH=128, RETRY_COMPARISONS=8192;
const RETRY_CELL_WORK=64*16384, RETRY_COMPARISON_WORK=64*100000;
const RETRY_WINDOW=4096, RETRY_MIN_RESOLUTION=0.10;
export function adjustSnsRetryBatch(batch,elapsed,cap){
    if(elapsed>80)return Math.max(Math.min(64,cap),Math.floor(batch/2));
    if(elapsed<20)return Math.min(cap,batch*2);
    return batch;
}
const EXACT=0x100, AMBIGUOUS=0x200, TRUNCATED=0x400;
const now=()=>performance.now();

export function planSnsGpu(n,occupied,m,limits,{maxShardEntries=MAX_SHARD_ENTRIES,maxBatch=MAX_BATCH}={}){
    assert(Number.isSafeInteger(n)&&n>0&&n<0x7fffffff&&Number.isInteger(occupied)&&occupied>0&&occupied<=n,'Invalid SNS GPU index size.');
    assert(Number.isInteger(m)&&m>=1&&m<=50,'Invalid SNS GPU threshold.');
    const binding=Math.min(limits.maxBufferSize,limits.maxStorageBufferBindingSize);
    const entries=Math.min(maxShardEntries,Math.floor(binding/16));
    const batch=Math.min(maxBatch,n,Math.floor(binding/(STRIDE*4)),Math.floor(binding/((m+1)*4)),limits.maxComputeWorkgroupsPerDimension*64);
    assert(Number.isSafeInteger(entries)&&entries>=1&&Number.isSafeInteger(batch)&&batch>=1,'SNS GPU buffer/dispatch limits unavailable or insufficient.');
    const split=count=>Array.from({length:Math.ceil(count/entries)},(_,i)=>Math.min(entries,count-i*entries));
    const points=Math.ceil(n/entries),cells=Math.ceil(occupied/entries);
    assert(points+cells+2<=Math.min(8,limits.maxStorageBuffersPerShaderStage),'SNS GPU spatial index exceeds available storage bindings.');
    assert(limits.maxComputeInvocationsPerWorkgroup>=64&&limits.maxComputeWorkgroupSizeX>=64&&limits.maxUniformBufferBindingSize>=32&&limits.maxBufferSize>=32,'SNS GPU workgroup/uniform limits insufficient.');
    return {entries,batch,pointSizes:split(n),cellSizes:split(occupied),storageBindings:points+cells+2,
        largestStorageBytes:Math.max(Math.min(n,entries)*16,Math.min(occupied,entries)*16,batch*STRIDE*4,batch*(m+1)*4),
        bufferBytes:(n+occupied)*16+batch*(STRIDE+2*(m+1))*4+32};
}

// GPU can propose positive witnesses only. The caller's original float64
// coordinates and f32 inverse basis establish the authoritative predicate.
export function verifySnsWitnesses(centers,geometry,i,ids,m,k){
    if(ids.length!==m||!geometry.valid[i])return false;
    const seen=ids.length>1?new Set():null,b=i*9,inv=geometry.inverse,r=geometry.radii[i];
    for(const j of ids){
        if(!Number.isInteger(j)||j<0||j>=geometry.valid.length||j===i||!geometry.valid[j]||seen?.has(j))return false;
        seen?.add(j);
        const x=centers.x[j]-centers.x[i],y=centers.y[j]-centers.y[i],z=centers.z[j]-centers.z[i];
        const u=inv[b]*x+inv[b+1]*y+inv[b+2]*z,v=inv[b+3]*x+inv[b+4]*y+inv[b+5]*z,w=inv[b+6]*x+inv[b+7]*y+inv[b+8]*z;
        if(!(x*x+y*y+z*z<=r*r&&u*u+v*v+w*w<=k*k))return false;
    }
    return true;
}

// CPU-side bound on upload quantization, including rounded origin subtraction.
// The shader uses an inflated scalar bound for both endpoints and f32 subtraction.
export function snsCoordinateError(local,packed){
    return Math.abs(local-packed)+Math.abs(local)*2e-15+1e-30;
}
// Float32 model of the conservative shader predicate, used for precision tests.
// Every basic operation is rounded; this is not a GPU execution substitute.
export function classifySnsGpuPair(point,center,rows,radius,k2,coordinateError){
    const F=Math.fround, add=(a,b)=>F(a+b), mul=(a,b)=>F(a*b), sub=(a,b)=>F(a-b);
    const dot=(a,b)=>add(add(mul(a[0],b[0]),mul(a[1],b[1])),mul(a[2],b[2]));
    const abs=v=>v.map(Math.abs), safe=v=>v.every(x=>Math.abs(x)<=1e15);
    const norm=(v,e,t2)=>{
        if(!safe(v)||!safe(e)||!(t2>=1e-30&&t2<=1e30))return 2;
        const pad=v.map((x,i)=>add(add(e[i],mul(Math.abs(x),1e-5)),1e-25));
        const lo=v.map((x,i)=>Math.max(sub(Math.abs(x),pad[i]),0));
        const hi=v.map((x,i)=>add(Math.abs(x),pad[i]));
        if(dot(lo,lo)>mul(t2,1+1e-5))return 0;
        if(dot(hi,hi)<mul(t2,1-1e-5))return 1;
        return 2;
    };
    const d=point.map((x,i)=>sub(x,center[i]));
    const e=d.map(x=>add(add(mul(2,coordinateError),mul(Math.abs(x),1e-6)),1e-25));
    const radial=norm(d,e,mul(radius,radius));if(radial===0)return 0;
    const u=rows.map(row=>dot(row,d)),ae=abs(d).map((x,i)=>add(x,e[i]));
    const ue=rows.map(row=>add(add(dot(abs(row),e),mul(dot(abs(row),ae),1e-5)),1e-25));
    const ellipsoid=norm(u,ue,k2);
    return ellipsoid===0?0:radial===1&&ellipsoid===1?1:2;
}

export function snsGpuShader(plan){
    let binding=0;
    const make=(prefix,sizes)=>{
        const decl=sizes.map((_,i)=>`@group(0) @binding(${binding++}) var<storage,read> ${prefix}${i}: array<vec4<u32>>;`).join('\n');
        const load=sizes.map((_,i)=>`if (shard == ${i}u) { return ${prefix}${i}[offset]; }`).join('\n');
        return `${decl}\nfn load_${prefix}(index:u32)->vec4<u32>{ let shard=index/${plan.entries}u; let offset=index%${plan.entries}u; ${load} return vec4<u32>(0xffffffffu); }`;
    };
    const p=make('points',plan.pointSizes),c=make('cells',plan.cellSizes);
    return `${p}\n${c}
@group(0) @binding(${binding++}) var<storage,read> queries:array<u32>;
@group(0) @binding(${binding++}) var<storage,read_write> output:array<u32>;
struct Params { count:u32, m:u32, cellCount:u32, maxCells:u32, maxComparisons:u32, k2:f32, coordinateError:f32, full:u32 }
@group(0) @binding(${binding++}) var<uniform> params:Params;
const NONE:u32=0xffffffffu;
fn lower_cell(x:i32,y:i32,z:i32)->u32 {
    var lo:u32=0u; var hi:u32=params.cellCount;
    while(lo<hi){
        let mid=lo+(hi-lo)/2u; let c=load_cells(mid); let v=bitcast<vec3<i32>>(c.xyz);
        if(v.x<x || (v.x==x && (v.y<y || (v.y==y && v.z<z)))){lo=mid+1u;}else{hi=mid;}
    } return lo;
}
fn cell_head(x:i32,y:i32,z:i32)->u32 {
    var lo:u32=0u; var hi:u32=params.cellCount;
    while(lo<hi){
        let mid=lo+(hi-lo)/2u; let c=load_cells(mid); let v=bitcast<vec3<i32>>(c.xyz);
        if(v.x==x && v.y==y && v.z==z){return c.w;}
        if(v.x<x || (v.x==x && (v.y<y || (v.y==y && v.z<z)))){lo=mid+1u;}else{hi=mid;}
    } return NONE;
}
// Bounds are intentionally wider than f32 rounding error. Values outside
// the guarded numeric range, boundary cases and cancellation resolve on CPU.
fn safe(v:vec3<f32>)->bool {return all(abs(v)<=vec3<f32>(1e15));}
fn norm_class(v:vec3<f32>,e:vec3<f32>,t2:f32)->u32 {
    if(!safe(v)||!safe(e)||!(t2>=1e-30&&t2<=1e30)){return 2u;}
    let pad=e+abs(v)*1e-5+vec3<f32>(1e-25);
    let lo=max(abs(v)-pad,vec3<f32>(0.0)); let hi=abs(v)+pad;
    if(dot(lo,lo)>t2*(1.0+1e-5)){return 0u;}
    if(dot(hi,hi)<t2*(1.0-1e-5)){return 1u;}
    return 2u;
}
fn pair_class(p:vec3<f32>,center:vec3<f32>,radius:f32,a:vec3<f32>,b:vec3<f32>,c:vec3<f32>)->u32 {
    let d=p-center;
    let e=vec3<f32>(2.0*params.coordinateError)+abs(d)*1e-6+vec3<f32>(1e-25);
    let radial=norm_class(d,e,radius*radius); if(radial==0u){return 0u;}
    let u=vec3<f32>(dot(a,d),dot(b,d),dot(c,d));
    let ae=abs(d)+e;
    let ue=vec3<f32>(dot(abs(a),e),dot(abs(b),e),dot(abs(c),e))+
        vec3<f32>(dot(abs(a),ae),dot(abs(b),ae),dot(abs(c),ae))*1e-5+vec3<f32>(1e-25);
    let ellipsoid=norm_class(u,ue,params.k2);
    if(ellipsoid==0u){return 0u;}
    if(radial==1u&&ellipsoid==1u){return 1u;}return 2u;
}
fn scan(head:u32, i:u32, center:vec3<f32>, radius:f32, a:vec3<f32>,b:vec3<f32>,c:vec3<f32>, outputBase:u32, found:ptr<function,u32>, checked:ptr<function,u32>, ambiguous:ptr<function,bool>, limited:ptr<function,bool>){
    var j=head;
    while(j!=NONE && *found<params.m){
        let p=load_points(j); let id=j; j=p.w;
        if(id==i){continue;}
        if(*checked>=params.maxComparisons){*limited=true;return;}
        *checked+=1u;
        let relation=pair_class(bitcast<vec3<f32>>(p.xyz),center,radius,a,b,c);
        if(relation==1u){output[outputBase+1u+*found]=id; *found+=1u;}
        if(relation==2u){*ambiguous=true;}
    }
}
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) gid:vec3<u32>){
    if(gid.x>=params.count){return;}
    let q=gid.x*${STRIDE}u; let outputBase=gid.x*(params.m+1u); output[outputBase]=0u;
    let i=queries[q]; if(i==NONE){return;}
    let center=bitcast<vec3<f32>>(load_points(i).xyz);
    let radius=bitcast<f32>(queries[q+11u]);
    let a=bitcast<vec3<f32>>(vec3<u32>(queries[q+12u],queries[q+13u],queries[q+14u]));
    let b=bitcast<vec3<f32>>(vec3<u32>(queries[q+15u],queries[q+16u],queries[q+17u]));
    let c=bitcast<vec3<f32>>(vec3<u32>(queries[q+18u],queries[q+19u],queries[q+20u]));
    var found=0u; var checked=0u; var ambiguous=false; var limited=false;
    scan(queries[q+1u],i,center,radius,a,b,c,outputBase,&found,&checked,&ambiguous,&limited);
    let cx=bitcast<i32>(queries[q+2u]);let cy=bitcast<i32>(queries[q+3u]);let cz=bitcast<i32>(queries[q+4u]);
    let lx=bitcast<i32>(queries[q+5u]);let hx=bitcast<i32>(queries[q+6u]);
    let ly=bitcast<i32>(queries[q+7u]);let hy=bitcast<i32>(queries[q+8u]);
    let lz=bitcast<i32>(queries[q+9u]);let hz=bitcast<i32>(queries[q+10u]);
    var visited=1u;
    let boxValid=lx<=hx && ly<=hy && lz<=hz;
    let total=select(0u,u32(hx-lx+1)*u32(hy-ly+1)*u32(hz-lz+1),boxValid);
    // Full-box retry: empty cells need no neighbor tests. Seek the first
    // occupied cell of each x/y row, then scan occupied z entries in order.
    // Only use this path when the entire logical box fits the CPU cell budget.
    var complete=false;
    if(params.full!=0u && boxValid && total<=params.maxCells){
        for(var x=lx; x<=hx && found<params.m && !limited; x+=1){
            for(var y=ly; y<=hy && found<params.m && !limited; y+=1){
                var cursor=lower_cell(x,y,lz);
                while(cursor<params.cellCount && found<params.m && !limited){
                    let cell=load_cells(cursor);let v=bitcast<vec3<i32>>(cell.xyz);
                    if(v.x!=x || v.y!=y || v.z>hz){break;}
                    cursor+=1u;
                    if(x==cx && y==cy && v.z==cz){continue;}
                    scan(cell.w,i,center,radius,a,b,c,outputBase,&found,&checked,&ambiguous,&limited);
                }
            }
        }
        complete=!limited && found<params.m;
    }else{
        for(var x=lx; x<=hx && found<params.m && !limited && visited<params.maxCells; x+=1){
            for(var y=ly; y<=hy && found<params.m && !limited && visited<params.maxCells; y+=1){
                for(var z=lz; z<=hz && found<params.m && !limited && visited<params.maxCells; z+=1){
                    if(x==cx && y==cy && z==cz){continue;}
                    visited+=1u; scan(cell_head(x,y,z),i,center,radius,a,b,c,outputBase,&found,&checked,&ambiguous,&limited);
                }
            }
        }
        complete=boxValid && visited==total && !limited;
    }
    output[outputBase]=found | select(0u,256u,complete&&!ambiguous&&found<params.m) |
        select(0u,512u,ambiguous) | select(0u,1024u,!complete && found<params.m && (boxValid||limited));
}`;
}

/** Receives the already built CPU grid; no second geometry read. On any GPU
 * failure discard ALL results. Fast batches resolve easy queries; a second
 * workload-bounded sparse-row pass retries eligible truncated queries.
 */
export async function accelerateSnsOutgoing({centers,geometry,grid,next,cx,cy,cz,minX,minY,minZ,cellWidth,k,minSupport,maxCellsPerQuery,maxComparisonsPerQuery,cancelled,progress},options={}){
    const start=now(),n=centers.x.length;
    const diag={backend:'cpu',verified:0,attempted:0,batches:0,gpu_ms:0,reason:null,
        max_gpu_cells:maxCellsPerQuery,max_gpu_comparisons:Math.min(maxComparisonsPerQuery,RETRY_COMPARISONS),exact:0,cpu_fallback:0,fast_batches:0,full_batches:0,full_queries:0,ambiguous:0,
        fast_search_ms:0,full_search_ms:0,full_eligible:0,full_resolved:0,full_skipped:0,
        full_ambiguous_skipped:0,full_work_skipped:0,full_stop_reason:null,full_max_batch:0,
        full_max_cell_work:0,full_max_comparison_work:0,full_comparison_budget:0};
    const gpu=options.gpu??globalThis.navigator?.gpu;
    const check=()=>assert(!cancelled(),'SNS analysis cancelled.');
    if(!gpu){diag.reason='WebGPU unavailable';diag.cpu_fallback=geometry.valid.reduce((sum,v)=>sum+(v?1:0),0);diag.fallback_reasons={gpu_unavailable:diag.cpu_fallback};return {diagnostics:diag};}
    let device,scopeCount=0,lost=null,readback;const buffers=[];
    const cleanup=()=>{for(const b of buffers){try{b.destroy();}catch{}}try{device?.destroy();}catch{}};
    try{
        check();assert(maxCellsPerQuery<=0x7fffffff&&maxComparisonsPerQuery<=0x7fffffff,'SNS GPU query budgets exceed integer limits.');const adapter=await gpu.requestAdapter({powerPreference:'high-performance'});check();
        assert(adapter,'No WebGPU adapter available.');
        const plan=planSnsGpu(n,grid.size,minSupport,adapter.limits,options);
        diag.buffer_bytes=plan.bufferBytes;diag.batch_size=plan.batch;diag.storage_bindings=plan.storageBindings;
        device=await adapter.requestDevice({requiredLimits:{maxBufferSize:plan.largestStorageBytes,maxStorageBufferBindingSize:plan.largestStorageBytes,maxStorageBuffersPerShaderStage:plan.storageBindings}});
        device.lost.then(info=>{lost=info.message||info.reason||'device lost';});
        const actual=planSnsGpu(n,grid.size,minSupport,device.limits,options);
        assert(actual.entries>=plan.entries&&actual.batch>=plan.batch&&device.limits.maxStorageBuffersPerShaderStage>=plan.storageBindings,'Actual SNS device limits insufficient.');
        const begin=()=>{for(const filter of ['out-of-memory','internal','validation']){device.pushErrorScope(filter);scopeCount++;}};
        const end=async()=>{const errors=[];while(scopeCount){scopeCount--;const e=await device.popErrorScope();if(e)errors.push(e.message);}assert(!errors.length,errors.join('; '));assert(!lost,`SNS GPU device lost: ${lost}`);};
        const buffer=(size,usage)=>{const b=device.createBuffer({size,usage});buffers.push(b);return b;};
        begin();
        const points=plan.pointSizes.map(s=>buffer(s*16,BU.STORAGE|BU.COPY_DST));
        const cells=plan.cellSizes.map(s=>buffer(s*16,BU.STORAGE|BU.COPY_DST));
        const qbuf=buffer(plan.batch*STRIDE*4,BU.STORAGE|BU.COPY_DST);
        const stride=minSupport+1,obytes=plan.batch*stride*4;
        const obuf=buffer(obytes,BU.STORAGE|BU.COPY_SRC);readback=buffer(obytes,BU.MAP_READ|BU.COPY_DST);
        const uniform=buffer(32,BU.UNIFORM|BU.COPY_DST);
        const shader=device.createShaderModule({code:snsGpuShader(plan)});
        if(shader.getCompilationInfo){const info=await shader.getCompilationInfo();assert(!info.messages.some(m=>m.type==='error'),info.messages.filter(m=>m.type==='error').map(m=>`${m.lineNum}: ${m.message}`).join('; '));}
        const pipeline=await device.createComputePipelineAsync({layout:'auto',compute:{module:shader,entryPoint:'main'}});
        const bind=device.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries:[...points,...cells,qbuf,obuf,uniform].map((b,binding)=>({binding,resource:{buffer:b}}))});
        await end();check();
        // Compact lexicographic cell directory; original cell linked-list order
        // remains intact. Only cell heads are sorted, never instance arrays.
        const indexStart=now();
        const heads=Uint32Array.from(grid.values());
        heads.sort((i,j)=>cx[i]-cx[j]||cy[i]-cy[j]||cz[i]-cz[j]);
        diag.directory_ms=Math.round(now()-indexStart);
        const int32=v=>Number.isInteger(v)&&v>=-2147483647&&v<=2147483646;
        const scratch=new Uint32Array(UPLOAD_CHUNK*4),fl=new Float32Array(scratch.buffer);
        let quantizationError=0;
        async function upload(shards,sizes,fill,stage){
            let base=0;for(let s=0;s<shards.length;s++){
                for(let off=0;off<sizes[s];off+=UPLOAD_CHUNK){check();const count=Math.min(UPLOAD_CHUNK,sizes[s]-off);
                    fill(base+off,count);begin();device.queue.writeBuffer(shards[s],off*16,scratch,0,count*4);await end();
                    progress(base+off+count,stage==='gpu-points'?n:heads.length,stage);await tick();}
                base+=sizes[s];
            }
        }
        const uploadStart=now();
        await upload(points,plan.pointSizes,(offset,count)=>{for(let j=0;j<count;j++){
            const i=offset+j,p=j*4;fl[p]=centers.x[i]-minX;fl[p+1]=centers.y[i]-minY;fl[p+2]=centers.z[i]-minZ;
            if(geometry.valid[i]){
                assert(Math.abs(fl[p])<=1e15&&Math.abs(fl[p+1])<=1e15&&Math.abs(fl[p+2])<=1e15,'SNS coordinates exceed guarded GPU range.');
                quantizationError=Math.max(quantizationError,snsCoordinateError(centers.x[i]-minX,fl[p]),snsCoordinateError(centers.y[i]-minY,fl[p+1]),snsCoordinateError(centers.z[i]-minZ,fl[p+2]));
            }
            scratch[p+3]=next[i]>>>0;
        }},'gpu-points');
        await upload(cells,plan.cellSizes,(offset,count)=>{for(let j=0;j<count;j++){
            const i=heads[offset+j],p=j*4;assert(int32(cx[i])&&int32(cy[i])&&int32(cz[i]),'SNS grid exceeds GPU integer range.');
            scratch[p]=cx[i];scratch[p+1]=cy[i];scratch[p+2]=cz[i];scratch[p+3]=i;
        }},'gpu-cells');
        diag.upload_ms=Math.round(now()-uploadStart);
        const searchStart=now();
        // resolved: 0 CPU required, 1 verified sufficient, 2 complete exact below m.
        // Exact counts are needed by reverse coverage for m>1.
        const confirmed=new Uint8Array(n),exactCounts=new Uint8Array(n),exact=new Uint8Array(n);
        const retry=new Uint8Array(n),query=new Uint32Array(plan.batch*STRIDE),qf=new Float32Array(query.buffer),params=new Uint32Array(8),pf=new Float32Array(params.buffer);
        params[1]=minSupport;params[2]=heads.length;pf[5]=k*k;pf[6]=quantizationError*1.00001+1e-30;
        assert(Number.isFinite(pf[6]),'SNS GPU coordinate error exceeds float32 range.');
        diag.coordinate_error=pf[6];
        const ids=new Uint32Array(plan.batch),qi=new Int32Array(query.buffer);
        const validBounds=i=>{
            const r=geometry.radii[i];
            const b=[Math.floor((centers.x[i]-r-minX)/cellWidth),Math.floor((centers.x[i]+r-minX)/cellWidth),Math.floor((centers.y[i]-r-minY)/cellWidth),Math.floor((centers.y[i]+r-minY)/cellWidth),Math.floor((centers.z[i]-r-minZ)/cellWidth),Math.floor((centers.z[i]+r-minZ)/cellWidth)];
            const size=(b[1]-b[0]+1)*(b[3]-b[2]+1)*(b[5]-b[4]+1);
            return b.every(int32)&&Number.isFinite(size)&&size>=1&&size<=maxCellsPerQuery?b:null;
        };
        const cellWork=i=>{const b=validBounds(i);return b?(b[1]-b[0]+1)*(b[3]-b[2]+1)*(b[5]-b[4]+1):1;};
        function pack(j,i){
            const p=j*STRIDE;query[p]=U32_NONE;if(!geometry.valid[i])return;
            const r=geometry.radii[i];qf[p+11]=r;
            // Guard subnormal coefficients and extreme operands; CPU is authoritative.
            if(!Number.isFinite(qf[p+11])||qf[p+11]<=1e-15||qf[p+11]>1e15)return;
            for(let a=0;a<9;a++){const v=geometry.inverse[i*9+a];if(!Number.isFinite(v)||Math.abs(v)>1e15||(v!==0&&Math.abs(v)<1e-30))return;}
            query[p]=i;query[p+1]=grid.get(`${cx[i]},${cy[i]},${cz[i]}`);query[p+2]=cx[i];query[p+3]=cy[i];query[p+4]=cz[i];
            query.set(validBounds(i)??[1,0,1,0,1,0],p+5);
            qf.set(geometry.inverse.subarray(i*9,i*9+9),p+12);
        }
        async function dispatch(count,full){
            check();assert(!lost,`SNS GPU device lost: ${lost}`);params[0]=count;
            for(let j=0;j<count;j++)pack(j,ids[j]);
            begin();device.queue.writeBuffer(qbuf,0,query,0,count*STRIDE);device.queue.writeBuffer(uniform,0,params);
            const enc=device.createCommandEncoder(),pass=enc.beginComputePass();pass.setPipeline(pipeline);pass.setBindGroup(0,bind);pass.dispatchWorkgroups(Math.ceil(count/64));pass.end();enc.copyBufferToBuffer(obuf,0,readback,0,count*stride*4);device.queue.submit([enc.finish()]);
            await readback.mapAsync(1,0,count*stride*4);
            try{const output=new Uint32Array(readback.getMappedRange(0,count*stride*4));
                for(let j=0;j<count;j++){
                    const p=j*stride,i=ids[j];if(query[j*STRIDE]===U32_NONE){if(geometry.valid[i])retry[i]=2;continue;}
                    if(!full)diag.attempted++;
                    const raw=output[p],found=raw&255,flags=raw&~255;
                    if(found>minSupport || (flags&~(EXACT|AMBIGUOUS|TRUNCATED))){retry[i]=4;continue;}
                    if(found===minSupport && verifySnsWitnesses(centers,geometry,i,output.subarray(p+1,p+1+found),found,k)){
                        confirmed[i]=1;diag.verified++;
                    }else if(found<minSupport && flags===EXACT){
                        // Host checks full-range eligibility independently of shader status.
                        const b=new Int32Array(query.buffer,(j*STRIDE+5)*4,6);
                        if(b[0]<=b[1]&&b[2]<=b[3]&&b[4]<=b[5]&&(b[1]-b[0]+1)*(b[3]-b[2]+1)*(b[5]-b[4]+1)<=params[3]&&(!found||verifySnsWitnesses(centers,geometry,i,output.subarray(p+1,p+1+found),found,k))){exact[i]=1;exactCounts[i]=found;diag.exact++;}
                    }
                    if(!confirmed[i]&&!exact[i]){
                        if(!full && (flags&TRUNCATED)){
                            // Additional GPU work cannot certify a complete count
                            // after an ambiguous pair; CPU handles these directly.
                            if(flags&AMBIGUOUS)diag.full_ambiguous_skipped++;else retry[i]=1;
                        }
                        if(flags&AMBIGUOUS){diag.ambiguous++;retry[i]=3;}
                        else if(full||(flags&TRUNCATED)===0){
                            const q=j*STRIDE;
                            retry[i]=(flags&TRUNCATED)?5:(qi[q+5]>qi[q+6]||qi[q+7]>qi[q+8]||qi[q+9]>qi[q+10])?6:4;
                        }
                    }
                }
            }finally{readback.unmap();}
            await end();diag.batches++;if(full)diag.full_batches++;else diag.fast_batches++;
        }
        // Throttle UI/timer activity by elapsed time, not by dispatch count.
        let lastYield=now();
        async function update(done,total,stage){
            check();if(done===total||now()-lastYield>=32){progress(done,total,stage);await tick();lastYield=now();}
        }
        params[3]=Math.min(maxCellsPerQuery,MAX_GPU_CELLS);params[4]=Math.min(maxComparisonsPerQuery,MAX_GPU_COMPARISONS);
        const fastStart=now();
        for(let offset=0;offset<n;offset+=plan.batch){
            const count=Math.min(plan.batch,n-offset);for(let j=0;j<count;j++)ids[j]=offset+j;
            await dispatch(count,false);await update(offset+count,n,'gpu-search');
        }
        diag.fast_search_ms=Math.round(now()-fastStart);
        const fullStart=now(),retryComparisons=Math.min(maxComparisonsPerQuery,RETRY_COMPARISONS);
        for(let i=0;i<n;i++)if(retry[i]===1)diag.full_eligible++;
        if(diag.full_eligible&&(maxCellsPerQuery>params[3]||retryComparisons>params[4])){
            params[3]=maxCellsPerQuery;params[4]=retryComparisons;params[7]=1;
            diag.full_comparison_budget=retryComparisons;
            const cap=Math.min(plan.batch,RETRY_MAX_BATCH,Math.floor(RETRY_COMPARISON_WORK/retryComparisons));
            // User-independent experimental policy; test options may only reduce the window.
            const window=Math.min(RETRY_WINDOW,options.retryWindow??RETRY_WINDOW);
            assert(Number.isInteger(window)&&window>0,'Invalid SNS retry evaluation window.');
            let limit=Math.min(cap,RETRY_INITIAL_BATCH),count=0,work=0,windowQueries=0,windowResolved=0;
            const total=diag.full_eligible;
            async function flush(){
                if(!count)return false;
                const before=diag.verified+diag.exact,t0=now();
                await dispatch(count,true);
                const elapsed=now()-t0,resolved=diag.verified+diag.exact-before;
                diag.full_queries+=count;diag.full_resolved+=resolved;
                diag.full_max_batch=Math.max(diag.full_max_batch,count);
                diag.full_max_cell_work=Math.max(diag.full_max_cell_work,work);
                diag.full_max_comparison_work=Math.max(diag.full_max_comparison_work,count*retryComparisons);
                windowQueries+=count;windowResolved+=resolved;
                limit=adjustSnsRetryBatch(limit,elapsed,cap);count=0;work=0;
                await update(diag.full_queries,total,'gpu-full-search');
                if(windowQueries>=window){
                    const low=windowResolved/windowQueries<RETRY_MIN_RESOLUTION;
                    windowQueries=0;windowResolved=0;
                    if(low&&diag.full_queries<total){diag.full_stop_reason='low_resolution_rate';return true;}
                }
                return false;
            }
            progress(0,total,'gpu-full-search');
            for(let i=0;i<n;i++){
                if(i%65536===0)check();if(retry[i]!==1)continue;
                const cost=cellWork(i);
                if(cost>RETRY_CELL_WORK){diag.full_work_skipped++;continue;}
                if(count&&(count>=limit||work+cost>RETRY_CELL_WORK)){if(await flush())break;}
                ids[count++]=i;work+=cost;
                if(count>=limit&&await flush())break;
            }
            if(!diag.full_stop_reason)await flush();
            diag.full_skipped=total-diag.full_queries;
        }else{
            diag.full_skipped=diag.full_eligible;
            if(diag.full_eligible)diag.full_stop_reason='no_larger_gpu_budget';
        }
        diag.full_search_ms=Math.round(now()-fullStart);
        // Reuse the retry byte as a terminal reason code; no extra per-instance memory.
        const reasons={retry_not_submitted:0,packing_guard:0,numerical_ambiguity:0,unverified_or_invalid_result:0,retry_truncated:0,outgoing_box_guard:0,other:0};
        const names=['other','retry_not_submitted','packing_guard','numerical_ambiguity','unverified_or_invalid_result','retry_truncated','outgoing_box_guard'];
        for(let i=0;i<n;i++)if(geometry.valid[i]&&!confirmed[i]&&!exact[i]){diag.cpu_fallback++;reasons[names[retry[i]]??'other']++;}
        diag.fallback_reasons=reasons;
        check();diag.search_verify_ms=Math.round(now()-searchStart);diag.backend='webgpu+cpu';diag.gpu_ms=Math.round(now()-start);return {confirmed,exact,exactCounts,diagnostics:diag};
    }catch(e){
        // Do not preserve partial GPU proposals after any error.
        diag.reason=String(e?.message??e);diag.device_lost=!!lost||/device.{0,35}(lost|hung|removed)|DEVICE_HUNG|DEVICE_REMOVED/i.test(diag.reason);diag.verified=0;diag.exact=0;diag.full_resolved=0;diag.cpu_fallback=geometry.valid.reduce((sum,v)=>sum+(v?1:0),0);diag.fallback_reasons={gpu_failure:diag.cpu_fallback};diag.gpu_ms=Math.round(now()-start);check();return {diagnostics:diag};
    }finally{
        // Close any outstanding error scopes even on failed compilation/map.
        while(device&&scopeCount){scopeCount--;try{await device.popErrorScope();}catch{}}
        cleanup();
    }
}
