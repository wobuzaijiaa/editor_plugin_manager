import { test } from 'node:test';
import assert from 'node:assert/strict';
import { attachSemanticUI, cameraVec3 } from '../semantic-ui.js';
import { IDENTITY, addRoom } from '../semantic-core.js';

class Element {
    constructor(tag='div') { this.tagName=tag;this.style={};this.dataset={};this.attrs={};this.children=[];
        this.textContent='';this.value='';this.checked=false;this.disabled=false;this.listeners=new Map(); }
    append(...items) {for(const item of items){this.children.push(item);item.parent=this;}}
    prepend(...items){for(const item of [...items].reverse()){this.children.unshift(item);item.parent=this;}}
    replaceChildren(...items){this.children=[];this.append(...items);}
    setAttribute(k,v){this.attrs[k]=String(v);}
    getAttribute(k){return this.attrs[k]??null;}
    addEventListener(k,fn){if(!this.listeners.has(k))this.listeners.set(k,[]);this.listeners.get(k).push(fn);}
    removeEventListener(k,fn){this.listeners.set(k,(this.listeners.get(k)||[]).filter(f=>f!==fn));}
    getBoundingClientRect(){return {left:0,top:0,width:300,height:240};}
    get firstChild(){return this.children[0]??null;}
    remove(){if(this.parent){const i=this.parent.children.indexOf(this);if(i>=0)this.parent.children.splice(i,1);}}
    dispatch(type,details={}){const event={button:0,buttons:0,clientX:30,clientY:30,pointerId:1,target:this,
        preventDefault(){this.prevented=true;},stopImmediatePropagation(){this.stopped=true;},...details};
        for(const cb of this.listeners.get(type)||[])cb(event);return event;}
}
const walk=root=>[root,...root.children.flatMap(walk)];
const button=(root,name)=>{const b=walk(root).find(e=>e.tagName==='button'&&e.textContent===name);
    assert(b,`Missing ${name}`);return b;};
const control=(root,name)=>{const c=walk(root).find(e=>e.attrs['aria-label']===name);
    assert(c,`Missing ${name}`);return c;};
const cameraMatrix=[1,0,0,0,0,0,1,0,0,1,0,0,0,0,0,1];
class Vec3 {
    constructor(x=0,y=0,z=0){this.x=x;this.y=y;this.z=z;}
    clone(){return new Vec3(this.x,this.y,this.z);}
    set(x,y,z){this.x=x;this.y=y;this.z=z;return this;}
    equals(other){return this.x===other.x&&this.y===other.y&&this.z===other.z;}
}
const frame={ortho:true,position:new Vec3(5,20,5),view:{data:Float32Array.from(cameraMatrix)},projection:{data:Float32Array.from(IDENTITY)}};
const setup = async (top=true,setCamera=async()=>{})=>{
    const prior={document:globalThis.document,window:globalThis.window,
        requestAnimationFrame:globalThis.requestAnimationFrame,cancelAnimationFrame:globalThis.cancelAnimationFrame};
    const body=new Element('body'),fakeDoc=new Element('document');fakeDoc.body=body;
    fakeDoc.createElement=tag=>new Element(tag);fakeDoc.createElementNS=(_ns,tag)=>new Element(tag);
    const savedDocuments=[];let failWrites=false;
    const handle={name:'semantic_Building.json',createWritable:async()=>({
        write:async data=>{if(failWrites)throw Error('simulated permission failure');savedDocuments.push(JSON.parse(data));},
        close:async()=>{},abort:async()=>{}
    })};
    globalThis.document=fakeDoc;globalThis.window={confirm:()=>true,
        showSaveFilePicker: async ()=>handle};
    globalThis.requestAnimationFrame=()=>1;globalThis.cancelAnimationFrame=()=>{};
    const canvas=new Element('canvas');
    let currentTop=top;
    const pose=()=>({position:{x:5,y:currentTop?20:6,z:5},
        target:{x:5,y:currentTop?0:6,z:5}});
    const scene={canvas,events:{invoke:key=>key==='camera.getPose'?pose():null},
        camera:{ortho:top,captureFrame:()=>frame}};
    let ranges={x:{min:0,max:10},y:{min:0,max:5},z:{min:0,max:10}};
    const preview={full:structuredClone(ranges),
        get worldCenters(){throw Error('Unexpected O(N) Gaussian-center scan');},
        getRanges:()=>structuredClone(ranges),enabled:()=>true,busy:()=>false,
        onRangesChanged:()=>()=>{},setRanges:async next=>{ranges=structuredClone(next);}};
    const holder=new Element('holder');
    const exportFormatRow=new Element('div');
    const exportFormatSelect=new Element('select');exportFormatSelect.value='ply';
    exportFormatSelect.setAttribute('aria-label','Filtered model format');
    exportFormatRow.append(exportFormatSelect);
    const ui=attachSemanticUI({scene,editor:{viewport:{setCamera:async settings=>{
        await setCamera(settings);
        if(settings.view==='top'){currentTop=true;scene.camera.ortho=true;}
    },info:()=>({viewToken:'stable'})}},
        target:{name:'Building'},preview,holder,exportFormatRow,modelToWorld:()=>IDENTITY});
    control(holder,'Permanent model ID').value='building-one';
    await button(holder,'Bind Current Model').onclick();
    button(holder,'New Floor').onclick();
    button(holder,'Create Floor').onclick();
    const roomName=walk(holder).find(e=>e.tagName==='input'&&e.placeholder==='Room / area name');
    assert(roomName);roomName.value='Living Room';
    return {holder,ui,scene,doc:fakeDoc,body,savedDocuments,exportFormatRow,exportFormatSelect,
        previewRanges:()=>structuredClone(ranges),fullBounds:structuredClone(preview.full),
        setWriteFailure:v=>{failWrites=v;},restore(){Object.assign(globalThis,prior);}};
};

test('SEM-20 drawing immediately activates in existing top-orthographic view without awaiting camera API or scanning millions of splats',async()=>{
    let calls=0;
    const env=await setup(true,()=>{calls++;return new Promise(()=>{});});
    try {
        const draw=button(env.holder,'Draw Room'),finish=button(env.holder,'Finish / Apply Polygon');
        draw.onclick();
        assert.equal(calls,0,'existing valid top view must not be reset');
        assert.equal(draw.disabled,true,'immediate transition into drawing mode');
        assert.equal(finish.disabled,false,'apply enabled in active drawing mode');
        const canvas=env.scene.canvas;
        for(const [x,y] of [[40,40],[200,40],[200,170],[40,170]]) {
            const evt=env.doc.dispatch('pointerdown',{target:canvas,clientX:x,clientY:y});
            assert(evt.stopped, 'left-click is owned by the polygon editor');
        }
        assert(walk(env.holder).some(e=>String(e.textContent).includes('4 vertices')),
            'vertex count is visible next to room controls');
        finish.onclick();
        const hierarchy=control(env.holder,'Building floor room hierarchy');
        assert(walk(hierarchy).some(e=>e.textContent.includes('Living Room')),'closed room saved');
        assert.equal(draw.disabled,false,'drawing mode exited');
        await env.ui.dispose();
    } finally {env.restore();}
});

test('SEM-21 non-top entry reports preparing state immediately; rejected Editor camera command restores controls',async()=>{
    let calls=0;
    const env=await setup(false,async()=>{if(++calls===1)throw new Error('camera busy');});
    try {
        const draw=button(env.holder,'Draw Room'),cancel=button(env.holder,'Cancel Draft');
        draw.onclick();
        assert(draw.disabled,'drawing transition must not remain inert before asynchronous camera call');
        assert.equal(cancel.disabled,false,'cancel remains available during camera preparation');
        await new Promise(resolve=>setImmediate(resolve));
        assert.equal(draw.disabled,false,'controls reenabled after failed camera command');
        assert(walk(env.holder).some(e=>String(e.textContent).includes('camera busy')),
            'failure is shown adjacent to room authoring controls');
        await env.ui.dispose();
    } finally {env.restore();}
});

test('SEM-22 tilt during drawing is rejected and floor-plane Y remains fixed',async()=>{
    const env=await setup(true);
    try {
        button(env.holder,'Draw Room').onclick();
        const canvas=env.scene.canvas;
        env.scene.camera.ortho=false;
        env.doc.dispatch('pointerdown',{target:canvas,clientX:50,clientY:50});
        assert(walk(env.holder).some(e=>String(e.textContent).includes('requires fixed orthographic Top View')),
            'invalid camera is reported locally, not converted into a 3D polygon vertex');
        env.scene.camera.ortho=true;
        env.doc.dispatch('pointerdown',{target:canvas,clientX:50,clientY:50});
        assert(walk(env.holder).some(e=>String(e.textContent).includes('1 vertex')),
            'vertex creation resumes in fixed orthographic top view');
        await env.ui.dispose();
    } finally {env.restore();}
});

// Genuine API-contract regression: v3.9.2 camera.getPose returns plain records,
// while viewport.setCamera internally calls .clone() and .equals() on Vec3.
test('SEM-23 plain camera.getPose records become real Vec3 before setCamera',()=>{
    const camera={captureFrame:()=>({position:new Vec3(0,1,0)})};
    const vector=cameraVec3({camera},{x:1,y:2,z:3});
    assert(vector instanceof Vec3);
    assert.deepEqual([vector.x,vector.y,vector.z],[1,2,3]);
    assert(vector.clone().equals(vector));
});

test('SEM-24 non-top Draw Room navigates using cloned PlayCanvas Vec3 records and enters drawing',async()=>{
    let commands=[];
    const env=await setup(false,async settings=>{
        if (settings.position) {
            assert(settings.position instanceof Vec3);
            assert(settings.target instanceof Vec3);
            assert(settings.position.clone().equals(settings.position));
        }
        commands.push(settings);
    });
    try {
        const draw=button(env.holder,'Draw Room');
        draw.onclick();
        await new Promise(resolve=>setImmediate(resolve));
        assert.equal(commands.length,1,'one camera command preserves current zoom and target');
        assert.deepEqual(commands[0],{view:'top',orthographic:true});
        assert(draw.disabled,'drawing started successfully');
        const evt=env.doc.dispatch('pointerdown',{target:env.scene.canvas,clientX:90,clientY:70});
        assert(evt.stopped,'left-click creates point after navigation');
        assert(walk(env.holder).some(e=>String(e.textContent).includes('1 vertex')));
        await env.ui.dispose();
    } finally {env.restore();}
});

test('SEM-25 nonconvex or unordered draft offers explicit hull confirmation, saves room, then permits next room',async()=>{
    let confirmations=0;
    const env=await setup(true);
    globalThis.window.confirm=()=>{confirmations++;return true;};
    try {
        const draw=button(env.holder,'Draw Room'),finish=button(env.holder,'Finish / Apply Polygon');
        draw.onclick();
        const canvas=env.scene.canvas;
        // Deliberately out of order, with interior points.
        for(const [x,y] of [[30,30],[250,180],[250,30],[30,180],[140,100],[90,100],[170,140]])
            env.doc.dispatch('pointerdown',{target:canvas,clientX:x,clientY:y});
        finish.onclick();
        assert.equal(confirmations,1,'user explicitly approves convex-hull correction');
        const hierarchy=control(env.holder,'Building floor room hierarchy');
        assert(walk(hierarchy).some(e=>e.textContent.includes('Living Room')),'first room saved');
        assert.equal(draw.disabled,false,'new room can be created immediately');
        assert.equal(button(env.holder,'Edit Vertices').disabled,false,'saved room can be edited');
        assert.equal(button(env.holder,'Remove Room').disabled,false,'saved room can be removed');
        const label=walk(env.holder).find(e=>e.tagName==='input'&&e.placeholder==='Room / area name');
        label.value='Kitchen';
        draw.onclick();
        assert.equal(button(env.holder,'Cancel Draft').disabled,false,'second draw is active');
        for(const [x,y] of [[60,30],[160,30],[160,80],[60,80]])
            env.doc.dispatch('pointerdown',{target:canvas,clientX:x,clientY:y});
        finish.onclick();
        assert(walk(hierarchy).some(e=>e.textContent.includes('Living Room')));
        assert(walk(hierarchy).some(e=>e.textContent.includes('Kitchen')),'second room saved');
        await env.ui.dispose();
    } finally {env.restore();}
});

test('SEM-26 declining hull conversion preserves draft, Undo and Cancel recover cleanly',async()=>{
    const env=await setup(true); globalThis.window.confirm=()=>false;
    try {
        const draw=button(env.holder,'Draw Room'),finish=button(env.holder,'Finish / Apply Polygon');
        draw.onclick();
        const canvas=env.scene.canvas;
        for(const [x,y] of [[30,30],[200,160],[200,30],[30,160]])
            env.doc.dispatch('pointerdown',{target:canvas,clientX:x,clientY:y});
        finish.onclick();
        assert.equal(draw.disabled,true,'draft still active after rejected hull suggestion');
        assert.equal(button(env.holder,'Cancel Draft').disabled,false);
        button(env.holder,'Undo Vertex').onclick();
        button(env.holder,'Cancel Draft').onclick();
        assert.equal(draw.disabled,false,'cancel restores drawing action');
        await env.ui.dispose();
    } finally {env.restore();}
});

test('SEM-27 complete room CRUD: create, edit, rename, remove and return to floor authoring',async()=>{
    const env=await setup(true);
    try {
        const draw=button(env.holder,'Draw Room'),finish=button(env.holder,'Finish / Apply Polygon');
        draw.onclick();
        for(const [x,y] of [[40,40],[200,40],[200,170],[40,170]])
            env.doc.dispatch('pointerdown',{target:env.scene.canvas,clientX:x,clientY:y});
        finish.onclick();
        const hierarchy=control(env.holder,'Building floor room hierarchy');
        assert(walk(hierarchy).some(e=>e.textContent.includes('Living Room')));
        button(env.holder,'Edit Vertices').onclick();
        assert.equal(draw.disabled,true,'editing is exclusive');
        assert.equal(button(env.holder,'Remove Floor').disabled,true,'floor cannot be removed mid-edit');
        assert.equal(button(env.holder,'Save / Retry').disabled,true,'draft must be committed before persistence');
        finish.onclick();
        assert.equal(draw.disabled,false);
        const roomName=walk(env.holder).find(e=>e.tagName==='input'&&e.placeholder==='Room / area name');
        roomName.value='Living Lounge';
        button(env.holder,'Rename Room').onclick();
        assert(walk(hierarchy).some(e=>e.textContent.includes('Living Lounge')));
        button(env.holder,'Remove Room').onclick();
        assert(!walk(hierarchy).some(e=>e.textContent.includes('Living Lounge')));
        assert.equal(draw.disabled,false,'after deleting room, floor remains available for drawing');
        await env.ui.dispose();
    } finally {env.restore();}
});

test('SEM-28 cancelled asynchronous top-view transition cannot re-enter polygon mode later',async()=>{
    let release;
    const blocked=new Promise(resolve=>release=resolve);
    const env=await setup(false,async()=>{await blocked;});
    try {
        const draw=button(env.holder,'Draw Room');draw.onclick();
        assert(draw.disabled);
        button(env.holder,'Cancel Draft').onclick();
        assert.equal(draw.disabled,false);
        release();
        await new Promise(resolve=>setImmediate(resolve));
        await new Promise(resolve=>setImmediate(resolve));
        assert.equal(draw.disabled,false);
        assert.equal(button(env.holder,'Finish / Apply Polygon').disabled,true);
        await env.ui.dispose();
    } finally {env.restore();}
});

test('SEM-29 invalid draft with too few vertices reports locally, then Cancel restores room actions',async()=>{
    const env=await setup(true);
    try {
        const draw=button(env.holder,'Draw Room');draw.onclick();
        env.doc.dispatch('pointerdown',{target:env.scene.canvas,clientX:40,clientY:40});
        button(env.holder,'Finish / Apply Polygon').onclick();
        assert(walk(env.holder).some(e=>String(e.textContent).includes('A room needs 3')));
        assert.equal(draw.disabled,true,'retain draft on validation error');
        button(env.holder,'Cancel Draft').onclick();
        assert.equal(draw.disabled,false);
        await env.ui.dispose();
    } finally {env.restore();}
});

test('SEM-31 semantic hierarchy is a collapsible Building > Floor > Room tree with ID-stable selection',async()=>{
    let cameraCommands=0;
    const env=await setup(true,async()=>{cameraCommands++;});
    try {
        const tree=control(env.holder,'Building floor room hierarchy');
        assert.equal(tree.attrs.role,'tree');
        assert(walk(tree).some(e=>e.textContent==='Building: Building' && e.attrs.role==='treeitem'));
        assert(walk(tree).some(e=>e.textContent==='Floor: Floor 1' && e.attrs.role==='treeitem'));
        button(env.holder,'Draw Room').onclick();
        for(const [x,y] of [[40,40],[200,40],[200,170],[40,170]])
            env.doc.dispatch('pointerdown',{target:env.scene.canvas,clientX:x,clientY:y});
        button(env.holder,'Finish / Apply Polygon').onclick();
        const room=()=>walk(tree).find(e=>e.textContent==='Room/Area: Living Room'&&e.attrs.role==='treeitem');
        assert(room(),'new room is nested in the tree');
        assert.equal(room().attrs['aria-selected'],'true','saved room selected');
        const collapseFloor=walk(tree).find(e=>e.attrs['aria-label']==='Collapse Floor: Floor 1');
        assert(collapseFloor,'floor exposes collapse control');collapseFloor.onclick();
        assert(!room(),'collapsed floor hides its room children');
        const expandFloor=walk(tree).find(e=>e.attrs['aria-label']==='Expand Floor: Floor 1');
        assert(expandFloor,'collapsed floor exposes expand control');expandFloor.onclick();
        assert(room(),'expanding restores room entry');
        const floorButton=walk(tree).find(e=>e.textContent==='Floor: Floor 1'&&e.attrs.role==='treeitem');
        floorButton.onclick();await new Promise(resolve=>setImmediate(resolve));
        assert.equal(walk(tree).find(e=>e.textContent==='Floor: Floor 1').attrs['aria-selected'],'true');
        room().onclick();await new Promise(resolve=>setImmediate(resolve));
        assert.equal(room().attrs['aria-selected'],'true');
        assert.equal(cameraCommands,0,'floor/room selection in existing top view preserves live camera zoom');
        await env.ui.dispose();
    } finally {env.restore();}
});

test('SEM-32 Draw Room from oblique building view changes only projection/orientation, never reframes zoom',async()=>{
    const calls=[];
    const env=await setup(false,async settings=>calls.push(settings));
    try {
        button(env.holder,'Draw Room').onclick();
        await new Promise(resolve=>setImmediate(resolve));
        assert.equal(calls.length,1);
        assert.deepEqual(calls[0],{view:'top',orthographic:true});
        assert.equal(Object.hasOwn(calls[0],'distance'),false);
        assert.equal(Object.hasOwn(calls[0],'position'),false);
        assert.equal(Object.hasOwn(calls[0],'target'),false);
        assert.equal(button(env.holder,'Finish / Apply Polygon').disabled,false);
        await env.ui.dispose();
    } finally {env.restore();}
});

test('SEM-33 selecting a floor from an oblique building view preserves camera framing in orthographic top',async()=>{
    const calls=[];
    const env=await setup(false,async settings=>calls.push(settings));
    try {
        const tree=control(env.holder,'Building floor room hierarchy');
        const floor=walk(tree).find(e=>e.textContent==='Floor: Floor 1' && e.attrs.role==='treeitem');
        assert(floor);
        floor.onclick();
        await new Promise(resolve=>setImmediate(resolve));
        assert.deepEqual(calls,[{view:'top',orthographic:true}],
            'hierarchy selection changes projection/orientation, not user zoom/position/distance');
        assert.equal(floor.attrs['aria-selected'],'true');
        await env.ui.dispose();
    } finally {env.restore();}
});

test('SEM-46 Bind creates semantic file and floor/room mutations auto-save a single workspace',async()=>{
    const env=await setup(true);
    try {
        assert.equal(env.savedDocuments.length,1,'Bind writes initial document');
        assert.equal(env.savedDocuments[0].model.model_id,'building-one');
        await new Promise(resolve=>setImmediate(resolve));
        assert(env.savedDocuments.some(doc=>doc.floors.length===1),'Create Floor auto-saves');
        button(env.holder,'Draw Room').onclick();
        for(const [x,y] of [[40,40],[200,40],[200,170],[40,170]])
            env.doc.dispatch('pointerdown',{target:env.scene.canvas,clientX:x,clientY:y});
        button(env.holder,'Finish / Apply Polygon').onclick();
        await new Promise(resolve=>setImmediate(resolve));
        await new Promise(resolve=>setImmediate(resolve));
        assert.equal(env.savedDocuments.at(-1).floors[0].rooms.length,1,'completed room persisted');
        const roomTree=control(env.holder,'Building floor room hierarchy');
        assert(walk(roomTree).some(e=>e.textContent.includes('Living Room')));
        button(env.holder,'Remove Room').onclick();
        await new Promise(resolve=>setImmediate(resolve));
        await new Promise(resolve=>setImmediate(resolve));
        assert.equal(env.savedDocuments.at(-1).floors[0].rooms.length,0,'remove persisted automatically');
        assert(env.savedDocuments.at(-1).document_id,'persistent document identity');
        assert(!env.ui.dirty(),'completed auto-save clears dirty state');
        await env.ui.dispose();
    } finally {env.restore();}
});

test('SEM-47 Import semantic JSON opens hierarchy without retyping model ID and retains writable handle',async()=>{
    const env=await setup(true);
    try {
        await new Promise(resolve=>setImmediate(resolve));
        const source=env.savedDocuments.at(-1);
        const imported={name:'semantic_Office.json',getFile:async()=>({
            size:JSON.stringify(source).length,text:async()=>JSON.stringify(source)
        }),createWritable:async()=>({write:async()=>{},close:async()=>{},abort:async()=>{}})};
        globalThis.window.showOpenFilePicker=async()=>[imported];
        control(env.holder,'Permanent model ID').value='';
        await button(env.holder,'Import semantic.json').onclick();
        assert.equal(control(env.holder,'Permanent model ID').value,'building-one');
        assert(walk(env.holder).some(e=>String(e.textContent).includes('Imported semantic_Office.json')));
        assert.equal(env.ui.dirty(),false);
        await env.ui.dispose();
    } finally {env.restore();}
});

test('SEM-48 failed automatic save remains unsaved and Save / Retry recovers latest state',async()=>{
    const env=await setup(true);
    try {
        await new Promise(resolve=>setImmediate(resolve));
        env.setWriteFailure(true);
        button(env.holder,'Update Floor').onclick();
        await new Promise(resolve=>setImmediate(resolve));
        await new Promise(resolve=>setImmediate(resolve));
        assert(env.ui.dirty(),'failed save must leave dirty state');
        assert(walk(env.holder).some(e=>String(e.textContent).includes('SAVE FAILED')));
        env.setWriteFailure(false);
        await button(env.holder,'Save / Retry').onclick();
        await new Promise(resolve=>setImmediate(resolve));
        assert.equal(env.ui.dirty(),false);
        assert(walk(env.holder).some(e=>String(e.textContent).includes('Auto-saved')));
        await env.ui.dispose();
    } finally {env.restore();}
});

test('SEM-49 binding refuses to overwrite a nonempty imported semantic file',async()=>{
    const env=await setup(true);
    try {
        await new Promise(resolve=>setImmediate(resolve));
        const count=env.savedDocuments.length;
        globalThis.window.showSaveFilePicker=async()=>({name:'semantic_Building.json',getFile:async()=>({size:10}),
            createWritable:async()=>{throw Error('should not write');}});
        await button(env.holder,'Bind Current Model').onclick();
        assert.equal(env.savedDocuments.length,count);
        assert(walk(env.holder).some(e=>String(e.textContent).includes('already contains data')));
        const hierarchy=control(env.holder,'Building floor room hierarchy');
        assert(walk(hierarchy).some(e=>e.textContent.includes('Floor: Floor 1')));
        await env.ui.dispose();
    } finally {env.restore();}
});


test('SEM-61 semantic isolation tracks room, floor and building hierarchy selection and restores manual XYZ bounds',async()=>{
    const env=await setup(true);
    try {
        // Existing floor definition is selected. Build a saved room first.
        const draw=button(env.holder,'Draw Room');draw.onclick();
        for(const [x,y] of [[40,40],[200,40],[200,170],[40,170]])
            env.doc.dispatch('pointerdown',{target:env.scene.canvas,clientX:x,clientY:y});
        button(env.holder,'Finish / Apply Polygon').onclick();
        const hierarchy=control(env.holder,'Building floor room hierarchy');
        const isolation=walk(env.holder).find(e=>e.tagName==='input'&&e.type==='checkbox'&&
            e.parent?.textContent.includes('Isolate selected Building'));
        assert(isolation && !isolation.disabled);
        const manual=env.previewRanges();
        isolation.checked=true; isolation.onchange();await new Promise(r=>setImmediate(r));
        const room=env.previewRanges();
        assert(room.x.max-room.x.min < manual.x.max-manual.x.min,
            'room isolation uses polygon-derived X bounds');
        assert(room.z.max-room.z.min < manual.z.max-manual.z.min,
            'room isolation uses polygon-derived Z bounds');
        button(hierarchy,'Floor: Floor 1').onclick();await new Promise(r=>setImmediate(r));
        const floor=env.previewRanges();
        assert.deepEqual(floor.x,manual.x,'floor selection restores the full X extent');
        assert.deepEqual(floor.z,manual.z,'floor selection restores the full Z extent');
        assert(floor.y.max < manual.y.max,'floor isolation limits Y to ceiling-free floor range');
        button(hierarchy,'Building: Building').onclick();await new Promise(r=>setImmediate(r));
        assert.deepEqual(env.previewRanges(),env.fullBounds,'building isolation uses full model XYZ range');
        assert(!isolation.disabled,'building isolation stays available');
        isolation.checked=false;isolation.onchange();await new Promise(r=>setImmediate(r));
        assert.deepEqual(env.previewRanges(),manual,'unchecking restores the original XYZ preview exactly');
        await env.ui.dispose();
    } finally {env.restore();}
});


test('SEM-62 selected-target isolation, navigation, snapshot, export and native format control share the tree-adjacent section',async()=>{
    const env=await setup(true);
    try {
        const tree=control(env.holder,'Building floor room hierarchy');
        const container=tree.parent;
        const section=container.children[container.children.indexOf(tree)+1];
        assert.equal(section.tagName,'section','semantic toolbar is directly below hierarchy');
        for(const name of ['Top View / Navigate','Restore XYZ View',
                'Semantic Snapshot PNG/JSON','Semantic Model Export...']){
            assert(walk(section).includes(button(env.holder,name)),`${name} belongs to the same toolbar`);
        }
        assert(walk(section).some(e=>e.tagName==='input'&&e.type==='checkbox'&&
            e.parent?.textContent.includes('Isolate selected Building')));
        assert(walk(section).includes(control(env.holder,'Semantic snapshot resolution')));
        assert.equal(env.exportFormatRow.parent,section,
            'the original XYZ export-format control was relocated instead of duplicated');
        assert.equal(walk(env.holder).filter(e=>e===env.exportFormatSelect).length,1);
        await env.ui.dispose();
    }finally{env.restore();}
});

test('SEM-75 Live Tracking samples camera position, highlights location, and leaves selection unchanged',async()=>{
    const previousSet=globalThis.setInterval,previousClear=globalThis.clearInterval;
    let tick=null, intervalMs=null, cleared=null;
    globalThis.setInterval=(fn,ms)=>{tick=fn;intervalMs=ms;return 9876;};
    globalThis.clearInterval=id=>{cleared=id;tick=null;};
    const env=await setup(true);
    try {
        const tree=control(env.holder,'Building floor room hierarchy');
        const floor=walk(tree).find(e=>e.textContent==='Floor: Floor 1'&&e.attrs.role==='treeitem');
        assert(floor,'floor remains visible in the hierarchy');
        const live=control(env.holder,'Live Tracking');
        assert.equal(live.checked,false,'tracking is disabled by default');
        live.checked=true;live.onchange();
        assert.equal(intervalMs,250,'location checks run four times per second');
        assert(walk(env.holder).some(e=>String(e.textContent).includes('Building / Exterior')),
            'orthographic overhead camera reports its true exterior position');
        assert.equal(floor.attrs['aria-selected'],'true','tracking does not change the selected floor');
        assert.equal(floor.attrs['data-live-match'],'false','exterior is not a floor highlight');
        env.scene.events.invoke=key=>key==='camera.getPose' ?
            {position:{x:5,y:1,z:5},target:{x:5,y:0,z:5}} : null;
        tick();
        assert(walk(env.holder).some(e=>String(e.textContent).includes('Camera location: Building / Floor 1')),
            'camera moves into EG and is classified by full floor height');
        assert.equal(floor.attrs['data-live-match'],'true','current floor highlighted');
        assert.equal(floor.attrs['aria-selected'],'true','selected export target is unchanged');
        live.checked=false;live.onchange();
        assert.equal(cleared,9876,'turning off tracking clears its timer');
        assert.equal(floor.attrs['data-live-match'],'false','turning off clears live highlight');
        assert.equal(floor.attrs['aria-selected'],'true','user selection remains intact');
        await env.ui.dispose();
    } finally {
        env.restore();
        globalThis.setInterval=previousSet;globalThis.clearInterval=previousClear;
    }
});

test('SEM-76 plugin disposal stops active camera tracking and leaves semantic model unchanged',async()=>{
    const previousSet=globalThis.setInterval,previousClear=globalThis.clearInterval;
    let cancelled=0;
    globalThis.setInterval=()=>123;
    globalThis.clearInterval=id=>{assert.equal(id,123);cancelled++;};
    const env=await setup(true);
    try {
        const before=JSON.stringify(env.savedDocuments.at(-1));
        const live=control(env.holder,'Live Tracking');
        live.checked=true;live.onchange();
        await env.ui.dispose();
        assert.equal(cancelled,1,'timer cleared on plugin close');
        assert.equal(JSON.stringify(env.savedDocuments.at(-1)),before,'tracking does not persist semantic edits');
    } finally {
        env.restore();globalThis.setInterval=previousSet;globalThis.clearInterval=previousClear;
    }
});

test('SEM-77 room-level live highlight follows the camera, not selected export target',async()=>{
    const previousSet=globalThis.setInterval,previousClear=globalThis.clearInterval;
    let tick=null;globalThis.setInterval=fn=>{tick=fn;return 42;};
    globalThis.clearInterval=()=>{tick=null;};
    const env=await setup(true);
    try {
        await new Promise(resolve=>setImmediate(resolve));
        const source=env.savedDocuments.at(-1), floorId=source.floors[0].floor_id;
        const withRoom=addRoom(source,floorId,{room_id:'room-green',name:'Living Room',
            polygon_xz:[[1,1],[3,1],[3,3],[1,3]]});
        const imported={name:'semantic_Building.json',getFile:async()=>({
            size:JSON.stringify(withRoom).length,text:async()=>JSON.stringify(withRoom)
        }),createWritable:async()=>({write:async()=>{},close:async()=>{},abort:async()=>{}})};
        globalThis.window.showOpenFilePicker=async()=>[imported];
        await button(env.holder,'Import semantic.json').onclick();
        const tree=control(env.holder,'Building floor room hierarchy');
        const building=walk(tree).find(e=>e.textContent==='Building: Building' && e.attrs.role==='treeitem');
        const room=walk(tree).find(e=>e.textContent==='Room/Area: Living Room' && e.attrs.role==='treeitem');
        assert(building&&room);
        assert.equal(building.attrs['aria-selected'],'true','import selects building for snapshot/export');
        env.scene.events.invoke=key=>key==='camera.getPose'?{
            position:{x:2,y:1,z:2},target:{x:0,y:0,z:0}
        }:null;
        const live=control(env.holder,'Live Tracking');
        live.checked=true;live.onchange();
        assert.equal(room.attrs['data-live-match'],'true','actual camera inside room highlights room node');
        assert.equal(room.attrs['aria-selected'],'false','camera does not switch selected export target');
        assert.equal(building.attrs['aria-selected'],'true');
        assert(walk(env.holder).some(e=>String(e.textContent).includes('Building / Floor 1 / Living Room')));
        env.scene.events.invoke=key=>key==='camera.getPose'?{
            position:{x:8,y:1,z:8},target:{x:0,y:0,z:0}
        }:null;
        tick();
        assert.equal(room.attrs['data-live-match'],'false','room highlight clears on exit');
        const floor=walk(tree).find(e=>e.textContent==='Floor: Floor 1' && e.attrs.role==='treeitem');
        assert.equal(floor.attrs['data-live-match'],'true','floor highlights when camera leaves every room');
        await env.ui.dispose();
    } finally {
        env.restore();globalThis.setInterval=previousSet;globalThis.clearInterval=previousClear;
    }
});
