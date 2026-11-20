/** Scale-Normalized Support (SNS): center support within a Gaussian's oriented k-sigma ellipsoid.
 * Proposed Revision 4 formulation. Never infers rendering quality or deletes a splat.
 * Pure support search can be tested independently of the SuperSplat scene adapter below.
 */
import { assert, tick } from './core.mjs';

export const SNS_K = 3;
export const SNS_MIN_SUPPORT = 1;
const isFiniteNumber = Number.isFinite;

/** Precompute inverse oriented basis and conservative world-space search radius.
 * Source quaternion is w,x,y,z and source scales are logarithmic.
 * B = A * R(q) * diag(exp(logScale)); ||B^-1 delta|| is dimensionless.
 * Returns null when the covariance is singular or cannot be represented safely.
 */
export function gaussianMetric(quaternion, logScales, transform, k=SNS_K) {
    const [w,x,y,z] = quaternion;
    const qnorm = Math.hypot(w,x,y,z);
    if (!isFiniteNumber(qnorm) || qnorm < 1e-12) return null;
    const qw=w/qnorm, qx=x/qnorm, qy=y/qnorm, qz=z/qnorm;
    const s=logScales.map(v=>Math.exp(v));
    if (s.some(v=>!isFiniteNumber(v) || v<=0)) return null;
    const m=transform?.data || transform;
    if (!m || m.length!==16 || Array.from(m).some(v=>!isFiniteNumber(v)) ||
        Math.abs(m[3])>1e-6 || Math.abs(m[7])>1e-6 || Math.abs(m[11])>1e-6 || Math.abs(m[15]-1)>1e-6) return null;
    // Rotation columns in Gaussian-local coordinates.
    const r0=[1-2*(qy*qy+qz*qz), 2*(qx*qy+qw*qz), 2*(qx*qz-qw*qy)];
    const r1=[2*(qx*qy-qw*qz), 1-2*(qx*qx+qz*qz), 2*(qy*qz+qw*qx)];
    const r2=[2*(qx*qz+qw*qy), 2*(qy*qz-qw*qx), 1-2*(qx*qx+qy*qy)];
    const apply=(r,scale)=>[
        (m[0]*r[0]+m[4]*r[1]+m[8]*r[2])*scale,
        (m[1]*r[0]+m[5]*r[1]+m[9]*r[2])*scale,
        (m[2]*r[0]+m[6]*r[1]+m[10]*r[2])*scale
    ];
    const [a,b,c]=[apply(r0,s[0]),apply(r1,s[1]),apply(r2,s[2])];
    const cross=(u,v)=>[u[1]*v[2]-u[2]*v[1],u[2]*v[0]-u[0]*v[2],u[0]*v[1]-u[1]*v[0]];
    const dot=(u,v)=>u[0]*v[0]+u[1]*v[1]+u[2]*v[2];
    const row0=cross(b,c),row1=cross(c,a),row2=cross(a,b);
    const det=dot(a,row0);
    const na=Math.hypot(...a),nb=Math.hypot(...b),nc=Math.hypot(...c);
    if (!isFiniteNumber(det) || !isFiniteNumber(na*nb*nc) || na*nb*nc<=0 || Math.abs(det)/(na*nb*nc)<1e-10) return null;
    const inv=[...row0.map(v=>v/det),...row1.map(v=>v/det),...row2.map(v=>v/det)];
    if(inv.some(v=>!isFiniteNumber(v) || Math.abs(v)>3e38))return null;
    // Gershgorin upper bound of largest eigenvalue of B^T B. This is a
    // guaranteed (not estimated) circumscribed radius, including shear.
    const g01=Math.abs(dot(a,b)),g02=Math.abs(dot(a,c)),g12=Math.abs(dot(b,c));
    const radius=k*Math.sqrt(Math.max(na*na+g01+g02,nb*nb+g01+g12,nc*nc+g02+g12));
    if(!isFiniteNumber(radius) || radius<=0)return null;
    return {inverse:inv,radius};
}

/** Reads only the geometric layer, indexed by original Editor instance IDs.
 * The caller's earlier Analyze step supplies world centers and palette matrices.
 * Invalid splats are inconclusive (and cannot support other splats), not removals.
 */
export async function readSnsGeometry(splat, analyzed, {k=SNS_K,cancelled=()=>false,progress=()=>{}}={}) {
    assert(Number.isFinite(k)&&k>=1&&k<=10&&Number.isInteger(k*2),'SNS k must be 1–10 in steps of 0.5.');
    assert(analyzed?.centers?.x && analyzed?.transformMap,'Analyze the selected model before SNS.');
    const {source,sourcePool}=splat.resource,instances=splat.instances,n=instances.count;
    assert(analyzed.centers.x.length===n && n>0,'Model instance count changed; reanalyze.');
    const layout=source.meta.layouts.geometric,fields=layout?.fields||{};
    for(const [name,components] of [['rotation',4],['scale',3]])
        assert(fields[name]?.type==='float32'&&fields[name]?.components===components,
            `SNS requires geometric.${name} float32×${components}.`);
    const inverse=new Float32Array(n*9),radii=new Float64Array(n),valid=new Uint8Array(n),locked=new Uint8Array(n);
    for(let offset=0;offset<n;offset+=source.meta.chunkSize){
        assert(!cancelled(),'SNS geometry read cancelled.');
        const count=Math.min(source.meta.chunkSize,n-offset);
        const position=sourcePool.acquire('position',source.meta.layouts.position,count);
        const geo=sourcePool.acquire('geometric',layout,count);
        try {
            await source.read({indices:instances.sourceRow,indexOffset:offset,count,position,geometric:geo});
            const rotation=geo.field('rotation'),scale=geo.field('scale');
            assert(rotation?.length===count*4&&scale?.length===count*3,'Incomplete SNS geometric source.');
            for(let j=0;j<count;j++){
                const i=offset+j,idx=instances.transformIndex(i),matrix=analyzed.transformMap.get(idx);
                assert(matrix,'SNS palette transform differs from earlier Analyze.');
                locked[i]=instances.flags[i]&2 ? 1:0;
                if(![analyzed.centers.x[i],analyzed.centers.y[i],analyzed.centers.z[i]].every(isFiniteNumber))continue;
                const metric=gaussianMetric(
                    [rotation[4*j],rotation[4*j+1],rotation[4*j+2],rotation[4*j+3]],
                    [scale[3*j],scale[3*j+1],scale[3*j+2]],matrix,k);
                if(!metric)continue;
                let supported=true;
                for(let q=0;q<9;q++){
                    const v=Math.fround(metric.inverse[q]);
                    if(!isFiniteNumber(v) || (v===0&&metric.inverse[q]!==0)) {supported=false;break;}
                    inverse[9*i+q]=v;
                }
                if(!supported)continue;
                radii[i]=metric.radius;
                valid[i]=1;
            }
        } finally {position.release();geo.release();}
        progress(offset+count,n);
        await tick();
    }
    assert(!cancelled(),'SNS geometry read cancelled.');
    return {inverse,radii,valid,locked,k};
}

/** Exact ellipsoidal center-inclusion test using precomputed B^-1 rows. */
export function insideSnsEllipsoid(centers,i,j,geometry,k=SNS_K){
    const dx=centers.x[j]-centers.x[i],dy=centers.y[j]-centers.y[i],dz=centers.z[j]-centers.z[i];
    const inv=geometry.inverse,base=i*9;
    const u=inv[base]*dx+inv[base+1]*dy+inv[base+2]*dz;
    const v=inv[base+3]*dx+inv[base+4]*dy+inv[base+5]*dz;
    const w=inv[base+6]*dx+inv[base+7]*dy+inv[base+8]*dz;
    return u*u+v*v+w*w<=k*k;
}

/** Bounded spatial-hash search. Positive result is exact (support found); an
 * unsupported result is exact only when all indexed cells were searched.
 * Exceeding a resource cap always yields INCONCLUSIVE, never a candidate.
 */
export async function analyzeSnsSupport(centers,geometry,{
    k=SNS_K, minSupport=SNS_MIN_SUPPORT, cellWidth=null,
    maxCellsPerQuery=16384,maxComparisonsPerQuery=100000,
    cancelled=()=>false, progress=()=>{}, accelerate=null, sparseCpu=true
}={}){
    const indexStart=performance.now();
    const n=centers.x.length;
    assert(n===centers.y.length&&n===centers.z.length&&geometry.valid.length===n&&
        geometry.locked.length===n&&geometry.radii.length===n&&geometry.inverse.length===9*n,'SNS input lengths disagree.');
    assert(Number.isFinite(k)&&k>=1&&k<=10&&Number.isInteger(k*2), 'SNS k must be 1–10 in steps of 0.5.');
    assert(Number.isInteger(minSupport)&&minSupport>=1&&minSupport<=50, 'SNS m must be an integer 1–50.');
    assert(geometry.k===undefined || geometry.k===k, 'SNS geometry was prepared for a different k.');
    assert(Number.isInteger(maxCellsPerQuery)&&maxCellsPerQuery>=1&&
        Number.isInteger(maxComparisonsPerQuery)&&maxComparisonsPerQuery>=1,'Invalid SNS search budgets.');
    let minX=Infinity,minY=Infinity,minZ=Infinity,maxX=-Infinity,maxY=-Infinity,maxZ=-Infinity,eligible=0;
    const sample=[];
    for(let i=0;i<n;i++){
        if(!geometry.valid[i])continue;
        eligible++;
        const x=centers.x[i],y=centers.y[i],z=centers.z[i];
        if (![x,y,z].every(isFiniteNumber)) throw new Error('Finite SNS geometry expected.');
        minX=Math.min(minX,x);minY=Math.min(minY,y);minZ=Math.min(minZ,z);
        maxX=Math.max(maxX,x);maxY=Math.max(maxY,y);maxZ=Math.max(maxZ,z);
        if (sample.length<4096 && (i % Math.max(1,Math.floor(n/4096))===0)) sample.push(geometry.radii[i]);
    }
    const candidateMask=new Uint8Array(n),inconclusiveMask=new Uint8Array(n),supportCount=new Uint8Array(n);
    if(!eligible) {
        inconclusiveMask.fill(1);
        return {candidateMask,inconclusiveMask,supportCount,validCount:0,invalidCount:n,
            supportedCount:0,candidateCount:0,inconclusiveCount:n,lockedExcluded:0,cellWidth:null};
    }
    const dim=Math.max(maxX-minX,maxY-minY,maxZ-minZ);
    if(cellWidth===null){
        sample.sort((a,b)=>a-b);
        const medianRadius=sample[Math.floor(sample.length/2)];
        cellWidth=Math.max(medianRadius,dim/1e7,Number.MIN_VALUE*1e10);
    }
    assert(isFiniteNumber(cellWidth)&&cellWidth>0,'Invalid SNS index cell width.');
    const grid=new Map(),next=new Int32Array(n).fill(-1),cx=new Float64Array(n),cy=new Float64Array(n),cz=new Float64Array(n);
    const key=(x,y,z)=>`${x},${y},${z}`;
    for(let i=0;i<n;i++){
        if(!geometry.valid[i])continue;
        const x=Math.floor((centers.x[i]-minX)/cellWidth),y=Math.floor((centers.y[i]-minY)/cellWidth),z=Math.floor((centers.z[i]-minZ)/cellWidth);
        assert([x,y,z].every(Number.isSafeInteger),'SNS spatial coordinates exceed safe index range.');
        cx[i]=x;cy[i]=y;cz[i]=z;
        const id=key(x,y,z);
        next[i]=grid.get(id)??-1;grid.set(id,i);
    }
    // GPU returns verified positive witnesses and complete numerically separated
    // counts from the same index and budgets. All unresolved queries run below.
    const indexMs=Math.round(performance.now()-indexStart);
    const acceleration=accelerate ? await accelerate({centers,geometry,grid,next,cx,cy,cz,minX,minY,minZ,cellWidth,k,minSupport,
        maxCellsPerQuery,maxComparisonsPerQuery,cancelled,progress}) : null;
    assert(!cancelled(),'SNS analysis cancelled.');
    const confirmed=acceleration?.confirmed;
    assert(!confirmed || confirmed instanceof Uint8Array && confirmed.length===n,'Invalid SNS accelerator result.');
    const exact=acceleration?.exact,exactCounts=acceleration?.exactCounts;
    assert(!exact&&!exactCounts || exact instanceof Uint8Array && exactCounts instanceof Uint8Array && exact.length===n && exactCounts.length===n,'Invalid SNS exact accelerator result.');
    const searchStart=performance.now();
    let candidateCount=0,supportedCount=0,inconclusiveCount=0,lockedExcluded=0,lastYield=searchStart;
    const cpuSearch={queries:0,supported:0,candidates:0,locked_excluded:0,cell_budget_limited:0,comparison_budget_limited:0,sparse_queries:0,directory_ms:0};
    let heads=null,sparseCellWork=0;
    const lower=(x,y,z)=>{let lo=0,hi=heads.length;while(lo<hi){const mid=lo+Math.floor((hi-lo)/2),h=heads[mid];if(cx[h]<x||(cx[h]===x&&(cy[h]<y||(cy[h]===y&&cz[h]<z))))lo=mid+1;else hi=mid;}return lo;};
    // Keep the public CPU-only progress stage compatible. A hybrid run reports
    // actual fallback work separately from inexpensive mask finalization.
    let unresolved=0;
    if(acceleration)for(let i=0;i<n;i++)if(geometry.valid[i]&&!confirmed?.[i]&&!exact?.[i])unresolved++;
    const cpuStage=acceleration?(unresolved?'outgoing-cpu-search':'outgoing-finalize'):'outgoing';
    for(let i=0;i<n;i++){
        // Avoid thousands of timer waits when most queries are already resolved.
        if(i%256===0){assert(!cancelled(),'SNS analysis cancelled.');if(i===0||performance.now()-lastYield>=16){progress(i,n,cpuStage);await tick();lastYield=performance.now();}}
        if(!geometry.valid[i]){inconclusiveMask[i]=1;inconclusiveCount++;continue;}
        if(confirmed?.[i]){supportCount[i]=minSupport;supportedCount++;continue;}
        if(exact?.[i]){
            const count=exactCounts[i];assert(count<minSupport,'Invalid SNS complete below-threshold count.');
            supportCount[i]=count;
            if(geometry.locked[i])lockedExcluded++;else{candidateMask[i]=1;candidateCount++;}
            continue;
        }
        cpuSearch.queries++;
        const rad=geometry.radii[i];
        const lx=Math.floor((centers.x[i]-rad-minX)/cellWidth),hx=Math.floor((centers.x[i]+rad-minX)/cellWidth),
              ly=Math.floor((centers.y[i]-rad-minY)/cellWidth),hy=Math.floor((centers.y[i]+rad-minY)/cellWidth),
              lz=Math.floor((centers.z[i]-rad-minZ)/cellWidth),hz=Math.floor((centers.z[i]+rad-minZ)/cellWidth);
        const cellCount=(hx-lx+1)*(hy-ly+1)*(hz-lz+1);
        let checked=0,found=0,incomplete=false;
        const scanHead=(head)=>{
            for(let j=head;j!==-1;j=next[j]){
                if(j===i)continue;
                if(++checked>maxComparisonsPerQuery){incomplete=true;cpuSearch.comparison_budget_limited++;return;}
                const dx=centers.x[j]-centers.x[i],dy=centers.y[j]-centers.y[i],dz=centers.z[j]-centers.z[i];
                if(dx*dx+dy*dy+dz*dz<=rad*rad && insideSnsEllipsoid(centers,i,j,geometry,k)){
                    found++;supportCount[i]=found;
                    if(found>=minSupport)return;
                }
            }
        };
        // Check the current cell first. Very large Gaussians often find support
        // immediately without enumerating their potentially enormous search box.
        scanHead(grid.get(key(cx[i],cy[i],cz[i]))??-1);
        if(found<minSupport&&!incomplete){
            if(!isFiniteNumber(cellCount)||cellCount>maxCellsPerQuery){incomplete=true;cpuSearch.cell_budget_limited++;}
            else if(sparseCpu&&cellCount>=256&&[lx,hx,ly,hy,lz,hz].every(Number.isSafeInteger)&&
                (heads||(sparseCellWork+=cellCount)>=Math.max(256,2*grid.size))){
                // Preserve logical cell budget, own-cell priority and lexicographic
                // occupied-cell order. Defer sorting until cumulative logical work
                // justifies the full-directory cost (heuristic, not a timing guarantee).
                if(!heads){
                    progress(i,n,'outgoing-cpu-directory');await tick();assert(!cancelled(),'SNS analysis cancelled.');
                    const t=performance.now();heads=Uint32Array.from(grid.values());heads.sort((i,j)=>cx[i]-cx[j]||cy[i]-cy[j]||cz[i]-cz[j]);
                    cpuSearch.directory_ms=Math.round(performance.now()-t);assert(!cancelled(),'SNS analysis cancelled.');
                }
                cpuSearch.sparse_queries++;
                for(let x=lx;x<=hx&&found<minSupport&&!incomplete;x++)for(let y=ly;y<=hy&&found<minSupport&&!incomplete;y++){
                    for(let p=lower(x,y,lz);p<heads.length&&found<minSupport&&!incomplete;p++){
                        const h=heads[p];if(cx[h]!==x||cy[h]!==y||cz[h]>hz)break;
                        if(x===cx[i]&&y===cy[i]&&cz[h]===cz[i])continue;
                        scanHead(h);
                    }
                }
            }
            else for(let x=lx;x<=hx&&found<minSupport&&!incomplete;x++)
                for(let y=ly;y<=hy&&found<minSupport&&!incomplete;y++)
                    for(let z=lz;z<=hz&&found<minSupport&&!incomplete;z++){
                        if(x===cx[i]&&y===cy[i]&&z===cz[i])continue;
                        scanHead(grid.get(key(x,y,z))??-1);
                    }
        }
        if(found>=minSupport){supportedCount++;cpuSearch.supported++;}
        else if(incomplete){inconclusiveMask[i]=1;inconclusiveCount++;}
        else if(geometry.locked[i]){lockedExcluded++;cpuSearch.locked_excluded++;}
        else {candidateMask[i]=1;candidateCount++;cpuSearch.candidates++;}
    }
    progress(n,n,cpuStage);
    if(acceleration&&unresolved)progress(n,n,'outgoing-finalize');
    assert(!cancelled(),'SNS analysis cancelled.');
    return {candidateMask,inconclusiveMask,supportCount,validCount:eligible,invalidCount:n-eligible,
        supportedCount,candidateCount,inconclusiveCount,lockedExcluded,cellWidth,
        outgoingCpuSearch:cpuSearch,
        timings:{outgoing_index_ms:indexMs,outgoing_cpu_ms:Math.round(performance.now()-searchStart)},
        ...(acceleration?{outgoingAcceleration:acceleration.diagnostics}: {})};
}

/** Stage 2: query only confirmed outgoing candidates, using all valid covering
 * Gaussians. A balanced candidate-center tree bounds even very large queries
 * without enumerating empty grid cells. Neighborhood membership is the union
 * of the two existing directed predicates, not ellipsoid intersection.
 * All tree state is temporary; the original result arrays are reused.
 */
export async function analyzeSnsBidirectionalSupport(centers,geometry,{
    k=SNS_K,minSupport=SNS_MIN_SUPPORT,cellWidth=null,
    maxCellsPerQuery=16384,maxComparisonsPerQuery=100000,
    maxReverseNodesPerQuery=16384,maxReverseComparisonsPerQuery=100000,
    cancelled=()=>false,progress=()=>{},accelerate=null,accelerateReverse=null,sparseCpu=true
}={}) {
    assert(Number.isInteger(maxReverseNodesPerQuery)&&maxReverseNodesPerQuery>=1 &&
        Number.isInteger(maxReverseComparisonsPerQuery)&&maxReverseComparisonsPerQuery>=1,'Invalid reverse SNS search budgets.');
    const check=()=>assert(!cancelled(),'SNS analysis cancelled.');
    const outgoingStart=performance.now();
    const result=await analyzeSnsSupport(centers,geometry,{k,minSupport,cellWidth,maxCellsPerQuery,maxComparisonsPerQuery,
        cancelled,accelerate,sparseCpu,progress:(done,total,stage)=>progress(done,total,stage??'outgoing')});
    result.timings={...result.timings,outgoing_total_ms:Math.round(performance.now()-outgoingStart),reverse_index_ms:0,reverse_search_ms:0};
    const reverseIndexStart=performance.now();
    const {candidateMask,inconclusiveMask,supportCount}=result;
    const n=centers.x.length,c=result.candidateCount;
    const stats={outgoingCandidateCount:c,reverseSupportedCount:0,reverseInconclusiveCount:0,
        reverseBudgetLimitedSources:0,reverseNodeVisits:0,reverseComparisons:0,
        outgoingCellBudget:maxCellsPerQuery,outgoingComparisonBudget:maxComparisonsPerQuery,
        reverseNodeBudget:maxReverseNodesPerQuery,reverseComparisonBudget:maxReverseComparisonsPerQuery};
    if(!c){check();return Object.assign(result,stats);}
    const xyz=[centers.x,centers.y,centers.z];
    const ids=new Uint32Array(c);
    let lastCollectYield=performance.now();
    for(let i=0,j=0;i<n;i++){
        if(i%65536===0){check();if(performance.now()-lastCollectYield>=16){await tick();lastCollectYield=performance.now();}}
        if(candidateMask[i])ids[j++]=i;
    }
    // Median splits along the widest axis give bounded depth even for coincident
    // centers. Only candidate IDs are reordered, never model/instance arrays.
    const root={start:0,end:c,remaining:c},stack=[root];
    let built=0,lastIndexYield=performance.now();
    progress(0,c,'index');
    while(stack.length){
        if(built++%128===0){check();if(performance.now()-lastIndexYield>=16){await tick();lastIndexYield=performance.now();}}
        const node=stack.pop(),{start,end}=node;
        const lo=[Infinity,Infinity,Infinity],hi=[-Infinity,-Infinity,-Infinity];
        for(let p=start;p<end;p++)for(let a=0;a<3;a++){
            const v=xyz[a][ids[p]];lo[a]=Math.min(lo[a],v);hi[a]=Math.max(hi[a],v);
        }
        node.lo=lo;node.hi=hi;
        if(end-start>32){
            let axis=0;
            for(let a=1;a<3;a++)if(hi[a]-lo[a]>hi[axis]-lo[axis])axis=a;
            if(hi[axis]>lo[axis])ids.subarray(start,end).sort((i,j)=>xyz[axis][i]-xyz[axis][j]);
            const mid=start+Math.floor((end-start)/2);
            node.left={start,end:mid,remaining:mid-start};node.right={start:mid,end,remaining:end-mid};
            stack.push(node.right,node.left);
        }
    }
    progress(c,c,'index');
    result.timings.reverse_index_ms=Math.round(performance.now()-reverseIndexStart);
    const reverseSearchStart=performance.now();
    // The same radial broad-phase and oriented test as Stage 1. Rechecking the
    // outgoing predicate for m>1 avoids retaining per-instance neighbor lists.
    const inverse=geometry.inverse,radii=geometry.radii,k2=k*k;
    const covers=(i,j)=>{
        const dx=xyz[0][j]-xyz[0][i],dy=xyz[1][j]-xyz[1][i],dz=xyz[2][j]-xyz[2][i],r=radii[i];
        if(!(dx*dx+dy*dy+dz*dz<=r*r))return false;
        const b=i*9,u=inverse[b]*dx+inverse[b+1]*dy+inverse[b+2]*dz,
            v=inverse[b+3]*dx+inverse[b+4]*dy+inverse[b+5]*dz,
            w=inverse[b+6]*dx+inverse[b+7]*dy+inverse[b+8]*dz;
        return u*u+v*v+w*w<=k2;
    };
    // Reuse the same traversal closure for each source (no per-source recursive
    // function allocation). Preserve reference order, counters and predicates.
    let i,x,y,z,rr,nodes,comparisons,limited;
    const overlaps=node=>{
        const dx=Math.max(node.lo[0]-x,x-node.hi[0],0),dy=Math.max(node.lo[1]-y,y-node.hi[1],0),dz=Math.max(node.lo[2]-z,z-node.hi[2],0);
        return !(dx*dx+dy*dy+dz*dz>rr);
    };
    const visit=node=>{
        if(!node.remaining||!overlaps(node))return 0;
        // Keep reference budget/uncertainty semantics exactly, including a
        // budget hit on an overlapping internal node or incomplete leaf.
        if(nodes>=maxReverseNodesPerQuery||comparisons>=maxReverseComparisonsPerQuery){
            node.uncertain=true;limited=true;return 0;
        }
        nodes++;
        let rescued=0;
        if(node.left){rescued=visit(node.left)+visit(node.right);}
        else for(let p=node.start;p<node.end;p++){
            const j=ids[p];if(j===i||!candidateMask[j])continue;
            if(comparisons>=maxReverseComparisonsPerQuery){node.uncertain=true;limited=true;break;}
            comparisons++;
            if(!covers(i,j)||(minSupport>1&&covers(j,i)))continue;
            if(++supportCount[j]>=minSupport){candidateMask[j]=0;rescued++;}
        }
        node.remaining-=rescued;return rescued;
    };
    // GPU only supplies a complete conservative leaf list. It cannot decide
    // support. Replay sources in the original order. On large models use a
    // CPU timing sample before an experimental GPU profitability check.
    const shouldAccelerate=accelerateReverse&&!result.outgoingAcceleration?.device_lost;
    const gpuStart=shouldAccelerate&&n>=32768?8192:0;
    const cpuSampleStart=performance.now();
    let accelerator=null,iterator=null,batch=null,gpuDone=!shouldAccelerate;
    let replayedSources=0,replayedLeaves=0,cpuSources=0,lastYield=performance.now(),workAtCheck=0;
    try{for(i=0;i<n&&root.remaining;i++){
        const work=stats.reverseNodeVisits+stats.reverseComparisons;
        if(i%256===0||work-workAtCheck>=100000){check();workAtCheck=work;if(performance.now()-lastYield>=16){progress(i,n,'reverse');await tick();lastYield=performance.now();}}
        if(!gpuDone&&i===gpuStart){
            accelerator=accelerateReverse({centers,geometry,root,maxReverseNodesPerQuery,maxReverseComparisonsPerQuery,cancelled,progress,
                startOffset:gpuStart,cpuSampleMs:gpuStart?performance.now()-cpuSampleStart:null});
            iterator=accelerator.batches;
        }
        if(iterator&&!gpuDone&&(!batch||i>=batch.offset+batch.count)){
            const next=await iterator.next();gpuDone=next.done;batch=next.value??null;
        }
        if(!geometry.valid[i])continue;
        x=xyz[0][i];y=xyz[1][i];z=xyz[2][i];rr=radii[i]*radii[i];
        // Static GPU bounds are stricter than reference budgets, so accepted
        // lists cannot reach either original per-source limit. Each leaf is
        // checked in double precision and its active candidates in CPU order.
        if(batch&&i>=batch.offset&&i<batch.offset+batch.count){
            const p=(i-batch.offset)*batch.stride,len=batch.result[p];
            if(len!==0xffffffff){
                replayedSources++;
                for(let h=0;h<len;h++){
                    const leaf=accelerator.nodes[batch.result[p+2+h]];
                    if(!leaf.remaining||!overlaps(leaf))continue;
                    replayedLeaves++;
                    let rescued=0;
                    for(let p=leaf.start;p<leaf.end;p++){
                        const j=ids[p];if(j===i||!candidateMask[j])continue;
                        stats.reverseComparisons++;
                        if(!covers(i,j)||(minSupport>1&&covers(j,i)))continue;
                        if(++supportCount[j]>=minSupport){candidateMask[j]=0;rescued++;}
                    }
                    if(rescued){stats.reverseSupportedCount+=rescued;for(let p=leaf;p;p=p.reverseParent)p.remaining-=rescued;}
                }
                continue;
            }
        }
        cpuSources++;nodes=0;comparisons=0;limited=false;
        stats.reverseSupportedCount+=visit(root);
        stats.reverseNodeVisits+=nodes;stats.reverseComparisons+=comparisons;
        if(limited)stats.reverseBudgetLimitedSources++;
    }}finally{if(iterator)await iterator.return();}
    if(accelerator)result.reverseAcceleration={...accelerator.diagnostics,replayed_sources:replayedSources,replayed_leaves:replayedLeaves,cpu_sources:cpuSources};
    // If a budget hid possibly supporting neighbors, retain unresolved points
    // as inconclusive. Fully supported points take precedence over uncertainty.
    // This deliberately conservative propagation may retain extra candidates
    // within an affected subtree, but never creates new removal candidates.
    const finalize=[{node:root,uncertain:false}];let finalized=0;
    while(finalize.length){
        if(finalized++%256===0){check();if(performance.now()-lastYield>=16){await tick();lastYield=performance.now();}}
        const {node,uncertain}=finalize.pop();
        if(!node.remaining)continue;
        const pending=uncertain||node.uncertain;
        if(node.left){finalize.push({node:node.left,uncertain:pending},{node:node.right,uncertain:pending});}
        else if(pending)for(let p=node.start;p<node.end;p++){
            const j=ids[p];if(!candidateMask[j])continue;
            candidateMask[j]=0;inconclusiveMask[j]=1;stats.reverseInconclusiveCount++;
        }
    }
    result.supportedCount+=stats.reverseSupportedCount;
    result.inconclusiveCount+=stats.reverseInconclusiveCount;
    result.candidateCount-=stats.reverseSupportedCount+stats.reverseInconclusiveCount;
    progress(n,n,'reverse');check();
    result.timings.reverse_search_ms=Math.round(performance.now()-reverseSearchStart);
    return Object.assign(result,stats);
}

/** Optional full-model CPU-reference diagnostic; not used by normal analysis.
 * Compare actual instance arrays rather than only aggregate candidate counts. */
export async function compareSnsResults(hybrid,reference,{cancelled=()=>false}={}){
    const fields=['candidateMask','inconclusiveMask','supportCount'];
    const differences={},first_candidate_differences=[];let lastYield=performance.now();
    for(const key of fields){
        const a=hybrid[key],b=reference[key];assert(a.length===b.length,'SNS reference array length differs.');let count=0;
        for(let i=0;i<a.length;i++){
            if(i%65536===0){assert(!cancelled(),'SNS analysis cancelled.');if(performance.now()-lastYield>=16){await tick();lastYield=performance.now();}}
            if(a[i]!==b[i]){count++;if(key==='candidateMask'&&first_candidate_differences.length<10)first_candidate_differences.push(i);}
        }
        differences[key]=count;
    }
    const summary_differences={};
    for(const key of ['candidateCount','inconclusiveCount','supportedCount','invalidCount','lockedExcluded','outgoingCandidateCount','reverseSupportedCount','reverseInconclusiveCount','reverseBudgetLimitedSources'])
        if(hybrid[key]!==reference[key])summary_differences[key]={hybrid:hybrid[key],cpu:reference[key]};
    return {match:Object.values(differences).every(v=>v===0)&&!Object.keys(summary_differences).length,differences,summary_differences,first_candidate_differences,hybrid_candidates:hybrid.candidateCount,cpu_candidates:reference.candidateCount};
}
