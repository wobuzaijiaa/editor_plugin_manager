import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSemanticOverlay } from '../semantic-view.js';
import { formatCoordinate } from '../semantic-ui.js';
import { IDENTITY } from '../semantic-core.js';

class FakeElement {
    constructor(tag='canvas') {
        this.tagName = tag;
        this.style = {};
        this.attrs = {};
        this.listeners = new Map();
        this.children = [];
        this.textContent = '';
    }
    setAttribute(k,v) { this.attrs[k] = String(v); }
    getAttribute(k) { return this.attrs[k] ?? null; }
    addEventListener(k,fn,capture=false) {
        if (!this.listeners.has(k)) this.listeners.set(k,[]);
        this.listeners.get(k).push({fn,capture});
    }
    removeEventListener(k,fn,capture=false) {
        this.listeners.set(k,(this.listeners.get(k)||[]).filter(l=>l.fn!==fn||l.capture!==capture));
    }
    getBoundingClientRect() { return { left:0,top:0,width:200,height:100 }; }
    append(node) { this.children.push(node); node.parent=this; }
    get firstChild() { return this.children[0] || null; }
    remove() {
        if (this.parent) this.parent.children.splice(this.parent.children.indexOf(this),1);
    }
    setPointerCapture(id) { this.captured=id; }
    hasPointerCapture(id) { return this.captured===id; }
    releasePointerCapture(id) { if(this.captured===id)this.captured=null; }
    send(type, props={}) {
        const e={ type, button:0, pointerId:7, clientX:150,clientY:25,
            target:this, prevented:false, stopped:false,
            preventDefault(){this.prevented=true;},stopPropagation(){this.stopped=true;},
            stopImmediatePropagation(){this.stopped=true;},...props };
        for (const listener of this.listeners.get(type) || []) listener.fn(e);
        return e;
    }
}

const top=[1,0,0,0,0,0,1,0,0,1,0,0,0,0,0,1];
const frame={view:{data:Float32Array.from(top)},projection:{data:Float32Array.from(IDENTITY)},ortho:true};

test('SEM-14 document capture reaches layered viewport input while preserving top-view navigation and releasing handlers',()=>{
    const priorDocument=globalThis.document, priorRAF=globalThis.requestAnimationFrame, priorCancel=globalThis.cancelAnimationFrame;
    const canvas=new FakeElement();
    const body=new FakeElement('body');
    const doc=new FakeElement('document');
    doc.body=body;doc.createElementNS=(_ns,tag)=>new FakeElement(tag);
    globalThis.document=doc;
    globalThis.requestAnimationFrame=()=>1;
    globalThis.cancelAnimationFrame=()=>{};
    try {
        let mode=null, points=[], moved=[];
        const floor={y_min:0,y_max:2.5,rooms:[]};
        const scene={canvas,camera:{captureFrame:()=>frame}};
        const overlay=createSemanticOverlay(scene,()=>({floor,selectedRoomId:null,
            semanticToWorld:IDENTITY,mode,draft:points}),{
            addPoint:p=>points.push(p),moveVertex:(i,p)=>moved.push([i,p]),error:e=>{throw e;}
        });
        const svg=body.children[0];
        overlay.redraw();
        assert.equal(svg.style.pointerEvents,'none');
        assert.equal(doc.send('pointerdown',{target:canvas,button:0}).stopped,false);
        mode='create';overlay.redraw();
        assert.equal(svg.style.pointerEvents,'none');
        assert.equal(doc.send('pointerdown',{target:canvas,button:2}).stopped,false,'native right-drag pan allowed');
        assert.equal(doc.send('pointermove',{target:canvas,buttons:2}).stopped,false,'right-drag movement reaches Editor');
        assert.equal(doc.send('mousemove',{target:canvas,buttons:2}).stopped,false,'mouse pan fallback reaches Editor');
        assert.equal(doc.send('pointerdown',{target:canvas,button:1,shiftKey:true}).stopped,false,'Shift+middle pan allowed');
        assert.equal(doc.send('pointermove',{target:canvas,buttons:4,shiftKey:true}).stopped,false,'Shift+middle pan motion allowed');
        assert.equal(doc.send('pointerdown',{target:canvas,button:1}).stopped,true,'plain middle orbit blocked');
        assert.equal(doc.send('pointermove',{target:canvas,buttons:4}).stopped,true,'plain middle rotation blocked');
        assert.equal(doc.send('pointerdown',{target:canvas,button:2,ctrlKey:true}).stopped,true,'Ctrl+right orbit blocked');
        assert.equal(doc.send('pointermove',{target:canvas,buttons:2,shiftKey:true}).stopped,true,'Shift+right orbit blocked');
        assert.equal(doc.send('wheel',{target:canvas}).stopped,false,'wheel zoom allowed');
        // Canvas and alternate viewport layers both receive clicks through document capture.
        const hit=doc.send('pointerdown',{target:canvas,button:0});
        assert(hit.prevented&&hit.stopped);assert.deepEqual(points[0],[0.5,0.5]);
        const viewportLayer=new FakeElement('div');
        doc.send('pointerdown',{target:viewportLayer,button:0,clientX:120});
        assert.equal(points.length,2,'viewport UI layer does not prevent point placement');
        const panel=new FakeElement('div');panel.id='custom-xyz-semantic-preview';
        const button=new FakeElement('button');button.parent=panel;
        doc.send('pointerdown',{target:button,button:0});
        assert.equal(points.length,2,'UI controls do not create polygon vertices');
        doc.send('pointerdown',{target:canvas,button:0,clientX:350});
        assert.equal(points.length,2,'outside canvas bounds is ignored');
        assert(doc.send('mousedown',{target:canvas,button:0}).stopped);
        assert(doc.send('click',{target:canvas,button:0}).stopped);
        mode='edit';overlay.redraw();
        assert(doc.send('pointerdown',{target:canvas,button:0,clientX:40,clientY:80}).stopped,
            'edit-mode background left drag must not rotate the fixed top view');
        doc.send('pointerdown',{target:canvas,button:0,clientX:150,clientY:25});
        doc.send('pointermove',{target:canvas,pointerId:7,clientX:160,clientY:25});
        doc.send('pointerup',{target:canvas,pointerId:7});
        assert.equal(moved.length,1,'edit vertex drag is captured independently of SVG hit target');
        mode=null;overlay.redraw();
        assert.equal(doc.send('pointerdown',{target:canvas,button:0}).stopped,false,'normal input restored');
        overlay.dispose();
        assert.equal(body.children.length,0);
        for(const name of ['pointerdown','mousedown','click','pointermove','mousemove','pointerup','pointercancel','contextmenu'])
            assert.equal((doc.listeners.get(name)||[]).length,0,`${name} handler cleaned up`);
    } finally {
        globalThis.document=priorDocument;
        globalThis.requestAnimationFrame=priorRAF;
        globalThis.cancelAnimationFrame=priorCancel;
    }
});

test('SEM-15 coordinate display uses three decimal places; unrounded domain remains independent',()=>{
    assert.equal(formatCoordinate(-2.0216736793),'-2.022');
    assert.equal(formatCoordinate(7.98768186569),'7.988');
    assert.equal(formatCoordinate(6.48627853393),'6.486');
    assert.equal(formatCoordinate(0.001234567),'0.001');
});
