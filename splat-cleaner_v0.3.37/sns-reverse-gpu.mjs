/** Experimental reverse SNS broad-phase. Integer AABB traversal of the SAME
 * static candidate tree. Never decides containment or removal. A complete
 * bounded leaf list is replayed in original source order by the CPU; all
 * other sources use the unmodified reference traversal. No float32 geometry.
 */
import {assert,tick} from './core.mjs';
const NONE=0xffffffff, QUANT=16777215, LEAVES=16, BATCH=2048, NODE_CAP=256, COMP_CAP=1024;
const BU={MAP_READ:1,COPY_SRC:4,COPY_DST:8,UNIFORM:64,STORAGE:128};

// Quantization is monotone (including saturation outside the root). Boxes
// which overlap before quantization still overlap afterwards. Degenerate
// axes collapse to zero, conservatively increasing potential intersections.
export function reverseQuantizer(root){
    const lo=root.lo,span=root.hi.map((v,a)=>v-lo[a]);
    assert(lo.every(Number.isFinite)&&span.every(v=>Number.isFinite(v)&&v>=0),'Reverse SNS bounds cannot be quantized.');
    return (v,a)=>span[a]===0?0:Math.max(0,Math.min(QUANT,Math.floor((v-lo[a])/span[a]*QUANT)));
}
export function packReverseSource(centers,geometry,i,quant,out,offset){
    out[offset+6]=0;
    if(!geometry.valid[i])return false;
    const r=geometry.radii[i];
    // Restrict to normal double squared-distance arithmetic. Expand both
    // bounds by much more than double rounding in subtraction, squaring,
    // radius comparison and addition. Extreme coordinates use CPU only.
    if(!(r>=1e-140&&r<=1e140))return false;
    for(let a=0;a<3;a++){
        const x=(a===0?centers.x:a===1?centers.y:centers.z)[i];
        if(!(Math.abs(x)<=1e150))return false;
        const pad=(Math.abs(x)+r)*1e-12;
        out[offset+a]=quant(x-r-pad,a);out[offset+3+a]=quant(x+r+pad,a);
    }
    out[offset+6]=1;return true;
}
export function flattenReverseTree(root,nodes=[]){
    function visit(node,parent){
        node.reverseParent=parent;const index=nodes.length;nodes.push(node);
        if(node.left){visit(node.left,node);visit(node.right,node);}
        node.reverseEscape=nodes.length;return index;
    }
    visit(root,null);return nodes;
}
export function packReverseTree(nodes,quant){
    const out=new Uint32Array(nodes.length*8);
    for(let i=0;i<nodes.length;i++){
        const node=nodes[i],p=i*8;
        for(let a=0;a<3;a++){out[p+a]=quant(node.lo[a],a);out[p+3+a]=quant(node.hi[a],a);}
        out[p+6]=node.reverseEscape;out[p+7]=node.left?0:node.end-node.start;
    }return out;
}
export function reverseGpuPlan(nodes,limits,{batch=BATCH}={}){
    const binding=Math.min(limits.maxBufferSize,limits.maxStorageBufferBindingSize);
    const size=Math.min(BATCH,batch,Math.floor(binding/((LEAVES+2)*4)),Math.floor(binding/32),limits.maxComputeWorkgroupsPerDimension*64);
    assert(Number.isSafeInteger(nodes)&&nodes>0&&nodes<=0x1fffffff&&nodes*32<=binding&&Number.isInteger(size)&&size>0,'Reverse SNS GPU buffers exceed device limits.');
    assert(limits.maxStorageBuffersPerShaderStage>=3&&limits.maxComputeInvocationsPerWorkgroup>=64&&limits.maxComputeWorkgroupSizeX>=64&&limits.maxUniformBufferBindingSize>=16,'Reverse SNS GPU device limits insufficient.');
    return {batch:size,stride:LEAVES+2,largest:Math.max(nodes*32,size*(LEAVES+2)*4,size*32),bytes:nodes*32+size*32+size*(LEAVES+2)*8+16};
}
export function reverseGpuShader(){return `
@group(0) @binding(0) var<storage,read> tree:array<u32>;
@group(0) @binding(1) var<storage,read> queries:array<u32>;
@group(0) @binding(2) var<storage,read_write> results:array<u32>;
struct Params { count:u32, nodes:u32, nodeCap:u32, comparisonCap:u32 }
@group(0) @binding(3) var<uniform> params:Params;
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) gid:vec3<u32>){
    if(gid.x>=params.count){return;}
    let q=gid.x*8u;let o=gid.x*${LEAVES+2}u;
    results[o]=0xffffffffu;results[o+1u]=0u;
    if(queries[q+6u]==0u){return;}
    var cursor=0u;var visits=0u;var leaves=0u;var comparisons=0u;
    while(cursor<params.nodes){
        if(visits>=params.nodeCap){return;}
        visits+=1u;let p=cursor*8u;
        if(tree[p]>queries[q+3u]||tree[p+3u]<queries[q]||tree[p+1u]>queries[q+4u]||tree[p+4u]<queries[q+1u]||tree[p+2u]>queries[q+5u]||tree[p+5u]<queries[q+2u]){cursor=tree[p+6u];continue;}
        let count=tree[p+7u];
        if(count>0u){
            if(leaves>=${LEAVES}u||comparisons+count>params.comparisonCap){return;}
            results[o+2u+leaves]=cursor;leaves+=1u;comparisons+=count;
        }
        cursor+=1u;
    }
    results[o+1u]=visits;results[o]=leaves;
}`;}

/** Stream ordered, bounded results; never store a whole-model pair list.
 * Completing a batch commits nothing. CPU consumes only after scopes succeed.
 * Unavailable/failed/inefficient GPU ends the stream; remaining sources run
 * on CPU. Earlier fully replayed batches stay valid. */
export function createSnsReverseSearch({centers,geometry,root, maxReverseNodesPerQuery,maxReverseComparisonsPerQuery,cancelled=()=>false,progress=()=>{},startOffset=0,cpuSampleMs=null},options={}){
    const diagnostics={backend:'cpu',reason:null,batches:0,submitted:0,complete:0,gpu_nodes_examined:0,gpu_ms:0,batch_ms:0,buffer_bytes:0,cpu_sample_sources:startOffset,cpu_sample_ms:cpuSampleMs,hybrid_sample_ms:null};
    const gpu=options.gpu??globalThis.navigator?.gpu;
    const nodes=[];
    async function* batches(){
        if(!gpu){diagnostics.reason='WebGPU unavailable';return;}
        const nodeCap=Math.min(NODE_CAP,maxReverseNodesPerQuery-1),comparisonCap=Math.min(COMP_CAP,maxReverseComparisonsPerQuery-1);
        if(nodeCap<1||comparisonCap<1){diagnostics.reason='Reference budgets too small for complete GPU replay';return;}
        const t=performance.now(),buffers=[];let device,readback,lost=null,scopes=0;
        const check=()=>assert(!cancelled(),'SNS analysis cancelled.');
        const begin=()=>{for(const filter of ['out-of-memory','internal','validation']){device.pushErrorScope(filter);scopes++;}};
        const end=async()=>{let errors=[];while(scopes){scopes--;const e=await device.popErrorScope();if(e)errors.push(e.message);}assert(!errors.length,errors.join('; '));assert(!lost,`Reverse SNS GPU device lost: ${lost}`);};
        try{
            check();flattenReverseTree(root,nodes);const quant=reverseQuantizer(root),adapter=await gpu.requestAdapter();check();assert(adapter,'No WebGPU adapter available.');
            const plan=reverseGpuPlan(nodes.length,adapter.limits,options);diagnostics.buffer_bytes=plan.bytes;
            device=await adapter.requestDevice({requiredLimits:{maxBufferSize:plan.largest,maxStorageBufferBindingSize:plan.largest,maxStorageBuffersPerShaderStage:3}});
            device.lost.then(info=>{lost=info.message||info.reason||'device lost';});check();assert(reverseGpuPlan(nodes.length,device.limits,{batch:plan.batch}).batch===plan.batch,'Actual reverse SNS GPU dispatch capacity insufficient.');
            const buffer=(size,usage)=>{const b=device.createBuffer({size,usage});buffers.push(b);return b;};
            begin();
            const tree=buffer(nodes.length*32,BU.STORAGE|BU.COPY_DST),query=buffer(plan.batch*32,BU.STORAGE|BU.COPY_DST),out=buffer(plan.batch*plan.stride*4,BU.STORAGE|BU.COPY_SRC),uniform=buffer(16,BU.UNIFORM|BU.COPY_DST);
            readback=buffer(plan.batch*plan.stride*4,BU.MAP_READ|BU.COPY_DST);
            const shader=device.createShaderModule({code:reverseGpuShader()});
            if(shader.getCompilationInfo){const info=await shader.getCompilationInfo();assert(!info.messages.some(m=>m.type==='error'),info.messages.filter(m=>m.type==='error').map(m=>m.message).join('; '));}
            const pipeline=await device.createComputePipelineAsync({layout:'auto',compute:{module:shader,entryPoint:'main'}});
            const bind=device.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries:[tree,query,out,uniform].map((buffer,binding)=>({binding,resource:{buffer}}))});
            const packed=packReverseTree(nodes,quant);device.queue.writeBuffer(tree,0,packed);await end();progress(startOffset,centers.x.length,'reverse-gpu');
            const q=new Uint32Array(plan.batch*8),params=new Uint32Array([0,nodes.length,nodeCap,comparisonCap]);
            let windowSubmitted=0,windowComplete=0,lastYield=performance.now(),sampleStart=lastYield;
            for(let offset=startOffset;offset<centers.x.length&&root.remaining;offset+=plan.batch){
                check();const batchStart=performance.now(),count=Math.min(plan.batch,centers.x.length-offset);params[0]=count;
                for(let j=0;j<count;j++)packReverseSource(centers,geometry,offset+j,quant,q,j*8);
                begin();device.queue.writeBuffer(query,0,q,0,count*8);device.queue.writeBuffer(uniform,0,params);
                const enc=device.createCommandEncoder(),pass=enc.beginComputePass();pass.setPipeline(pipeline);pass.setBindGroup(0,bind);pass.dispatchWorkgroups(Math.ceil(count/64));pass.end();enc.copyBufferToBuffer(out,0,readback,0,count*plan.stride*4);device.queue.submit([enc.finish()]);
                await readback.mapAsync(BU.MAP_READ,0,count*plan.stride*4);
                let result;try{result=new Uint32Array(readback.getMappedRange(0,count*plan.stride*4)).slice();}finally{readback.unmap();}
                await end();check();diagnostics.backend='webgpu+cpu';diagnostics.batches++;diagnostics.submitted+=count;
                let complete=0,eligible=0;
                for(let j=0;j<count;j++){
                    const p=j*plan.stride;if(!q[j*8+6]){result[p]=NONE;continue;}eligible++;
                    const len=result[p],visits=result[p+1];if(len>LEAVES||visits<1||visits>nodeCap){result[p]=NONE;continue;}
                    let previous=-1,comparisons=0,valid=true;
                    for(let a=0;a<len;a++){
                        const idx=result[p+2+a],node=nodes[idx];if(!node||node.left||idx<=previous){valid=false;break;}
                        previous=idx;comparisons+=node.end-node.start;
                        // Validate listed leaves overlap the packed query; output
                        // cannot authorize any pair without the CPU predicate.
                        const b=idx*8,s=j*8;for(let axis=0;axis<3;axis++)if(packed[b+axis]>q[s+3+axis]||packed[b+3+axis]<q[s+axis])valid=false;
                    }
                    if(!valid||comparisons>comparisonCap||len>visits){result[p]=NONE;continue;}
                    complete++;diagnostics.gpu_nodes_examined+=visits;
                }
                diagnostics.complete+=complete;windowSubmitted+=eligible;windowComplete+=complete;diagnostics.batch_ms+=performance.now()-batchStart;
                // Caller receives a copied batch and replays in source order.
                yield {offset,count,stride:plan.stride,result};
                if(startOffset&&cpuSampleMs!==null&&diagnostics.hybrid_sample_ms===null&&diagnostics.submitted>=startOffset){
                    diagnostics.hybrid_sample_ms=performance.now()-sampleStart;
                    if(diagnostics.hybrid_sample_ms/diagnostics.submitted>1.25*cpuSampleMs/startOffset){diagnostics.reason='GPU/CPU pilot slower than CPU sample';break;}
                }
                if(performance.now()-lastYield>=32){progress(offset+count,centers.x.length,'reverse-gpu');await tick();lastYield=performance.now();}
                if(windowSubmitted>=4096){if(windowComplete/windowSubmitted<0.2){diagnostics.reason='Low complete reverse GPU query rate';break;}windowSubmitted=0;windowComplete=0;}
            }
        }catch(e){diagnostics.reason=String(e?.message??e);diagnostics.device_lost=!!lost||/device.{0,35}(lost|hung|removed)|DEVICE_HUNG|DEVICE_REMOVED/i.test(diagnostics.reason);check();}
        finally{if(lost){diagnostics.device_lost=true;diagnostics.reason??=`Reverse SNS GPU device lost: ${lost}`;}while(device&&scopes){scopes--;try{await device.popErrorScope();}catch{}}for(const b of buffers){try{b.destroy();}catch{}}try{device?.destroy();}catch{}diagnostics.gpu_ms=Math.round(performance.now()-t);}
    }
    return {nodes,diagnostics,batches:batches()};
}
