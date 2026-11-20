// Explicit workstation acceptance gate. No model files or Manager changes.
import {resolvePackage,detect,runProcessor} from './service.mjs';
import {DEFAULT_GPU_BACKEND,resolveGpuBackend} from '../native-protocol.mjs';
const args=process.argv.slice(2);
let packageDir,gpuBackend=DEFAULT_GPU_BACKEND;
for(let i=0;i<args.length;i++){
    if(args[i]==='--package-dir'&&args[i+1])packageDir=args[++i];
    else if(args[i]==='--gpu-backend'&&args[i+1])gpuBackend=resolveGpuBackend(args[++i]);
    else throw Error('Usage: node native/smoke-test.mjs [--package-dir path] [--gpu-backend default|d3d12|vulkan]');
}
const info=await detect(packageDir,undefined,gpuBackend);
console.log(`System CLI: ${resolvePackage(packageDir).cli}`);
console.log(`SplatTransform ${info.version} (${info.commit}); requested GPU backend: ${info.gpu_backend}`);
if(info.warning)console.warn(info.warning);
const result=await runProcessor(['--smoke',info.cli,info.gpu_backend],{timeout:120000,log:true});
const line=result.split(/\r?\n/).find(s=>s.startsWith('SMOKE_RESULT '));
if(!line)throw Error('Smoke test returned no mask.');
const {count,candidates,mask}=JSON.parse(line.slice(13));
if(count!==28||mask.length!==28||mask.some(v=>v!==0&&v!==1)||candidates!==mask.reduce((a,b)=>a+b,0)||mask[27]!==1||candidates!==1)throw Error('Unexpected smoke fixture result.');
console.log(`PASS: real native CLI execution, ${count} rows, ${candidates} candidates.`);
