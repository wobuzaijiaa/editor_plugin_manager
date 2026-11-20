import {GEOMETRY,NAMES,STRIDE,HEADER_BYTES,MAGIC,geometryByteLength,MAX_ROWS,PROTOCOL,SERVICE_URL,serviceURL,validateNativePort,PARAMETERS,validateGpuBackend} from './native-protocol.mjs';
const VERSION=/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;
async function responseError(response){
    let message=`HTTP ${response.status}`;
    try{const body=await response.json();if(typeof body.error==='string')message=body.error;}catch{}
    throw Error(message);
}
export async function detectNativeSplatTransform({fetchImpl=fetch,signal,startService,port=3015,verifyAssignment}={}){
    if(signal?.aborted)throw Error('Native Floaters cancelled.');
    const timeout=ms=>signal?AbortSignal.any([signal,AbortSignal.timeout(ms)]):AbortSignal.timeout(ms);
    // Manager ownership/readiness comes BEFORE any connection to a native listener.
    const owned=typeof startService==='function'?await startService():null;
    if(signal?.aborted)throw Error('Native Floaters cancelled.');
    if(startService&&(!owned||owned.state!=='running'||typeof owned.folder!=='string'||
        !Number.isInteger(owned.port)))throw Error('Manager did not confirm assigned native service port and readiness.');
    const effectivePort=validateNativePort(startService?owned.port:port);
    if(owned && typeof verifyAssignment==='function')await verifyAssignment(owned,effectivePort);
    if(signal?.aborted)throw Error('Native Floaters cancelled.');
    const endpoint=serviceURL(effectivePort);
    let response;
    try{response=await fetchImpl(`${endpoint}/status`,{cache:'no-store',signal:timeout(35000)});}
    catch(e){if(signal?.aborted)throw Error('Native Floaters cancelled.');throw Error(`Native Floaters service unavailable on authorized port ${effectivePort}. Check Manager and service logs.`);}
    if(signal?.aborted)throw Error('Native Floaters cancelled.');
    if(!response.ok)await responseError(response);
    const info=await response.json();
    if(owned&&(info.release_folder!==owned.folder||info.port!==effectivePort))throw Error('Floaters service endpoint does not match the Manager-owned release and approved port.');
    if(info.protocol!==PROTOCOL)throw Error('Incompatible Native Floaters service protocol.');
    if(!info.available)throw Error(info.error||'System SplatTransform unavailable. Install the official system SplatTransform package.');
    if(typeof info.version!=='string'||!VERSION.test(info.version)||typeof info.identity!=='string'||!/^[a-f0-9]{64}$/.test(info.identity)||info.maxRows!==MAX_ROWS)throw Error('Invalid native service version/capability response.');
    validateGpuBackend(info.gpu_backend);
    if(info.busy)throw Error('Native Floaters service is busy.');
    return {...info,endpoint};
}
// Preserve world geometry exactly for the native DataTable.
export async function encodeGeometry(columns,{cancelled=()=>false,progress=()=>{}}={}){
    const n=columns.x?.length;geometryByteLength(n);
    for(const k of NAMES)if(columns[k]?.length!==n)throw Error(`Missing instance-aligned column ${k}.`);
    const header=new Uint8Array(HEADER_BYTES);header.set(new TextEncoder().encode(MAGIC));new DataView(header.buffer).setUint32(4,n,true);
    const parts=[header];
    for(let start=0;start<n;start+=32768){
        if(cancelled())throw Error('Native Floaters cancelled.');
        const count=Math.min(32768,n-start),buffer=new ArrayBuffer(count*STRIDE),view=new DataView(buffer);
        for(let j=0;j<count;j++){
            const i=start+j,base=j*STRIDE;
            if(columns._cleaner_instance_id[i]!==i)throw Error('Instance IDs are not in original order.');
            for(let k=0;k<GEOMETRY.length;k++){
                const value=columns[GEOMETRY[k]][i];
                if(k===10?Number.isNaN(value):!Number.isFinite(value))throw Error(`Invalid geometry at instance ${i}.`);
                view.setFloat32(base+k*4,value,true);
            }
            view.setUint32(base+STRIDE-4,i,true);
        }
        parts.push(buffer);progress(start+count,n);
        await new Promise(resolve=>setTimeout(resolve,0));
    }
    if(cancelled())throw Error('Native Floaters cancelled.');
    return new Blob(parts,{type:'application/octet-stream'});
}
export async function runNativeFloaters(columns,info,{fetchImpl=fetch,signal,cancelled=()=>false,progress=()=>{}}={}){
    validateGpuBackend(info.gpu_backend);
    const isCancelled=()=>signal?.aborted||cancelled();
    const body=await encodeGeometry(columns,{cancelled:isCancelled,progress:(d,n)=>progress('encoding',d,n)});
    if(isCancelled())throw Error('Native Floaters cancelled.');
    progress('executing',0,columns.x.length);
    let res;
    try{res=await fetchImpl(`${info.endpoint??SERVICE_URL}/analyze`,{method:'POST',headers:{'Content-Type':'application/octet-stream','X-Splat-Protocol':String(PROTOCOL),'X-Splat-Identity':info.identity},body,signal});}
    catch(e){throw Error(isCancelled()?'Native Floaters cancelled.':`Native Floaters request failed: ${e.message}`);}
    if(!res.ok)await responseError(res);
    if(res.headers.get('X-Splat-Identity')!==info.identity||res.headers.get('X-Splat-Protocol')!==String(PROTOCOL))throw Error('Native Floaters runtime changed during execution.');
    if(res.headers.get('content-type')!=='application/octet-stream')throw Error('Unexpected native Floaters result format.');
    const n=columns.x.length;
    if(res.headers.get('content-length')!==String(n)||res.headers.get('X-Splat-Instance-Count')!==String(n))throw Error('Invalid candidate mask response length.');
    const candidate=new Uint8Array(await res.arrayBuffer());
    if(candidate.length!==n)throw Error('Truncated candidate mask response.');
    let total=0;
    for(const value of candidate){if(value!==0&&value!==1)throw Error('Invalid candidate mask value.');total+=value;}
    if(res.headers.get('X-Splat-Candidate-Count')!==String(total))throw Error('Candidate count mismatch.');
    if(isCancelled())throw Error('Native Floaters cancelled.');
    const elapsed=Number(res.headers.get('X-Splat-Elapsed-Ms'));
    return {candidate,runtime_version:info.version,gpu_backend:info.gpu_backend,runtime_commit:info.commit??null,version_warning:info.warning??null,parameters:PARAMETERS,elapsed_ms:Number.isFinite(elapsed)?elapsed:null};
}
