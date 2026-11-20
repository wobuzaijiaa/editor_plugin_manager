import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {pipeline} from 'node:stream/promises';
import {Transform} from 'node:stream';
import {fileURLToPath} from 'node:url';
import {PROTOCOL,MAX_ROWS,HEADER_BYTES,STRIDE,MAGIC,geometryByteLength,VALIDATED_VERSION,DEFAULT_PORT,validateNativePort,DEFAULT_GPU_BACKEND,resolveGpuBackend,validateGpuBackend,floaterSettings} from '../native-protocol.mjs';
import {requireStorage,storageBytes} from './ply-adapter.mjs';
const PROCESSOR=fileURLToPath(new URL('./processor.mjs',import.meta.url));
const PORT=DEFAULT_PORT, HOST='127.0.0.1', LIMIT=geometryByteLength(MAX_ROWS);
const clean=s=>s.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g,'');
export function resolvePackage(explicit,env=process.env){
    const candidates=[];
    if(explicit)candidates.push(explicit);
    else{
        for(const dir of (env.PATH||'').split(path.delimiter).filter(Boolean)){
            // npm global Windows shims live beside node_modules; Unix shims
            // are usually symlinks under prefix/bin, with package under lib.
            for(const executable of ['splat-transform','splat-transform.cmd','splat-transform.ps1']){
                const entry=path.join(dir,executable);if(!fs.existsSync(entry))continue;
                candidates.push(path.join(dir,'node_modules','@playcanvas','splat-transform'),path.join(dir,'..','lib','node_modules','@playcanvas','splat-transform'));
                try{let parent=path.dirname(fs.realpathSync(entry));for(let i=0;i<4;i++){candidates.push(parent);parent=path.dirname(parent);}}catch{}
            }
        }
        if(env.NPM_CONFIG_PREFIX)candidates.push(path.join(env.NPM_CONFIG_PREFIX,'node_modules','@playcanvas','splat-transform'),path.join(env.NPM_CONFIG_PREFIX,'lib','node_modules','@playcanvas','splat-transform'));
    }
    for(const root of candidates){try{
        const real=fs.realpathSync(root),pkg=JSON.parse(fs.readFileSync(path.join(real,'package.json'),'utf8'));
        if(pkg.name!=='@playcanvas/splat-transform')continue;
        const bin=typeof pkg.bin==='string'?pkg.bin:pkg.bin?.['splat-transform'];if(typeof bin!=='string')continue;
        const cli=fs.realpathSync(path.resolve(real,bin));if(!cli.startsWith(real+path.sep)||!fs.statSync(cli).isFile())continue;
        const bundle=path.join(real,'dist','cli.mjs');
        return {cli,version:pkg.version,files:[path.join(real,'package.json'),cli,...(fs.existsSync(bundle)?[fs.realpathSync(bundle)]:[])]};
    }catch{}}
    throw Error('System SplatTransform not found. Install @playcanvas/splat-transform globally, or start service with --package-dir pointing to its installed package directory.');
}
export function runProcessor(args,{signal,timeout=15000,log=false}={}){
    return new Promise((resolve,reject)=>{
        if(signal?.aborted)return reject(Error('Native Floaters cancelled.'));
        let reason=null,output='',settled=false;
        const child=spawn(process.execPath,[PROCESSOR,...args],{stdio:['ignore','pipe','pipe','ipc'],windowsHide:true,shell:false});
        const cancel=()=>{if(child.connected)child.send({type:'cancel'},()=>{});};
        const abort=()=>{reason=Error('Native Floaters cancelled.');cancel();};
        const timer=setTimeout(()=>{reason=Error('SplatTransform execution timed out.');cancel();},timeout);
        signal?.addEventListener('abort',abort,{once:true});
        const collect=(chunk)=>{output=(output+chunk.toString()).slice(-65536);if(log)process.stdout.write(chunk);};
        child.stdout.on('data',collect);child.stderr.on('data',collect);
        const finish=(error,code)=>{if(settled)return;settled=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);
            if(reason||error||code!==0)reject(reason||error||Error(`Native SplatTransform processor exited with code ${code}: ${clean(output).trim().slice(-1800)}`));else resolve(clean(output));};
        child.on('error',e=>finish(e));child.on('close',code=>finish(null,code));
    });
}
function runtimeIdentity(pkg,commit,gpuBackend){
    const files=pkg.files.map(file=>{const st=fs.statSync(file);return [file,st.size,st.mtimeMs];});
    return createHash('sha256').update(JSON.stringify([files,pkg.version,commit,gpuBackend])).digest('hex');
}
function assertRuntimeUnchanged(info,packageDir){
    if(runtimeIdentity(resolvePackage(packageDir),info.commit,info.gpu_backend)!==info.identity)throw Error('Installed SplatTransform changed during analysis; click Analyze GPU Floaters again.');
}
export async function detect(packageDir,signal,gpuBackend=DEFAULT_GPU_BACKEND){
    validateGpuBackend(gpuBackend);
    const pkg=resolvePackage(packageDir);
    const output=await runProcessor(['--probe',pkg.cli],{signal});
    const line=output.split(/\r?\n/).find(l=>l.startsWith('SCF_RUNTIME '));
    if(!line)throw Error('System SplatTransform CLI capability response missing.');
    const {version,commit}=JSON.parse(line.slice(12));
    if(version!==pkg.version||typeof commit!=='string'||!commit)throw Error('SplatTransform CLI version does not match package metadata.');
    const identity=runtimeIdentity(pkg,commit,gpuBackend);
    const warning=version===VALIDATED_VERSION&&commit==='6f64293'?null:`SplatTransform ${version} (${commit}) differs from reference 3.11.2 (6f64293); CLI detected; PLY exchange behavior unvalidated.`;
    return {protocol:PROTOCOL,available:true,version,commit,identity,gpu_backend:gpuBackend,maxRows:MAX_ROWS,warning,cli:pkg.cli};
}
// Manager authorizes the exact release and passes its selected port as a
// process argument. The public approval projection is never trusted for binding.
export async function readInstalledSettings(root){
    const folder=path.basename(root);
    const catalog=JSON.parse(await fsp.readFile(path.join(root,'..','manifest.json'),'utf8'));
    const rec=catalog.plugins?.find(p=>p.id==='splat-cleaner'&&p.folder===folder);
    if(!rec)throw Error('Cleaner installed release not found in saved manifest.');
    return {folder,gpuBackend:floaterSettings(rec.settings).gpuBackend};
}
export function createService({packageDir,gpuBackend=DEFAULT_GPU_BACKEND,releaseFolder=null,origins=['http://127.0.0.1:3013','http://localhost:3013'],port=PORT,tempRoot=os.tmpdir(),processingTimeout=30*60*1000}={}){
    validateGpuBackend(gpuBackend);
    const allowed=new Set(origins);for(const origin of allowed){const u=new URL(origin);if(u.origin!==origin||u.protocol!=='http:'||!['127.0.0.1','localhost','[::1]'].includes(u.hostname))throw Error('Allowed Editor origin must be an exact loopback HTTP origin.');}
    let busy=false,closing=false;const jobs=new Set();
    const server=http.createServer(async(req,res)=>{
        const json=(code,body)=>{if(res.destroyed||res.writableEnded)return;res.writeHead(code,{'Content-Type':'application/json'});res.end(JSON.stringify(body));};
        // Exact Host and Origin; no wildcard, no arbitrary command or path.
        const host=`${HOST}:${server.address()?.port??port}`;
        if(req.headers.host!==host||!allowed.has(req.headers.origin)){json(403,{error:'Editor origin or service host is not allowed.'});return;}
        res.setHeader('Access-Control-Allow-Origin',req.headers.origin);res.setHeader('Vary','Origin');res.setHeader('Cache-Control','no-store');
        res.setHeader('Access-Control-Expose-Headers','X-Splat-Identity, X-Splat-Protocol, X-Splat-Elapsed-Ms, X-Splat-Instance-Count, X-Splat-Candidate-Count');
        if(req.method==='OPTIONS'&&['/status','/analyze'].includes(req.url)){res.setHeader('Access-Control-Allow-Methods','GET, POST, OPTIONS');res.setHeader('Access-Control-Allow-Headers','Content-Type, X-Splat-Protocol, X-Splat-Identity');if(req.headers['access-control-request-private-network']==='true')res.setHeader('Access-Control-Allow-Private-Network','true');res.writeHead(204);res.end();return;}
        if(closing){json(503,{error:'Native Floaters service is stopping.'});return;}
        if(req.method==='GET'&&req.url==='/status'){
            const controller=new AbortController();jobs.add(controller);
            res.on('close',()=>{if(!res.writableEnded)controller.abort();});
            const ownership={release_folder:releaseFolder,port:server.address()?.port??port};
            try{const {cli,...info}=await detect(packageDir,controller.signal,gpuBackend);json(200,{...info,busy,...ownership});}
            catch(e){json(200,{protocol:PROTOCOL,available:false,error:e.message,busy,...ownership});}
            finally{jobs.delete(controller);}return;
        }
        if(req.method!=='POST'||req.url!=='/analyze'){json(404,{error:'Unknown operation.'});return;}
        if(req.headers['content-type']!=='application/octet-stream'||req.headers['x-splat-protocol']!==String(PROTOCOL)||!/^([a-f0-9]{64})$/.test(req.headers['x-splat-identity']||'')){json(400,{error:'Invalid native Floaters request contract.'});return;}
        const length=Number(req.headers['content-length']);if(!Number.isSafeInteger(length)||length<1||length>LIMIT){json(413,{error:'Input geometry exceeds transport limit or has no valid length.'});return;}
        const declared=(length-HEADER_BYTES)/STRIDE;if(!Number.isInteger(declared)||declared<1||declared>MAX_ROWS){json(400,{error:'Invalid SCF2 declared size.'});return;}
        if(busy){json(409,{error:'Native Floaters service is already processing a model.'});return;}
        busy=true;const controller=new AbortController();jobs.add(controller);const signal=controller.signal;
        res.on('close',()=>{if(!res.writableEnded)controller.abort();});
        let dir;try{
            const info=await detect(packageDir,signal,gpuBackend);if(info.identity!==req.headers['x-splat-identity'])throw Error('Installed SplatTransform changed since preflight; click Analyze GPU Floaters again.');
            // Check peak live storage, accounting for SCF2 removal before CLI execution.
            await requireStorage(tempRoot,storageBytes(declared));
            dir=await fsp.mkdtemp(path.join(tempRoot,'splat-cleaner-'));const rawPath=path.join(dir,'geometry.bin'),maskPath=path.join(dir,'mask.bin');let written=0;
            await pipeline(req,new Transform({transform(chunk,_encoding,cb){written+=chunk.length;cb(written>length?Error('Upload exceeds declared length.'):null,chunk);}}),fs.createWriteStream(rawPath,{flags:'wx'}),{signal});if(written!==length)throw Error('Incomplete input upload.');
            const started=Date.now();
            const fd=await fsp.open(rawPath,'r');let instances;
            try{const header=Buffer.alloc(HEADER_BYTES);const {bytesRead}=await fd.read(header,0,HEADER_BYTES,0);
                if(bytesRead!==HEADER_BYTES||header.toString('ascii',0,4)!==MAGIC)throw Error('Invalid geometry header.');
                instances=header.readUInt32LE(4);if(geometryByteLength(instances)!==written)throw Error('Geometry size/layout mismatch.');
            }finally{await fd.close();}
            console.log(`[Native Floaters] ${info.version}: ${instances} instances (original CLI PLY; requested GPU backend ${info.gpu_backend})`);if(info.warning)console.warn(info.warning);
            assertRuntimeUnchanged(info,packageDir);
            await runProcessor(['--run',info.cli,rawPath,maskPath,info.version,info.commit,info.gpu_backend],{signal,timeout:processingTimeout,log:true});
            assertRuntimeUnchanged(info,packageDir);
            const result=await fsp.readFile(maskPath);
            if(result.length!==instances)throw Error('Invalid candidate mask length.');
            let count=0;for(const v of result){if(v!==0&&v!==1)throw Error('Invalid candidate mask value.');count+=v;}
            if(signal.aborted)throw Error('Native Floaters cancelled.');
            await fsp.rm(dir,{recursive:true,force:true,maxRetries:3,retryDelay:200});dir=null;
            signal.throwIfAborted();
            res.writeHead(200,{'Content-Type':'application/octet-stream','Content-Length':result.length,'X-Splat-Protocol':String(PROTOCOL),'X-Splat-Identity':info.identity,'X-Splat-Elapsed-Ms':String(Date.now()-started),'X-Splat-Instance-Count':String(instances),'X-Splat-Candidate-Count':String(count)});res.end(result);
        }catch(e){
            console.error('[Native Floaters]',e.message);
            if(dir)try{await fsp.rm(dir,{recursive:true,force:true,maxRetries:3,retryDelay:200});dir=null;}
            catch(cleanup){console.error(`Temporary cleanup failed at ${dir}:`,cleanup.message);e=Error(`${e.message}; temporary cleanup failed at ${dir}: ${cleanup.message}`);}
            json(422,{error:e.message});
        }finally{jobs.delete(controller);busy=false;}
    });server.requestTimeout=30*60*1000;server.headersTimeout=30000;server.abortJobs=()=>{closing=true;for(const job of jobs)job.abort();};server.on('close',server.abortJobs);return server;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
    const args=process.argv.slice(2),origins=[];let packageDir,explicitPort,explicitBackend;
    for(let i=0;i<args.length;i++){if(args[i]==='--editor-origin'&&args[i+1])origins.push(args[++i]);else if(args[i]==='--package-dir'&&args[i+1])packageDir=args[++i];else if(args[i]==='--gpu-backend'&&args[i+1])explicitBackend=resolveGpuBackend(args[++i]);else if(args[i]==='--port'&&args[i+1])explicitPort=args[++i];else throw Error('Usage: node service.mjs [--editor-origin http://127.0.0.1:3013] [--package-dir path] [--port number] [--gpu-backend default|d3d12|vulkan]');}
    const managed=process.connected;
    const installed=managed?await readInstalledSettings(path.dirname(path.dirname(fileURLToPath(import.meta.url)))):null;
    if(managed&&!process.connected)throw Error('Native service parent disconnected during startup.');
    const port=managed?validateNativePort(Number(explicitPort)):validateNativePort(explicitPort===undefined?DEFAULT_PORT:Number(explicitPort));
    if(managed&&explicitBackend!==undefined)throw Error('Managed GPU backend must come from saved Cleaner settings.');
    const gpuBackend=installed?.gpuBackend??explicitBackend??DEFAULT_GPU_BACKEND;
    const s=createService({packageDir,gpuBackend,port,releaseFolder:installed?.folder??null,...(origins.length?{origins}:{})});
    let stopping=false;const stop=()=>{if(stopping)return;stopping=true;s.abortJobs();s.close();s.closeAllConnections();};
    process.on('SIGINT',stop);process.on('SIGTERM',stop);
    // A Manager-owned child stops if the parent shuts down or disappears.
    if(process.connected){
        process.on('disconnect',stop);
        process.on('message',message=>{if(message?.type==='native-stop')stop();});
    }
    s.on('error',error=>{console.error(`[Native Floaters] Startup failed on port ${port}:`,error.message);process.exitCode=1;if(process.connected){if(error.code==='EADDRINUSE')process.send({type:'native-start-error',code:'PORT_IN_USE',port},()=>process.disconnect());else process.disconnect();}});
    s.on('close',()=>{if(process.connected)process.disconnect();});
    s.listen(port,HOST,()=>{
        console.log(`Native Floaters service listening on http://${HOST}:${port}. GPU backend: ${gpuBackend}. Editor origin(s): ${origins.length?origins.join(', '):'http://127.0.0.1:3013, http://localhost:3013'}`);
        if(process.connected)process.send({type:'native-ready',port:s.address().port},error=>{if(error)stop();});
    });
}
