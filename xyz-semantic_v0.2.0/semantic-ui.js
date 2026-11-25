/* XYZ Semantic v0.2.0 browser authoring UI; fork-owned XYZ preview is the only filter owner. */
import {
    inverse4, transformPoint, semanticWorldMatrix, horizontalAlignment, polygonBounds,
    validatePolygon, convexHull, newDocument, validateDocument, addFloor, editFloor, removeFloor,
    locateSemanticCamera,
    addRoom, editRoom, removeRoom, worldBoundsForTarget, semanticProvenance
} from './semantic-core.js';
import { createSemanticOverlay } from './semantic-view.js';
import { readSemanticJson, selectNewSemanticFile, selectExistingSemanticFile, writeSemanticFile, createSemanticWriter, semanticOutputStem } from './semantic-io.js';

const check = (ok, message) => { if (!ok) throw new Error(message); };
const make = (tag, text, style) => {
    const e = document.createElement(tag);
    if (text != null) e.textContent = text;
    if (style) e.style.cssText = style;
    return e;
};
const row = () => make('div', null, 'display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin:5px 0');
const uuid = () => (globalThis.crypto?.randomUUID?.() || `sem-${Date.now()}-${Math.random().toString(16).slice(2)}`);
const btn = (label, action) => { const e = make('button', label); e.type='button'; e.onclick=action; return e; };
const numeric = (label, parent) => {
    const wrap = make('label', label, 'font-size:11px;flex:1 1 75px;min-width:65px');
    const el = make('input'); el.type='number'; el.step='0.001';
    el.style.cssText='width:100%;box-sizing:border-box;background:#222;border:1px solid #6b7280;color:white;padding:4px';
    el.addEventListener('input', () => { delete el.dataset.exact; });
    wrap.append(el); parent.append(wrap); return el;
};
const input = (placeholder, parent) => {
    const el = make('input'); el.placeholder=placeholder;
    el.style.cssText='background:#222;color:white;border:1px solid #6b7280;padding:5px;min-width:80px;flex:1 1 120px';
    parent.append(el); return el;
};
// Display precision only. Keep source bounds exact until a user edits a field.
export const formatCoordinate = n => {
    const fixed = Number(n).toFixed(3);
    return fixed === '-0.000' ? '0.000' : fixed;
};
const setCoordinate = (el, number) => {
    el.value = formatCoordinate(number);
    el.dataset.exact = String(number);
};
const readCoordinate = el => el.value.trim() === '' ? NaN : Number(el.dataset.exact ?? el.value);

// XYZ visibility sliders operate in Editor-world space. Semantic floor heights
// are model-anchored: convert through the current semantic-to-world matrix.
export function semanticYFromWorldRange(worldY, semanticToWorld) {
    check(worldY && [worldY.min, worldY.max].every(Number.isFinite) && worldY.min <= worldY.max,
        'Invalid live XYZ Y range.');
    check(horizontalAlignment(semanticToWorld), 'Semantic Y is not aligned with world Y.');
    const reverse = inverse4(semanticToWorld);
    check(reverse, 'Cannot invert semantic transform.');
    const a = transformPoint(reverse, [0, worldY.min, 0])[1];
    const b = transformPoint(reverse, [0, worldY.max, 0])[1];
    return { min: Math.min(a,b), max: Math.max(a,b) };
}


export function worldYFromSemanticRange(localY, semanticToWorld) {
    check(localY && [localY.min, localY.max].every(Number.isFinite) && localY.min < localY.max,
        'Invalid semantic Y range.');
    check(horizontalAlignment(semanticToWorld), 'Semantic Y is not aligned with world Y.');
    const a = transformPoint(semanticToWorld, [0, localY.min, 0])[1];
    const b = transformPoint(semanticToWorld, [0, localY.max, 0])[1];
    return { min: Math.min(a, b), max: Math.max(a, b) };
}

// Editor camera.getPose returns plain {x,y,z} position/target records in
// SuperSplat v3.9.2. viewport.setCamera requires actual PlayCanvas Vec3s:
// construct them using a cloned Vec3 from the public captured camera frame.
export function cameraVec3(scene, xyz) {
    check(xyz && [xyz.x,xyz.y,xyz.z].every(Number.isFinite),
        'Editor camera pose is invalid.');
    const template=scene.camera.captureFrame()?.position;
    check(template && typeof template.clone==='function',
        'Editor camera frame did not provide a PlayCanvas Vec3.');
    const value=template.clone();
    check(typeof value.set==='function', 'Editor camera Vec3 is incomplete.');
    return value.set(xyz.x,xyz.y,xyz.z);
}

export function attachSemanticUI({ scene, editor, target, preview, holder, modelToWorld, exportFormatRow = null }) {
    const root = make('section', null,
        'margin:12px 0 4px;padding:10px;background:#242b2b;border:1px solid #4c7770;border-radius:7px;display:grid;gap:7px;color:#eee');
    holder.append(root);
    root.append(make('strong', 'Building / Floor / Room Semantics'));
    root.append(make('div', 'Convex room polygons are model-anchored and changes are saved automatically to the selected semantic file.', 'font-size:11px;color:#b8d6d1'));
    const info = make('div', 'Bind a model or import a semantic document.', 'font-size:12px;color:#bfe7d7'); root.append(info);
    const setInfo = message => { info.textContent = message; };
    let doc = null, dirty = false, selected = { type:'building' }, mode = null, draft = [], savedCamera = null, lastOwnViewToken = null;
    let boundKey = null, disposed = false, editGeneration = 0;
    let workspaceHandle = null, saveRevision = 0, lastSavedRevision = 0;
    const writeQueue = createSemanticWriter();
    let floorPreviewMode = null, suppressRangeSync = 0;
    // Calls from the semantic hierarchy must not overwrite floor-editing fields.
    const setOwnedPreviewRange = async (ranges, enabled) => {
        suppressRangeSync++;
        try { await preview.setRanges(ranges, enabled); }
        finally { suppressRangeSync--; }
    };
    const requireDoc = () => { check(doc, 'Bind a model or import a semantic document first.'); return doc; };
    const currentMatrix = () => {
        const matrix = modelToWorld();
        check(matrix, 'Model transform is nonuniform across Gaussian groups. Semantic mapping is unavailable.');
        return matrix;
    };
    const currentWorld = () => semanticWorldMatrix(requireDoc(), currentMatrix());
    // The inherited XYZ preview already has exact world-space Gaussian-centre
    // AABB bounds. Convert its eight corners to conservative semantic-local
    // bounds instead of scanning 10M+ Gaussian centres on the UI thread.
    // For rotated models this may be wider than the exact semantic-local AABB,
    // which is safe for floor framing and filtering (never clips extra splats).
    let cachedDomain = null, cachedDomainKey = null;
    const domain = () => {
        const world = currentWorld();
        const key = world.join(',');
        if (cachedDomain && key === cachedDomainKey) return cachedDomain;
        const reverse = inverse4(world);
        check(reverse, 'Cannot invert semantic-to-world transform.');
        const out = { x:{min:Infinity,max:-Infinity}, y:{min:Infinity,max:-Infinity}, z:{min:Infinity,max:-Infinity} };
        for (const x of [preview.full.x.min, preview.full.x.max])
            for (const y of [preview.full.y.min, preview.full.y.max])
                for (const z of [preview.full.z.min, preview.full.z.max]) {
                    const xyz = transformPoint(reverse,[x,y,z]);
                    for (let axis=0;axis<3;axis++) {
                        const range=out[['x','y','z'][axis]];
                        range.min=Math.min(range.min,xyz[axis]);
                        range.max=Math.max(range.max,xyz[axis]);
                    }
                }
        cachedDomain = out; cachedDomainKey = key;
        return out;
    };
    const targetRange = (operation = 'view') => {
        if (selected.type === 'building') return structuredClone(preview.full);
        const base = domain();
        return worldBoundsForTarget(requireDoc(), currentMatrix(), base, selected, operation);
    };
    const fullSemanticRange = (operation = 'view') => {
        if (selected.type === 'building') return structuredClone(preview.full);
        return worldBoundsForTarget(requireDoc(), currentMatrix(), domain(), selected, operation);
    };
    const floorFor = () => doc?.floors.find(f => f.floor_id === selected.floorId) || null;
    const roomFor = () => floorFor()?.rooms.find(r => r.room_id === selected.roomId) || null;
    const context = operation => {
        requireDoc();
        const bounds = fullSemanticRange(operation);
        const floor = floorFor(), room = roomFor();
        const stem = semanticOutputStem(doc.model.name, floor?.name, room?.name);
        const overlay = { target_type: selected.type, semantic_to_world: [...currentWorld()],
            floor: floor ? { y_min: floor.y_min, y_max: floor.y_max } : null,
            rooms: (selected.type === 'room' ? [room] : selected.type === 'floor' ? floor.rooms : [])
                .filter(Boolean).map(r => ({ room_id: r.room_id, name: r.name,
                    polygon_xz: r.polygon_xz.map(p=>[...p]) })) };
        const [width,height] = (snapSize?.value || '1920x1080').split('x').map(Number);
        return { bounds, semantic: semanticProvenance(doc, selected, operation, bounds),
            target: { ...selected }, stem, overlay,
            snapshot: { width, height, fit: !!snapFit?.checked } };
    };
    const fileMessage = make('div','No writable semantic file selected.','font-size:11px;color:#aee1cb;min-height:15px');
    const writerState = message => { fileMessage.textContent = message; };
    const persist = () => {
        if (!doc) return Promise.resolve();
        const revision = ++saveRevision;
        dirty = true;
        if (!doc.document_id) doc.document_id=uuid(); // legacy file: assign an ID on its first edit
        doc.updated_at = new Date().toISOString();
        const handle = workspaceHandle;
        if (!handle) { writerState('Save pending: choose a semantic file using Bind or Import.'); update(); return Promise.resolve(false); }
        const snapshot = validateDocument(doc);
        writerState(`Saving ${handle.name || 'semantic document'}…`);
        update();
        return writeQueue(handle, snapshot).then(filename => {
            if (disposed || handle !== workspaceHandle) return false;
            lastSavedRevision = Math.max(lastSavedRevision, revision);
            if (revision === saveRevision) dirty = false;
            writerState(`${filename} — ${dirty ? 'changes pending' : 'Auto-saved'}`);
            update(); return true;
        }, error => {
            if (!disposed && handle === workspaceHandle) {
                dirty = true;
                writerState(`SAVE FAILED: ${error?.message || error}. Click Save / Retry.`);
                update();
            }
            return false;
        });
    };
    const applyChange = next => { doc = next; dirty = true; update(); void persist(); };
    const requireIdle = () => { check(!preview.busy(), 'Finish the snapshot/export operation first.'); };
    const wrap = fn => (...args) => {
        if (disposed) return;
        try { const result = fn(...args);
            if (result?.then) void result.catch(e => setInfo(`Error: ${e.message || e}`));
        } catch (error) { setInfo(`Error: ${error.message || error}`); }
    };
    // Bind selects the writable semantic destination in the original click event.
    // A cancel or failed initial write does not replace an existing document.
    const bindRow = row(); root.append(bindRow);
    const modelKey = input('Permanent model ID (from project.json)', bindRow);
    modelKey.setAttribute('aria-label', 'Permanent model ID');
    const bindStatus=make('div','','font-size:11px;color:#bfe7d7');
    const bind = btn('Bind Current Model', async () => {
        try {
            requireIdle(); check(!mode, 'Finish or cancel polygon editing first.');
            check(!dirty, 'Current semantic changes are not saved; retry saving before binding another model.');
            const key = modelKey.value.trim();
            check(key.length > 0, 'Enter a permanent model ID or an explicit standalone model key.');
            const matrix = currentMatrix();
            check(inverse4(matrix), 'Model has a noninvertible transform.');
            check(window.confirm(`Bind model "${target.name}" to key "${key}"?\nConfirm the building is upright in Editor world Y.`),'Binding cancelled.');
            const created = newDocument(key, target.name || 'Building Model', inverse4(matrix), uuid());
            check(horizontalAlignment(semanticWorldMatrix(created, matrix)), 'Binding requires an upright model in world Y.');
            const request = selectNewSemanticFile(created.model.name); // before first await
            const handle = await request;
            check(handle?.createWritable,'Selected semantic file cannot be written.');
            // Bind must never overwrite an existing semantic document: Import it.
            if (handle.getFile) {
                const existing=await handle.getFile();
                check(!existing?.size, 'This semantic file already contains data. Use Import semantic.json instead of Bind.');
            }
            await writeSemanticFile(handle, created);
            workspaceHandle=handle;doc=created;boundKey=key;dirty=false;
            saveRevision=lastSavedRevision=0;selected={type:'building'};
            const ys=semanticYFromWorldRange(preview.getRanges().y,currentWorld());
            setCoordinate(sliceMin,ys.min);setCoordinate(sliceMax,ys.max);
            const d=domain();
            setCoordinate(floorMin,d.y.min);setCoordinate(floorMax,d.y.max);
            setCoordinate(floorView,d.y.min+(d.y.max-d.y.min)*.85);
            update(); writerState(`${handle.name} — Created; automatic saving enabled.`);
            bindStatus.textContent=`Bound model "${target.name}" to ${handle.name}.`;
        } catch(error) {bindStatus.textContent=error?.name==='AbortError'?'Binding cancelled; no data changed.':`Bind failed: ${error?.message || error}`;}
    });
    bindRow.append(bind); root.append(bindStatus);
    const ioRow=row();root.append(ioRow);
    const importStatus=make('div','','font-size:11px;color:#bfe7d7');
    const openFile=btn('Import semantic.json', async () => {
        try {
            requireIdle(); check(!mode, 'Finish or cancel polygon editing first.');
            check(!dirty,'Save current changes before importing another document.');
            const request=selectExistingSemanticFile(); // user activation required
            const [handle]=await request;
            check(handle,'No file selected.');
            const next=await readSemanticJson(await handle.getFile());
            check(window.confirm(`Associate imported semantic model "${next.model.name}" (${next.model.model_id}) with loaded layer "${target.name}"? Verify it is the same building.`),'Import cancelled.');
            check(horizontalAlignment(semanticWorldMatrix(next,currentMatrix())),
                'Imported floor plane is tilted in current model pose. Reorient model first.');
            workspaceHandle=handle;doc=next;boundKey=next.model.model_id;
            modelKey.value=boundKey;dirty=false;saveRevision=lastSavedRevision=0;
            selected={type:'building'};mode=null;draft=[];
            update();writerState(`${handle.name} — Imported; auto-save ready.`);
            const n=doc.floors.reduce((count,f)=>count+f.rooms.length,0);
            importStatus.textContent=`Imported ${handle.name}: ${doc.floors.length} floor(s), ${n} room(s).`;
        } catch(error) {importStatus.textContent=error?.name==='AbortError'?'Import cancelled.':`Import failed: ${error?.message || error}`;}
    });
    const save=btn('Save / Retry', async()=>{
        try {
            requireIdle();requireDoc();
            // Requesting write permission must originate from this click.
            if(workspaceHandle?.queryPermission && (await workspaceHandle.queryPermission({mode:'readwrite'}))!=='granted') {
                const permission=await workspaceHandle.requestPermission({mode:'readwrite'});
                check(permission==='granted','Write permission was not granted.');
            }
            await persist();
        } catch(error) {writerState(`Save failed: ${error?.message||error}`);dirty=true;update();}
    });
    ioRow.append(openFile,save);root.append(importStatus);
    const modified=make('span','','font-size:11px');ioRow.append(modified);
    root.append(fileMessage);

    // A real expandable hierarchy, not a visually indented flat <select>.
    // Stable project/floor/room IDs remain the only selection identities.
    const hierarchy = make('div');
    hierarchy.setAttribute('role','tree');
    hierarchy.setAttribute('aria-label','Building floor room hierarchy');
    hierarchy.style.cssText='width:100%;box-sizing:border-box;background:#222;color:#eee;border:1px solid #707070;padding:5px;min-height:120px;max-height:220px;overflow:auto';
    root.append(hierarchy);
    // Hierarchy selection, XYZ isolation, camera navigation, snapshot settings,
    // and export format all act on one selected semantic target. Keep the
    // complete toolbox directly below the tree rather than splitting it across
    // the floor and room authoring controls.
    const semanticOperations=make('section',null,
        'border:1px solid #4c7770;border-radius:6px;padding:8px;display:grid;gap:5px');
    root.append(semanticOperations);
    semanticOperations.append(make('strong','Selected Building / Floor / Room — View & Output',
        'font-size:12px'));
    const filterRow=row();semanticOperations.append(filterRow);
    const navRow=row();semanticOperations.append(navRow);
    const collapsedFloors=new Set();
    let buildingExpanded=true;
    // Live tracking is presentation-only: it NEVER changes selected, preview,
    // camera navigation, the editable semantic document, or the export target.
    let liveLocation=null, trackingTimer=null;
    let trackingNodes=[];
    const locationKey=loc=>loc?.level==='room' ?
        `room:${loc.floorId}:${loc.roomId}` : loc?.level==='floor' ?
        `floor:${loc.floorId}:` : loc?.level==='building' ? 'building::' : null;
    const paintTracking=()=>{
        const active=trackingToggle?.checked ? locationKey(liveLocation) : null;
        for (const { element, key } of trackingNodes) {
            const match=!!active && key===active;
            element.setAttribute('data-live-match', String(match));
            element.style.borderLeft=match?'3px solid #29c7a6':'3px solid transparent';
            element.style.fontWeight=match?'bold':'normal';
        }
    };
    const refKey=t=>`${t.type}:${t.floorId ?? ''}:${t.roomId ?? ''}`;
    const nodeRow=(parent,depth,ref,label,expand=null)=>{
        const line=make('div',null,`display:flex;align-items:center;padding-left:${depth*14}px;gap:2px;min-height:25px`);
        if(expand){
            const arrow=btn(expand.open?'▾':'▸',expand.toggle);
            arrow.setAttribute('aria-label',`${expand.open?'Collapse':'Expand'} ${label}`);
            arrow.setAttribute('aria-expanded',String(expand.open));
            arrow.style.cssText='width:21px;min-width:21px;padding:2px;background:transparent;color:#ccc;border:0;cursor:pointer';
            line.append(arrow);
        } else line.append(make('span',null,'display:inline-block;width:21px;min-width:21px'));
        const select=btn(label,()=>selectHierarchyTarget(ref));
        select.setAttribute('role','treeitem');
        select.setAttribute('aria-selected',String(refKey(selected)===refKey(ref)));
        select.style.cssText=`flex:1;text-align:left;min-width:0;color:#eee;cursor:pointer;border:0;border-radius:3px;padding:4px;`+
            `background:${refKey(selected)===refKey(ref)?'#285b91':'transparent'}`;
        line.append(select);parent.append(line);
        trackingNodes.push({element: select, key: refKey(ref)});
        return line;
    };
    const refreshHierarchy=()=>{
        const previousScroll=hierarchy.scrollTop || 0;
        hierarchy.replaceChildren();
        trackingNodes=[];
        nodeRow(hierarchy,0,{type:'building'},`Building: ${target.name || '(unnamed)'}`,{
            open:buildingExpanded,toggle:()=>{buildingExpanded=!buildingExpanded;refreshHierarchy();}
        });
        if(buildingExpanded){
            const floorGroup=make('div',null,'padding-left:14px');
            floorGroup.setAttribute('role','group'); hierarchy.append(floorGroup);
            for(const floor of doc?.floors || []){
                const ref={type:'floor',floorId:floor.floor_id};
                const open=!collapsedFloors.has(floor.floor_id);
                nodeRow(floorGroup,0,ref,`Floor: ${floor.name}`,{
                    open,toggle:()=>{
                        if(open)collapsedFloors.add(floor.floor_id);
                        else collapsedFloors.delete(floor.floor_id);
                        refreshHierarchy();
                    }
                });
                if(!open)continue;
                const roomGroup=make('div',null,'padding-left:14px');
                roomGroup.setAttribute('role','group');floorGroup.append(roomGroup);
                for(const room of floor.rooms){
                    nodeRow(roomGroup,0,{type:'room',floorId:floor.floor_id,roomId:room.room_id},
                        `Room/Area: ${room.name}`);
                }
            }
        }
        hierarchy.scrollTop=previousScroll;
        paintTracking();
    };
    // Floor full Y bounds and view Y upper limit (one shared Y minimum).
    root.append(make('strong','Floor — Create / Edit / Remove','font-size:12px'));
    const floorNameRow=row(); root.append(floorNameRow);
    const floorName=input('Floor name',floorNameRow);
    const fRange=row(); root.append(fRange);
    const floorMin=numeric('Y min',fRange), floorMax=numeric('Y full max',fRange), floorView=numeric('Y view max',fRange);
    const fActions=row(); root.append(fActions);
    const floorStatus=make('div','','font-size:11px;color:#bfe7d7;min-height:15px');
    const floorMessage=message=>{floorStatus.textContent=message;};
    const floorAction=fn=>(...args)=>{
        try { const result=fn(...args);if(result?.then) void result.catch(e=>floorMessage(`Floor: ${e.message||e}`)); }
        catch(error){floorMessage(`Floor: ${error.message||error}`);}
    };
    const newFloor=btn('New Floor',floorAction(() => {
        requireDoc(); mode=null; draft=[]; selected={type:'building'};
        floorName.value=`Floor ${doc.floors.length+1}`;
        const live=semanticYFromWorldRange(preview.getRanges().y,currentWorld());
        setCoordinate(floorMin,live.min); setCoordinate(floorMax,live.max);
        setCoordinate(floorView,live.min+(live.max-live.min)*.85);
        floorPreviewMode=null; update();
        floorMessage('New floor: adjust the XYZ live Y sliders, then Create Floor.');
    }));
    const createFloor=btn('Create Floor',floorAction(() => {
        requireIdle(); requireDoc();
        const id=uuid();
        const next=addFloor(doc,{floor_id:id,name:floorName.value,
            y_min:readCoordinate(floorMin),y_max:readCoordinate(floorMax),view_y_max:readCoordinate(floorView)});
        doc=next;dirty=true;selected={type:'floor',floorId:id};mode=null;draft=[];
        const height=readCoordinate(floorMax)-readCoordinate(floorMin);
        setCoordinate(sliceMin,readCoordinate(floorMin)+height*.4);
        setCoordinate(sliceMax,readCoordinate(floorMin)+height*.6);
        update();void persist();
        floorMessage(`Floor ${floorName.value} created; auto-save queued. Choose Wall Slice, then Draw Room.`);
    }));
    const updateFloor=btn('Update Floor',floorAction(() => {
        requireIdle(); check(floorFor(),'Select a floor.');
        applyChange(editFloor(doc,selected.floorId,{name:floorName.value,
            y_min:readCoordinate(floorMin),y_max:readCoordinate(floorMax),view_y_max:readCoordinate(floorView)}));
        floorMessage(`Floor ${floorName.value} updated; auto-save queued.`);
    }));
    const deleteFloor=btn('Remove Floor',floorAction(() => {
        requireIdle(); const floor=floorFor(); check(floor,'Select a floor.');
        check(window.confirm(`Delete ${floor.name} and its ${floor.rooms.length} room definition(s)? No model geometry will be deleted.`),'Deletion cancelled.');
        applyChange(removeFloor(doc,floor.floor_id)); selected={type:'building'}; mode=null; draft=[]; update();
        floorMessage(`Floor ${floor.name} removed; auto-save queued.`);
    }));
    fActions.append(newFloor,createFloor,updateFloor,deleteFloor);root.append(floorStatus);
    // Three editing MODES, one existing XYZ visibility preview and one PreviewMask.
    // The modes connect semantic fields to the live slider rather than copying
    // values on demand or introducing a second filtering implementation.
    root.append(make('strong','Live floor Y preview — linked to XYZ visibility', 'font-size:12px'));
    const liveModes=row();root.append(liveModes);
    const fullMode=btn('Full Floor',wrap(()=>activateLiveMode('full')));
    const viewMode=btn('Ceiling-Free',wrap(()=>activateLiveMode('view')));
    const sliceMode=btn('Wall Slice',wrap(()=>activateLiveMode('slice')));
    liveModes.append(fullMode,viewMode,sliceMode);
    const sliceRow=row();root.append(sliceRow);
    const sliceMin=numeric('Slice Y min',sliceRow),sliceMax=numeric('Slice Y max',sliceRow);
    // A semantic document does not exist until Bind/Open; initialize neutral
    // slice fields, then convert from live Editor-world Y after binding.
    setCoordinate(sliceMin,0); setCoordinate(sliceMax,1);
    const liveHint=make('div','','font-size:11px;color:#b8d6d1');root.append(liveHint);
    const updateModeControls=()=>{
        for(const [button,name] of [[fullMode,'full'],[viewMode,'view'],[sliceMode,'slice']]) {
            button.style.background=floorPreviewMode===name?'#147d73':'';
            button.setAttribute('aria-pressed',floorPreviewMode===name?'true':'false');
            button.disabled=!doc;
        }
        const isSlice=floorPreviewMode==='slice';
        sliceRow.style.display=isSlice?'flex':'none';
        liveHint.textContent=floorPreviewMode==='full'?
            'LIVE: XYZ Y min → Floor Y min; XYZ Y max → Full floor Y max.':
            floorPreviewMode==='view'?
            'LIVE: XYZ Y min → Floor Y min; XYZ Y max → Ceiling-free Y max.':
            isSlice?'LIVE: XYZ Y min/max → temporary wall slice. Right-drag pans; wheel zooms in Top View.':
            'Choose a mode to link its Y fields to the EXISTING live XYZ visibility sliders.';
    };
    const localModeRange=kind=>{
        const yMin=readCoordinate(floorMin), yFull=readCoordinate(floorMax), yView=readCoordinate(floorView);
        if(kind==='slice')return {min:readCoordinate(sliceMin),max:readCoordinate(sliceMax)};
        return {min:yMin,max:kind==='full'?yFull:yView};
    };
    const activateLiveMode=async kind=>{
        requireIdle();requireDoc();
        const local=localModeRange(kind);
        const worldY=worldYFromSemanticRange(local,currentWorld());
        const ranges={...preview.getRanges(),y:worldY};
        await setOwnedPreviewRange(ranges,true);
        floorPreviewMode=kind;
        // Reflect the actual (potentially domain-clamped) preview values.
        syncLiveY(preview.getRanges().y);
        updateModeControls();
        setInfo(`${kind==='full'?'Full Floor':kind==='view'?'Ceiling-Free':'Wall Slice'}: live XYZ Y controls now edit the linked fields. Use Create/Update Floor to persist full/view ranges.`);
    };
    const syncLiveY=worldY=>{
        if(!doc || !floorPreviewMode || suppressRangeSync || !worldY)return;
        const live=semanticYFromWorldRange(worldY,currentWorld());
        if(floorPreviewMode==='full'){
            setCoordinate(floorMin,live.min);setCoordinate(floorMax,live.max);
            const priorView=readCoordinate(floorView);
            if(!(priorView>live.min && priorView<=live.max))
                setCoordinate(floorView,live.min+0.9*(live.max-live.min));
        } else if(floorPreviewMode==='view'){
            setCoordinate(floorMin,live.min);setCoordinate(floorView,live.max);
        } else if(floorPreviewMode==='slice'){
            setCoordinate(sliceMin,live.min);setCoordinate(sliceMax,live.max);
        }
    };
    const unlinkRanges=preview.onRangesChanged?.((worldY)=>{
        if(disposed || suppressRangeSync || !floorPreviewMode || preview.busy())return;
        try {syncLiveY(worldY);} catch(error){setInfo(`Live Y range: ${error.message||error}`);}
    });
    // Direct edits to floor/slice numeric inputs also drive the same preview.
    for(const field of [floorMin,floorMax,floorView,sliceMin,sliceMax]) {
        field.addEventListener('change',()=>{
            if(!floorPreviewMode || disposed || !doc)return;
            const affects= floorPreviewMode==='full'?[floorMin,floorMax]:
                floorPreviewMode==='view'?[floorMin,floorView]:[sliceMin,sliceMax];
            if(affects.includes(field))wrap(()=>activateLiveMode(floorPreviewMode))();
        });
    }
    updateModeControls();

    const roomGroup=make('section',null,'border:1px solid #4c7770;border-radius:5px;padding:8px;display:grid;gap:5px');
    root.append(roomGroup);
    roomGroup.append(make('strong','Room / Area — Create / Edit / Remove','font-size:12px'));
    const chooseFloorRow=row();roomGroup.append(chooseFloorRow);
    const roomFloorLabel=make('label','Room floor: ','font-size:11px;flex:1');
    const roomFloorSelect=make('select');
    roomFloorSelect.setAttribute('aria-label','Floor for room authoring');
    roomFloorSelect.style.cssText='width:100%;background:#222;color:#eee;border:1px solid #707070;padding:5px';
    roomFloorLabel.append(roomFloorSelect);chooseFloorRow.append(roomFloorLabel);
    const roomHint=make('div','','font-size:11px;color:#b8d6d1');roomGroup.append(roomHint);
    const rNameRow=row(); roomGroup.append(rNameRow);
    const roomName=input('Room / area name',rNameRow);
    const rActions=row(); roomGroup.append(rActions);
    const drawStatus=make('div','Select a saved floor and click Draw Room.',
        'font-size:11px;color:#bfe7d7;min-height:15px');
    const reportDraw=message=>{drawStatus.textContent=message;setInfo(message);};
    const draw=btn('Draw Room',wrap(async()=>{
        try { await enterPolygonMode('create'); }
        catch(error) { reportDraw(`Cannot start Draw Room: ${error.message||error}`); }
    }));
    const edit=btn('Edit Vertices',wrap(async()=>{
        try {
            const room=roomFor(); check(room,'Select a room first.');
            await enterPolygonMode('edit',room);
        } catch(error) { reportDraw(`Cannot start Edit Vertices: ${error.message||error}`); }
    }));
    // Finish is a transactional state transition: invalid drafts stay editable,
    // and a successful room commit immediately returns to the idle state with
    // Create/Edit/Remove available for another room.
    const finish=btn('Finish / Apply Polygon',()=>{
        try {
        requireIdle(); check(mode && editingReady,'Start drawing or editing first.');
        const activeMode=mode;
        let polygon;
        try { polygon=validatePolygon(draft); }
        catch (error) {
            if (!Array.isArray(draft) || draft.length<3) {
                reportDraw(`Cannot finish: ${error.message||error} Add vertices, or Cancel Draft.`);
                return;
            }
            let hull;
            try { hull=convexHull(draft); }
            catch (_) {
                reportDraw(`Cannot finish: ${error.message||error} Undo invalid vertices or Cancel Draft.`);
                return;
            }
            if (!window.confirm(`The ${draft.length} clicked positions do not form a convex outline.\n\n`+
                `Use the convex hull of those points (${hull.length} boundary corners)?\n`+
                'This removes interior points and may change the intended room boundary.\n\n'+
                'Cancel to keep editing the original draft.')) {
                reportDraw('Draft retained. Use Undo Vertex or adjust points before finishing.');
                return;
            }
            polygon=hull;
        }
        const floorId=selected.floorId;
        const name=roomName.value.trim();
        check(name.length>0,'Enter a room/area name before finishing.');
        let next, roomId;
        if(activeMode==='create') {
            roomId=uuid();
            next=addRoom(doc,floorId,{room_id:roomId,name,polygon_xz:polygon});
        } else {
            roomId=selected.roomId;
            next=editRoom(doc,floorId,roomId,{name,polygon_xz:polygon});
        }
        // Commit only after validation, and reset authoring state together.
        doc=next;dirty=true;
        selected={type:'room',floorId,roomId};
        mode=null;draft=[];editingReady=false;editGeneration++;
        roomName.value='';
        update();overlay.redraw();void persist();
        reportDraw(`Room "${name}" saved (${polygon.length} corners). Draw Room is ready for the next room; select the saved room to edit.`);
        } catch(error) { reportDraw(`Cannot save room: ${error.message||error}. Correct the draft or Cancel Draft.`); }
    });
    const cancel=btn('Cancel Draft',()=>{
        editGeneration++;mode=null;draft=[];editingReady=false;update();overlay.redraw();
        reportDraw('Polygon draft cancelled. Draw Room is ready.');
    });
    rActions.append(draw,edit,finish,cancel);
    const moreRoom=row(); roomGroup.append(moreRoom);
    const undo=btn('Undo Vertex',()=>{if(mode==='create'){draft.pop();update(false);overlay.redraw();reportDraw(`Draft: ${draft.length} vertices. Click to add or Finish / Apply Polygon.`);}});
    const rename=btn('Rename Room',wrap(() => {
        requireIdle(); check(roomFor(),'Select a room.');
        applyChange(editRoom(doc,selected.floorId,selected.roomId,{name:roomName.value}));
        reportDraw(`Room renamed to ${roomName.value}; auto-save queued.`);
    }));
    const deleteRoom=btn('Remove Room',wrap(() => {
        requireIdle(); const r=roomFor(); check(r,'Select a room.');
        check(window.confirm(`Delete room/area "${r.name}"? No Gaussian geometry will be deleted.`),'Deletion cancelled.');
        applyChange(removeRoom(doc,selected.floorId,selected.roomId));
        selected={type:'floor',floorId:selected.floorId};mode=null;draft=[];update();
        reportDraw(`Room ${r.name} removed; auto-save queued.`);
    }));
    moreRoom.append(undo,rename,deleteRoom);

    roomGroup.append(drawStatus);
    const labelToggle=(text,initial=false)=>{
        const label=make('label',text,'font-size:12px');
        const cb=make('input'); cb.type='checkbox'; cb.checked=initial; label.prepend(cb); filterRow.append(label); return cb;
    };
    const isolateSelection=labelToggle(' Isolate selected Building / Floor / Room (XYZ range)',false);
    const navigate=btn('Top View / Navigate',wrap(async()=>{
        requireIdle();requireDoc();
        await showTarget(true);
    }));
    const restore=btn('Restore XYZ View',wrap(async()=>{await restoreView();}));
    navRow.append(navigate,restore);
    const snapshotSettings=row();semanticOperations.append(snapshotSettings);
    const snapSizeLabel=make('label','Snapshot size: ','font-size:11px');
    const snapSize=make('select');snapSize.setAttribute('aria-label','Semantic snapshot resolution');
    for(const [value,label] of [['1920x1080','1920 × 1080'],['2048x2048','2048 × 2048']]) {
        const option=make('option',label);option.value=value;snapSize.append(option);
    }
    snapSize.value='2048x2048';snapSizeLabel.append(snapSize);snapshotSettings.append(snapSizeLabel);
    const fitLabel=make('label',' Fit selected region','font-size:11px');
    const snapFit=make('input');snapFit.type='checkbox';snapFit.checked=true;fitLabel.prepend(snapFit);
    snapshotSettings.append(fitLabel);
    // The original export-format select is still owned by the XYZ Filter
    // panel, so the native serializer and get('export-format') remain intact.
    // Reparent its existing DOM node instead of introducing duplicate controls.
    if (exportFormatRow) semanticOperations.append(exportFormatRow);
    const operationRow=row();semanticOperations.append(operationRow);
    const operationStatus=make('div','','font-size:11px;color:#bfe7d7;min-height:16px');
    const snapshot=btn('Semantic Snapshot PNG/JSON',async () => {
        try { requireIdle(); requireDoc(); const ctx=context('view');
            operationStatus.textContent='Capturing semantic snapshot…';
            const result=await preview.snapshotSemantic(ctx);
            operationStatus.textContent=result?.image?`Snapshot saved: ${result.image}`:'Snapshot cancelled.';
        } catch(error) {operationStatus.textContent=`Snapshot failed: ${error?.message||error}`;}
    });
    const exportModel=btn('Semantic Model Export...',async () => {
        try {requireIdle();requireDoc();const ctx=context('export');
            operationStatus.textContent='Exporting semantic model…';
            const result=await preview.exportSemantic(ctx);
            operationStatus.textContent=result?.modelExported?`Export completed: ${ctx.stem}`:'Export cancelled.';
            if(result?.reportError) operationStatus.textContent+=`; report error: ${result.reportError}`;
            if(result?.modelExported && result?.placeholder && !result.placeholder.cleaned &&
                result.placeholder.reason !== 'unverified target')
                operationStatus.textContent+=`; unused native file was not removed (${result.placeholder.reason})`;
        } catch(error) {operationStatus.textContent=`Export failed: ${error?.message||error}`;}
    });operationRow.append(snapshot,exportModel);semanticOperations.append(operationStatus);

    // Position only: never substitute view target/focal point for camera pose,
    // including in the overhead orthographic view (which may be exterior).
    const trackingRow=row();semanticOperations.append(trackingRow);
    const trackingLabel=make('label',' Live Tracking — virtual camera position','font-size:12px');
    const trackingToggle=make('input');trackingToggle.type='checkbox';trackingToggle.checked=false;
    trackingToggle.setAttribute('aria-label','Live Tracking');
    trackingLabel.prepend(trackingToggle);trackingRow.append(trackingLabel);
    const trackingStatus=make('div','Tracking off.','font-size:11px;color:#bfe7d7;min-height:14px');
    const trackingCoords=make('div','','font-size:11px;color:#a9bdba;min-height:14px');
    semanticOperations.append(trackingStatus,trackingCoords);
    const sampleTracking=()=>{
        if(disposed || !trackingToggle.checked || !doc) return;
        try {
            // v3.9.2 getPose returns plain coordinate objects, not Vec3s.
            const p=scene.events.invoke('camera.getPose')?.position;
            check(p && [p.x,p.y,p.z].every(Number.isFinite), 'Camera position unavailable.');
            const result=locateSemanticCamera(doc,currentMatrix(),domain(),[p.x,p.y,p.z]);
            liveLocation=result;
            trackingStatus.textContent=`Camera location: ${result.label}`;
            trackingCoords.textContent=`World X ${formatCoordinate(p.x)} · Y ${formatCoordinate(p.y)} · Z ${formatCoordinate(p.z)} | ${result.level==='exterior'?'Model bounds approximation':'Camera position'}`;
            paintTracking();
        } catch(error) {
            liveLocation=null;
            trackingStatus.textContent=`Tracking unavailable: ${error.message||error}`;
            trackingCoords.textContent='';
            paintTracking();
        }
    };
    const stopTracking=()=>{
        if(trackingTimer!==null) {clearInterval(trackingTimer);trackingTimer=null;}
        liveLocation=null;trackingStatus.textContent='Tracking off.';trackingCoords.textContent='';
        paintTracking();
    };
    const startTracking=()=>{
        if(trackingTimer!==null) return;
        if(!doc) {trackingStatus.textContent='Bind or import a semantic document first.';return;}
        sampleTracking();
        trackingTimer=setInterval(sampleTracking,250);
    };
    trackingToggle.onchange=()=>{if(trackingToggle.checked) startTracking();else stopTracking();};
    semanticOperations.append(make('div',
        'Snapshots use ceiling-free Y; model exports use full floor Y. Room isolation/export uses the polygon XYZ bounding box.',
        'font-size:11px;color:#b8d6d1'));

    // Manual polygon authoring requires a TRUE Y-down top view (not merely
    // any orthographic camera). Middle pan and wheel zoom preserve this axis.
    const isTopView=()=>{
        if (!scene.camera.ortho) return false;
        const pose=scene.events.invoke('camera.getPose');
        const a=pose?.position, b=pose?.target;
        if (!a || !b || ![a.x,a.y,a.z,b.x,b.y,b.z].every(Number.isFinite)) return false;
        const dx=a.x-b.x, dy=a.y-b.y, dz=a.z-b.z;
        return dy>0 && Math.hypot(dx,dz)<=Math.max(1e-8,dy*1e-3);
    };
    let editingReady=false;
    const enterPolygonMode=async (requestedMode, existingRoom=null)=>{
        requireIdle(); requireDoc(); check(floorFor(),'Select a floor first.');
        check(!mode,'Finish or cancel the existing polygon draft first.');
        check(horizontalAlignment(currentWorld()),'Reorient the model so the semantic floor is horizontal.');
        const generation=++editGeneration;
        if (existingRoom) roomName.value=existingRoom.name;
        // Change mode immediately: neither a costly bounds lookup nor an
        // asynchronous Editor command may leave the Draw button inert.
        mode=requestedMode;
        draft=existingRoom ? existingRoom.polygon_xz.map(p=>[...p]) : [];
        editingReady=isTopView();
        update();
        reportDraw(editingReady ?
            (mode==='create'?'Drawing active: click the floor plan to place vertices.':'Editing active: drag an orange vertex.') :
            'Entering orthographic top view…');
        if (editingReady) return;
        try {
            await navigateToBounds(fullSemanticRange('view'));
            check(isTopView(), 'Editor did not enter a fixed orthographic Top View. Select Top View / Navigate and retry.');
            if (disposed || mode!==requestedMode || generation!==editGeneration) return;
            editingReady=true;
            update(false);
            overlay.redraw();
            reportDraw(mode==='create'?'Drawing active: click to place vertices.':'Editing active: drag an orange vertex.');
        } catch(error) {
            if (!disposed && mode===requestedMode && generation===editGeneration) {
                editGeneration++;mode=null;draft=[];editingReady=false;update();
                let restoreError='';
                try { await restoreCamera(); }
                catch(e) { restoreError=`; previous camera could not be restored: ${e.message||e}`; }
                reportDraw(`Unable to start polygon editing: ${error.message||error}${restoreError}`);
            }
        }
    };
    const rememberCamera=()=>{
        if (savedCamera) return;
        const pose=scene.events.invoke('camera.getPose');
        savedCamera={position:cameraVec3(scene,pose.position),target:cameraVec3(scene,pose.target),orthographic:scene.camera.ortho};
    };
    let manualRanges=null; // snapshot the user's LAST manual XYZ state on entry, not when the panel opens
    const rememberRanges=()=>{
        if(!manualRanges) manualRanges={...structuredClone(preview.getRanges()),enabled:preview.enabled()};
    };
    const draftFloorBounds=()=>{
        requireDoc();
        const y0=readCoordinate(floorMin), y1=readCoordinate(floorMax), yView=readCoordinate(floorView);
        check(Number.isFinite(y0)&&Number.isFinite(y1)&&Number.isFinite(yView) && y0<yView && yView<=y1,
            'Set Y min < Y view max <= Y full max.');
        const fake={...doc,floors:[{floor_id:'__draft_view__',
            name:'Unsaved floor view',y_min:y0,y_max:y1,view_y_max:yView,rooms:[]}]};
        return worldBoundsForTarget(fake,currentMatrix(),domain(),
            {type:'floor',floorId:'__draft_view__'},'view');
    };
    // The Editor's top-view command only changes orientation/projection.  It
    // retains the user's current camera target and zoom (including building
    // framing and any deliberate pan/zoom).  Do NOT compute a fresh distance
    // from the selected floor/room bounds: scene.camera.distance is normalized
    // internally and an arbitrary world-space distance causes tiny views.
    const navigateToBounds=async _framing=>{
        if (isTopView()) return;
        rememberCamera();
        await editor.viewport.setCamera({view:'top',orthographic:true});
        lastOwnViewToken=editor.viewport.info().viewToken;
    };
    const navigateFloorDraft=async()=>{
        requireIdle();
        const bounds=draftFloorBounds();
        await navigateToBounds(bounds);
        setInfo('Top-down orthographic view active. Use the XYZ visibility Y sliders for live wall slicing.');
    };
    const showTarget=async navigateCamera=>{
        requireIdle();requireDoc();
        if (isolateSelection.checked) {
            // Do not overwrite the user's manual live XYZ settings: switching
            // between tree nodes updates the selected bounds, while unchecking
            // returns to the range that was active before isolation started.
            rememberRanges();
            await setOwnedPreviewRange(targetRange('view'),true);
            floorPreviewMode=selected.type==='building'?null:'view';
            updateModeControls();
        }
        if(navigateCamera) await navigateToBounds(fullSemanticRange('view'));
        setInfo(isolateSelection.checked
            ? `${selected.type==='room'?'Room bounding box':selected.type==='floor'?'Floor ceiling-free range':'Full building range'} isolated with XYZ visibility preview.`
            : 'Selected semantic target. Use Top View for navigation or enable XYZ isolation to apply its range.');
    };
    const restoreCamera=async()=>{
        if (!savedCamera) return;
        const saved=savedCamera;savedCamera=null;
        const currentToken=editor.viewport.info().viewToken;
        if(lastOwnViewToken && currentToken!==lastOwnViewToken) {
            setInfo('Editor camera changed externally; leaving its new pose intact.');return;
        }
        await editor.viewport.setCamera({position:saved.position,target:saved.target,orthographic:saved.orthographic});
        lastOwnViewToken=null;
    };
    const restoreView=async()=>{
        requireIdle();
        if (manualRanges) {
            const { enabled, ...previousRanges } = manualRanges;
            await setOwnedPreviewRange(previousRanges,enabled);
            manualRanges=null;
        }
        isolateSelection.checked=false;
        floorPreviewMode=null;updateModeControls();
        await restoreCamera();setInfo('Original XYZ ranges and owned camera view restored.');
    };
    const selectHierarchyTarget=wrap(async nextSelection=>{
        if(mode){reportDraw('Finish or cancel polygon editing before switching rooms.');return;}
        const previousFloorId=selected.floorId;
        selected=nextSelection;
        const floor=floorFor(),room=roomFor();
        if(floor && previousFloorId!==floor.floor_id){
            const h=floor.y_max-floor.y_min;
            setCoordinate(sliceMin,floor.y_min+h*.4);setCoordinate(sliceMax,floor.y_min+h*.6);
        }
        if(floor){ floorName.value=floor.name;setCoordinate(floorMin,floor.y_min);
            setCoordinate(floorMax,floor.y_max);setCoordinate(floorView,floor.view_y_max);
        }
        if(room)roomName.value=room.name;
        update();
        await showTarget(true);
    });
    roomFloorSelect.onchange=wrap(async()=>{
        if(mode) { setInfo('Finish or cancel polygon editing before switching floors.');return; }
        const floorId=roomFloorSelect.value,previousFloorId=selected.floorId;
        selected=floorId?{type:'floor',floorId}:{type:'building'};
        const floor=floorFor();
        if(floor && previousFloorId!==floor.floor_id){
            const h=floor.y_max-floor.y_min;
            setCoordinate(sliceMin,floor.y_min+h*.4);setCoordinate(sliceMax,floor.y_min+h*.6);
        }
        if(floor){ floorName.value=floor.name;setCoordinate(floorMin,floor.y_min);
            setCoordinate(floorMax,floor.y_max);setCoordinate(floorView,floor.view_y_max); }
        roomName.value='';update();
        if(floor) await showTarget(true);
    });

    isolateSelection.onchange=wrap(async()=>{
        requireIdle();requireDoc();
        if (isolateSelection.checked) {
            await showTarget(false);
        } else {
            if (manualRanges) {
                const { enabled, ...previousRanges } = manualRanges;
                await setOwnedPreviewRange(previousRanges,enabled);
                manualRanges=null;
            }
            floorPreviewMode=null;updateModeControls();
            setInfo('Semantic XYZ isolation disabled; prior live XYZ visibility range restored.');
        }
    });
    const update=(refresh=true)=>{
        if (disposed) return;
        updateModeControls();
        if(refresh)refreshHierarchy();
        const floor=floorFor(),room=roomFor();
        modified.textContent=doc?(dirty?'Unsaved changes':'Auto-save enabled'):'No semantic document';
        modified.style.color=dirty?'#fbbf24':'#b5c4c0';
        // Keep the selected floor, model and saved document stable during a room draft.
        newFloor.disabled=!!mode;createFloor.disabled=!!mode;
        updateFloor.disabled=!floor || !!mode;deleteFloor.disabled=!floor || !!mode;
        bind.disabled=!!mode;openFile.disabled=!!mode;save.disabled=!!mode;
        hierarchy.disabled=!!mode;
        if(refresh) {
            roomFloorSelect.replaceChildren();
            const placeholder=make('option','Select a saved floor');placeholder.value='';roomFloorSelect.append(placeholder);
            for(const f of doc?.floors || []) {
                const opt=make('option',f.name);opt.value=f.floor_id;roomFloorSelect.append(opt);
            }
        }
        roomFloorSelect.value=floor?.floor_id || '';
        roomFloorSelect.disabled=!doc?.floors.length || !!mode;
        roomHint.textContent=floor ? `Floor "${floor.name}" selected — Draw Room enters fixed orthographic Top View; click corners in boundary order.` :
            'Room drawing is disabled until a floor is CREATED and SELECTED. Click Create Floor, or select an existing floor here.';
        draw.disabled=!floor || !!mode;
        edit.disabled=!room || !!mode;
        finish.disabled=!mode || !editingReady;
        cancel.disabled=!mode;
        draw.setAttribute('aria-pressed',mode==='create'?'true':'false');
        edit.setAttribute('aria-pressed',mode==='edit'?'true':'false');
        undo.disabled=mode!=='create';
        rename.disabled=!room || !!mode;deleteRoom.disabled=!room || !!mode;
        isolateSelection.disabled=!doc || !!mode;
        if(trackingToggle.checked && !trackingTimer && doc) startTracking();
    };
    const overlay=createSemanticOverlay(scene,()=>{
        if (!doc || !floorFor()) return null;
        let semanticToWorld;
        try { semanticToWorld=currentWorld(); } catch (_) {return null;}
        return { floor:floorFor(), selectedRoomId:selected.roomId,semanticToWorld,mode,draft,
            editingEnabled:editingReady };
    },{
        addPoint: point => { if(mode==='create' && editingReady && draft.length<256){
            draft.push(point); update(false);overlay.redraw();
            let guidance='';
            if (draft.length>=4) { try { validatePolygon(draft); }
                catch (_) { guidance=' The outline is not convex; Finish will offer a convex hull, or use Undo Vertex.'; } }
            reportDraw(`Drawing active: ${draft.length} ${draft.length===1?'vertex':'vertices'}. Finish / Apply Polygon when ready.${guidance}`);
        } },
        moveVertex:(index,point)=>{ if(mode==='edit' && editingReady && index>=0 && index<draft.length){draft[index]=point;} },
        error:error=>reportDraw(`Polygon editor: ${error.message||error}`)
    });
    const onEscape=e=>{
        if(e.key!=='Escape' || !mode || disposed) return;
        editGeneration++;mode=null;draft=[];editingReady=false;update();overlay.redraw();
        reportDraw('Polygon editing cancelled. Draw Room is ready.');
        e.preventDefault();e.stopPropagation();
    };
    document.addEventListener('keydown',onEscape,true);
    update();
    return {
        async dispose(){
            document.removeEventListener('keydown',onEscape,true);
            stopTracking();
            disposed=true;unlinkRanges?.();overlay.dispose();
            try { if(savedCamera) await restoreCamera(); } finally { root.remove(); }
        },
        dirty(){return dirty;},
        error:setInfo
    };
}
