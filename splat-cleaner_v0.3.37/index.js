/** Region-Aware Splat Cleaner v0.3.37 hybrid GPU SNS Stage 2; native mask-service GPU Floaters; SNS reverse-coverage verification; managed external plugin; import has no side effects.
 * Audited integration pattern: XYZ v1.0.4 / SuperSplat 3.7.0/v3.8.0; pinned internal API contracts.
 * Internal SuperSplat scene APIs are version-sensitive; not a general plugin SDK.
 */
import { assert, tick, analyzeDensity, computeSelection, previewHidden, subsetRuns, buildReport, analyzeComponents, AXES, RULE_BITS, candidateMaskForRule, resolveOpacityMode, validOpacityThreshold } from './core.mjs';
import { readFloaterColumns, runSplatTransformFloaters } from './floater-adapter.mjs';
import {floaterSettings} from './native-protocol.mjs';
import { detectNativeSplatTransform } from './native-floaters.mjs';
import { autoVoxelResolution } from './auto-voxel.mjs';
import { readSnsGeometry, analyzeSnsBidirectionalSupport } from './sns-support.mjs';
import { accelerateSnsOutgoing } from './sns-gpu.mjs';
import { createSnsReverseSearch } from './sns-reverse-gpu.mjs';
const showError = error => error instanceof Error ? error.message : String(error);
// Diagnostic lock tint defaults; exact appearance must be checked in Editor v3.8.0.
const DEFAULT_TINT_HEX = '#ff6b0f';
const DEFAULT_TINT_OPACITY = 0.8;
function parseMethodTintStyle(hex, opacity) {
    assert(typeof hex === 'string' && /^#[0-9a-fA-F]{6}$/.test(hex),
        'Method Tint color must be a 6-digit hex color.');
    assert(opacity !== '' && opacity !== null && opacity !== undefined,
        'Method Tint opacity must be between 0.05 and 1.');
    const a=Number(opacity);
    assert(Number.isFinite(a) && a>=0.05 && a<=1,
        'Method Tint opacity must be between 0.05 and 1.');
    return {r:parseInt(hex.slice(1,3),16)/255,
        g:parseInt(hex.slice(3,5),16)/255,
        b:parseInt(hex.slice(5,7),16)/255,a};
}
const METHOD_TINT_COLOR = Object.freeze(parseMethodTintStyle(DEFAULT_TINT_HEX,DEFAULT_TINT_OPACITY));
function methodTintHex(style) {
    return '#' + ['r','g','b'].map(ch=>Math.round(style[ch]*255).toString(16).padStart(2,'0')).join('');
}
const INSPECTION_METHODS = Object.freeze({
    size: {bit: RULE_BITS.size, enabled: c => c.sizeEnabled},
    opacity: {bit: RULE_BITS.opacity, enabled: c => resolveOpacityMode(c)==='independent'},
    sns: {bit: RULE_BITS.sns, enabled: c => c.snsEnabled},
    floaters: {bit: RULE_BITS.floaters, enabled: c => c.floaterEnabled || c.selectedComponentId != null},
    splatTransformFloaters: {bit: RULE_BITS.splatTransformFloaters, enabled: c => c.splatTransformEnabled}
});
// Data validity is independent of the applied cleaning-rule toggles; the UI
// exposes Method Tint only for methods the user has explicitly selected.
const METHOD_ENABLE_KEYS = Object.freeze({
    size:'sizeEnabled',opacity:'opacityEnabled',sns:'snsEnabled',
    floaters:'floaterEnabled',splatTransformFloaters:'splatTransformEnabled'
});
function methodTintEligible(method, cache) {
    if (!Object.prototype.hasOwnProperty.call(METHOD_ENABLE_KEYS,method) || !cache.data || !cache.density)
        return false;
    const n=cache.data.centers.x.length;
    const opacityReady=cache.data.opacities?.length===n &&
        cache.opacityEncoding===cache.analyzedOpacityEncoding && validOpacityThreshold(cache.opacityThreshold);
    switch(method) {
        case 'size': return cache.data.sizes?.length===n;
        case 'opacity': return opacityReady;
        case 'sns': return cache.snsMask?.length===n && !!cache.snsDetails &&
            cache.snsDetails.k===cache.snsParameters?.k &&
            cache.snsDetails.min_neighbors===cache.snsParameters?.m &&
            (resolveOpacityMode(cache)!=='restrict-sns' || opacityReady);
        case 'floaters': return cache.components?.labels?.length===n &&
            !!cache.components.sizes?.length && Number.isInteger(cache.componentMax) &&
            cache.componentMax>=1 && cache.componentMax<=1000000;
        case 'splatTransformFloaters': return cache.stMask?.length===n && !!cache.stDetails &&
            cache.opacityEncoding===cache.analyzedOpacityEncoding;
    }
    return false;
}
// Selection gates Method Tint availability; it never clears or changes cached data.
// Component inspection is selected by either the small-component checkbox or
// an explicit group, matching the existing cleaning-rule semantics.
function methodSelectedForTint(method, config) {
    return !!INSPECTION_METHODS[method]?.enabled(config);
}
// Automatic refresh is legal only after a successful manual application with
// unchanged analysis data; an active Apply may accept later checkbox changes,
// but Analyze/export/restore must never be bypassed by a UI event.
function canAutoRefreshMethodToggle({hasChoice,analysisValid,busy,applying,activeExport,restoring,gpuUnavailable,restoreError}) {
    return !!hasChoice && !!analysisValid && (!busy || !!applying) &&
        !activeExport && !restoring && !gpuUnavailable && !restoreError;
}
// A DISPLAY-ONLY one-rule evaluation. The frozen OR candidate selection is never
// mutated, and the same v0.3.4 selection algorithm still defines each rule.
// For an unchecked method, enable the requested rule in an ephemeral copy of the applied config.
function inspectionCandidateMask(selection, method, centers, density, config, attributes) {
    const entry=INSPECTION_METHODS[method];
    assert(entry && METHOD_ENABLE_KEYS[method], 'Unknown inspection method.');
    if(entry.enabled(config)) return candidateMaskForRule(selection,entry.bit);
    const inspected=computeSelection(centers,density,{...config,[METHOD_ENABLE_KEYS[method]]:true,
        ...(method==='opacity' ? {opacityMode:'independent'} : {})},attributes);
    return candidateMaskForRule(inspected,entry.bit);
}
// Reusing SNS/GPU results after Analyze requires the underlying centers to agree.
// A different model, transform or instance mapping is rejected separately.
function sameCenters(before, after) {
    if(!before || !after)return false;
    for(const axis of AXES) {
        const a=before.centers?.[axis],b=after.centers?.[axis];
        if(!a || !b || a.length!==b.length)return false;
        for(let i=0;i<a.length;i++)if(a[i]!==b[i])return false;
    }
    return true;
}
function colorEqualsRGBA(a,b) {
    return !!a && !!b && ['r','g','b','a'].every(ch => a[ch] === b[ch]);
}
function hasOriginalLocked(flags) {
    return !!flags && Array.prototype.some.call(flags, flag => (flag & 2) !== 0);
}
// Applies display-only native locked color; the source Gaussian palette is never modified.
function applyLockDisplayColor(color, saved, mode, active, tintStyle=METHOD_TINT_COLOR) {
    color.copy(saved);
    if (!active) return;
    if (mode==='method-tint') {
        for (const channel of ['r','g','b','a']) color[channel]=tintStyle[channel];
    } else color.a=0; // Existing Candidates/Cleaned binary visibility contract.
}
// Original-view Method Tint: locked bit carries the highlight; no other display channel is used.
// The same verified Preview remains the sole temporary lock-bit owner.
function updateActiveMethodTint(scene, preview, lockedColor, originalColor, expectedLockColor, tintStyle, isolation) {
    assert(preview && isolation, 'Method Tint is not active or model isolation is missing.');
    assert(colorEqualsRGBA(lockedColor,expectedLockColor),
        'Editor locked color was changed outside Splat Cleaner; unsafe to overwrite.');
    preview.verify(scene);
    isolation.ensure();
    applyLockDisplayColor(lockedColor,originalColor,'method-tint',true,tintStyle);
    scene.forceRender=true;
    return lockedColor.clone();
}

// In SuperSplat the selected-color shader uses the native active model and
// Selection Outline/Selection Tint appearance. Fail before flag mutation if the
// available Editor interface cannot provide visible Candidates tint.
// Resolve the actual renderer contract, not an Editor version string.
// v3.9.1 removes the global blend function but uses per-model selectionAlpha.
function candidatesTintBlend(events, model) {
    const registry=events.functions;
    const knownRegistry=typeof registry?.has==='function';
    const legacy=!knownRegistry || registry.has('view.splatsSelectionBlend');
    if(legacy) {
        assert(Number.isFinite(events.invoke('view.splatsSelectionBlend')),
            'SuperSplat Gaussian selection blend is unavailable.');
        return {
            read:()=>events.invoke('view.splatsSelectionBlend'),
            write:value=>events.fire('view.setSplatsSelectionBlend',value)
        };
    }
    assert(Number.isFinite(model?.selectionAlpha),
        'SuperSplat model selection alpha is unavailable.');
    return {read:()=>model.selectionAlpha,write:value=>{model.selectionAlpha=value;}};
}
function candidatesTintRendererReady(scene, model) {
    assert(scene.events.invoke('selection')===model,
        'Candidates Method Tint requires this model to be the active Editor selection. Select it in the Scene Manager.');
    assert(scene.events.invoke('view.outlineSelection')!==true,
        'Disable Selection Outline in Editor Appearance before Candidates Method Tint.');
    const color=scene.events.invoke('selectedClr');
    assert(color?.clone && color?.copy,'Native selected-color service unavailable for Candidates tint.');
    assert(typeof scene.events.invoke('view.selectionColor')==='boolean',
        'SuperSplat Selection Color is unavailable.');
    candidatesTintBlend(scene.events,model);
    return color;
}
// The Editor defaults to selection-centers ON and Gaussian Selection Color OFF.
// Temporary selected flags alone would therefore tint only the centers. This
// display-only owner enables full Gaussian tint and restores both preferences.
// Never overwrite an appearance setting edited externally while the tint is active.
class CandidatesTintAppearance {
    constructor(events,model) {
        this.events=events;
        this.blend=candidatesTintBlend(events,model);
        this.originalColor=events.invoke('view.selectionColor');
        this.originalBlend=this.blend.read();
        assert(typeof this.originalColor==='boolean' && Number.isFinite(this.originalBlend),
            'Native Gaussian selection appearance is unavailable.');
        this.expectedColor=this.originalColor;
        this.expectedBlend=this.originalBlend;
    }
    verify() {
        assert(this.events.invoke('view.selectionColor')===this.expectedColor &&
            this.blend.read()===this.expectedBlend,
            'Editor Gaussian selection appearance changed outside Splat Cleaner; unsafe to overwrite.');
    }
    enable(opacity) {
        assert(Number.isFinite(opacity) && opacity>=0.05 && opacity<=1,
            'Candidates Method Tint opacity must be between 0.05 and 1.');
        this.verify();
        if(!this.expectedColor)this.events.fire('view.setSelectionColor',true);
        // The renderer reads the global blend on legacy Editors, or the
        // exact selected model's selectionAlpha on v3.9.1.
        if(this.expectedBlend!==opacity)this.blend.write(opacity);
        this.expectedColor=true;this.expectedBlend=opacity;
        this.verify();
    }
    restore() {
        this.verify();
        if(this.expectedColor!==this.originalColor)
            this.events.fire('view.setSelectionColor',this.originalColor);
        if(this.expectedBlend!==this.originalBlend)
            this.blend.write(this.originalBlend);
        this.expectedColor=this.originalColor;this.expectedBlend=this.originalBlend;
        this.verify();
    }
}
// Candidates-view tint needs THREE states: non-candidates hidden, other OR candidates
// normal, and the selected method's candidates highlighted. The existing locked
// channel hides the first group; temporary selected bit (1) colors the third.
// Both flag bits are controlled by the SAME Preview owner and restored together.
function candidatePreviewMasks(selection, methodBit, independentMask=null) {
    const hidden=previewHidden(selection,'candidates',false); // unchanged OR candidate visibility
    const highlight=independentMask ?? candidateMaskForRule(selection,methodBit);
    assert(highlight.length===hidden.length,'Candidate highlight mask length mismatch.');
    // The selected method may be unchecked. Only tint the intersection of its
    // cached candidates with the unchanged, currently visible OR candidates.
    const visibleHighlight=new Uint8Array(highlight.length);
    for(let i=0;i<hidden.length;i++)
        visibleHighlight[i]=highlight[i] && !hidden[i] ? 1 : 0;
    return {hidden,highlight:visibleHighlight};
}
function applySelectedDisplayColor(color, saved, active, tintStyle=METHOD_TINT_COLOR) {
    color.copy(saved);
    if(active) for(const channel of ['r','g','b','a'])color[channel]=tintStyle[channel];
}
function updateActiveCandidatesTint(scene, preview, lockedColor, originalColor,
        expectedLockColor, selectedColor, originalSelectedColor, expectedSelectedColor,
        tintStyle, isolation, appearance) {
    assert(preview && isolation && selectedColor && originalSelectedColor && appearance,
        'Candidates Method Tint is not active or display ownership is missing.');
    assert(colorEqualsRGBA(lockedColor,expectedLockColor) &&
        colorEqualsRGBA(selectedColor,expectedSelectedColor),
        'Editor preview colors were changed outside Splat Cleaner; unsafe to overwrite.');
    preview.verify(scene);
    appearance.verify();
    assert(scene.events.invoke('selection')===preview.splat &&
        scene.events.invoke('view.outlineSelection')!==true,
        'Candidates Method Tint requires the original active Editor model with Selection Outline disabled.');
    assert(preview.selectedMask,'Candidates Method Tint selected-mask state is missing.');
    isolation.ensure();
    applySelectedDisplayColor(selectedColor,originalSelectedColor,true,tintStyle);
    appearance.enable(tintStyle.a);
    scene.forceRender=true;
    return selectedColor.clone();
}

function validatedSnsParameters(kValue,mValue) {
    const k=Number(kValue),m=Number(mValue);
    assert(Number.isFinite(k) && k>=1 && k<=10 && Number.isInteger(k*2),
        'SNS k must be 1–10 in steps of 0.5.');
    assert(Number.isInteger(m) && m>=1 && m<=50, 'SNS m must be an integer 1–50.');
    return {k,m};
}
// Experimental policy ceiling; actual adapter/device limits are checked separately.

// Only the UI is rounded. Internal model bounds, masks and export use full precision.
const display3 = value => Number.isFinite(value) ? Number(value.toFixed(3)).toFixed(3) : '';
const round3 = value => Number(value.toFixed(3));
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
function reviseRoiInterval(interval, domain, side, value) {
    assert(side === 'min' || side === 'max', 'Invalid ROI endpoint.');
    assert(Number.isFinite(value), 'ROI coordinate must be finite.');
    const next = { ...interval, [side]: clamp(value, domain.min, domain.max) };
    if (next.min > next.max) next[side] = next[side === 'min' ? 'max' : 'min'];
    return next;
}
const dl = (bytes, filename) => {
    const url = URL.createObjectURL(new Blob([bytes], {type:'application/json'}));
    const link = document.createElement('a'); link.href = url; link.download = filename;
    document.body.append(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
};
function modelAttached(scene, splat) {
    return !!splat && scene.elements?.includes(splat) && splat.scene === scene && !!splat.instances && !!splat.resource?.source;
}
function loadedSplats(scene) { return scene.elements.filter(e => modelAttached(scene, e)); }
function selectedModel(scene, splat) {
    assert(modelAttached(scene, splat), 'Selected 3DGS model was removed. Refresh models.');
    assert(splat.visible, 'Selected model is hidden in the Editor. Make it visible first.');
    return splat;
}
function transformOf(splat, id) {
    const palette = splat.worldTransform.clone();
    splat.transformPalette.getTransform(id, palette);
    return splat.worldTransform.clone().mul2(splat.worldTransform, palette);
}
// Capture the dense instance mapping independently from mutable Editor buffers.
function snapshotMapping(instances) {
    const n=instances.count;
    assert(instances.sourceRow?.length>=n && instances.palette?.length>=n,'Incomplete instance mapping.');
    return {rows:instances.sourceRow.slice(0,n),palette:instances.palette.slice(0,n)};
}
function mappingCurrent(instances,snapshot) {
    const n=instances.count;
    if(snapshot.rows?.length!==n||snapshot.palette?.length!==n||instances.sourceRow?.length<n||instances.palette?.length<n)return false;
    for(let i=0;i<n;i++)if(snapshot.rows[i]!==instances.sourceRow[i]||snapshot.palette[i]!==instances.palette[i])return false;
    return true;
}
// Matrix details are copied only when a failed Apply requests a diagnostic.
function analysisInvalidReason(scene, selected, stopped, data, identity, details=false, checkMapping=true) {
    const issue=(code,message,extra)=>({code,message,...extra});
    const matrixIssue=(code,message,saved,current,extra)=>{
        if(!details)return issue(code,message,extra);
        const before=Array.from(saved.data), after=Array.from(current.data);
        return issue(code,message,{...extra,saved:before,current:after,
            maxAbsoluteDifference:Math.max(...before.map((v,i)=>Math.abs(v-after[i])))});
    };
    if(!data)return issue('BASE_DATA_MISSING','Base analysis is missing');
    if(!identity)return issue('ANALYSIS_IDENTITY_MISSING','Saved analysis identity is missing');
    if(stopped)return issue('PLUGIN_STOPPED','Cleaner is deactivated');
    if(!selected)return issue('NO_MODEL','No model is selected');
    if(!modelAttached(scene,selected)) {
        if(!scene.elements?.includes(selected))return issue('MODEL_NOT_IN_SCENE','Selected model is no longer in the scene');
        if(selected.scene!==scene)return issue('MODEL_SCENE_CHANGED','Selected model belongs to a different scene');
        if(!selected.instances)return issue('INSTANCES_MISSING','Selected model has no instance collection');
        return issue('SOURCE_MISSING','Selected model has no geometry source');
    }
    if(selected!==identity.model)return issue('MODEL_CHANGED','Selected model object changed');
    if(selected.instances!==identity.instances)return issue('INSTANCES_CHANGED','Editor instance collection was replaced');
    if(selected.resource.source!==identity.source)return issue('SOURCE_CHANGED','Editor geometry source was replaced');
    if(selected.instances.count!==data.centers.x.length)return issue('COUNT_CHANGED','Instance count changed',
        {savedCount:data.centers.x.length,currentCount:selected.instances.count});
    if(checkMapping && !mappingCurrent(selected.instances,identity))return issue('MAPPING_CHANGED','Instance/source mapping changed');
    const world=selected.worldTransform;
    if(!world.equals(identity.world))return matrixIssue('WORLD_CHANGED','World transformation changed',identity.world,world);
    for(const [id,matrix] of data.transformMap) {
        const current=transformOf(selected,id);
        if(!current.equals(matrix))return matrixIssue('PALETTE_CHANGED',`Effective palette transformation ${id} changed`,matrix,current,{paletteId:id});
    }
    return null;
}
function similarTransformScale(matrix) {
    // Effective principal scale is max(source std-dev) * uniform world-scale.
    // Reject shears and nonuniform or singular transforms instead of mislabeling sizes.
    const m = matrix.data || matrix;
    if (!m || m.length !== 16) return null;
    const c = [[m[0],m[1],m[2]], [m[4],m[5],m[6]], [m[8],m[9],m[10]]];
    const lens = c.map(v => Math.hypot(...v));
    const factor = (lens[0] + lens[1] + lens[2]) / 3;
    if (!Array.from(m).every(Number.isFinite) || Math.abs(m[3])>1e-6 || Math.abs(m[7])>1e-6 ||
        Math.abs(m[11])>1e-6 || Math.abs(m[15]-1)>1e-6 ||
        !Number.isFinite(factor) || factor <= 1e-12 || lens.some(l => Math.abs(l-factor) > 1e-4 * factor)) return null;
    for (let i=0;i<3;i++) for (let j=i+1;j<3;j++) {
        const dot = c[i].reduce((sum,v,k) => sum+v*c[j][k],0);
        if (Math.abs(dot) > 1e-4*factor*factor) return null;
    }
    return factor;
}
function indicesFromPredicate(total, predicate) {
    // Native GaussianInstances setBits()/clearBits() reads .forEach(), not array type.
    return { forEach(fn) { for (let i=0;i<total;i++) if (predicate(i)) fn(i); } };
}
function isolationFor(scene, target) {
    const hidden = new Map();
    let revision = 0;
    const conceal = element => {
        if (element === target || !modelAttached(scene, element) || !element.visible) return;
        hidden.set(element, true); element.visible = false; scene.forceRender = true;
    };
    for (const element of loadedSplats(scene)) conceal(element);
    const added = scene.events.on('scene.elementAdded', e => { revision++; conceal(e); });
    const removed = scene.events.on('scene.elementRemoved', () => { revision++; });
    return {
        ensure() { for (const element of loadedSplats(scene)) conceal(element); },
        revision() { return revision; },
        restore() {
            added.off(); removed.off();
            for (const [element, visible] of hidden)
                if (modelAttached(scene, element) && !element.visible) element.visible = visible;
            scene.forceRender = true;
        }
    };
}

/** Read instance-aligned world-space centers and geometric attributes in chunks.
 * SuperSplat 3.8.0 / SplatTransform 3.11.1 ChunkSource geometric.opacity
 * is TRUE LINEAR opacity (canonical chunk/layout.ts contract), unlike the
 * v3.10.2 compatibility source which can pass through raw logits. Users of
 * SuperSplat 3.7.0 select explicit logit interpretation instead of guessing.
 * SplatTransform DataTable.opacity remains logit; the GPU bridge converts.
 */
async function readModel(splat, cancelled, progress, {opacityEncoding='linear'} = {}) {
    assert(['linear','logit'].includes(opacityEncoding), 'Unsupported opacity interpretation.');
    const { source, sourcePool } = splat.resource;
    assert(sourcePool?.acquire && source?.read, 'Gaussian chunk source/pool API unavailable.');
    const n = splat.instances.count;
    assert(n > 0 && Number.isInteger(source.meta.chunkSize) && source.meta.chunkSize > 0,
        'Selected model has no readable Gaussian source.');
    assert(source.meta.layouts.position, 'Missing Gaussian position layer.');
    const centers = { x:new Float64Array(n), y:new Float64Array(n), z:new Float64Array(n) };
    // These are optional. If the installed source does not match the expected
    // field/encoding contract, no attribute filter is offered.
    const layout = source.meta.layouts.geometric;
    const fields = layout?.fields || {};
    const scaleLayout = fields.scale?.components === 3 && fields.scale?.type === 'float32';
    const opacityLayout = fields.opacity?.components === 1 && fields.opacity?.type === 'float32';
    let scaleEnabled = scaleLayout, opacityEnabled = opacityLayout;
    let sizes = scaleEnabled ? new Float32Array(n) : null;
    let opacities = opacityEnabled ? new Float32Array(n) : null;
    let aboveOneCount = 0;
    let opacityFailure = null, scaleFailure = null;
    const transformMap = new Map(), uniformScales = new Map();
    for (let offset=0; offset<n; offset+=source.meta.chunkSize) {
        assert(!cancelled(), 'Analysis cancelled.');
        const count = Math.min(source.meta.chunkSize,n-offset);
        const position = sourcePool.acquire('position', source.meta.layouts.position, count);
        const geometric = layout && (scaleEnabled || opacityEnabled) ? sourcePool.acquire('geometric', layout, count) : null;
        try {
            if (geometric) {
                try { await source.read({indices:splat.instances.sourceRow,indexOffset:offset,count,position,geometric}); }
                catch (_decodeError) {
                    const reason = showError(_decodeError);
                    opacityFailure ||= `geometric layer read failed at source-row offset ${offset}: ${reason}`;
                    scaleFailure ||= `geometric layer read failed at source-row offset ${offset}: ${reason}`;
                    // Density must still be available if optional geometric decoding fails.
                    scaleEnabled=false; opacityEnabled=false;
                    await source.read({indices:splat.instances.sourceRow,indexOffset:offset,count,position});
                }
            } else await source.read({indices:splat.instances.sourceRow,indexOffset:offset,count,position});
            const xyz = new Float32Array(position.data, 0, count*3);
            // Determine field names from runtime metadata instead of guessing a byte offset.
            let s=null, a=null;
            try { s = scaleEnabled ? geometric.field('scale') : null; } catch(e) { scaleFailure ||= `scale field read failed at offset ${offset}: ${showError(e)}`; scaleEnabled=false; }
            try { a = opacityEnabled ? geometric.field('opacity') : null; } catch(e) { opacityFailure ||= `opacity field read failed at offset ${offset}: ${showError(e)}`; opacityEnabled=false; }
            if (scaleEnabled && s?.length !== count*3) { scaleFailure ||= `scale field length at offset ${offset} was ${s?.length ?? 'missing'}, expected ${count*3}`; scaleEnabled = false; }
            if (opacityEnabled && a?.length !== count) { opacityFailure ||= `opacity field length at offset ${offset} was ${a?.length ?? 'missing'}, expected ${count}`; opacityEnabled = false; }
            for (let j=0;j<count;j++) {
                const i=offset+j, palette=splat.instances.transformIndex(i);
                if (!transformMap.has(palette)) {
                    const matrix=transformOf(splat,palette);
                    transformMap.set(palette,matrix);
                    uniformScales.set(palette,similarTransformScale(matrix));
                }
                const m=transformMap.get(palette).data;
                const x=xyz[j*3],y=xyz[j*3+1],z=xyz[j*3+2];
                centers.x[i]=m[0]*x+m[4]*y+m[8]*z+m[12];
                centers.y[i]=m[1]*x+m[5]*y+m[9]*z+m[13];
                centers.z[i]=m[2]*x+m[6]*y+m[10]*z+m[14];
                if (scaleEnabled) {
                    const scale=uniformScales.get(palette);
                    const size=Math.exp(Math.max(s[j*3],s[j*3+1],s[j*3+2])) * scale;
                    if (scale === null || !Number.isFinite(size) || size <= 0) {
                        scaleFailure ||= `invalid effective scale at instance ${i} (source row ${splat.instances.sourceRow[i]})`;
                        scaleEnabled=false;
                    }
                    else sizes[i]=size;
                }
                if (opacityEnabled) {
                    const value=a[j];
                    // Raw logit in legacy v3.10.2 sources; linear in v3.11.1 chunk sources.
                    // +/-Infinity are valid logits representing fully opaque/
                    // transparent alpha; NaN is not. Linear override permits >1.
                    if (Number.isNaN(value) || (opacityEncoding==='linear' && (!Number.isFinite(value) || value<0))) {
                        opacityFailure ||= `invalid ${opacityEncoding} opacity at instance ${i} (source row ${splat.instances.sourceRow[i]}): ${String(value)}`;
                        opacityEnabled=false;
                    } else {
                        const decoded=opacityEncoding==='logit'
                            ? (value>=0 ? 1/(1+Math.exp(-value)) : Math.exp(value)/(1+Math.exp(value)))
                            : value;
                        if (!Number.isFinite(decoded)) {opacityEnabled=false; opacityFailure ||= `decoded opacity is nonfinite at instance ${i}`;}
                        else {opacities[i]=decoded; if(decoded>1) aboveOneCount++;}
                    }
                }
            }
        } finally { position.release(); geometric?.release(); }
        progress(offset+count,n);
        await tick();
    }
    if (!scaleEnabled) sizes=null;
    if (!opacityEnabled) opacities=null;
    return { centers, sizes, opacities, transformMap,
        attributeStatus: {
            size: scaleEnabled ? 'available' : (scaleLayout ? `disabled: ${scaleFailure || 'unsupported effective transform or invalid scale values'}` : 'disabled: source geometric.scale (log std-dev ×3) unavailable'),
            opacity: opacityEnabled ? (opacityEncoding==='logit' ? 'available (raw logit → sigmoid; legacy v3.10.2 source contract)' : (aboveOneCount
                ? `available (linear; ${aboveOneCount.toLocaleString()} values > 1 are permitted)`
                : 'available (linear)'))
                : (opacityLayout ? `disabled: ${opacityFailure || 'non-finite/negative opacity or unreadable source'}`
                    : 'disabled: float32 geometric.opacity unavailable')
        }};
}

/** Reversible preview. Binary and Original-tint modes mutate only locked bit (2).
 * Candidates-tint additionally uses selected bit (1), under the same state owner.
 * Original flags and source-row/palette mapping are always restored/verified.
 */
class Preview {
    constructor(splat, data) {
        this.splat=splat; this.instances=splat.instances; this.data=data;
        this.original=this.instances.flags.slice(0,this.instances.count);
        this.sourceRows=this.instances.sourceRow.slice(0,this.instances.count);
        this.palette=this.instances.palette.slice(0,this.instances.count);
        this.world=splat.worldTransform.clone();
        this.transforms=new Map([...data.transformMap].map(([id,m])=>[id,m.clone()]));
        this.hidden=null;
        this.selectedMask=null; // Only used by Candidates-view Method Tint.
    }
    verify(scene) {
        assert(modelAttached(scene,this.splat) && this.splat.visible && this.instances===this.splat.instances &&
            this.instances.count===this.original.length && this.splat.worldTransform.equals(this.world),
            'Selected model changed; preview must be closed and reanalyzed.');
        const n=this.original.length;
        for(let i=0;i<n;i++) {
            assert(this.instances.sourceRow[i]===this.sourceRows[i] && this.instances.palette[i]===this.palette[i],
                'Instance/source mappings changed; preview invalid.');
            const expected = this.selectedMask
                ? ((this.original[i] & ~1) | (this.selectedMask[i] ? 1 : 0) | (this.hidden?.[i] ? 2 : 0))
                : (this.original[i] | (this.hidden?.[i] ? 2 : 0));
            assert(this.instances.flags[i] === expected,
                'Native Gaussian flags were modified outside Splat Cleaner; unsafe to overwrite.');
        }
        for(const [id,saved] of this.transforms)
            assert(transformOf(this.splat,id).equals(saved), 'Model palette transform changed; reanalyze.');
    }
    setHidden(scene, hidden, selectedMask=null) {
        this.verify(scene);
        const n=this.original.length;
        assert(hidden.length===n, 'Preview mask length mismatch.');
        if(selectedMask) {
            assert(selectedMask.length===n, 'Highlight mask length mismatch.');
            for(let i=0;i<n;i++)assert(!selectedMask[i] || !hidden[i],
                'A hidden Gaussian cannot be selected for Candidates Method Tint.');
        }
        this.instances.clearBits(indicesFromPredicate(n,i=>!(this.original[i]&2)),2);
        this.instances.setBits(indicesFromPredicate(n,i=>!!hidden[i]),2);
        // Selected-bit mutation exists ONLY for Candidates-view tint. Restore the
        // exact initial selection when returning to a normal binary preview.
        if(selectedMask || this.selectedMask) {
            this.instances.clearBits(indicesFromPredicate(n,()=>true),1);
            this.instances.setBits(indicesFromPredicate(n,i=>selectedMask ? !!selectedMask[i] : !!(this.original[i]&1)),1);
        }
        // Record CPU state before native GPU upload; failed GPU contents cannot
        // safely be inferred from the previous mask.
        this.hidden=hidden;
        this.selectedMask=selectedMask;
        try { this.instances.flush(); }
        catch(e) {
            // Restore CPU flags without issuing a second upload to a potentially lost device.
            this.instances.clearBits(indicesFromPredicate(n,()=>true),3);
            this.instances.setBits(indicesFromPredicate(n,i=>!!(this.original[i]&1)),1);
            this.instances.setBits(indicesFromPredicate(n,i=>!!(this.original[i]&2)),2);
            this.hidden=null;this.selectedMask=null;
            this.uploadFailed=true;
            throw e;
        }
        scene.forceRender=true;
    }
    restore(scene) {
        assert(!this.uploadFailed, 'Native GPU preview upload previously failed; reload the Editor. CPU flags have been reverted.');
        this.verify(scene);
        const n=this.original.length;
        this.instances.clearBits(indicesFromPredicate(n,i=>!(this.original[i]&2)),2);
        this.instances.setBits(indicesFromPredicate(n,i=>!!(this.original[i]&2)),2);
        if(this.selectedMask) {
            this.instances.clearBits(indicesFromPredicate(n,()=>true),1);
            this.instances.setBits(indicesFromPredicate(n,i=>!!(this.original[i]&1)),1);
        }
        this.hidden=null;this.selectedMask=null;
        try { this.instances.flush(); } catch(e) { this.uploadFailed=true; throw e; }
        scene.forceRender=true;
        for(let i=0;i<n;i++) assert(this.instances.flags[i]===this.original[i], 'Preview restoration did not preserve original flags.');
    }
}

function makeExportLayers(splat, selection) {
    const ranges=subsetRuns(selection.candidates);
    assert(ranges.count>0, 'No Gaussians remain after candidate removal.');
    assert(typeof splat.createLayer==='function', 'Native subset layer API unavailable.');
    const layer=splat.createLayer(ranges, `${splat.name} (cleaned)`);
    try {
        assert(layer.worldTransform.equals(splat.worldTransform), 'Native export layer transform differs from source.');
        return { layers:[layer], count:ranges.count };
    } catch(e) { layer.destroy(); throw e; }
}

const FORMATS=new Set(['ply','splat','sog','spz']);
function exportChoices(format, choice) {
    assert(FORMATS.has(format) && choice?.filename, 'Invalid export choice.');
    const fileType=format==='ply' && choice.compressedPly ? 'compressedPly' : format;
    return { fileType, options: {
        filename:choice.filename,splatIdx:'all',serializeSettings:{shBands:choice.shBands},
        ...(format==='sog' ? {sogIterations:choice.sogIterations}:{}),
        ...(format==='spz' ? {spzVersion:choice.spzVersion}:{})
    }};
}
function reportName(filename, suffix='') {
    const stem=filename.replace(/\.(?:compressed\.ply|ply|splat|sog|spz)$/i,'');
    return `${stem}.export${suffix}.json`;
}
async function saveReport(report, directory) {
    const bytes=new TextEncoder().encode(JSON.stringify(report,null,2));
    if (directory) {
        let name;
        for (let i=0; i<1000; i++) {
            name=reportName(report.model_file,i?`-${i+1}`:'');
            try { await directory.getFileHandle(name); }
            catch(e) { if(e.name==='NotFoundError') break; throw e; }
            if(i===999) throw new Error('No unused export report filename available.');
        }
        const file=await directory.getFileHandle(name,{create:true});
        const writable=await file.createWritable();
        try { await writable.write(bytes); await writable.close(); }
        catch(e) { try { await writable.abort(); } catch(_) {} throw e; }
        return {delivery:'saved',filename:name};
    }
    const name=reportName(report.model_file);
    dl(bytes,name);
    return {delivery:'download_requested',filename:name};
}

// Shared (same-origin) floating-window stacking across independently loaded plugins.
// Each plugin retains ownership of its own controls, minimize state and cleanup.
function attachPluginWindow(panel, content, minimizeButton) {
    const key = '__supersplatPluginFloatingStackV1';
    const stack = window[key] || (window[key] = { panels: [] });
    const bringToFront = () => {
        stack.panels = stack.panels.filter(item => item !== panel);
        stack.panels.push(panel);
        // Reassign bounded z-indices to avoid unbounded growth after repeated clicks.
        stack.panels.forEach((item, index) => { item.style.zIndex = String(1150 + index); });
    };
    let minimized = false;
    let prior = null;
    const setMinimized = value => {
        if (value === minimized) return;
        if (value) {
            const rect = panel.getBoundingClientRect?.();
            prior = {
                width: Number.isFinite(rect?.width) && rect.width > 0 ? `${rect.width}px` : panel.style.width,
                height: Number.isFinite(rect?.height) && rect.height > 0 ? `${rect.height}px` : panel.style.height,
                minHeight: panel.style.minHeight,
                maxHeight: panel.style.maxHeight,
                resize: panel.style.resize,
                overflow: panel.style.overflow,
                overflowY: panel.style.overflowY,
                contentDisplay: content.style.display
            };
            if (prior.width) panel.style.width = prior.width;
            panel.style.height = 'auto';
            panel.style.minHeight = '0px';
            panel.style.maxHeight = 'calc(100vh - 32px)';
            panel.style.resize = 'none';
            panel.style.overflow = 'hidden';
            panel.style.overflowY = 'hidden';
            content.style.display = 'none';
        } else {
            panel.style.width = prior.width || '';
            panel.style.height = prior.height || '';
            panel.style.minHeight = prior.minHeight || '';
            panel.style.maxHeight = prior.maxHeight || '';
            panel.style.resize = prior.resize || '';
            panel.style.overflow = prior.overflow || '';
            panel.style.overflowY = prior.overflowY || '';
            content.style.display = prior.contentDisplay || '';
        }
        minimized = value;
        minimizeButton.textContent = minimized ? 'Restore' : 'Minimize';
        minimizeButton.setAttribute('aria-expanded', String(!minimized));
        minimizeButton.title = minimized ? 'Restore plugin window' : 'Minimize plugin window';
        minimizeButton.setAttribute('aria-label', minimizeButton.title);
    };
    const onMinimize = () => { setMinimized(!minimized); bringToFront(); };
    minimizeButton.type = 'button';
    minimizeButton.textContent = 'Minimize';
    minimizeButton.setAttribute('aria-expanded', 'true');
    minimizeButton.addEventListener('click', onMinimize);
    panel.addEventListener('pointerdown', bringToFront);
    panel.addEventListener('focusin', bringToFront);
    bringToFront();
    return {
        bringToFront,
        restoreWindow() { setMinimized(false); bringToFront(); },
        isMinimized() { return minimized; },
        dispose() {
            panel.removeEventListener?.('pointerdown', bringToFront);
            panel.removeEventListener?.('focusin', bringToFront);
            minimizeButton.removeEventListener?.('click', onMinimize);
            stack.panels = stack.panels.filter(item => item !== panel);
            stack.panels.forEach((item, index) => { item.style.zIndex = String(1150 + index); });
        }
    };
}

function panelHTML() {
    return `<div id="sc-header" style="display:flex;justify-content:space-between;gap:8px;align-items:center;flex:none">
          <strong style="flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">Region-Aware Splat Cleaner</strong>
          <span style="display:flex;gap:6px;align-items:center"><button id="sc-minimize" type="button" aria-label="Minimize Splat Cleaner">Minimize</button><button id="sc-hide" type="button">Close</button></span></div>
        <div id="sc-window-body" style="display:flex;flex:1 1 auto;min-height:0;flex-direction:column">
        <p id="sc-progress" role="status" style="font-size:11px;color:#bddcff;flex:none;margin:7px 0;max-height:3.4em;overflow-y:auto">Choose a loaded model and Analyze. Preview never deletes splats in place.</p>
        <div id="sc-scroll" tabindex="0" aria-label="Splat Cleaner settings (scrollable)"
          style="flex:1 1 auto;min-height:0;overflow-y:auto;overflow-x:hidden;scrollbar-gutter:stable;padding-right:4px">
          <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin:5px 0">
            <label>Loaded Model <select id="sc-model"></select></label>
            <button id="sc-models" type="button">Refresh</button><button id="sc-analyze" type="button">Analyze</button>
            <button id="sc-sns-find" type="button">Analyze SNS</button>
            <button id="sc-st-find" type="button">Analyze GPU Floaters</button>
          </div>
          <div id="sc-controls" hidden>
            <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center">
              <label>Density <select id="sc-density"><option value="all">All</option><option value="sparse">Sparse</option><option value="medium">Medium</option><option value="dense">Dense</option></select></label>
              <button id="sc-roi-reset" type="button">Reset XYZ ROI</button>
            </div>
            <details id="sc-roi-details" style="margin-top:8px"><summary style="cursor:pointer">XYZ region (world coordinates; 3 d.p.)</summary>
              <div id="sc-roi" style="margin:7px 0"></div>
            </details>
            <details id="sc-rules-details" style="margin-top:8px"><summary style="cursor:pointer">Candidate rules (off by default)</summary>
              <fieldset style="border:1px solid #555;margin:7px 0;padding:8px">
                <label><input type="checkbox" id="sc-size-enabled"> Large Gaussian size (scope percentile)</label>
                <label style="display:block;margin:5px 0 9px">Percentile <input id="sc-size-p" type="number" min="1" max="100" value="99" step="0.5" style="width:65px"></label>
                <label><input type="checkbox" id="sc-sns-enabled" disabled> Include SNS isolated candidates (experimental)</label>
                <div style="display:flex;gap:10px;flex-wrap:wrap;margin:5px 0">
                  <label>Extent k <input id="sc-sns-k" type="number" min="1" max="10" step="0.5" value="3" style="width:56px"></label>
                  <label>Min. neighbors m <input id="sc-sns-m" type="number" min="1" max="50" step="1" value="1" style="width:56px"></label>
                </div>
                <p id="sc-sns-status" style="font-size:11px;color:#b9c2cf;margin:5px 0 9px;white-space:pre-wrap">Not analyzed. Default k=3, m=1. Click Analyze SNS.</p>
                <label style="display:block">Opacity <select id="sc-opacity-mode" style="max-width:100%"><option value="off">Off</option><option value="independent">Independent Low opacity rule</option><option value="restrict-sns">Restrict SNS candidates</option></select></label>
                <label style="display:block;margin:5px 0">Below <input id="sc-opacity" type="number" min="0" max="1" value="0.01" step="0.005" style="width:80px"></label>
                <label style="display:block;margin:5px 0 9px;font-size:11px">Source opacity interpretation <select id="sc-opacity-encoding" style="max-width:100%"><option value="linear">Linear (default for v3.11.1 / Editor v3.8)</option><option value="logit">Raw logit → sigmoid (legacy v3.10.2 / Editor v3.7)</option></select></label>
                <span id="sc-opacity-note" style="font-size:11px;color:#b9c2cf">Uses cached opacity; no detector reanalysis required.</span>
                <p id="sc-attributes" style="font-size:11px;color:#b9c2cf;overflow-wrap:anywhere"></p>
              </fieldset>
            </details>
            <details id="sc-floater-details" style="margin-top:8px"><summary style="cursor:pointer">Detached components / floater candidates (experimental)</summary>
              <fieldset style="border:1px solid #555;margin:7px 0;padding:8px">
                <div style="display:flex;flex-wrap:wrap;align-items:center;gap:7px">
                  <button id="sc-find-components" type="button">Find components</button>
                  <label><input type="checkbox" id="sc-floater-enabled" disabled> Select small components</label>
                </div>
                <label style="display:block;margin:9px 0">Maximum Gaussian instances per candidate component
                  <input id="sc-component-max" type="number" min="1" max="1000000" step="10" value="500" style="width:85px"></label>
                <label style="display:block;margin:6px 0">Or select one detached component for inspection
                  <select id="sc-component-select" disabled style="width:100%;max-width:100%;box-sizing:border-box"><option value="">None — analyze first</option></select>
                </label>
                <p id="sc-component-status" style="font-size:11px;color:#b9c2cf;white-space:pre-wrap">Not calculated. Optional; runs only when requested.</p>
                <p style="font-size:11px;color:#f1d79a">Find identifies groups only. Tick Select small components or choose a group, then Apply / Preview. Export requires at least one candidate.</p>
                <p style="font-size:11px;color:#b9c2cf">26-connected occupied voxels; the largest component is protected. This is a geometric suggestion, not proof of a floater. Sparse legitimate geometry may also be selected.</p>
              </fieldset>
            </details>
            <details id="sc-st-details" style="margin-top:8px"><summary style="cursor:pointer">SplatTransform GPU floater filter (optional)</summary>
              <fieldset style="border:1px solid #555;margin:7px 0;padding:8px">
                <label style="display:block;margin:8px 0"><input type="checkbox" id="sc-st-enabled" disabled> Include GPU floater candidates</label>
                <p id="sc-st-service" style="font-size:11px;color:#b9c2cf;white-space:pre-wrap">Service: stopped.</p>
                <p id="sc-st-config" style="font-size:11px;color:#b9c2cf;white-space:pre-wrap"></p>
                <p id="sc-st-status" style="font-size:11px;color:#b9c2cf;white-space:pre-wrap">Not analyzed. Uses SplatTransform defaults (fixed voxel width 0.05 world units). Requires plugin-owned native service and system SplatTransform.</p>
                <p style="font-size:11px;color:#f1d79a">No parameters to tune. Analysis covers the whole selected model; ROI/density scope limits final candidates. Review Candidates/Cleaned before export.</p>
              </fieldset>
            </details>
            <p id="sc-counts" style="white-space:pre-wrap;font-size:12px;margin:10px 0"></p>
          </div>
        </div>
        <div id="sc-footer" hidden style="flex:none;border-top:1px solid #535b64;margin-top:8px;padding-top:8px">
          <div style="display:flex;gap:7px;flex-wrap:wrap;align-items:center">
            <label>View <select id="sc-view"><option value="original">Original</option><option value="candidates">Candidates</option><option value="cleaned">Cleaned</option></select></label>
            <label><input type="checkbox" id="sc-isolate"> Isolate scope</label>
            <button id="sc-apply" type="button" title="Required after Analyze or parameter/ROI changes. Method checkboxes refresh automatically after the first Apply.">Apply / Preview</button>
          </div>
          <div style="display:flex;gap:7px;flex-wrap:wrap;align-items:center;margin-top:7px">
            <label>Method Tint <select id="sc-inspect-method" disabled title="Only checked methods with valid analysis can be inspected in Original or Candidates view; do not edit while tinted">
              <option value="off">Off</option><option value="size">Size</option><option value="opacity">Opacity</option>
              <option value="sns">SNS</option><option value="floaters">Components</option>
              <option value="splatTransformFloaters">GPU Floaters</option></select></label>
            <span style="font-size:11px;color:#e9cd99">Inspect only; do not edit the scene while tinted.</span>
          </div>
          <div style="display:flex;gap:9px;align-items:center;flex-wrap:wrap;margin-top:7px">
            <label>Highlight color <input id="sc-tint-color" type="color" value="#ff6b0f" aria-label="Method Tint highlight color"
              style="width:34px;height:25px;vertical-align:middle;padding:0;border:0;background:transparent"></label>
            <label>Highlight opacity <input id="sc-tint-opacity" type="number" min="0.05" max="1" step="0.05" value="0.8"
              aria-label="Method Tint highlight opacity" style="width:57px"></label>
          </div>
          <div style="display:flex;gap:7px;align-items:center;flex-wrap:wrap;margin-top:7px">
            <select id="sc-format"><option value="ply">PLY / Compressed PLY</option><option value="splat">SPLAT</option><option value="sog">SOG</option><option value="spz">SPZ</option></select>
            <button id="sc-export" type="button" disabled title="Apply a nonempty removal selection first">Export Cleaned…</button>
            <button id="sc-restore" type="button">Restore</button>
          </div>
        </div></div>`;
}
    function axisMarkup(axis) {
        const cap=axis.toUpperCase();
        return `<div style="margin:9px 0;padding:9px;background:#303135;border:1px solid #505158;border-radius:7px">
          <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:6px">
            <strong>${cap} Axis</strong><span id="sc-${axis}-domain" style="font-size:11px;color:#c7c7c7"></span>
          </div>
          <div style="display:grid;grid-template-columns:88px minmax(0,1fr) 88px;gap:9px;align-items:center">
            <label style="font-size:12px;min-width:0">Min
              <input id="sc-${axis}-min" type="number" step="0.001" aria-label="${cap} minimum"
                style="display:block;margin-top:5px;width:100%;min-width:0;box-sizing:border-box;background:#222;color:#fff;border:1px solid #777;border-radius:5px;padding:5px 3px;font:inherit">
            </label>
            <div id="sc-${axis}-slider" role="group" aria-label="${cap} interval"
              style="position:relative;height:34px;margin:10px 11px 0;touch-action:none;user-select:none;cursor:pointer;min-width:0">
              <div style="position:absolute;left:0;right:0;top:14px;height:6px;border-radius:3px;background:#60646a;pointer-events:none"></div>
              <div id="sc-${axis}-selected" style="position:absolute;top:14px;height:6px;background:#77b6f8;cursor:grab;touch-action:none;z-index:1"></div>
              <button id="sc-${axis}-min-handle" data-handle="min" type="button" role="slider" aria-label="Minimum ${cap}"
                style="position:absolute;top:6px;left:0;width:22px;height:22px;border-radius:50%;border:2px solid #d9e8ff;background:#357dc8;transform:translateX(-50%);cursor:ew-resize;touch-action:none;z-index:3;padding:0"></button>
              <button id="sc-${axis}-max-handle" data-handle="max" type="button" role="slider" aria-label="Maximum ${cap}"
                style="position:absolute;top:6px;left:100%;width:22px;height:22px;border-radius:50%;border:2px solid #d9e8ff;background:#357dc8;transform:translateX(-50%);cursor:ew-resize;touch-action:none;z-index:4;padding:0"></button>
            </div>
            <label style="font-size:12px;min-width:0">Max
              <input id="sc-${axis}-max" type="number" step="0.001" aria-label="${cap} maximum"
                style="display:block;margin-top:5px;width:100%;min-width:0;box-sizing:border-box;background:#222;color:#fff;border:1px solid #777;border-radius:5px;padding:5px 3px;font:inherit">
            </label>
          </div>
          <div style="display:flex;justify-content:space-between;gap:8px;align-items:center;margin-top:7px">
            <span id="sc-${axis}-current" style="font-size:11px;color:#aad4ff"></span>
            <button type="button" id="sc-${axis}-reset">Reset</button>
          </div>
        </div>`;
    }

export async function activate({editor,uiHost,advanced,settings={}}) {
    const scene=window.scene;
    assert(scene?.elements && scene?.events && scene?.commandQueue && uiHost,
        'Splat Cleaner requires audited internal scene and a Plugin Manager UI host.');
    assert(scene.events.functions?.has('scene.write') && scene.events.functions?.has('show.exportPopup'),
        'Native Editor export services unavailable.');
    let panel=null, windowControls=null, selected=null, stopped=false, failure=null, busy=false, generation=0;
    let data=null,density=null,components=null,roiRanges=null,choice=null,preview=null,isolation=null,originalColor=null,lockedColor=null;
    let stMask=null, stDetails=null, snsMask=null, snsDetails=null, gpuUnavailable=false, analysisIdentity=null;
    let nativeAbort=null,nativeTask=null,nativeClosing=false,nativeRequested=false,nativeStopTask=null;
    // Only Floaters uses these settings; invalid input cannot block other methods.
    const native=advanced?.native;
    let nativeNotice='Service: stopped.';
    // Recover an owned service left behind by a browser reload. Activation does
    // not start a service; unavailable native management never blocks SNS/Analyze.
    if(typeof native?.status==='function'&&typeof native?.stop==='function'){
        try{
            const state=await native.status();
            nativeRequested=state?.state!=='stopped';
            await stopFloaters();
        }catch(e){nativeRequested=true;nativeNotice=`Service state not confirmed: ${showError(e)}`;}
    }
    async function stopFloaters(){
        if(!nativeRequested)return;
        if(typeof native?.stop!=='function')throw Error('Native shutdown capability unavailable.');
        if(!nativeStopTask)nativeStopTask=(async()=>{
            const result=await native.stop();
            if(result?.state!=='stopped')throw Error('Floaters service shutdown not confirmed.');
            nativeRequested=false;nativeNotice='Service: stopped.';
            if(panel)get('sc-st-service').textContent=nativeNotice;
        })().finally(()=>{nativeStopTask=null;});
        await nativeStopTask;
    }
    async function cleanupFloaters(){
        nativeAbort?.abort();
        // Stop first: pending Manager authorization/readiness must be interrupted.
        await stopFloaters();
        if(nativeTask)await nativeTask;
        await stopFloaters();
    }
    let restoreError=null, activeExport=false, selectionRestoring=false, analyzedOpacityEncoding=null;
    let expectedLockColor=null, displayMode='none';
    // Candidates-view tint additionally owns the Editor selected-color channel.
    let selectedColor=null, originalSelectedColor=null, expectedSelectedColor=null;
    let candidatesAppearance=null;
    // No history of selection combinations is retained. Method toggles coalesce
    // into the latest computeSelection/Preview update; parameter changes remain manual.
    let selectionRevision=0, methodRefreshPending=false, methodRefreshScheduled=false;
    let applyingSelection=false, restoreAfterApply=false;
    // Display-only preferences. They are not part of candidate selection or export reports.
    let tintStyle=METHOD_TINT_COLOR;
    let pipeline=Promise.resolve();
    const tasks=new Set();
    const track = promise => { tasks.add(promise); void promise.then(()=>tasks.delete(promise),()=>tasks.delete(promise)); return promise; };
    const queue = fn => { pipeline=pipeline.catch(()=>{}).then(()=>scene.commandQueue.enqueue(fn)); return pipeline; };
    const get=id=>panel?.querySelector(`#${id}`);
    const status=text => { if(panel) get('sc-progress').textContent=text; };
    const valid = () => !stopped && selected && modelAttached(scene,selected);
    let previousOpacityMode='off';
    const opacityThreshold=()=>{const value=get('sc-opacity').value.trim();return value==='' ? NaN : Number(value);};
    const snsParameters=()=>validatedSnsParameters(get('sc-sns-k').value,get('sc-sns-m').value);
    function availableForTint(method) {
        let params=null;
        try {params=snsParameters();} catch (_) { /* invalid SNS settings make SNS tint stale */ }
        const selectedRules={
            sizeEnabled:get('sc-size-enabled').checked,
            opacityMode:get('sc-opacity-mode').value,
            snsEnabled:get('sc-sns-enabled').checked,
            floaterEnabled:get('sc-floater-enabled').checked,
            selectedComponentId:get('sc-component-select').value==='' ? null : Number(get('sc-component-select').value),
            splatTransformEnabled:get('sc-st-enabled').checked
        };
        return methodSelectedForTint(method,selectedRules) && analysisCurrent() && methodTintEligible(method,{
            data,density,components,snsMask,snsDetails,stMask,stDetails,snsParameters:params,
            opacityMode:get('sc-opacity-mode').value,opacityThreshold:opacityThreshold(),
            opacityEncoding:get('sc-opacity-encoding').value,analyzedOpacityEncoding,
            componentMax:Number(get('sc-component-max').value)
        });
    }
    function refreshMethodOptions() {
        const select=get('sc-inspect-method');
        if (!select) return;
        const eligible=Object.keys(INSPECTION_METHODS).filter(availableForTint);
        select.disabled=!eligible.length || busy || activeExport || !!gpuUnavailable || !!restoreError;
        for (const option of select.options) {
            if(option.value!=='off') option.disabled=!eligible.includes(option.value);
        }
        // Valid cached data remains untouched when a method is unchecked;
        // it is simply no longer selectable for inspection.
        if(select.value!=='off' && !eligible.includes(select.value)) select.value='off';
    }
    function displayMask(mask, mode, highlight=null) {
        // Called ONLY within the existing serialized Editor command queue.
        assert(valid(), 'Model removed while applying display mask.');
        assert(['binary','method-tint','candidates-tint'].includes(mode),'Unknown preview display mode.');
        const active=mask.some(v=>v!==0) || !!highlight?.some(v=>v!==0);
        if(mode==='candidates-tint') {
            assert(highlight && highlight.length===mask.length,'Candidates tint requires a distinct highlight mask.');
            candidatesTintRendererReady(scene,selected);
        }
        if((mode==='method-tint'||mode==='candidates-tint') && active)
            assert(!hasOriginalLocked(preview?.original ?? selected.instances.flags),
                'Method Tint unavailable: model has originally locked Gaussians.');
        if (!preview) {
            lockedColor=scene.events.invoke('lockedClr');
            assert(lockedColor?.clone && lockedColor?.copy,'Native locked-color service unavailable.');
            originalColor=lockedColor.clone();
            expectedLockColor=originalColor.clone();
            preview=new Preview(selected,data);
        }
        assert(colorEqualsRGBA(lockedColor,expectedLockColor),
            'Editor locked color was changed outside Splat Cleaner; unsafe to overwrite.');
        preview.verify(scene);
        // Do not mutate instance flags until both color channels are verified.
        if(mode==='candidates-tint' && active && !selectedColor) {
            const clr=candidatesTintRendererReady(scene,selected);
            selectedColor=clr;originalSelectedColor=clr.clone();expectedSelectedColor=clr.clone();
        }
        if(selectedColor)assert(colorEqualsRGBA(selectedColor,expectedSelectedColor),
            'Editor selected color was changed outside Splat Cleaner; unsafe to overwrite.');
        candidatesAppearance?.verify();
        // The global color overrides can affect unrelated models: isolate them.
        if(active) {
            if(!isolation) isolation=isolationFor(scene,selected);
            else isolation.ensure();
        }
        // Preview is the ONLY writer for locked and temporary selected flags.
        preview.setHidden(scene,mask,mode==='candidates-tint' && active ? highlight : null);
        // Enable full Gaussian fill (not just the selected-center overlay).
        // Appearance changes affect rendering only and are never exported.
        if(mode==='candidates-tint' && active) {
            if(!candidatesAppearance)candidatesAppearance=new CandidatesTintAppearance(scene.events,selected);
            candidatesAppearance.enable(tintStyle.a);
        } else if(candidatesAppearance) {
            candidatesAppearance.restore();
            candidatesAppearance=null;
        }
        applyLockDisplayColor(lockedColor,originalColor,mode==='candidates-tint'?'binary':mode,active,tintStyle);
        if(selectedColor) {
            applySelectedDisplayColor(selectedColor,originalSelectedColor,mode==='candidates-tint' && active,tintStyle);
            expectedSelectedColor=selectedColor.clone();
            if(mode!=='candidates-tint') {
                selectedColor=null;originalSelectedColor=null;expectedSelectedColor=null;
            }
        }
        expectedLockColor=lockedColor.clone();
        displayMode=active ? mode : 'none';
        if(!active && isolation) {isolation.restore();isolation=null;}
        scene.forceRender=true;
    }
    async function exitTintForExport() {
        if(displayMode!=='method-tint' && displayMode!=='candidates-tint') return;
        await queue(()=>{
            assert(analysisCurrent(true),'Model changed before export; click Analyze again.');
            displayMask(new Uint8Array(choice.selection.candidates.length),'binary');
        });
        const control=get('sc-inspect-method');if(control)control.value='off';
        if(get('sc-view'))get('sc-view').value='original';
        status('Method Tint exited before export; frozen OR cleaning selection preserved.');
    }
    // UI readiness is advisory: avoid full dense scans on routine refreshes.
    // Indexed operations explicitly request the complete snapshot check.
    const analysisCurrent=(checkMapping=false)=>!analysisInvalidReason(scene,selected,stopped,data,analysisIdentity,false,checkMapping);
    function invalidateSnsSettings() {
        let params;
        try {params=snsParameters();} catch (_) {params=null;}
        if(snsDetails && (!params || snsDetails.k!==params.k || snsDetails.min_neighbors!==params.m)) {
            const enabled=get('sc-sns-enabled').checked;
            snsMask=null; snsDetails=null;
            get('sc-sns-enabled').checked=false;
            get('sc-sns-enabled').disabled=true;
            get('sc-sns-status').textContent='SNS settings changed. Click Analyze SNS again; GPU result is retained.';
            if(enabled || get('sc-inspect-method')?.value==='sns')
                invalidateAppliedSelection('SNS settings changed.');
            else status('SNS result marked stale. Other enabled rules and their previews are unchanged.');
            refreshMethodOptions();
        } else if(!params && (get('sc-sns-enabled').checked || get('sc-inspect-method')?.value==='sns')) {
            invalidateAppliedSelection('Enter valid SNS k and m values.');
            refreshMethodOptions();
        }
    }

    const clearCache=()=>{
        ++selectionRevision;methodRefreshPending=false;
        data=null;density=null;components=null;roiRanges=null;choice=null;analyzedOpacityEncoding=null;stMask=null;stDetails=null;snsMask=null;snsDetails=null;analysisIdentity=null;
        if(panel && get('sc-inspect-method')) get('sc-inspect-method').value='off';
        if(panel) {
            get('sc-controls').hidden=true;get('sc-footer').hidden=true;
            get('sc-floater-enabled').checked=false;get('sc-floater-enabled').disabled=true;
            get('sc-component-select').replaceChildren(new Option('None — analyze first',''));get('sc-component-select').disabled=true;
            get('sc-component-status').textContent='Not calculated. Optional; runs only when requested.';
            get('sc-sns-enabled').checked=false;get('sc-sns-enabled').disabled=true;
            get('sc-sns-status').textContent='Not analyzed. Click Analyze SNS with the current k/m values.';
            get('sc-st-enabled').checked=false;get('sc-st-enabled').disabled=true;
            get('sc-st-status').textContent='Not analyzed. Fixed voxel width 0.05 world units; plugin-owned native service and system SplatTransform required.';
            refreshOpacityUI();
        }
    };
    async function restore({preserveInspection=false}={}) {
        if (!preview && !isolation && !originalColor && !originalSelectedColor && !candidatesAppearance) return;
        const errors=[];
        try {
            await queue(()=>{
                // Do not write GPU state of a detached/destroyed model.
                if (preview && modelAttached(scene,preview.splat)) {
                    try { preview.restore(scene); } catch(e) {
                        errors.push(showError(e));
                        if (/device.{0,35}lost|GPUBuffer|DEVICE_HUNG|DEVICE_REMOVED|writeBuffer/i.test(showError(e)))
                            gpuUnavailable=true;
                    }
                }
                if (lockedColor && originalColor) {
                    if (colorEqualsRGBA(lockedColor,expectedLockColor)) lockedColor.copy(originalColor);
                    else errors.push('Shared Editor locked color changed externally; not overwritten.');
                }
                if(selectedColor && originalSelectedColor) {
                    if(colorEqualsRGBA(selectedColor,expectedSelectedColor)) selectedColor.copy(originalSelectedColor);
                    else errors.push('Shared Editor selected color changed externally; not overwritten.');
                }
                if(candidatesAppearance) {
                    try { candidatesAppearance.restore(); }
                    catch(e) { errors.push(`Gaussian appearance restoration: ${showError(e)}`); }
                }
                scene.forceRender=true;
            });
        } catch(e) { errors.push(`Native restoration: ${showError(e)}`); }
        try { isolation?.restore(); } catch(e) { errors.push(`Model visibility: ${showError(e)}`); }
        preview=null; isolation=null; lockedColor=null; originalColor=null;
        expectedLockColor=null;selectedColor=null;originalSelectedColor=null;expectedSelectedColor=null;
        candidatesAppearance=null;
        displayMode='none'; choice=null;
        if(!preserveInspection && panel && get('sc-inspect-method')) get('sc-inspect-method').value='off';
        updateExportReadiness();refreshMethodOptions();
        if (errors.length) {
            restoreError=errors.join('; ');
            throw new Error(`Preview restoration uncertain: ${restoreError}`);
        }
        if(!gpuUnavailable)restoreError=null;
    }
    function refreshModels() {
        if(!panel) return;
        const models=loadedSplats(scene);
        if(!models.includes(selected)) { selected=models.length===1?models[0]:null; clearCache(); }
        const select=get('sc-model');
        select.replaceChildren();
        const add=(text,value)=>{ const option=document.createElement('option'); option.textContent=text;option.value=value;select.append(option); };
        add(models.length?'Choose model…':'No 3DGS models','');
        models.forEach((m,i)=>add(`${m.name||'(unnamed)'} (#${i+1})${m.visible?'':' [hidden]'}`,String(i)));
        select.value=selected?String(models.indexOf(selected)):'';
        select.disabled=busy;
        get('sc-analyze').disabled=busy || !selected;
        get('sc-sns-find').disabled=busy || !selected;
        get('sc-st-find').disabled=busy || nativeClosing || !selected || gpuUnavailable;
    }
    function refreshOpacityUI() {
        const mode=get('sc-opacity-mode'), threshold=get('sc-opacity');
        if(!mode || !threshold)return;
        const sns=get('sc-sns-enabled');
        const snsReady=!!sns?.checked && !sns.disabled && !!snsMask && !!snsDetails;
        const ready=!!data?.opacities && get('sc-opacity-encoding').value===analyzedOpacityEncoding;
        // Parent deselection or invalidation resets the dependent mode before
        // automatic refresh. Stale opacity alone never silently broadens SNS.
        if(mode.value==='restrict-sns' && !snsReady) {
            mode.value='off';previousOpacityMode='off';
        }
        for(const option of mode.options) {
            if(option.value==='independent')option.disabled=!ready && mode.value!==option.value;
            if(option.value==='restrict-sns')option.disabled=!snsReady || (!ready && mode.value!==option.value);
        }
        threshold.disabled=!ready || mode.value==='off';
        get('sc-opacity-note').textContent=ready
            ? 'Uses cached opacity; click Apply / Preview after threshold or SNS restriction changes. No detector reanalysis required.'
            : 'Current opacity data unavailable. Analyze first, or choose Off.';
    }
    function refreshAttributeUI() {
        if(!data) return;
        const sizeOK=!!data.sizes;
        const size=get('sc-size-enabled');
        size.disabled=!sizeOK;
        if(!sizeOK) size.checked=false;
        get('sc-size-p').disabled=!sizeOK;
        refreshOpacityUI();
        get('sc-attributes').textContent=`Size: ${data.attributeStatus.size}. Opacity: ${data.attributeStatus.opacity}. SNS reads covariance separately when requested.`;
    }
    function invalidateAppliedSelection(message) {
        ++selectionRevision;
        methodRefreshPending=false;
        // Rule changes invalidate only the applied/frozen selection. Cached
        // analysis results and the chosen inspection method remain untouched.
        choice=null;
        updateExportReadiness();refreshMethodOptions();
        get('sc-counts').textContent='Selection settings changed. Click Apply / Preview to refresh candidate and retained counts.';
        // An in-flight preview may not have created its GPU owner yet. Defer
        // restoration even in that case, before returning for absent preview.
        if(applyingSelection)restoreAfterApply=true;
        if (!preview && !isolation) {status(message);return;}
        get('sc-view').value='original';
        if (selectionRestoring) return;
        if (busy || activeExport) {
            status('Finish current operation, then Apply / Preview manually for the changed settings.');return;
        }
        busy=true;selectionRestoring=true;
        track((async()=>{
            try {
                await restore({preserveInspection:true});
                get('sc-view').value='original';
                status(`${message} Previous preview restored; click Apply / Preview.`);
            } catch(e) {failure=e;status(`Previous preview could not be restored: ${showError(e)}`);}
            finally {selectionRestoring=false;busy=false;refreshModels();updateExportReadiness();}
        })());
    }
    function markRoiChanged() {
        invalidateAppliedSelection('XYZ region changed.');
    }
    function syncAxis(axis) {
        const d=density.bounds[axis], r=roiRanges[axis], span=d.max-d.min;
        const ratio=value => span>0 ? clamp((value-d.min)/span,0,1) : 0.5;
        const minPct=100*ratio(r.min), maxPct=100*ratio(r.max);
        get(`sc-${axis}-min`).value=display3(r.min);
        get(`sc-${axis}-max`).value=display3(r.max);
        get(`sc-${axis}-domain`).textContent=`Full ${axis.toUpperCase()}: ${display3(d.min)} to ${display3(d.max)}`;
        get(`sc-${axis}-current`).textContent=`Selected ${axis.toUpperCase()}: ${display3(r.min)} to ${display3(r.max)}`;
        get(`sc-${axis}-selected`).style.left=`${minPct}%`;
        get(`sc-${axis}-selected`).style.width=`${Math.max(0,maxPct-minPct)}%`;
        const together=Math.abs(maxPct-minPct)<0.01;
        for(const side of ['min','max']) {
            const handle=get(`sc-${axis}-${side}-handle`);
            handle.style.left=`${side==='min'?minPct:maxPct}%`;
            handle.style.transform=together
                ? `translateX(calc(-50% ${side==='min'?'-':'+'} 7px))` : 'translateX(-50%)';
            handle.setAttribute('aria-valuemin',String(side==='min'?d.min:r.min));
            handle.setAttribute('aria-valuemax',String(side==='min'?r.max:d.max));
            handle.setAttribute('aria-valuenow',String(r[side]));
            handle.setAttribute('aria-valuetext',`${display3(r[side])} model units`);
        }
    }
    function setAxisEndpoint(axis, side, value) {
        if(!density || !roiRanges || (busy && !selectionRestoring) || activeExport)return;
        const next=reviseRoiInterval(roiRanges[axis],density.bounds[axis],side,value);
        if(next.min!==roiRanges[axis].min || next.max!==roiRanges[axis].max) {
            roiRanges[axis]=next;markRoiChanged();
        }
        syncAxis(axis);
    }
    function bindAxis(axis) {
        const slider=get(`sc-${axis}-slider`),domain=density.bounds[axis];
        const positionToValue=x=>{
            const rect=slider.getBoundingClientRect();
            if(rect.width<=0 || domain.max===domain.min)return domain.min;
            return round3(domain.min+clamp((x-rect.left)/rect.width,0,1)*(domain.max-domain.min));
        };
        for(const side of ['min','max']) {
            const input=get(`sc-${axis}-${side}`);
            input.addEventListener('change',()=>{
                const value=Number(input.value);
                if(input.value.trim()==='' || !Number.isFinite(value)) {
                    status(`Invalid ${axis.toUpperCase()} coordinate. Enter a finite number.`);syncAxis(axis);return;
                }
                setAxisEndpoint(axis,side,round3(value));
            });
            get(`sc-${axis}-${side}-handle`).addEventListener('keydown',e=>{
                const old=roiRanges?.[axis]?.[side];
                if(old===undefined)return;
                const step=e.shiftKey?0.01:0.001;
                const value=e.key==='Home'?domain.min:e.key==='End'?domain.max:
                    e.key==='ArrowLeft'||e.key==='ArrowDown'?round3(old-step):
                    e.key==='ArrowRight'||e.key==='ArrowUp'?round3(old+step):null;
                if(value===null)return;
                e.preventDefault();setAxisEndpoint(axis,side,value);
            });
        }
        get(`sc-${axis}-reset`).onclick=()=>{
            if(!density || (busy && !selectionRestoring) || activeExport)return;
            roiRanges[axis]={...domain};syncAxis(axis);markRoiChanged();
        };
        let drag=null;
        slider.addEventListener('pointerdown',e=>{
            if(!roiRanges || (busy && !selectionRestoring) || activeExport || e.button!==0)return;
            const target=e.target;
            const handle=target?.closest?.('[data-handle]');
            const selectedTrack=target?.id===`sc-${axis}-selected`;
            const r=roiRanges[axis], value=positionToValue(e.clientX);
            let side=handle?.dataset.handle;
            if(!side && !selectedTrack) {
                side=Math.abs(value-r.min)<=Math.abs(value-r.max)?'min':'max';
                setAxisEndpoint(axis,side,value);
            }
            drag={id:e.pointerId,side:side??'range',startX:e.clientX,startRange:{...roiRanges[axis]}};
            slider.setPointerCapture(e.pointerId);
            e.preventDefault();
        });
        slider.addEventListener('pointermove',e=>{
            if(!drag || drag.id!==e.pointerId || !roiRanges)return;
            if(drag.side!=='range') {setAxisEndpoint(axis,drag.side,positionToValue(e.clientX));return;}
            const width=slider.getBoundingClientRect().width;
            if(width<=0)return;
            let delta=(e.clientX-drag.startX)/width*(domain.max-domain.min);
            delta=clamp(delta,domain.min-drag.startRange.min,domain.max-drag.startRange.max);
            const next={min:drag.startRange.min+delta,max:drag.startRange.max+delta};
            if(next.min!==roiRanges[axis].min || next.max!==roiRanges[axis].max) {
                roiRanges[axis]=next;markRoiChanged();syncAxis(axis);
            }
        });
        const endDrag=e=>{
            if(!drag || drag.id!==e.pointerId)return;
            drag=null;
            if(slider.hasPointerCapture(e.pointerId))slider.releasePointerCapture(e.pointerId);
        };
        slider.addEventListener('pointerup',endDrag);
        slider.addEventListener('pointercancel',endDrag);
    }
    function initializeBounds() {
        if(!density)return;
        roiRanges=Object.fromEntries(AXES.map(axis=>[axis,{...density.bounds[axis]}]));
        get('sc-roi').innerHTML=AXES.map(axisMarkup).join('');
        for(const axis of AXES){bindAxis(axis);syncAxis(axis);}
    }
    function readConfig() {
        assert(density && data && roiRanges,'Analyze before selecting a cleaning region.');
        const opacityMode=resolveOpacityMode({opacityMode:get('sc-opacity-mode').value,snsEnabled:get('sc-sns-enabled').checked});
        if(opacityMode!=='off' || get('sc-st-enabled').checked)
            assert(get('sc-opacity-encoding').value===analyzedOpacityEncoding,
                'Opacity encoding changed; click Analyze before applying opacity-dependent rules.');
        if(get('sc-st-enabled').checked)
            assert(stMask && stDetails, 'Run automatic GPU floater analysis before applying this rule.');
        if(get('sc-sns-enabled').checked) {
            assert(snsMask && snsDetails, 'Run SNS analysis before applying this rule.');
            const {k,m}=snsParameters();
            assert(snsDetails.k===k && snsDetails.min_neighbors===m, 'SNS settings changed; click Analyze SNS again.');
        }
        // Use full-precision internal endpoints: rounded displayed model bounds
        // must not accidentally exclude a few boundary Gaussians.
        const roi=Object.fromEntries(AXES.map(axis=>[axis,{...roiRanges[axis]}]));
        const percentile=Number(get('sc-size-p').value),opacity=opacityThreshold();
        assert(percentile>=1 && percentile<=100 && Number.isFinite(percentile), 'Size percentile must be from 1 to 100.');
        for(const a of AXES) assert(Number.isFinite(roi[a].min) && Number.isFinite(roi[a].max) && roi[a].min<=roi[a].max,
            `Invalid ${a.toUpperCase()} region bounds.`);
        const maxComponentGaussians=Number(get('sc-component-max').value);
        if(get('sc-floater-enabled').checked)
            assert(Number.isInteger(maxComponentGaussians) && maxComponentGaussians>=1 && maxComponentGaussians<=1000000,
                'Maximum candidate-component size must be an integer from 1 to 1000000.');
        const snsParams=get('sc-sns-enabled').checked?snsParameters():{k:null,m:null};
        return {roi,density:get('sc-density').value,snsK:snsParams.k,snsMinNeighbors:snsParams.m,
            floaterEnabled:get('sc-floater-enabled').checked,maxComponentGaussians,
            selectedComponentId:get('sc-component-select').value===''?null:Number(get('sc-component-select').value),
            sizeEnabled:get('sc-size-enabled').checked, sizePercentile:percentile,
            snsEnabled:get('sc-sns-enabled').checked,opacityMode,opacityThreshold:opacity,
            opacityEncoding:get('sc-opacity-encoding').value,
            splatTransformEnabled:get('sc-st-enabled').checked};
    }
    async function applyPreview(reuseSelection=false, expectedRevision=selectionRevision) {
        const invalid=!density ? {code:'DENSITY_MISSING',message:'Density analysis is missing'} :
            analysisInvalidReason(scene,selected,stopped,data,analysisIdentity,true);
        if(invalid) {
            // A serialized, small snapshot survives browser console-log export.
            console.warn('[Splat Cleaner] Preview validity: '+JSON.stringify({
                operation:reuseSelection?'reuse selection':'apply selection',model:selected?.name??null,
                ...invalid}));
            throw new Error(`${invalid.message} [${invalid.code}]; click Analyze again`);
        }
        assert(!gpuUnavailable, 'GPU device is unavailable after a failed upload/filter; reload the Editor before preview.');
        assert(!document.getElementById('custom-xyz-preview'),
            'Close XYZ Filter preview before using Splat Cleaner (both modify native visibility).');
        // View changes reuse the last applied selection: View changes display only,
        // and must not silently recompute masks from edited filter controls.
        const config=reuseSelection && choice ? choice.config : readConfig();
        // Compute candidate state first. An exception cannot partially alter GPU visibility.
        const selection=reuseSelection && choice ? choice.selection :
            computeSelection(data.centers,density,config,{sizes:data.sizes,opacity:data.opacities,components,splatTransformMask:stMask,snsMask});
        const method=get('sc-inspect-method')?.value ?? 'off';
        const tint=method!=='off';
        const view=get('sc-view').value;
        if(tint) {
            assert(availableForTint(method),
                'Selected method has no valid cached analysis for this model and settings.');
            assert((view==='original'||view==='candidates') && !get('sc-isolate').checked,
                'Method Tint supports Original or Candidates view with scope isolation off.');
        }
        const inspectionMask=tint ? inspectionCandidateMask(selection,method,data.centers,density,config,
            {sizes:data.sizes,opacity:data.opacities,components,splatTransformMask:stMask,snsMask}) : null;
        // Candidates always uses the frozen OR visibility mask, regardless of
        // whether the selected inspection method is checked for cleaning.
        const {hidden,highlight}=tint && view==='candidates'
            ? candidatePreviewMasks(selection,INSPECTION_METHODS[method].bit,inspectionMask)
            : {hidden:tint ? inspectionMask :
                previewHidden(selection,view,get('sc-isolate').checked),highlight:null};
        const tintCount=tint ? (highlight ?? hidden).reduce((a,b)=>a+b,0) : 0;
        const hasMask=hidden.some(v=>v!==0) || !!highlight?.some(v=>v!==0);
        if(tint && tintCount>0) assert(!hasOriginalLocked(preview?.original ?? selected.instances.flags),
            'Method Tint unavailable: originally locked Gaussian instances share the color channel.');
        if(tint && view==='candidates' && tintCount>0)
            candidatesTintRendererReady(scene,selected);
        // Initial Original view does not require native GPU flag writes.
        if (!preview && !isolation && (!tint || !hasMask) && !get('sc-isolate').checked && get('sc-view').value==='original') {
            if(expectedRevision!==selectionRevision)return false;
            choice={config,selection};updateExportReadiness();refreshMethodOptions();
            get('sc-counts').textContent=`Original: ${data.centers.x.length.toLocaleString()} | Candidates: ${selection.candidateCount.toLocaleString()} | Retained: ${selection.retainedCount.toLocaleString()}\nOriginal view needs no GPU preview upload.`;
            status(tint ? `No candidates for ${method} in the applied scope; no GPU display change needed.` :
                'Selection calculated. Choose Candidates/Cleaned to inspect it, or export the current applied selection.');
            return true;
        }
        await queue(()=>{
            assert(valid() && analysisCurrent(true), 'Model changed while applying cleaning preview; click Analyze again.');
            displayMask(hidden,tint && tintCount>0 ? (view==='candidates' ? 'candidates-tint' : 'method-tint') : 'binary',
                tint && tintCount>0 ? highlight : null);
        });
        // The GPU update was serialized, but controls may have changed while
        // it was pending. Never certify a stale selection for export.
        if(expectedRevision!==selectionRevision)return false;
        choice={config,selection};updateExportReadiness();refreshMethodOptions();
        get('sc-counts').textContent=`Original: ${data.centers.x.length.toLocaleString()}  |  ROI/density scope: ${selection.scopedCount.toLocaleString()}\n`+
            `Candidates: ${selection.candidateCount.toLocaleString()}  |  Retained: ${selection.retainedCount.toLocaleString()}\n`+
            `By rule — size ${selection.ruleCounts.size}, opacity ${selection.ruleCounts.opacity}, SNS ${selection.ruleCounts.sns}, components ${selection.ruleCounts.floaters}, SplatTransform ${selection.ruleCounts.splatTransformFloaters}`+
            (config.snsEnabled&&config.splatTransformEnabled?`\nSNS ∩ GPU: ${selection.snsGpuOverlap} (overlap counted once)`:'')+
            (config.floaterEnabled?`\nSelected disconnected groups in scope: ${selection.selectedFloaterComponents}`:'')+
            (selection.sizeResolvedThreshold!==null?`\nResolved size threshold: ${selection.sizeResolvedThreshold.toPrecision(5)}`:'')+
            (tint ? `\nMethod Tint (${method}): ${tintCount} candidates in ${view} view; inspection only. Do not edit while tinted.` :
                `\nNo permanent deletion. Native preview temporarily hides Gaussian instances.`);
        status(tint ? (tintCount ? `Method Tint: ${method} candidates highlighted in ${view} view. Editing while tinted is unsafe.` : `No in-scope candidates for ${method}; ${view} rendering shown without tint.`) : selection.candidateCount === 0
            ? 'No removal candidates. Enable a cleaning rule; checked methods refresh automatically after the first Apply / Preview.'
            : selection.retainedCount === 0
                ? 'All Gaussians selected: review thresholds. Export requires at least one retained Gaussian.'
                : 'Preview applied. Inspect Candidates/Cleaned before exporting.');
        return true;
    }
    async function doAnalyze() {
        assert(!busy && selected && valid(), 'Select a visible loaded model first.');
        busy=true; const token=++generation;
        methodRefreshPending=false;
        ++selectionRevision;
        // Keep prior method results until the new base analysis commits. SNS
        // is independent of opacity interpretation; GPU Floaters is not.
        const reusableBefore=analysisCurrent(true);
        const previousData=data, previousRoi=roiRanges;
        const previousOpacityEncoding=analyzedOpacityEncoding;
        refreshModels();
        const started=performance.now();
        const modelBefore=selected, instancesBefore=selected.instances, sourceBefore=selected.resource.source,
            worldBefore=selected.worldTransform.clone(), countBefore=selected.instances.count;
        try {
            await restore({preserveInspection:true});
            const mappingBefore=snapshotMapping(instancesBefore);
            const encodingBefore=get('sc-opacity-encoding').value;
            // A changed transform/model cannot retain stale indexed masks.
            if(!reusableBefore)clearCache();
            choice=null;
            status('Reading Gaussian positions and attributes…');
            const nextData=await readModel(selected,()=>stopped || token!==generation,
                (done,total)=>status(`Reading attributes… ${Math.round(done/total*100)}%`),
                {opacityEncoding:encodingBefore});
            assert(!stopped && token===generation && valid() && selected===modelBefore &&
                selected.instances===instancesBefore && selected.resource.source===sourceBefore &&
                selected.instances.count===countBefore && selected.worldTransform.equals(worldBefore) &&
                mappingCurrent(instancesBefore,mappingBefore) && get('sc-opacity-encoding').value===encodingBefore,
                'Analysis cancelled: model/source/transform/encoding changed.');
            for(const [palette,matrix] of nextData.transformMap) assert(transformOf(selected,palette).equals(matrix),
                'Palette transforms changed during analysis.');
            const nextDensity=await analyzeDensity(nextData.centers,{ resolution:128,
                cancelled:()=>stopped || token!==generation || !valid(),
                progress:(done,total)=>status(`Computing voxel density… ${Math.round(done/total*100)}%`) });
            assert(!stopped && token===generation && valid() && selected===modelBefore &&
                selected.instances===instancesBefore && selected.resource.source===sourceBefore &&
                selected.instances.count===countBefore && selected.worldTransform.equals(worldBefore) &&
                mappingCurrent(instancesBefore,mappingBefore) && get('sc-opacity-encoding').value===encodingBefore,
                'Analysis cancelled: model/source/transform/encoding changed.');
            for(const [palette,matrix] of nextData.transformMap) assert(transformOf(selected,palette).equals(matrix),
                'Palette transforms changed during density analysis.');
            const preserveMethods=reusableBefore && sameCenters(previousData,nextData);
            const nextEncoding=get('sc-opacity-encoding').value;
            // Atomic commit: only now replace base analysis; never clear other
            // method slots merely because Analyze was clicked.
            data=nextData;density=nextDensity;analyzedOpacityEncoding=nextEncoding;
            analysisIdentity={model:selected,instances:selected.instances,source:selected.resource.source,world:selected.worldTransform.clone(),...mappingBefore};
            if(!preserveMethods) {
                components=null;snsMask=null;snsDetails=null;stMask=null;stDetails=null;
                get('sc-floater-enabled').checked=false;get('sc-floater-enabled').disabled=true;
                get('sc-sns-enabled').checked=false;get('sc-sns-enabled').disabled=true;
                get('sc-st-enabled').checked=false;get('sc-st-enabled').disabled=true;
                get('sc-component-status').textContent='Not calculated. Optional; runs only when requested.';
                get('sc-sns-status').textContent='Model geometry changed. Click Analyze SNS again.';
                get('sc-st-status').textContent='Model geometry changed. Click Analyze GPU Floaters again.';
                populateComponentOptions();
            } else if(previousOpacityEncoding!==nextEncoding) {
                stMask=null;stDetails=null;
                get('sc-st-enabled').checked=false;get('sc-st-enabled').disabled=true;
                get('sc-st-status').textContent='Opacity interpretation changed. Run GPU Floaters again.';
            }
            initializeBounds();
            if(preserveMethods && previousRoi) {
                roiRanges=Object.fromEntries(AXES.map(axis=>[axis,{...previousRoi[axis]}]));
                for(const axis of AXES)syncAxis(axis);
            }
            refreshAttributeUI();get('sc-controls').hidden=false;get('sc-footer').hidden=false;
            get('sc-counts').textContent=`Density distribution — Sparse ${density.classCounts[0].toLocaleString()}, `+
                `Medium ${density.classCounts[1].toLocaleString()}, Dense ${density.classCounts[2].toLocaleString()}\n`+
                `Occupied voxel cells: ${density.occupiedCells.toLocaleString()}, cutoffs: ${density.cutoffs.join(' / ')}.`;
            status(`Analyzed ${data.centers.x.length.toLocaleString()} Gaussian instances in ${((performance.now()-started)/1000).toFixed(2)}s. ${preserveMethods?'Compatible SNS/GPU results retained. ':''}Density classes are not quality labels. Click Apply / Preview to refresh the frozen selection.`);
            return true;
        } catch(e) {
            // A failed Analyze must not delete earlier compatible SNS/GPU data.
            if(!reusableBefore)clearCache();
            status(`Analysis unavailable: ${showError(e)}`);
            return false;
        } finally { busy=false;refreshModels();updateExportReadiness(); }
    }
    function updateExportReadiness() {
        if (!panel) return;
        const ready=!!(choice && choice.selection.candidateCount>0 && choice.selection.retainedCount>0 && valid() && analysisCurrent() &&
            !methodRefreshPending && !restoreAfterApply && !gpuUnavailable && !busy && !activeExport);
        refreshOpacityUI();
        const button=get('sc-export');
        button.disabled=!ready;
        refreshMethodOptions();
        button.title=ready ? 'Export selected model after excluding approved candidates' :
            'Select candidates and click Apply / Preview before exporting';
    }
    function populateComponentOptions() {
        const select=get('sc-component-select');
        select.replaceChildren(new Option('None — small groups only or no floater selection',''));
        if(!components) {select.disabled=true;return;}
        // Surface the most significant detached components, not just tiny fragments.
        // Preserve the main component even if the user attempts to set its ID.
        const others=Array.from({length:components.sizes.length},(_,id)=>id)
            .filter(id=>id!==components.largestId)
            .sort((a,b)=>components.sizes[b]-components.sizes[a] || a-b)
            .slice(0,20);
        for(const id of others)
            select.append(new Option(`Group ${id+1}: ${components.sizes[id].toLocaleString()} splats (${components.cellCounts[id]} cells)`,String(id)));
        select.disabled=others.length===0;
    }
    function updateComponentSummary() {
        if(!components || !panel) return;
        const max=Number(get('sc-component-max').value);
        if(!Number.isInteger(max) || max<1 || max>1000000) {
            get('sc-component-status').textContent='Enter a component limit from 1 to 1000000.';
            return;
        }
        let small=0,n=0;
        for(let id=0;id<components.sizes.length;id++) {
            if(id!==components.largestId && components.sizes[id]<=max) {small++;n+=components.sizes[id];}
        }
        const sorted=[...components.sizes].sort((a,b)=>b-a);
        get('sc-component-status').textContent=`${components.componentCount.toLocaleString()} components; largest: ${components.sizes[components.largestId].toLocaleString()} Gaussians.\n`+
            `Next detached groups: ${sorted.slice(1,4).map(v=>v.toLocaleString()).join(' / ') || 'none'} Gaussians.\n`+
            `${small.toLocaleString()} small groups (${n.toLocaleString()} Gaussians) at current size limit, before ROI filtering.\n`+
            `Voxel width: ${display3(components.voxelWidth)} world units. ${components.coarseningPasses?'Grid coarsened to cap work.':''}`;
    }
    async function doFindComponents() {
        assert(!busy && !activeExport && density && data && valid() && analysisCurrent(true), 'Analyze a valid model first.');
        busy=true;const token=++generation;
        const model=selected,instances=selected.instances,source=selected.resource.source;
        const world=selected.worldTransform.clone();
        try {
            await restore({preserveInspection:true});
            status('Finding disconnected occupied-voxel components…');
            const result=await analyzeComponents(data.centers,{
                cancelled:()=>stopped || token!==generation || !valid(),
                progress:(phase,done,total)=>status(`Component ${phase}: ${Math.round(done/Math.max(total,1)*100)}%`)
            });
            assert(!stopped && token===generation && valid() && selected===model &&
                selected.instances===instances && selected.resource.source===source &&
                selected.worldTransform.equals(world), 'Model changed during component detection; reanalyze.');
            for(const [palette,matrix] of data.transformMap)
                assert(transformOf(selected,palette).equals(matrix),'Palette transforms changed; reanalyze.');
            assert(analysisCurrent(true),'Model mapping changed during component detection; reanalyze.');
            components=result;choice=null;updateExportReadiness();
            get('sc-floater-enabled').disabled=false;populateComponentOptions();
            updateComponentSummary();
            status('Components found. Tick Select small components OR choose a specific detached group, then Apply / Preview. No geometry deleted.');
        } catch(e) {
            components=null;get('sc-floater-enabled').checked=false;get('sc-floater-enabled').disabled=true;
            get('sc-component-select').replaceChildren(new Option('None — analyze first',''));get('sc-component-select').disabled=true;
            get('sc-component-status').textContent=`Unavailable: ${showError(e)}`;
            status(`Component analysis unavailable: ${showError(e)}`);
        } finally {busy=false;refreshModels();updateExportReadiness();}
    }
    async function doSnsSupport() {
        assert(!busy && !activeExport && valid(), 'Select a visible model first.');
        if(!data || !density) await doAnalyze();
        assert(!busy && data && density && analysisCurrent(true), 'Model data or transforms changed; click Analyze before SNS.');
        const {k,m}=snsParameters();
        if(snsMask && snsDetails?.k===k && snsDetails?.min_neighbors===m) {
            status(`SNS result already calculated (k=${k}, m=${m}). Checked methods update automatically after an initial Apply / Preview.`);
            return;
        }
        busy=true; const token=++generation;
        const model=selected, instances=model.instances, source=model.resource.source, world=model.worldTransform.clone();
        const rows=instances.sourceRow.slice(), palette=instances.palette.slice();
        // Fresh SNS evidence requires a new Apply even when Original view owns no preview.
        ++selectionRevision;methodRefreshPending=false;choice=null;
        snsMask=null;snsDetails=null;
        get('sc-sns-enabled').checked=false;get('sc-sns-enabled').disabled=true;
        updateExportReadiness();
        try {
            await restore({preserveInspection:true});
            const cancelled=()=>stopped || token!==generation || !valid() || selected!==model;
            const snsGeometryStart=performance.now();
            const geometry=await readSnsGeometry(model,data,{k,cancelled,
                progress:(done,total)=>status(`Reading SNS geometry… ${Math.round(done/total*100)}%`)});
            assert(!cancelled() && model.instances===instances && model.resource.source===source &&
                instances.count===rows.length && geometry.valid.length===rows.length &&
                model.worldTransform.equals(world), 'Model changed during SNS analysis.');
            for(let i=0;i<rows.length;i++)
                assert(rows[i]===instances.sourceRow[i] && palette[i]===instances.palette[i],
                    'Instance/source mapping changed during SNS analysis.');
            for(const [id,matrix] of data.transformMap)
                assert(transformOf(model,id).equals(matrix), 'Palette transform changed during SNS analysis.');
            const snsGeometryMs=Math.round(performance.now()-snsGeometryStart);
            status('Evaluating scale-normalized local center support…');
            let result=await analyzeSnsBidirectionalSupport(data.centers,geometry,{k,minSupport:m,cancelled,
                accelerate:gpuUnavailable?null:accelerateSnsOutgoing,
                accelerateReverse:gpuUnavailable?null:createSnsReverseSearch,
                progress:(done,total,stage)=>status(`SNS ${{'gpu-points':'1/2 GPU point upload','gpu-cells':'1/2 GPU cell upload','gpu-search':'1/2 GPU fast search','gpu-full-search':'1/2 GPU adaptive retry','outgoing':'1/2 CPU search','outgoing-cpu-search':'1/2 CPU unresolved search','outgoing-finalize':'1/2 CPU mask finalization','outgoing-cpu-directory':'1/2 CPU sparse directory','index':'2/2 candidate index','reverse':'2/2 exact reverse coverage','reverse-gpu':'2/2 GPU reverse tree search'}[stage]??'analysis'}… ${Math.round(done/total*100)}%`)});
            if(result.outgoingAcceleration?.device_lost||result.reverseAcceleration?.device_lost)gpuUnavailable=true;
            console.info('[Splat Cleaner] SNS processing diagnostics', {instances:rows.length,k,m,
                timings_ms:{geometry_read:snsGeometryMs,...result.timings},outgoing_acceleration:result.outgoingAcceleration,outgoing_cpu_search:result.outgoingCpuSearch,reverse_acceleration:result.reverseAcceleration,
                outgoing_candidates:result.outgoingCandidateCount,reverse_supported:result.reverseSupportedCount,
                reverse_inconclusive:result.reverseInconclusiveCount,final_candidates:result.candidateCount});
            // Opt-in diagnostic for a real scene. No extra default work or UI.
            let referenceVerification=null;
            if(globalThis.__splatCleanerVerifySnsCpu===true||globalThis.__splatCleanerVerifySnsHistory===true){
                const {auditSnsCompatibility}=await import('./sns-audit.mjs');
                status('Verifying SNS against full CPU reference…');
                const audit=await auditSnsCompatibility(result,data.centers,geometry,{k,minSupport:m,cancelled,
                    includeHistory:globalThis.__splatCleanerVerifySnsHistory===true,
                    progress:(done,total,stage)=>status(`SNS audit ${stage}… ${Math.round(done/total*100)}%`)});
                result=audit.result;referenceVerification=audit.verification;
                console.info('[Splat Cleaner] SNS CPU reference verification',referenceVerification);
            }
            assert(!cancelled() && model.instances===instances && model.resource.source===source &&
                instances.count===rows.length && geometry.valid.length===rows.length &&
                model.worldTransform.equals(world), 'Model changed during SNS neighborhood search.');
            for(let i=0;i<rows.length;i++)
                assert(rows[i]===instances.sourceRow[i] && palette[i]===instances.palette[i],
                    'Instance/source mapping changed during SNS neighborhood search.');
            for(const [id,matrix] of data.transformMap)
                assert(transformOf(model,id).equals(matrix), 'Palette transform changed during SNS neighborhood search.');
            for(let i=0;i<rows.length;i++)
                assert(geometry.locked[i]===((instances.flags[i]&2)?1:0),'Native lock state changed during SNS analysis.');
            assert(snsParameters().k===k && snsParameters().m===m, 'SNS parameters changed during analysis.');
            snsMask=result.candidateMask;
            snsDetails={method:'bidirectional_oriented_ellipsoid_center_support',k,min_neighbors:m,
                analysis_scope:'entire_selected_model',candidates_before_xyz_density_scope:result.candidateCount,
                supported:result.supportedCount,inconclusive:result.inconclusiveCount,
                invalid:result.invalidCount,locked_excluded:result.lockedExcluded,
                spatial_index_cell_width:result.cellWidth,
                timings_ms:{geometry_read:snsGeometryMs,...result.timings},
                outgoing_acceleration:result.outgoingAcceleration??{backend:'cpu',verified:0,reason:'GPU disabled or no eligible geometry'},
                outgoing_cpu_search:result.outgoingCpuSearch,
                outgoing_search_limits:{max_cells_per_query:result.outgoingCellBudget,max_comparisons_per_query:result.outgoingComparisonBudget},
                ...(referenceVerification?{reference_verification:referenceVerification}:{}),
                reverse_acceleration:result.reverseAcceleration??{backend:'cpu',reason:'GPU disabled, unavailable or no outgoing candidates'},
                reverse_coverage:{outgoing_candidates:result.outgoingCandidateCount,supported:result.reverseSupportedCount,
                    inconclusive:result.reverseInconclusiveCount,budget_limited_sources:result.reverseBudgetLimitedSources,
                    node_visits:result.reverseNodeVisits,comparisons:result.reverseComparisons,
                    max_nodes_per_source:result.reverseNodeBudget,max_comparisons_per_source:result.reverseComparisonBudget},
                limitations:'Distinct neighbors covering either center; bounded searches retain uncertainty. Not ellipsoid overlap or rendered contribution.'};
            get('sc-sns-enabled').disabled=false;
            // Analysis never implicitly enables a cleaning rule.
            get('sc-rules-details').open=true;
            get('sc-sns-status').textContent=`SNS: ${result.candidateCount.toLocaleString()} candidate(s), `+
                `${result.supportedCount.toLocaleString()} supported, ${result.inconclusiveCount.toLocaleString()} inconclusive; `+
                `${result.lockedExcluded.toLocaleString()} original locked instances protected. `+
                `Outgoing: ${result.outgoingAcceleration?.backend==='webgpu+cpu'?`WebGPU + CPU (${result.outgoingAcceleration.verified.toLocaleString()} supported, ${(result.outgoingAcceleration.exact??0).toLocaleString()} exact below threshold, ${(result.outgoingAcceleration.cpu_fallback??0).toLocaleString()} CPU fallback)`: `CPU${result.outgoingAcceleration?.reason?` (${result.outgoingAcceleration.reason})`: ''}`}. `+
                `Reverse coverage: ${result.reverseSupportedCount.toLocaleString()} supported, ${result.reverseInconclusiveCount.toLocaleString()} inconclusive. `+
                (referenceVerification?`CPU reference ${referenceVerification.match?'matched':'mismatch — using CPU result'}. `:'')+
                (referenceVerification?.historical?.status==='compared'?`Historical v0.3.10 CPU: ${referenceVerification.historical.reference.final_candidates.toLocaleString()} candidate(s). `:'')+
                `Outgoing candidates: ${result.outgoingCandidateCount.toLocaleString()}; reverse backend: ${result.reverseAcceleration?.backend??'cpu'}. k=${k}, m=${m}. Enable rule then Apply / Preview.`;
            status(`SNS calculated (k=${k}, m=${m}). ${gpuUnavailable?'GPU unavailable; reload before preview or further GPU analysis.':'Enable the SNS rule to include its candidates.'}`);
        }catch(e){
            snsMask=null;snsDetails=null;
            get('sc-sns-enabled').checked=false;get('sc-sns-enabled').disabled=true;
            get('sc-sns-status').textContent=`Unavailable: ${showError(e)}`;
            status(`SNS analysis unavailable: ${showError(e)}`);
        }finally{busy=false;refreshModels();updateExportReadiness();}
    }
    async function doSplatTransformFloaters() {
        assert(!busy && !nativeClosing && !activeExport && valid(), 'Select a valid visible model first.');
        const requestedModel=selected;
        const controller=new AbortController();nativeAbort=controller;
        let fresh=false,success=false,autoStop=true;
        busy=true;refreshModels();updateExportReadiness();
        try {
            // On every click, including cache hits, check the installed CLI first.
            // A failed dependency check must not invalidate analysis or preview.
            status('Checking local SplatTransform availability. Confirm native execution if the Manager prompts you…');
            const config=floaterSettings(settings);autoStop=config.autoStop;
            assert(typeof native?.start==='function' && typeof native?.stop==='function','Floaters requires the authorized native capability of Plugin Manager v1.12.');
            // Compare activation settings with saved settings before starting. Existing
            // Manager settings UI requires Save + reactivate; never modify its manifest here.
            const response=await fetch(new URL('../manifest.json',import.meta.url),{cache:'no-store',signal:controller.signal});
            assert(response.ok,'Cannot read saved Cleaner settings.');
            const folder=decodeURIComponent(new URL('.',import.meta.url).pathname.split('/').filter(Boolean).pop());
            const record=(await response.json()).plugins?.find(p=>p.id==='splat-cleaner'&&p.folder===folder);
            assert(record,'Installed Cleaner release missing from saved manifest.');
            const saved=floaterSettings(record.settings);
            assert(saved.autoStop===config.autoStop && saved.gpuBackend===config.gpuBackend,'Cleaner settings changed. Save and deactivate/reactivate Cleaner before Floaters.');
            const info=await detectNativeSplatTransform({signal:controller.signal,
                startService:async()=>{
                    nativeRequested=true;get('sc-st-service').textContent='Service: awaiting native port authorization / startup…';
                    try{return await native.start({signal:controller.signal});}catch(e){if(controller.signal.aborted||e?.code==='NATIVE_AUTH_CANCELLED')throw e;throw Error(`Floaters startup failed: ${showError(e)}`);}
                },
                verifyAssignment:async(owned,port)=>{
                    const projection=await fetch(new URL('../native-approvals.json',import.meta.url),{cache:'no-store',signal:controller.signal});
                    assert(projection.ok,'Native approval projection unavailable.');
                    const value=await projection.json();
                    const assigned=value?.schema_version===2 && value.plugins?.find(p=>p.id==='splat-cleaner'&&p.folder===folder&&p.approval_recorded===true);
                    assert(assigned?.port===port && owned.folder===folder,'Native port projection does not match the Manager-authorized installed release.');
                }});
            assert(info.gpu_backend===config.gpuBackend,'Running Floaters service backend differs from saved settings. Stop service and reactivate Cleaner.');
            get('sc-st-service').textContent=`Service: running on authorized port ${info.port}.`;
            assert(!stopped && !controller.signal.aborted && valid() && selected===requestedModel,'Native Floaters preflight cancelled.');
            const versionText=`System SplatTransform ${info.version}${info.commit?' ('+info.commit+')':''} · GPU backend: ${info.gpu_backend} (requested)`;
            if(info.warning){console.warn('[Splat Cleaner]',info.warning);get('sc-st-status').textContent=info.warning;get('sc-st-details').open=true;}
            assert(requestedModel.instances.count<=info.maxRows,`Native Floaters supports up to ${info.maxRows.toLocaleString()} instances per analysis (exact ID transport).`);
            status(`${versionText} available.${info.warning?' Unvalidated version; proceeding with fixed parameters.':''}`);
            // Base Analyze remains independent. Do it only after successful dependency detection.
            if(!data || !density || !analysisCurrent(true) || get('sc-opacity-encoding').value!==analyzedOpacityEncoding){
                busy=false;const refreshed=await doAnalyze();busy=true;refreshModels();
                assert(refreshed,'Base analysis refresh failed; GPU Floaters not started.');
            }
            assert(!gpuUnavailable, 'A previous Editor GPU failure requires Editor reload before preview or further analysis.');
            assert(!stopped && !controller.signal.aborted && valid() && selected===requestedModel && data && density && analysisCurrent(true), 'Model data or transforms changed; click Analyze before GPU Floaters.');
            assert(get('sc-opacity-encoding').value===analyzedOpacityEncoding,'Opacity encoding changed; click Analyze before GPU Floaters.');
            if(stMask && stDetails && stDetails.runtime_identity===info.identity && stDetails.gpu_backend===info.gpu_backend){success=true;status(`${versionText}: GPU Floaters result cached.${info.warning?' Unvalidated runtime.':''}`);return;}
            const token=++generation;
            const model=selected, instances=model.instances, source=model.resource.source, world=model.worldTransform.clone();
            const count=instances.count;
            const {rows,palette}=analysisIdentity;
            fresh=true;
            ++selectionRevision;methodRefreshPending=false;choice=null;
            stMask=null;stDetails=null;
            get('sc-st-enabled').checked=false;get('sc-st-enabled').disabled=true;
            updateExportReadiness();
            await restore({preserveInspection:true});
            assert(analysisCurrent(true) && analyzedOpacityEncoding===get('sc-opacity-encoding').value,
                'Model changed before geometry extraction.');
            status('Reading SplatTransform geometric attributes…');
            const cancelled=()=>controller.signal.aborted || stopped || token!==generation || !valid() || selected!==model;
            const columns=await readFloaterColumns(model,data,{
                cancelled,opacityEncoding:analyzedOpacityEncoding,
                progress:(done,total)=>status(`Reading floater geometry… ${Math.round(done/total*100)}%`)
            });
            assert(!cancelled() && model.instances===instances && model.resource.source===source &&
                instances.count===count && columns.x.length===count && model.worldTransform.equals(world), 'Model changed during SplatTransform analysis.');
            for (let i=0;i<rows.length;i++)
                assert(rows[i]===instances.sourceRow[i] && palette[i]===instances.palette[i],
                    'Instance/source mapping changed during SplatTransform analysis.');
            for (const [id,matrix] of data.transformMap)
                assert(transformOf(model,id).equals(matrix), 'Palette transform changed; reanalyze.');
            const auto=autoVoxelResolution(columns);
            const {voxelResolution,opacityCutoff,minContribution}=auto;
            const parameters={voxelResolution,opacityCutoff,minContribution};
            let metadata;
            status(`${versionText}: preparing native Floaters input…`);
            const candidate=await runSplatTransformFloaters(columns,parameters,{info,signal:controller.signal,cancelled,
                onMetadata:value=>{metadata=value;},
                progress:(stage,done,total)=>status(stage==='encoding'?`Encoding geometry… ${Math.round(done/total*100)}%`:`${versionText}: uploading / running native GPU Floaters. See native service logs for progress.${info.warning?' Unvalidated version.':''}`)});
            assert(!cancelled() && model.instances===instances && model.resource.source===source &&
                instances.count===count && candidate.length===count && model.worldTransform.equals(world), 'Model changed during GPU floater analysis.');
            for (let i=0;i<rows.length;i++)
                assert(rows[i]===instances.sourceRow[i] && palette[i]===instances.palette[i],
                    'Instance/source mapping changed during GPU floater analysis.');
            for (const [id,matrix] of data.transformMap)
                assert(transformOf(model,id).equals(matrix), 'Palette transform changed during GPU floater analysis.');
            assert(analyzedOpacityEncoding===get('sc-opacity-encoding').value,
                'Opacity encoding changed during GPU analysis.');
            stMask=candidate;
            const total=candidate.reduce((a,v)=>a+v,0);
            stDetails={method:`splat_transform_${info.version}_filterFloaters`,runtime_version:info.version,runtime_commit:info.commit??null,runtime_identity:info.identity,gpu_backend:metadata.gpu_backend,execution_backend:'system_splat_transform_cli_ply',version_warning:info.warning??null,parameters,automatic_voxel_sizing:auto,elapsed_ms:metadata.elapsed_ms,
                analysis_scope:'entire_selected_model',candidates_before_xyz_density_scope:total,
                limitations:'GPU voxel-contribution test; not guaranteed to remove internally supported detached clusters'};
            get('sc-st-enabled').disabled=false;
            get('sc-st-details').open=true;
            get('sc-st-status').textContent=`${versionText}. Analyzed ${candidate.length.toLocaleString()} instances; ${total.toLocaleString()} candidate(s) before scope. Fixed voxel width: 0.05 world units. ${info.warning?info.warning+' ':''}Click Apply / Preview to inspect.`;
            success=true;
            status('Native GPU floaters calculated. Enable its rule and click Apply / Preview to review.');
        } catch(e) {
            if(controller.signal.aborted||e?.code==='NATIVE_AUTH_CANCELLED'){
                get('sc-st-status').textContent='Native execution authorization cancelled. Existing analysis retained.';
                status('GPU Floaters cancelled. Click Analyze GPU Floaters to retry.');
                return;
            }
            // External process errors do not mark the Editor/SNS GPU unavailable.
            if(fresh){stMask=null;stDetails=null;get('sc-st-enabled').checked=false;get('sc-st-enabled').disabled=true;}
            console.error('[Splat Cleaner] Native GPU Floaters failed:',e);
            const gpuError=/DXGI_ERROR_DEVICE_HUNG/i.test(showError(e))?'SplatTransform GPU device lost (DXGI_ERROR_DEVICE_HUNG).':/device.{0,35}lost/i.test(showError(e))?'SplatTransform GPU device lost.':showError(e).split(/\r?\n/)[0].slice(0,180);
            get('sc-st-status').textContent=`${gpuError} ${!fresh&&stMask?'Existing cached result retained.':'No new candidate result generated.'} See management logs for details.`;
            get('sc-st-details').open=true;
            status('GPU Floaters analysis failed. See Floaters status and management logs.');
        } finally {
            if(autoStop||!success||controller.signal.aborted||nativeClosing||stopped){
                try{await stopFloaters();}catch(e){get('sc-st-service').textContent=`Service shutdown not confirmed: ${showError(e)}`;status(`Floaters shutdown failed: ${showError(e)}`);}
            }
            if(nativeAbort===controller)nativeAbort=null;busy=false;refreshModels();updateExportReadiness();
        }
    }
    async function doExport() {
        assert(choice && choice.selection.candidateCount>0 && choice.selection.retainedCount>0 && valid() && analysisCurrent(true),
            'Export requires a current applied selection and an unchanged model.');
        assert(!activeExport && !busy && !methodRefreshPending && !restoreAfterApply && !gpuUnavailable,
            'Finish automatic selection refresh before exporting, or reload the Editor after a GPU failure.');
        assert(scene.events.functions?.has('scene.write') && scene.events.functions?.has('show.exportPopup'), 'Native exporter unavailable.');
        // Begin browser-gesture-sensitive directory request before ANY await.
        const directoryPromise=window.showDirectoryPicker ? scene.events.invoke('scene.getExportDirectory') : undefined;
        activeExport=true;busy=true;
        const model=selected, frozenChoice=choice;
        const format=get('sc-format').value;
        const controls=[...panel.querySelectorAll('button,input,select')];
        const before=controls.map(e=>e.disabled); controls.forEach(e=>e.disabled=true);
        let layer=null,fileTarget=null,ok=false;
        try {
            const directory=await directoryPromise;
            // Preserve the frozen OR choice; never export while a temporary tint is active.
            await exitTintForExport();
            assert(valid() && selected===model && choice===frozenChoice && analysisCurrent(true), 'Model or cleaning selection changed.');
            await queue(()=>preview?.verify(scene));
            const dialog=await scene.events.invoke('show.exportPopup',format,[model.name],{directory});
            if(!dialog) {status('Export cancelled.');return;}
            ({fileTarget}=dialog);
            assert(valid() && selected===model && choice===frozenChoice && analysisCurrent(true), 'Model changed during export dialog.');
            await queue(()=>preview?.verify(scene));
            const {fileType,options}=exportChoices(format,dialog);
            const {layers}=makeExportLayers(model,frozenChoice.selection);layer=layers[0];
            const report=buildReport({modelName:model.name,filename:options.filename,format:fileType,density,
                config:frozenChoice.config,selection:frozenChoice.selection,total:model.instances.count,
                attributeStatus:data.attributeStatus,components,splatTransform:stDetails,sns:snsDetails});
            const stream=fileTarget?await fileTarget.handle.createWritable():undefined;
            ok=await scene.events.invoke('scene.write',fileType,options,stream,{splats:layers,throwOnError:true});
            if(ok!==true) {status('Native model export failed.');return;}
            // Successful model write and successful report are distinct outcomes.
            // Never issue provenance for a source that changed during the native write.
            try {
                assert(valid() && selected===model && choice===frozenChoice && analysisCurrent(true), 'Model/selection changed during native export.');
                await queue(()=>preview?.verify(scene));
            } catch(e) {status(`Model exported, but report withheld: ${showError(e)}`);return;}
            let reportResult;
            try { reportResult=await saveReport(report,dialog.directory??directory); }
            catch(e) {status(`Model exported; report failed: ${showError(e)}`);return;}
            status(`Cleaned model exported (${frozenChoice.selection.retainedCount.toLocaleString()} subset instances). Report: ${reportResult.filename} (${reportResult.delivery}).`);
        } catch(e) {status(ok===true ? `Model exported, but post-export operation failed: ${showError(e)}` : `Export failed: ${showError(e)}`);}
        finally {
            try {layer?.destroy();} catch(e) {failure=e;status(`Temporary export layer cleanup failed: ${showError(e)}`);}
            if(!ok) try {await fileTarget?.discard?.();}catch(_){}
            controls.forEach((e,i)=>e.disabled=before[i]);
            busy=false;activeExport=false;updateExportReadiness();
        }
    }
    function openPanel() {
        if(panel) {panel.hidden=false;panel.style.display='flex';windowControls?.restoreWindow();refreshModels();return;}
        panel=document.createElement('section'); panel.id='splat-cleaner-panel'; panel.className='blocks-shortcuts';
        panel.setAttribute('aria-label','Region-Aware Splat Cleaner');
        panel.style.cssText='position:fixed;z-index:1203;left:clamp(16px,4vw,72px);bottom:16px;width:min(430px,calc(100vw - 32px));height:min(600px,calc(100vh - 32px));min-width:min(340px,calc(100vw - 32px));min-height:min(320px,calc(100vh - 32px));max-width:calc(100vw - 32px);max-height:calc(100vh - 32px);resize:both;overflow:hidden;display:flex;flex-direction:column;box-sizing:border-box;padding:12px;background:#262b32;color:#f2f5f7;border:1px solid #7a838e;border-radius:9px;font:13px system-ui,sans-serif;box-shadow:0 8px 26px #0008';
        panel.innerHTML=panelHTML();
        uiHost.append(panel);
        windowControls=attachPluginWindow(panel,get('sc-window-body'),get('sc-minimize'));
        get('sc-models').onclick=()=>refreshModels();
        get('sc-model').onchange=()=>{
            if(busy || activeExport || preview) {refreshModels();status('Restore preview before changing models.');return;}
            const models=loadedSplats(scene), value=get('sc-model').value;
            selected=value===''?null:models[Number(value)]??null;clearCache();refreshModels();
        };
        get('sc-analyze').onclick=()=>track(doAnalyze());
        get('sc-sns-find').onclick=()=>track(doSnsSupport());
        get('sc-find-components').onclick=()=>track(doFindComponents());
        get('sc-st-service').textContent=nativeNotice;
        try{const config=floaterSettings(settings);get('sc-st-config').textContent=`Port: Manager-authorized on first Floaters startup (preferred 3015) · GPU backend: ${config.gpuBackend} · Automatic stop: ${config.autoStop?'on':'off'}. Change backend in Manager settings. Change port through Plugin Manager native authorization.`;}
        catch(e){get('sc-st-config').textContent=showError(e);}
        get('sc-st-find').onclick=()=>{
            if(nativeTask||nativeClosing)return;
            nativeTask=track(doSplatTransformFloaters().catch(e=>status(`SplatTransform unavailable: ${showError(e)}`)));
            void nativeTask.then(()=>{nativeTask=null;},()=>{nativeTask=null;});
        };
        get('sc-component-max').addEventListener('change',()=>{
            updateComponentSummary();refreshMethodOptions();
        });
        for(const id of ['sc-sns-k','sc-sns-m'])get(id).addEventListener('change',invalidateSnsSettings);
        get('sc-opacity-encoding').addEventListener('change',()=>{
            // GPU Floaters depend on the source opacity interpretation;
            // CPU SNS does not. Never silently reuse a GPU result with another encoding.
            if(stMask || stDetails) {
                stMask=null;stDetails=null;
                get('sc-st-enabled').checked=false;get('sc-st-enabled').disabled=true;
                get('sc-st-status').textContent='Stale — opacity encoding changed. Click Analyze, then Analyze GPU Floaters.';
            }
            invalidateAppliedSelection('Opacity interpretation changed. Reanalyze before using opacity-dependent rules; SNS remains cached.');
        });
        // Checkbox events within one event-loop turn are coalesced. During a
        // serialized preview upload, a second toggle is applied on the next pass
        // before exporting becomes possible. No extra cached candidate histories.
        const scheduleMethodRefresh=()=>{
            if(methodRefreshScheduled)return;
            methodRefreshScheduled=true;
            queueMicrotask(()=>{
                methodRefreshScheduled=false;
                if(!methodRefreshPending || busy || selectionRestoring)return;
                if(!choice || !analysisCurrent() || gpuUnavailable || restoreError || activeExport){
                    methodRefreshPending=false;updateExportReadiness();
                    status('Analysis or selection changed; click Apply / Preview manually.');
                    return;
                }
                runApply(false,true);
            });
        };
        const runApply=(reuseSelection=false,automatic=false)=>track((async()=>{
            if(busy)return;
            busy=true;applyingSelection=true;
            try {
                do {
                    if(automatic)methodRefreshPending=false;
                    const revision=selectionRevision;
                    const applied=await applyPreview(reuseSelection,revision);
                    if(restoreAfterApply)break;
                    if(!applied && !methodRefreshPending){
                        // A parameter edit superseded the pending preview.
                        status('Selection settings changed during preview. Click Apply / Preview manually.');
                        break;
                    }
                    reuseSelection=false;
                } while(automatic && methodRefreshPending && choice);
            } catch(e){
                choice=null;methodRefreshPending=false;
                if (/device.{0,35}lost|GPUBuffer|DEVICE_HUNG|DEVICE_REMOVED|writeBuffer/i.test(showError(e))) {
                    gpuUnavailable=true;
                    if(preview?.uploadFailed) {
                        // CPU flags were reverted in setHidden(). Avoid a second GPU
                        // upload on a device that is already known to be unavailable.
                        try { if(lockedColor && originalColor && colorEqualsRGBA(lockedColor,expectedLockColor)) lockedColor.copy(originalColor); }
                        catch(ignored) { failure=ignored; }
                        try { if(selectedColor && originalSelectedColor && colorEqualsRGBA(selectedColor,expectedSelectedColor)) selectedColor.copy(originalSelectedColor); }
                        catch(ignored) { failure=ignored; }
                        try { isolation?.restore(); } catch(ignored) { failure=ignored; }
                        try { candidatesAppearance?.restore(); } catch(ignored) { failure=ignored;restoreError=showError(ignored); }
                        candidatesAppearance=null;
                        preview=null; isolation=null; originalColor=null;lockedColor=null;expectedLockColor=null;
                        selectedColor=null;originalSelectedColor=null;expectedSelectedColor=null;displayMode='none';
                    }
                    restoreError='GPU flag upload failed; GPU contents cannot be verified without Editor reload.';
                    status(`GPU preview unavailable: ${showError(e)}. Reload the Editor before retrying.`);
                } else {
                    status(`${automatic?'Automatic method refresh':'Preview'} not applied: ${showError(e)}. Click Apply / Preview manually.`);
                    if(automatic && preview && !restoreError)restoreAfterApply=true;
                }
            } finally {
                applyingSelection=false;
                if(restoreAfterApply){
                    restoreAfterApply=false;methodRefreshPending=false;
                    try {await restore({preserveInspection:true});status('Previous preview restored; click Apply / Preview manually.');}
                    catch(e){failure=e;status(`Previous preview could not be restored: ${showError(e)}`);}
                }
                busy=false;refreshModels();updateExportReadiness();
                if(methodRefreshPending && choice)scheduleMethodRefresh();
                else if(!choice)methodRefreshPending=false;
            }
        })());
        get('sc-apply').onclick=()=>{methodRefreshPending=false;runApply(false);};
        const onMethodCheckboxChanged=()=>{
            ++selectionRevision;
            const eligible=canAutoRefreshMethodToggle({hasChoice:!!choice,analysisValid:analysisCurrent(),
                busy,applying:applyingSelection,activeExport,restoring:selectionRestoring,gpuUnavailable,restoreError});
            refreshMethodOptions();
            if(!eligible){
                if(choice)invalidateAppliedSelection('Method changed while analysis/preview was unavailable.');
                else status('Method selection updated. Click Apply / Preview to apply the current analysis.');
                return;
            }
            methodRefreshPending=true;
            updateExportReadiness();
            status('Updating cached candidate selection and preview…');
            scheduleMethodRefresh();
        };
        const onTintStyleChanged=()=>{
            const colorInput=get('sc-tint-color'),opacityInput=get('sc-tint-opacity');
            let nextStyle;
            try { nextStyle=parseMethodTintStyle(colorInput.value,opacityInput.value); }
            catch(e) {
                colorInput.value=methodTintHex(tintStyle);
                opacityInput.value=String(tintStyle.a);
                status(`Highlight appearance unchanged: ${showError(e)}`);
                return;
            }
            if(displayMode!=='method-tint' && displayMode!=='candidates-tint') { tintStyle=nextStyle; return; }
            if(busy || activeExport || selectionRestoring) {
                colorInput.value=methodTintHex(tintStyle);
                opacityInput.value=String(tintStyle.a);
                status('Finish the current operation before changing Method Tint appearance.');
                return;
            }
            track(queue(()=>{
                assert(['method-tint','candidates-tint'].includes(displayMode) && valid(),
                    'Method Tint was exited or model changed before the appearance update.');
                if(displayMode==='candidates-tint')
                    expectedSelectedColor=updateActiveCandidatesTint(scene,preview,lockedColor,originalColor,
                        expectedLockColor,selectedColor,originalSelectedColor,expectedSelectedColor,nextStyle,isolation,candidatesAppearance);
                else expectedLockColor=updateActiveMethodTint(scene,preview,lockedColor,originalColor,
                    expectedLockColor,nextStyle,isolation);
                tintStyle=nextStyle;
            }).then(()=>status('Method Tint appearance updated; candidate selection and Gaussian flags unchanged.'),e=>{
                colorInput.value=methodTintHex(tintStyle);
                opacityInput.value=String(tintStyle.a);
                status(`Method Tint appearance unchanged: ${showError(e)}`);
            }));
        };
        for(const id of ['sc-tint-color','sc-tint-opacity'])
            get(id).addEventListener('change',onTintStyleChanged);
        get('sc-inspect-method').onchange=()=>{
            const input=get('sc-inspect-method');
            if(busy || activeExport || selectionRestoring) {input.value='off';status('Finish the current operation first.');return;}
            if(input.value!=='off') {
                if(!availableForTint(input.value)) {
                    input.value='off';status('This method needs a valid cached analysis.');return;
                }
                if(hasOriginalLocked(preview?.original ?? selected?.instances?.flags)) {
                    input.value='off';
                    status('Method Tint disabled: originally locked Gaussians share the Editor locked color.');
                    return;
                }
                if(choice && get('sc-view').value==='candidates') {
                    try {
                        const methodMask=inspectionCandidateMask(choice.selection,input.value,data.centers,density,
                            choice.config,{sizes:data.sizes,opacity:data.opacities,components,splatTransformMask:stMask,snsMask});
                        if(candidatePreviewMasks(choice.selection,INSPECTION_METHODS[input.value].bit,methodMask).highlight.some(Boolean))
                            candidatesTintRendererReady(scene,selected);
                    } catch(e) {
                        input.value='off';status(`Candidates tint unavailable: ${showError(e)}`);return;
                    }
                }
                // Preserve the chosen view when it is Candidates; OR candidates remain
                // the visible group. Cleaned is not an inspection-tint view.
                if(get('sc-view').value==='cleaned')get('sc-view').value='original';
                get('sc-isolate').checked=false;
            }
            runApply(!!choice);
        };
        for (const id of ['sc-view','sc-isolate']) get(id).onchange=()=>{
            if(!data || !density || busy)return;
            if(get('sc-view').value==='candidates' && !get('sc-isolate').checked &&
                get('sc-inspect-method').value!=='off' && choice) {
                try {
                    const bit=INSPECTION_METHODS[get('sc-inspect-method').value].bit;
                    const methodMask=inspectionCandidateMask(choice.selection,get('sc-inspect-method').value,
                        data.centers,density,choice.config,
                        {sizes:data.sizes,opacity:data.opacities,components,splatTransformMask:stMask,snsMask});
                    if(candidatePreviewMasks(choice.selection,bit,methodMask).highlight.some(Boolean))
                        candidatesTintRendererReady(scene,selected);
                } catch(e) {
                    get('sc-view').value='original';
                    status(`Candidates tint unavailable: ${showError(e)}`);return;
                }
            }
            // Original <-> Candidates retains the inspected method. Cleaned or
            // scope isolation exits tint and keeps original binary preview behavior.
            if(get('sc-view').value==='cleaned' || get('sc-isolate').checked)
                get('sc-inspect-method').value='off';
            if(choice)runApply(true);
            else status('Select cleaning rules, then click Apply / Preview before switching views.');
        };
        const methodIDs=new Set(['sc-size-enabled','sc-sns-enabled',
            'sc-floater-enabled','sc-st-enabled']);
        const manualConfigIDs=new Set(['sc-density','sc-size-p','sc-opacity',
            'sc-component-max','sc-component-select']);
        panel.addEventListener('change',event=>{
            if(event.target.id==='sc-opacity-mode') {
                const before=previousOpacityMode;
                refreshOpacityUI();
                const after=get('sc-opacity-mode').value;
                previousOpacityMode=after;
                if(before===after)return;
                if(before==='restrict-sns' || after==='restrict-sns')
                    invalidateAppliedSelection('Selection parameter changed. Click Apply / Preview manually.');
                else onMethodCheckboxChanged();
            } else if(methodIDs.has(event.target.id)) {
                if(event.target.id==='sc-sns-enabled')refreshOpacityUI();
                onMethodCheckboxChanged();
            }
            else if(manualConfigIDs.has(event.target.id))
                invalidateAppliedSelection('Selection parameter changed. Click Apply / Preview manually.');
        });
        get('sc-restore').onclick=()=>track((async()=>{if(busy)return;busy=true;try{await restore();status('Original Gaussian flags and unrelated model visibility restored.');}catch(e){failure=e;status(showError(e));}finally{busy=false;refreshModels();}})());
        get('sc-roi-reset').onclick=()=>{if(!density || (busy && !selectionRestoring) || activeExport)return; for(const axis of AXES){roiRanges[axis]={...density.bounds[axis]};syncAxis(axis);}markRoiChanged();status('XYZ ROI reset to exact model bounds. Click Apply / Preview.');};
        get('sc-export').onclick=()=>track(doExport().catch(e=>status(`Export unavailable: ${showError(e)}`)));
        get('sc-hide').onclick=()=>{
            if(nativeClosing)return;
            if((busy&&!nativeTask)||activeExport){status('Finish the current operation first.');return;}
            nativeClosing=true;busy=true;refreshModels();updateExportReadiness();
            if(nativeTask)status('Cancelling GPU Floaters and stopping its service…');
            track((async()=>{try{await cleanupFloaters();busy=true;try{await restore();}catch(e){failure=e;throw e;}panel.hidden=true;panel.style.display='none';}
                catch(e){status(`Close failed: ${showError(e)}`);}
                finally{nativeClosing=false;busy=false;refreshModels();updateExportReadiness();}})());
        };
        refreshModels();updateExportReadiness();
    }
    const added=scene.events.on('scene.elementAdded',()=>{if(panel && !busy)refreshModels();});
    const removed=scene.events.on('scene.elementRemoved',element=>{
        if(selected===element) {
            nativeAbort?.abort();++generation;selected=null;clearCache();
            if(preview?.splat===element) { // disposed resources must NOT be touched
                preview=null;
                try {
                    if(lockedColor && originalColor) {
                        if(colorEqualsRGBA(lockedColor,expectedLockColor)) lockedColor.copy(originalColor);
                        else { failure=new Error('Shared Editor locked color changed externally; not overwritten.'); restoreError=showError(failure); }
                    }
                } catch(e) { failure=e; }
                if(selectedColor && originalSelectedColor) {
                    try {
                        if(colorEqualsRGBA(selectedColor,expectedSelectedColor))selectedColor.copy(originalSelectedColor);
                        else {failure=new Error('Shared Editor selected color changed externally; not overwritten.');restoreError=showError(failure);}
                    }catch(e){failure=e;}
                }
                lockedColor=null;originalColor=null;expectedLockColor=null;
                if(candidatesAppearance) {
                    try { candidatesAppearance.restore(); }
                    catch(e) { failure=e;restoreError=showError(e); }
                    candidatesAppearance=null;
                }
                selectedColor=null;originalSelectedColor=null;expectedSelectedColor=null;displayMode='none';
                try{isolation?.restore();}catch(e){failure=e;}isolation=null;
            }
            status('Selected model removed; previous analysis invalidated. Refresh and select another model.');
        }
        if(panel && !busy)refreshModels();
    });
    return {
        async open() { assert(!stopped,'Plugin is deactivated.');openPanel(); },
        isRunning() {
            // Plugin Manager polls this synchronously. Never throw here: a
            // GPU failure must not trigger a cascade of status-query errors.
            return !!(busy||activeExport||tasks.size||preview||nativeRequested||(panel&&!panel.hidden)); },
        async deactivate() {
            if(stopped) {await stopFloaters();if(failure||restoreError)throw new Error(showError(failure||restoreError));return;}
            stopped=true;nativeAbort?.abort();++generation;
            let shutdownError=null;
            try {
                try{await cleanupFloaters();}catch(e){shutdownError=e;}
                const result=await Promise.allSettled([...tasks]);
                try{await stopFloaters();}catch(e){shutdownError=e;}
                const bad=result.find(r=>r.status==='rejected');if(bad)throw bad.reason;
                await restore();
                if(failure||restoreError)throw new Error(showError(failure||restoreError));
                if(shutdownError)throw shutdownError;
            } catch(e) {if(e!==shutdownError)failure=e;throw e;}
            finally {added.off();removed.off();windowControls?.dispose();windowControls=null;panel?.remove();panel=null;data=null;density=null;components=null;stMask=null;stDetails=null;snsMask=null;snsDetails=null;choice=null;}
        }
    };
}

// Source-level hooks for automated tests; not part of the Plugin Manager lifecycle contract.
export const __testing = {snapshotMapping,mappingCurrent,analysisInvalidReason,methodTintEligible,methodSelectedForTint,canAutoRefreshMethodToggle,CandidatesTintAppearance,inspectionCandidateMask,sameCenters,DEFAULT_TINT_HEX,DEFAULT_TINT_OPACITY,METHOD_TINT_COLOR,parseMethodTintStyle,methodTintHex,
    updateActiveMethodTint,updateActiveCandidatesTint,candidatesTintRendererReady,candidatePreviewMasks,applySelectedDisplayColor,
    INSPECTION_METHODS,colorEqualsRGBA,hasOriginalLocked,applyLockDisplayColor,validatedSnsParameters,readModel,Preview,similarTransformScale,loadedSplats,modelAttached,makeExportLayers,exportChoices,isolationFor,display3,round3,reviseRoiInterval,panelHTML,axisMarkup,attachPluginWindow};
