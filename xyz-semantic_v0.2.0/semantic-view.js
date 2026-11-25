/* XYZ Semantic: non-destructive SVG viewport overlay and screen-to-plane mapping. */
import { inverse4, multiply4, transformPoint, horizontalAlignment } from './semantic-core.js';
const NS = 'http://www.w3.org/2000/svg';
const elm = (tag, attributes = {}) => {
    const e = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attributes)) e.setAttribute(k, String(v));
    return e;
};
export function viewportMatrices(frame) {
    return { viewProjection: multiply4(Array.from(frame.projection.data), Array.from(frame.view.data)) };
}
export function projectXZ(xz, height, semanticToWorld, frame, width, viewportHeight) {
    const m = viewportMatrices(frame).viewProjection;
    const p = transformPoint(semanticToWorld, [xz[0], height, xz[1]]);
    const ndc = transformPoint(m, p);
    return [(ndc[0] + 1) * width / 2, (1 - ndc[1]) * viewportHeight / 2];
}
export function screenToPlane(x, y, width, height, frame, semanticToWorld, semanticHeight) {
    if (!(width > 0 && height > 0)) throw new Error('Viewport size is invalid.');
    if (!frame.ortho) throw new Error('Use orthographic top view to draw room polygons.');
    if (!horizontalAlignment(semanticToWorld)) throw new Error('Semantic floor plane is tilted. Reorient model for top-view editing.');
    const inverse = inverse4(viewportMatrices(frame).viewProjection);
    const reverseSemantic = inverse4(semanticToWorld);
    if (!inverse || !reverseSemantic) throw new Error('Camera/model mapping cannot be inverted.');
    const nx = x / width * 2 - 1, ny = 1 - y / height * 2;
    const a = transformPoint(inverse, [nx, ny, -1]);
    const b = transformPoint(inverse, [nx, ny, 1]);
    const yWorld = transformPoint(semanticToWorld, [0, semanticHeight, 0])[1];
    const dy = b[1] - a[1];
    if (Math.abs(dy) < 1e-12) throw new Error('Camera ray is parallel to floor plane.');
    const t = (yWorld - a[1]) / dy;
    const local = transformPoint(reverseSemantic, a.map((v, i) => v + (b[i] - v) * t));
    if (!local.every(Number.isFinite)) throw new Error('Invalid polygon point.');
    return [local[0], local[2]];
}
export function createSemanticOverlay(scene, getState, handlers) {
    const canvas = scene.canvas;
    if (!canvas?.getBoundingClientRect) throw new Error('Editor viewport canvas unavailable.');
    const svg = elm('svg', { 'aria-label': 'XYZ Semantic polygon overlay' });
    svg.style.cssText = 'position:fixed;pointer-events:none;overflow:visible;z-index:950';
    document.body.append(svg);
    let disposed = false, frameId = null, dragging = null;
    let latest = null;
    const getPoint = e => {
        const rect = canvas.getBoundingClientRect();
        const state = getState();
        if (!state?.floor) throw new Error('Select a floor before drawing.');
        // Navigation is allowed only within a fixed Top View while authoring.
        // If another Editor shortcut tilts the camera, reject the point rather
        // than silently changing the meaning of the XZ polygon.
        if (scene.events?.invoke && scene.camera?.ortho !== undefined) {
            const pose=scene.events.invoke('camera.getPose');
            const p=pose?.position, t=pose?.target;
            if (p && t && [p.x,p.y,p.z,t.x,t.y,t.z].every(Number.isFinite)) {
                const dx=p.x-t.x,dy=p.y-t.y,dz=p.z-t.z;
                if (!scene.camera.ortho || dy<=0 || Math.hypot(dx,dz)>Math.max(1e-8,dy*1e-3))
                    throw new Error('Polygon editing requires fixed orthographic Top View. Select Top View / Navigate.');
            }
        }
        return screenToPlane(e.clientX - rect.left, e.clientY - rect.top,
            rect.width, rect.height, scene.camera.captureFrame(), state.semanticToWorld,
            (state.floor.y_min + state.floor.y_max) / 2);
    };
    // Editor input is not guaranteed to target the render canvas: it can
    // target a viewport UI layer above it. Capture at document level, but
    // ONLY when drawing/editing, inside the canvas rectangle, and never on
    // launcher/plugin/Editor controls. The overlay stays click-through.
    const inViewport = e => {
        const rect = canvas.getBoundingClientRect();
        return e.clientX >= rect.left && e.clientX < rect.left + rect.width &&
            e.clientY >= rect.top && e.clientY < rect.top + rect.height;
    };
    const isControl = target => {
        let node=target;
        while(node && node !== canvas && node !== document.body) {
            const tag=String(node.tagName||'').toLowerCase();
            const role=node.getAttribute?.('role');
            if(['button','input','textarea','select','label','a'].includes(tag) ||
                ['button','menu','menuitem','dialog','slider','textbox','combobox'].includes(role) ||
                String(node.id||'').startsWith('custom-xyz-semantic-preview') ||
                String(node.id||'')==='custom-xyz-preview') return true;
            node=node.parentElement||node.parentNode||node.parent;
        }
        return false;
    };
    const canCapture=e=>inViewport(e)&&!isControl(e.target);
    const consume=e=>{ e.preventDefault(); e.stopImmediatePropagation(); };
    const nearestVertex=e=>{
        const state=getState();
        if(state?.mode!=='edit' || !state.draft?.length)return -1;
        const rect=canvas.getBoundingClientRect(),frame=scene.camera.captureFrame();
        const y=(state.floor.y_min+state.floor.y_max)/2;
        let index=-1,closest=11*11;
        state.draft.forEach((xz,i)=>{
            const pt=projectXZ(xz,y,state.semanticToWorld,frame,rect.width,rect.height);
            const dx=pt[0]-(e.clientX-rect.left),dy=pt[1]-(e.clientY-rect.top);
            const d2=dx*dx+dy*dy;
            if(d2<=closest){closest=d2;index=i;}
        });
        return index;
    };
    // SuperSplat Editor v3.9.2: right-drag or Shift+middle-drag PANS;
    // plain middle-drag and Ctrl/Shift+right-drag ORBIT.  Only suppress
    // rotation gestures so the semantic XZ drawing plane stays top-down.
    const rotatesDown=e=>(e.button===1 && !e.shiftKey && !e.ctrlKey) ||
        (e.button===2 && (e.ctrlKey || e.shiftKey));
    const rotatesMove=e=>((e.buttons & 4)!==0 && !e.shiftKey && !e.ctrlKey) ||
        ((e.buttons & 2)!==0 && (e.ctrlKey || e.shiftKey));
    const down=e=>{
        const state=getState();
        if(!state || (state.mode!=='create' && state.mode!=='edit') || state.editingEnabled===false || !canCapture(e))return;
        if(rotatesDown(e)){consume(e);return;}
        // Ordinary right-drag pans; Shift+middle-drag also pans.  Wheel zoom
        // and Ctrl+middle zoom pass directly to SuperSplat.
        if(e.button!==0)return;
        if(state.mode==='create'){
            consume(e);
            try { handlers.addPoint(getPoint(e)); }
            catch(error){handlers.error(error);}
        } else {
            try {
                const index=nearestVertex(e);
                if(index>=0)dragging={id:e.pointerId,index};
                // Block ordinary Editor left-drag rotation even when the
                // click misses an existing vertex handle.
                consume(e);
            } catch(error){handlers.error(error);}
        }
    };
    const stopMouse=e=>{
        const state=getState();
        if(!state || (state.mode!=='create' && state.mode!=='edit') || !canCapture(e))return;
        if(e.type==='contextmenu') {e.preventDefault();return;}
        if(rotatesDown(e))consume(e);
        else if(state.mode==='create' && e.button===0)consume(e);
        else if(state.mode==='edit' && e.button===0)consume(e);
    };
    const move=e=>{
        if(!dragging || dragging.id!==e.pointerId){
            const state=getState();
            if(state && (state.mode==='create'||state.mode==='edit') &&
                rotatesMove(e) && canCapture(e))consume(e);
            return;
        }
        try { handlers.moveVertex(dragging.index,getPoint(e));consume(e); }
        catch(error){handlers.error(error);}
    };
    const finish=e=>{if(dragging?.id===e.pointerId){dragging=null;consume(e);}};
    document.addEventListener('pointerdown',down,true);
    document.addEventListener('mousedown',stopMouse,true);
    document.addEventListener('click',stopMouse,true);
    document.addEventListener('pointermove',move,true);
    document.addEventListener('mousemove',move,true);
    document.addEventListener('pointerup',finish,true);
    document.addEventListener('pointercancel',finish,true);
    document.addEventListener('contextmenu',stopMouse,true);
    const redraw = () => {
        const state = getState(); latest = state;
        const rect = canvas.getBoundingClientRect();
        svg.style.left = `${rect.left}px`; svg.style.top = `${rect.top}px`;
        svg.style.width = `${rect.width}px`; svg.style.height = `${rect.height}px`;
        svg.setAttribute('viewBox', `0 0 ${Math.max(1, rect.width)} ${Math.max(1, rect.height)}`);
        // Fullscreen overlay remains click-through even in drawing mode.
        svg.style.pointerEvents = 'none';
        while (svg.firstChild) svg.firstChild.remove();
        if (!state?.floor || !state?.semanticToWorld) return;
        const frame = scene.camera.captureFrame();
        const yy = (state.floor.y_min + state.floor.y_max) / 2;
        const plot = coords => coords.map(p => projectXZ(p, yy, state.semanticToWorld, frame, rect.width, rect.height));
        for (const room of state.floor.rooms) {
            const pts = plot(room.polygon_xz);
            if (pts.some(p => !p.every(Number.isFinite))) continue;
            const selected = state.selectedRoomId === room.room_id;
            const path = elm('polygon', {
                points: pts.map(p => p.join(',')).join(' '),
                fill: selected ? 'rgba(20,184,166,.16)' : 'rgba(100,116,139,.08)',
                stroke: selected ? '#14b8a6' : '#9ca3af', 'stroke-width': selected ? 2.5 : 1.4
            });
            path.style.pointerEvents = 'none'; svg.append(path);
            if (pts.length) {
                const center = pts.reduce((v, p) => [v[0] + p[0] / pts.length, v[1] + p[1] / pts.length], [0,0]);
                const text = elm('text', { x: center[0], y: center[1], 'text-anchor': 'middle',
                    fill: 'white', 'font-size': 12, 'paint-order': 'stroke', stroke: '#232323', 'stroke-width': 3 });
                text.textContent = room.name; text.style.pointerEvents = 'none'; svg.append(text);
            }
        }
        if (state.draft?.length) {
            const pts = plot(state.draft);
            const outline = elm(state.mode === 'edit' ? 'polygon' : 'polyline', {
                points: pts.map(p => p.join(',')).join(' '), fill: 'none', stroke: '#f59e0b',
                'stroke-width': 2.5, 'stroke-dasharray': '5 3'
            });
            outline.style.pointerEvents = 'none'; svg.append(outline);
            pts.forEach((p,i) => {
                const dot = elm('circle', { cx: p[0], cy: p[1], r: 5,
                    fill: '#f59e0b', stroke: 'white', 'stroke-width': 1.5,
                    ...(state.mode === 'edit' ? { 'data-vertex': i } : {}) });
                dot.style.pointerEvents = 'none'; svg.append(dot);
            });
        }
    };
    let last = 0;
    const loop = now => {
        if (disposed) return;
        if (now - last > 90) {
            try { redraw(); } catch (error) { handlers.error(error); }
            last = now;
        }
        frameId = requestAnimationFrame(loop);
    };
    frameId = requestAnimationFrame(loop);
    return { dispose() {
        disposed = true; cancelAnimationFrame(frameId);
        document.removeEventListener('pointerdown',down,true);
        document.removeEventListener('mousedown',stopMouse,true);
        document.removeEventListener('click',stopMouse,true);
        document.removeEventListener('pointermove',move,true);
        document.removeEventListener('mousemove',move,true);
        document.removeEventListener('pointerup',finish,true);
        document.removeEventListener('pointercancel',finish,true);
        document.removeEventListener('contextmenu',stopMouse,true);
        svg.remove();
    }, redraw };
}

// Draw semantic polygons into the actual offscreen snapshot bytes. The on-screen
// SVG is a DOM overlay and is NOT part of SuperSplat's native PNG renderer.
export function snapshotPolygonLayout(meta, overlay) {
    if (!overlay?.rooms?.length) return [];
    const frame = { projection: {data: meta.projection_matrix}, view: {data: meta.view_matrix} };
    const y = overlay.floor ? (overlay.floor.y_min + overlay.floor.y_max) / 2 : 0;
    return overlay.rooms.map(room => {
        const points = room.polygon_xz.map(point => projectXZ(point, y,
            overlay.semantic_to_world, frame, meta.image_width, meta.image_height));
        const center = points.reduce((sum,point) => [sum[0]+point[0],sum[1]+point[1]], [0,0])
            .map(value => value / points.length);
        return { name: room.name, room_id: room.room_id, points, center };
    });
}
export async function annotateSemanticSnapshotPng(png, meta, overlay) {
    const rooms = snapshotPolygonLayout(meta, overlay);
    if (!rooms.length) return png;
    if (typeof document === 'undefined' || typeof createImageBitmap !== 'function')
        throw new Error('Semantic snapshot annotation needs browser canvas and image decoding.');
    const bitmap = await createImageBitmap(new Blob([png], {type:'image/png'}));
    try {
        const canvas = document.createElement('canvas');
        canvas.width = meta.image_width; canvas.height = meta.image_height;
        const ctx = canvas.getContext('2d');
        if (!ctx) throw new Error('Unable to create snapshot overlay canvas.');
        ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
        const scale = Math.max(1, Math.min(canvas.width,canvas.height)/1080);
        ctx.lineWidth=3*scale;ctx.strokeStyle='#ff9e23';ctx.fillStyle='#fff';
        ctx.lineJoin='round';ctx.font=`bold ${Math.round(20*scale)}px sans-serif`;
        for (const room of rooms) {
            if (room.points.length < 3 || !room.points.flat().every(Number.isFinite)) continue;
            ctx.beginPath(); ctx.moveTo(...room.points[0]);
            for (const point of room.points.slice(1)) ctx.lineTo(...point);
            ctx.closePath();ctx.stroke();
            const title=room.name;
            const width=ctx.measureText(title).width+12*scale;
            const x=room.center[0], y=room.center[1];
            ctx.fillStyle='rgba(0,0,0,0.8)';
            ctx.fillRect(x-width/2,y-17*scale,width,26*scale);
            ctx.fillStyle='#fff';ctx.textAlign='center';ctx.fillText(title,x,y+3*scale);
        }
        const encoded = await new Promise((resolve,reject) =>
            canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('Unable to encode semantic PNG.')), 'image/png'));
        return new Uint8Array(await encoded.arrayBuffer());
    } finally { bitmap.close?.(); }
}
