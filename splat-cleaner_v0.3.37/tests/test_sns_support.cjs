const {test}=require('node:test');
const assert=require('node:assert/strict');
const {pathToFileURL}=require('node:url');
const path=require('node:path');
const api=import(pathToFileURL(path.join(__dirname,'..','sns-support.mjs')).href);
const I=[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1];
const pts=values=>Object.fromEntries(['x','y','z'].map((name,a)=>[name,Float64Array.from(values.map(v=>v[a]))]));
function buildGeometry(points,scales,quat=[1,0,0,0],A=I,locked=[]) {
    return api.then(({gaussianMetric})=>{
        const n=points.length;
        const inverse=new Float32Array(n*9),radii=new Float64Array(n),valid=new Uint8Array(n).fill(1),flags=new Uint8Array(n);
        for(let i=0;i<n;i++){
            const metric=gaussianMetric(quat,scales[i].map(Math.log),A);
            if(!metric){valid[i]=0;continue;}
            for(let j=0;j<9;j++)inverse[9*i+j]=metric.inverse[j];
            radii[i]=metric.radius;
            if(locked.includes(i))flags[i]=1;
        }
        return {inverse,radii,valid,locked:flags};
    });
}
test('SNS-01 standard k=2,m=1 isolates center with no neighbors; coincident centers support each other',async()=>{
    const {analyzeSnsSupport}=await api;
    const values=[[0,0,0],[0.5,0,0],[10,0,0],[10,0,0],[30,0,0]];
    const geometry=await buildGeometry(values,values.map(()=>[1,1,1]));
    const a=await analyzeSnsSupport(pts(values),geometry,{cellWidth:1});
    assert.deepEqual([...a.candidateMask],[0,0,0,0,1]);
    assert.equal(a.supportedCount,4);
    assert.equal(a.inconclusiveCount,0);
});
test('SNS-02 quaternion wxyz orientation rotates anisotropic neighborhood',async()=>{
    const {analyzeSnsSupport,insideSnsEllipsoid}=await api;
    const values=[[0,0,0],[0,1,0],[1,0,0],[15,0,0]];
    const q=[Math.SQRT1_2,0,0,Math.SQRT1_2];
    const g=await buildGeometry(values,[[1.5,.15,.15],...[1,2,3].map(()=>[.12,.12,.12])],q);
    assert.equal(insideSnsEllipsoid(pts(values),0,1,g),true);
    assert.equal(insideSnsEllipsoid(pts(values),0,2,g),false);
    const r=await analyzeSnsSupport(pts(values),g,{cellWidth:.5});
    assert.equal(r.supportCount[0],1);
    assert.equal(r.candidateMask[2],1);
    assert.equal(r.candidateMask[3],1);
});
test('SNS-03 common invertible nonuniform/shear transform preserves normalized membership',async()=>{
    const {analyzeSnsSupport,insideSnsEllipsoid}=await api;
    const A=[2,0,0,0, .3,1,0,0, 0,0,3,0, 11,5,-7,1];
    const points=[[0,0,0],[.5,0,0],[0,1.5,0],[0,0,2],[20,0,0]];
    const world=points.map(p=>[A[0]*p[0]+A[4]*p[1]+A[8]*p[2]+A[12],
        A[1]*p[0]+A[5]*p[1]+A[9]*p[2]+A[13],
        A[2]*p[0]+A[6]*p[1]+A[10]*p[2]+A[14]]);
    const scales=points.map(()=>[1,1,.5]);
    const localGeom=await buildGeometry(points,scales);
    const worldGeom=await buildGeometry(points,scales,[1,0,0,0],A);
    const cLocal=pts(points),cWorld=pts(world);
    for(let i=0;i<points.length;i++)for(let j=0;j<points.length;j++)
        assert.equal(insideSnsEllipsoid(cLocal,i,j,localGeom),insideSnsEllipsoid(cWorld,i,j,worldGeom));
    const l=await analyzeSnsSupport(cLocal,localGeom,{cellWidth:1});
    const w=await analyzeSnsSupport(cWorld,worldGeom,{cellWidth:.7});
    assert.deepEqual([...l.candidateMask],[...w.candidateMask]);
});
test('SNS-04 index cell width changes cost, not complete candidate classification',async()=>{
    const {analyzeSnsSupport}=await api;
    const values=[[0,0,0],[1,0,0],[4,0,0],[10,0,0],[10.1,0,0],[50,0,0]];
    const geometry=await buildGeometry(values,values.map(()=>[1,1,1]));
    const a=await analyzeSnsSupport(pts(values),geometry,{cellWidth:.5});
    const b=await analyzeSnsSupport(pts(values),geometry,{cellWidth:5});
    assert.deepEqual([...a.candidateMask],[...b.candidateMask]);
});
test('SNS-05 insufficient cell search budget is inconclusive and never removes geometry',async()=>{
    const {analyzeSnsSupport}=await api;
    const values=[[0,0,0],[50,50,50]];
    const geometry=await buildGeometry(values,values.map(()=>[1,1,1]));
    const a=await analyzeSnsSupport(pts(values),geometry,{cellWidth:.1,maxCellsPerQuery:5});
    assert.deepEqual([...a.candidateMask],[0,0]);
    assert.deepEqual([...a.inconclusiveMask],[1,1]);
});
test('SNS-06 zero scale, invalid quaternion, and singular transform are rejected',async()=>{
    const {gaussianMetric}=await api;
    assert.equal(gaussianMetric([1,0,0,0],[0,-Infinity,0],I),null);
    assert.equal(gaussianMetric([0,0,0,0],[0,0,0],I),null);
    const singular=[1,0,0,0,0,0,0,0,0,0,1,0,0,0,0,1];
    assert.equal(gaussianMetric([1,0,0,0],[0,0,0],singular),null);
    assert.ok(gaussianMetric([1,0,0,0],[0,0,0],I));
});
test('SNS-07 original locked Gaussian still supports others but is protected as candidate',async()=>{
    const {analyzeSnsSupport}=await api;
    const values=[[0,0,0],[100,0,0],[100.1,0,0]];
    const geometry=await buildGeometry(values,values.map(()=>[1,1,1]),[1,0,0,0],I,[0]);
    const result=await analyzeSnsSupport(pts(values),geometry,{cellWidth:2});
    assert.equal(result.candidateMask[0],0);
    assert.equal(result.lockedExcluded,1);
    assert.equal(result.supportedCount,2);
});
test('SNS-08 invalid Gaussian is not a neighbor and is always inconclusive',async()=>{
    const {analyzeSnsSupport}=await api;
    const values=[[0,0,0],[1,0,0]];
    const geometry=await buildGeometry(values,[[1,1,1],[1,1,1]]);
    geometry.valid[1]=0;
    const result=await analyzeSnsSupport(pts(values),geometry,{cellWidth:1});
    assert.deepEqual([...result.candidateMask],[1,0]);
    assert.equal(result.inconclusiveCount,1);
});
test('SNS-09 source reader uses instance source-row IDs and wxyz quaternion with no opacity dependency',async()=>{
    const {readSnsGeometry,analyzeSnsSupport}=await api;
    const sourceRow=Uint32Array.from([1,0,2]);
    const fields={rotation:{type:'float32',components:4},scale:{type:'float32',components:3}};
    const sourcePool={acquire(){return {_values:{},data:new ArrayBuffer(96),field(name){return this._values[name]},release(){}};}};
    const source={meta:{chunkSize:2,layouts:{position:{},geometric:{fields}}},async read(req){
        req.geometric._values.rotation=Float32Array.from(Array.from({length:req.count},()=>[1,0,0,0]).flat());
        const scales=[.3,1,.2];
        req.geometric._values.scale=Float32Array.from(Array.from({length:req.count},(_,j)=>Array(3).fill(Math.log(scales[req.indices[req.indexOffset+j]]))).flat());
    }};
    const instances={count:3,sourceRow,flags:Uint8Array.from([0,0,2]),transformIndex(){return 0;}};
    const splat={resource:{source,sourcePool},instances};
    const data={centers:pts([[0,0,0],[1,0,0],[20,0,0]]),transformMap:new Map([[0,{data:Float32Array.from(I)}]])};
    const geom=await readSnsGeometry(splat,data);
    assert.equal(geom.valid.reduce((a,b)=>a+b,0),3);
    assert.equal(geom.locked[2],1);
    assert.ok(Math.abs(geom.radii[0]-3)<1e-5, 'Instance 0 uses scale from source row 1');
    assert.ok(Math.abs(geom.radii[1]-.9)<1e-5, 'Instance 1 uses scale from source row 0');
    const out=await analyzeSnsSupport(data.centers,geom,{cellWidth:2});
    assert.deepEqual([...out.candidateMask],[0,1,0]);
});
