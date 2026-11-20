/** Fixed upstream-default policy for SplatTransform filterFloaters (v0.3.18_fix).
 * Retains the historical function name for integration compatibility.
 * World-space geometry estimates are diagnostic only; they do not select or
 * reject a resolution based on conceptual grid size. Coarsening can concentrate
 * millions of Gaussians into one upstream spatial batch and cause device loss.
 */
export function autoVoxelResolution(columns, {sampleSize=8192}={}) {
    if (!Number.isSafeInteger(sampleSize) || sampleSize<1)
        throw new Error('Invalid Gaussian scale sample limit.');
    const n=columns?.x?.length;
    if (!Number.isInteger(n) || n<1 || !['y','z','scale_0','scale_1','scale_2'].every(k=>columns[k]?.length===n))
        throw new Error('Incomplete instance-aligned Gaussian columns for voxel diagnostics.');
    const min=[Infinity,Infinity,Infinity],max=[-Infinity,-Infinity,-Infinity];
    for(let i=0;i<n;i++) {
        const logs=[columns.scale_0[i],columns.scale_1[i],columns.scale_2[i]];
        if(logs.some(v=>!Number.isFinite(v))) throw new Error('Invalid Gaussian log-scale for voxel diagnostics.');
        // Conservative rotation-independent 3-sigma AABB, to approximate the
        // bounds of the actual GPU voxelization (which uses Gaussian extents).
        const radius=3*Math.exp(Math.max(...logs));
        if(!Number.isFinite(radius)||radius<=0) throw new Error('Invalid Gaussian radius for voxel diagnostics.');
        for(let a=0;a<3;a++) {
            const v=columns[['x','y','z'][a]][i];
            if(!Number.isFinite(v))throw new Error('Invalid Gaussian center for voxel diagnostics.');
            if(v-radius<min[a])min[a]=v-radius;
            if(v+radius>max[a])max[a]=v+radius;
        }
    }
    const scales=[];
    const stride=Math.max(1,Math.floor(n/sampleSize));
    for(let i=0;i<n && scales.length<sampleSize;i+=stride) {
        const ls=[columns.scale_0[i],columns.scale_1[i],columns.scale_2[i]];
        if(ls.some(v=>!Number.isFinite(v)))throw new Error('Invalid Gaussian log-scale for voxel diagnostics.');
        ls.sort((a,b)=>a-b);
        const middle=Math.exp(ls[1]);
        if(!Number.isFinite(middle)||middle<=0) throw new Error('Invalid Gaussian scale for voxel diagnostics.');
        scales.push(middle);
    }
    scales.sort((a,b)=>a-b);
    const medianScale=scales[Math.floor(scales.length/2)];
    const extent=max.map((v,a)=>v-min[a]);
    const longest=Math.max(...extent);
    if(!(longest>0) || !Number.isFinite(longest))throw new Error('Degenerate or invalid model extent for voxel diagnostics.');
    // Match filterFloaters' upstream defaults. Neither the model extent nor
    // median scale controls the voxel width. The conservative +8 padding is
    // retained for comparable diagnostics, not exact vendor grid alignment.
    const width=0.05;
    const estimate=extent.reduce((product,d)=>product*(Math.ceil(d/width)+8),1);
    return {
        voxelResolution:width,
        opacityCutoff:0.1,
        minContribution:1/255,
        policy:'splat_transform_default_fixed_v1',
        medianMiddleScale:medianScale,
        estimatedGaussianExtent:extent,
        estimatedGridCells:Number.isFinite(estimate)?estimate:null,
        scaleSampleLimit:sampleSize
    };
}
