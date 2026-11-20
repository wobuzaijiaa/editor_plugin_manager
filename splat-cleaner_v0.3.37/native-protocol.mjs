// Native Floaters protocol v2: SCF2 + uint32 count + row-major world geometry.
export const PROTOCOL=2;
export const DEFAULT_PORT=3015;
export function validateNativePort(port){
    if(!Number.isInteger(port)||port<1024||port>65535)throw Error('Authorized native port must be an integer from 1024 to 65535.');
    return port;
}
export const DEFAULT_GPU_BACKEND='vulkan';
// Effective backend is always explicit; legacy default/blank belongs only to input settings.
export function validateGpuBackend(value){
    if(!['d3d12','vulkan'].includes(value))throw Error('Floaters GPU backend must be d3d12 or vulkan.');
    return value;
}
export function resolveGpuBackend(value){
    return validateGpuBackend(value===undefined||value===''||value==='default'?DEFAULT_GPU_BACKEND:value);
}
export function floaterSettings(settings={}){
    const autoStop=settings['floaters-auto-stop']??true;
    if(typeof autoStop!=='boolean')throw Error('Floaters automatic shutdown must be true or false.');
    const value=settings['floaters-gpu-backend'];
    const gpuBackend=resolveGpuBackend(value);
    return {autoStop,gpuBackend};
}
export const serviceURL=port=>`http://127.0.0.1:${validateNativePort(port)}`;
export const SERVICE_URL=serviceURL(DEFAULT_PORT); // standalone test default

export const MAX_ROWS=16777216;
export const MAGIC='SCF2';
export const HEADER_BYTES=8;
export const GEOMETRY=['x','y','z','rot_0','rot_1','rot_2','rot_3','scale_0','scale_1','scale_2','opacity'];
export const NAMES=[...GEOMETRY,'_cleaner_instance_id'];
export const STRIDE=NAMES.length*4;
export const PARAMETERS=Object.freeze({voxelResolution:.05,opacityCutoff:.1,minContribution:1/255});
export const VALIDATED_VERSION='3.11.2';
export function geometryByteLength(n){
    if(!Number.isInteger(n)||n<1||n>MAX_ROWS)throw Error(`Native Floaters supports 1–${MAX_ROWS.toLocaleString()} instances per analysis (exact ID transport).`);
    return HEADER_BYTES+n*STRIDE;
}
