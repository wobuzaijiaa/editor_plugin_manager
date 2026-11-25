'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const raw=fs.readFileSync(path.join(__dirname,'../index.js'),'utf8');
const load=()=>import('data:text/javascript;base64,'+Buffer.from(raw).toString('base64'));

class Element {
    constructor(tag){this.tag=tag;this.children=[];this.style={};this.hidden=false;this.removed=false;this.disabled=false;this.textContent='';}
    append(...children){this.children.push(...children);}
    setAttribute(){}
    addEventListener(kind,fn){this[`on${kind}`]=fn;}
    remove(){this.removed=true;}
}

test('XYZ-M04 startup subscribes to scene.elementAdded before render service readiness',async()=>{
    const priorWindow=global.window, priorDocument=global.document;
    try {
        const module=await load();
        const listeners=[];
        const functions=new Map();
        const scene={elements:[],events:{functions,on(name,fn){const handle={name,fn,off(){handle.offCalled=true;}};listeners.push(handle);return handle;}},
            camera:{captureFrame(){}},commandQueue:{async enqueue(fn){return fn();}}};
        global.window={scene};
        global.document={createElement(tag){return new Element(tag);}};
        const host=new Element('host');
        const pending=module.activate({editor:{viewport:{captureFrame(){}}},uiHost:host,plugin:{name:'XYZ'}});
        await new Promise(r=>setTimeout(r,5));
        assert.equal(listeners.length,1,'transform listener must register before rendering services are ready');
        assert.equal(listeners[0].name,'scene.elementAdded');
        functions.set('render.image',()=>{});
        const instance=await pending;
        assert.equal(instance.isRunning(),false,'startup activation does not open plugin UI');
        await instance.open();
        assert.equal(instance.isRunning(),true);
        const panel=host.children[0];
        const close=panel.children[1].children[1].children[0];
        close.onclick();
        assert.equal(panel.style.display,'none','Close hides inline flex panel');
        assert.equal(instance.isRunning(),false);
        await instance.deactivate();
        assert.equal(listeners[0].offCalled,true);
    } finally {
        if(priorWindow===undefined) delete global.window;else global.window=priorWindow;
        if(priorDocument===undefined) delete global.document;else global.document=priorDocument;
    }
});
