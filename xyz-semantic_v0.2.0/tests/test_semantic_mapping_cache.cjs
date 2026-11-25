const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const source=fs.readFileSync(require('node:path').join(__dirname,'../index.js'),'utf8');
const context=vm.createContext({console,Number,Array,Map,Set,Error,Promise,Float32Array,Float64Array,performance});
vm.runInContext(source.split('// === MANAGED PLUGIN ENTRY ===')[0]+
    '\n;globalThis.api={semanticMappingReader,matMul4};',context);
const {semanticMappingReader,matMul4}=context.api;
const ID=[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1];
const matrix=data=>({data:Float32Array.from(data),clone(){return matrix(this.data);},
    mul2(a,b){this.data.set(matMul4(a.data,b.data));return this;},
    equals(b){return this.data.every((x,i)=>x===b.data[i]);}});
test('SEM-16 semantic camera redraw resolves palette transforms without rescanning per Gaussian',()=>{
    let reads=0,shift=0;
    const splat={instances:{count:100000,transformIndex(){reads++;return 0;}},
        worldTransform:matrix(ID),transformPalette:{getTransform(_,out){const m=[...ID];m[12]=shift;out.data.set(m);}}};
    const live=semanticMappingReader(splat);
    assert.equal(reads,100000,'one scan only during initialization');
    for(let i=0;i<100;i++) assert.equal(live().data[12],0);
    assert.equal(reads,100000,'no per-frame Gaussian scan');
    shift=3;
    assert.equal(live().data[12],3,'live transform still updates without rescanning flags');
});
