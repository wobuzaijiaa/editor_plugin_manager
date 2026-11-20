// Disposable CLI supervisor. No vendor library imports or GPU device creation.
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {GEOMETRY,NAMES,HEADER_BYTES,STRIDE,geometryByteLength,PARAMETERS,resolveGpuBackend} from '../native-protocol.mjs';
import {writeInputPly,readRetainedMask,requireStorage,storageBytes} from './ply-adapter.mjs';
import {openGeometry} from './scf2-reader.mjs';
import {invokePowerShellCli} from './powershell-cli.mjs';

export function smokeColumns(){
    const n=28,c=Object.fromEntries(GEOMETRY.map(k=>[k,new Float32Array(n)]));
    c._cleaner_instance_id=Uint32Array.from({length:n},(_,i)=>i);
    for(let i=0;i<n;i++){
        c.x[i]=i===27?1:(i%3)*.025;c.y[i]=Math.floor(i/3)%3*.025;c.z[i]=Math.floor(i/9)*.025;
        c.rot_0[i]=1;c.opacity[i]=i===27?-12:4;
        for(const k of ['scale_0','scale_1','scale_2'])c[k][i]=Math.log(.025);
    }return c;
}

export function smokeFixture(){
    const c=smokeColumns(), n=c.x.length, b=Buffer.alloc(geometryByteLength(n));
    b.write('SCF2');b.writeUInt32LE(n,4);
    for(let i=0;i<n;i++){
        for(let k=0;k<GEOMETRY.length;k++)b.writeFloatLE(c[GEOMETRY[k]][i],HEADER_BYTES+i*STRIDE+k*4);
        b.writeUInt32LE(i,HEADER_BYTES+i*STRIDE+44);
    }return b;
}
const strip=s=>s.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g,'');
export function invokeCli(cli,args,{cwd,signal}={}){
    return new Promise((resolve,reject)=>{
        if(signal?.aborted)return reject(Error('Native Floaters cancelled.'));
        const child=spawn(process.execPath,[cli,...args],{cwd,windowsHide:true,shell:false,stdio:['ignore','pipe','pipe']});
        let output='',gpuError=false;
        const tails=['',''];
        const collect=(chunk,i,stream)=>{
            const s=chunk.toString();output=(output+s).slice(-65536);
            const text=strip(tails[i]+s);
            if(/WebGPU\s+(?:device lost|out-of-memory|error):/i.test(text))gpuError=true;
            tails[i]=text.slice(-256);if(!stream.destroyed)stream.write(chunk);
        };
        child.stdout.on('data',c=>collect(c,0,process.stdout));child.stderr.on('data',c=>collect(c,1,process.stderr));
        const abort=()=>child.kill();signal?.addEventListener('abort',abort,{once:true});
        let spawnError;
        child.on('error',e=>{spawnError=e;});
        child.once('close',(code,sig)=>{
            signal?.removeEventListener('abort',abort);
            if(signal?.aborted||spawnError||gpuError||code!==0)reject(spawnError||Error(signal?.aborted?'Native Floaters cancelled.':`Original SplatTransform CLI failed (exit ${code}, signal ${sig}, GPU error ${gpuError}): ${strip(output).trim().slice(-1800)}`));
            else resolve(strip(output));
        });
    });
}
export function parseVersion(output){
    const m=output.match(/^splat-transform v([^\s]+) \(([^()\s]+)\)\s*$/m);
    if(!m)throw Error('System SplatTransform CLI version response missing.');
    return {version:m[1],commit:m[2]};
}
async function calculate(cli,input,signal,gpuBackend,fullRun){
    const dir=path.dirname(input), output=path.join(dir,'retained.ply');
    if(path.basename(input)!=='geometry.bin')throw Error('Invalid SCF2 job path.');
    const reader=openGeometry(input);const count=reader.count;reader.close();
    await requireStorage(dir,storageBytes(count,false));
    await writeInputPly(input,path.join(dir,'input.ply'),signal);
    // The input PLY is complete and closed; the result parser only needs IDs.
    signal.throwIfAborted();
    await fsp.unlink(input);
    signal.throwIfAborted();
    const args=['-g','0','--no-tty','--verbose','--memory','--gpu-backend',gpuBackend,'input.ply',`--filter-floaters=${PARAMETERS.voxelResolution},${PARAMETERS.opacityCutoff},${PARAMETERS.minContribution}`,'retained.ply'];
    console.log('[Native Floaters] Original CLI:',JSON.stringify([process.execPath,cli,...args]));
    const powerShellWindow=fullRun&&process.platform==='win32';
    console.log('[Native Floaters] Launch mode:',powerShellWindow?'powershell-window':'direct-node');
    await (powerShellWindow?invokePowerShellCli:invokeCli)(cli,args,{cwd:dir,signal});
    const result=await readRetainedMask(output,count,signal);
    console.log(`[Native Floaters] Retained ${result.kept}/${result.count}; candidates ${result.candidates}; PLY bytes ${(await fsp.stat(output)).size}`);
    return result.mask;
}
async function main(signal){
    const [mode,cli,input,output,version,commit,requestedBackend]=process.argv.slice(2);
    if(!['--probe','--run','--smoke'].includes(mode)||!cli)throw Error('Invalid native processor invocation.');
    const gpuBackend=resolveGpuBackend(mode==='--smoke'?input:requestedBackend);
    const actual=parseVersion(await invokeCli(cli,['--version'],{signal}));
    if(mode==='--probe'){console.log('SCF_RUNTIME '+JSON.stringify(actual));return;}
    if(mode==='--run'&&(actual.version!==version||actual.commit!==commit))throw Error('System runtime changed after preflight.');
    let dir;
    try{
        if(mode==='--smoke'){dir=await fsp.mkdtemp(path.join(os.tmpdir(),'scf-cli-smoke-'));await fsp.writeFile(path.join(dir,'geometry.bin'),smokeFixture());}
        const mask=await calculate(cli,mode==='--smoke'?path.join(dir,'geometry.bin'):input,signal,gpuBackend,mode==='--run');
        signal.throwIfAborted();
        if(mode==='--run')await fsp.writeFile(output,mask,{flag:'wx'});
        else console.log('SMOKE_RESULT '+JSON.stringify({count:mask.length,candidates:mask.reduce((a,b)=>a+b,0),mask:[...mask]}));
    }finally{if(dir)try{await fsp.rm(dir,{recursive:true,force:true,maxRetries:3,retryDelay:200});}catch(e){throw Error(`Temporary cleanup failed at ${dir}: ${e.message}`);}}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
    const controller=new AbortController();
    const cancel=()=>controller.abort();
    const managed=typeof process.send==='function';
    if(managed){if(!process.connected)cancel();process.on('disconnect',cancel);process.on('message',m=>{if(m?.type==='cancel')cancel();});}
    process.on('SIGINT',cancel);process.on('SIGTERM',cancel);
    // If the owning service disappears, broken log pipes must not prevent CLI cleanup.
    process.stdout.on('error',cancel);process.stderr.on('error',cancel);
    try{await main(controller.signal);}catch(e){console.error(e);process.exitCode=1;}
    if(process.connected)process.disconnect();
}
