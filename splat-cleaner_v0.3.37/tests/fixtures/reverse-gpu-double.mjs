// Software emulation of packed integer shader traversal, not a WGSL compiler.
import assert from 'node:assert/strict';
export const limits={maxBufferSize:2**28,maxStorageBufferBindingSize:2**27,maxStorageBuffersPerShaderStage:8,maxComputeWorkgroupsPerDimension:65535,maxComputeInvocationsPerWorkgroup:256,maxComputeWorkgroupSizeX:256,maxUniformBufferBindingSize:65536};
export function reverseGpuDouble({failAt=0,failMessage='mock map failure',corrupt=false,cancel=null,limitOverride={},scopeErrorAt=0}={}){
 const stats={devices:0,destroyed:0,buffers:0,bufferDestroyed:0,batches:0,scopes:0,maps:0,unmaps:0};let resources;
 function execute(){
   stats.batches++;const [tree,q,o,p]=resources.map(b=>new Uint32Array(b.data));const [count,n,nodeCap,comparisonCap]=p;
   for(let i=0;i<count;i++){
     const a=i*8,b=i*18;o[b]=0xffffffff;o[b+1]=0;if(!q[a+6])continue;
     let cursor=0,visits=0,leaves=0,comparisons=0;
     while(cursor<n){
       if(visits>=nodeCap)break;visits++;const t=cursor*8;
       if([0,1,2].some(axis=>tree[t+axis]>q[a+3+axis]||tree[t+3+axis]<q[a+axis])){cursor=tree[t+6];continue;}
       const c=tree[t+7];if(c){if(leaves>=16||comparisons+c>comparisonCap)break;o[b+2+leaves++]=cursor;comparisons+=c;}
       cursor++;
     }
     if(cursor===n){o[b+1]=visits;o[b]=leaves;if(corrupt&&leaves)o[b+2]=n+1;}
   }
   cancel?.(stats.batches);
 }
 const caps={...limits,...limitOverride};
 const gpu={async requestAdapter(){return {limits:caps,async requestDevice(){
   stats.devices++;return {limits:caps,lost:new Promise(()=>{}),destroy(){stats.destroyed++;},pushErrorScope(){stats.scopes++;},async popErrorScope(){stats.scopes--;return scopeErrorAt&&stats.batches===scopeErrorAt?{message:'mock GPU validation failure'}:null;},
   createBuffer({size}){stats.buffers++;const data=new ArrayBuffer(size);return {data,destroy(){stats.bufferDestroyed++;},async mapAsync(){stats.maps++;if(failAt===stats.batches)throw Error(failMessage);},getMappedRange(offset,size){return data.slice(offset,offset+size);},unmap(){stats.unmaps++;}};},
   createShaderModule({code}){assert.match(code,/tree\[p\+6u\]/);assert.match(code,/comparisonCap/);return {async getCompilationInfo(){return {messages:[]};}};},
   async createComputePipelineAsync(){return {getBindGroupLayout(){return {};}};},createBindGroup({entries}){resources=entries.map(v=>v.resource.buffer);return {};},
   queue:{writeBuffer(buffer,offset,data,start=0,count=data.length){new Uint8Array(buffer.data,offset,count*data.BYTES_PER_ELEMENT).set(new Uint8Array(data.buffer,data.byteOffset+start*data.BYTES_PER_ELEMENT,count*data.BYTES_PER_ELEMENT));},submit(cmds){for(const cmd of cmds)cmd();}},
   createCommandEncoder(){let copy;return {beginComputePass(){return {setPipeline(){},setBindGroup(){},dispatchWorkgroups(groups){assert.ok(groups>0);},end(){}};},copyBufferToBuffer(src,a,dst,b,size){copy=()=>new Uint8Array(dst.data,b,size).set(new Uint8Array(src.data,a,size));},finish(){return ()=>{execute();copy();};}};}};
 }};}};
 return {gpu,stats};
}
