import test from 'node:test';
import assert from 'node:assert/strict';
import {__testing} from '../index.js';
const {analysisInvalidReason}=__testing;
const matrix=(values=[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1])=>({
    data:Float32Array.from(values),clone(){return matrix(this.data);},
    equals(other){return this.data.every((v,i)=>v===other.data[i]);},
    mul2(a,b){ // fixture world is identity when checking palette
        this.data.set(b.data);return this;
    }
});
function fixture(){
    const scene={elements:[]},world=matrix(),palette=matrix(),model={scene,instances:{count:4,sourceRow:Uint32Array.of(4,5,6,7),palette:Uint32Array.of(7,7,7,7)},resource:{source:{}},worldTransform:world,
        transformPalette:{getTransform(id,out){out.data.set(palette.data);}}};
    scene.elements.push(model);
    const data={centers:{x:new Float64Array(4)},transformMap:new Map([[7,palette.clone()]])};
    const identity={model,instances:model.instances,source:model.resource.source,world:world.clone(),...__testing.snapshotMapping(model.instances)};
    return {scene,model,data,identity,palette,world,check(details=true){return analysisInvalidReason(scene,this.model,false,this.data,this.identity,details);}};
}
test('Preview validity: unchanged model and numerically identical replacement matrices accepted',()=>{
    const f=fixture(); assert.equal(f.check(),null);f.model.worldTransform=f.world.clone();assert.equal(f.check(),null);
});
for(const [code,change] of Object.entries({
    BASE_DATA_MISSING:f=>{f.data=null;}, ANALYSIS_IDENTITY_MISSING:f=>{f.identity=null;},NO_MODEL:f=>{f.model=null;},
    MODEL_NOT_IN_SCENE:f=>{f.scene.elements=[];}, MODEL_SCENE_CHANGED:f=>{f.model.scene={};},
    INSTANCES_MISSING:f=>{f.model.instances=null;},SOURCE_MISSING:f=>{f.model.resource.source=null;},
    MODEL_CHANGED:f=>{f.model={...f.model};f.scene.elements=[f.model];},
    INSTANCES_CHANGED:f=>{f.model.instances={count:4};},SOURCE_CHANGED:f=>{f.model.resource.source={};},
    COUNT_CHANGED:f=>{f.model.instances.count=3;},WORLD_CHANGED:f=>{f.world.data[12]=1e-7;},
    MAPPING_CHANGED:f=>{f.model.instances.sourceRow[0]=5;},
    PALETTE_CHANGED:f=>{f.palette.data[13]=2;}
}))test('Preview validity: '+code,()=>{
    const f=fixture();change(f);assert.equal(f.check().code,code);assert.equal(f.check(false).code,code);
});
test('Preview validity: no tolerance or new array snapshots on normal checks; detailed matrix differences captured only on failure',()=>{
    const f=fixture();f.world.data[12]=1e-7;const issue=f.check();
    assert.equal(issue.code,'WORLD_CHANGED');assert.equal(issue.saved[12],0);assert.equal(issue.current[12],f.world.data[12]);
    assert.equal(issue.maxAbsoluteDifference,f.world.data[12]);assert.equal(f.check(false).saved,undefined);
    f.world.data[12]=0;f.palette.data[13]=2;const p=f.check();assert.equal(p.paletteId,7);assert.equal(p.maxAbsoluteDifference,2);
    const c=fixture();c.model.instances.count=2;assert.deepEqual([c.check().savedCount,c.check().currentCount],[4,2]);
    assert.equal(analysisInvalidReason(c.scene,c.model,true,c.data,c.identity).code,'PLUGIN_STOPPED');
});

test("Same-count palette remapping invalidates cached geometry",()=>{const f=fixture();f.model.instances.palette[0]=8;assert.equal(f.check().code,"MAPPING_CHANGED");});

test('UI readiness avoids dense mapping scans; indexed operation rejects same-count remapping',()=>{
    const f=fixture();const check=(full)=>analysisInvalidReason(f.scene,f.model,false,f.data,f.identity,false,full);
    f.model.instances.sourceRow[0]=5;assert.equal(check(false),null);assert.equal(check(true).code,'MAPPING_CHANGED');
    f.model.instances.sourceRow[0]=4;let reads=0;const original=f.model.instances.sourceRow;
    f.model.instances.sourceRow=new Proxy(original,{get(target,key){if(key==='length')return target.length;if(/^\d+$/.test(String(key)))reads++;return target[key];}});
    assert.equal(check(false),null);assert.equal(reads,0);assert.equal(check(true),null);assert.equal(reads,4);
    f.world.data[12]=1;assert.equal(check(false).code,'WORLD_CHANGED');
});
