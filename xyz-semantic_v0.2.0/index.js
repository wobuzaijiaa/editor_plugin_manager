/* XYZ Semantic v0.2.0, forked from XYZ Filter v1.0.10, Plugin Manager v1.13.3.
 * Phase 2 migration of the independently tested standalone XYZ extension.
 * Audited upstream: SuperSplat Editor v3.7.0 / 4069712370df3425c386610f28a814403e835543.
 * Uses private window.scene interfaces for advanced Gaussian operations.
 * Never imported into or patched into the native Editor TypeScript bundle.
 * Importing this module has no side effects; initialize only in activate(context).
 */
const SIZE = [1920, 1080];
const $ = (root, id) => root.querySelector(`#${id}`);
const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const assert = (ok, why) => { if (!ok) throw new Error(why); };
const fmtError = error => error instanceof Error ? error.message : String(error);

function loadedSplats(scene) {
    return scene.elements.filter(e => e.scene === scene && e.instances && e.resource?.source);
}

function splatsIn(scene) {
    return loadedSplats(scene).filter(e => e.visible);
}

function modelAttached(scene, model) {
    return !!model && scene.elements.includes(model) && model.scene === scene &&
        !!model.instances && !!model.resource?.source;
}

function selectedModel(scene, model) {
    assert(modelAttached(scene, model), 'Selected model was removed. Select another loaded model.');
    assert(model.visible, 'Selected model is hidden. Show it in SuperSplat before processing.');
    return model;
}

// Hide unrelated splats while a selected model is being previewed/captured.
// The scope does not modify Gaussian flags of any unrelated model.
function isolateModel(scene, selected, trackAdditions = false) {
    selectedModel(scene, selected);
    const hidden = new Map();
    let revision = 0;
    const hide = element => {
        if (element === selected || !modelAttached(scene, element) || !element.visible) return;
        hidden.set(element, true);
        element.visible = false;
        scene.forceRender = true;
    };
    for (const element of loadedSplats(scene)) hide(element);
    const added = trackAdditions ? scene.events?.on?.('scene.elementAdded', element => {
        revision++;
        hide(element);
    }) : null;
    const removed = trackAdditions ? scene.events?.on?.('scene.elementRemoved', () => { revision++; }) : null;
    return {
        revision() { return revision; },
        ensure() {
            selectedModel(scene, selected);
            for (const model of loadedSplats(scene)) {
                if (model !== selected && model.visible) hide(model);
            }
        },
        restore() {
            added?.off();
            removed?.off();
            for (const [model, wasVisible] of hidden) {
                if (modelAttached(scene, model) && !model.visible) model.visible = wasVisible;
            }
            scene.forceRender = true;
        }
    };
}

function interval(min, max) {
    assert(Number.isFinite(min) && Number.isFinite(max) && min <= max, 'Range endpoints must be finite and ordered.');
    return { min, max };
}

// The native GaussianInstances mutator currently calls ranges.forEach(). This
// small iterable avoids bundling/upstream-copying IndexRanges solely for masks.
function indicesFromPredicate(total, predicate) {
    const runs = [];
    let start = -1;
    for (let i = 0; i < total; i++) {
        if (predicate(i)) {
            if (start === -1) start = i;
        } else if (start !== -1) {
            runs.push([start, i]);
            start = -1;
        }
    }
    if (start !== -1) runs.push([start, total]);
    return { forEach(fn) { for (const [start, end] of runs) for (let i = start; i < end; i++) fn(i); } };
}

function transformOf(splat, id) {
    const palette = splat.worldTransform.clone();
    splat.transformPalette.getTransform(id, palette);
    return splat.worldTransform.clone().mul2(splat.worldTransform, palette);
}

// Read canonical source positions, applying live source-row, palette and entity
// transforms. One combined XYZ mask uses these same world-space centers.
async function readWorldCenters(splat) {
    const { instances, resource } = splat;
    const { source, sourcePool } = resource;
    const centers = {
        x: new Float64Array(instances.count),
        y: new Float64Array(instances.count),
        z: new Float64Array(instances.count)
    };
    const transforms = new Map();
    for (let offset = 0; offset < instances.count; offset += source.meta.chunkSize) {
        const count = Math.min(source.meta.chunkSize, instances.count - offset);
        const buffer = sourcePool.acquire('position', source.meta.layouts.position, count);
        try {
            await source.read({ indices: instances.sourceRow, indexOffset: offset, count, position: buffer });
            const xyz = new Float32Array(buffer.data);
            for (let i = 0; i < count; i++) {
                const palette = instances.transformIndex(offset + i);
                if (!transforms.has(palette)) transforms.set(palette, transformOf(splat, palette));
                const m = transforms.get(palette).data;
                const x = xyz[3 * i], y = xyz[3 * i + 1], z = xyz[3 * i + 2];
                centers.x[offset + i] = m[0] * x + m[4] * y + m[8] * z + m[12];
                centers.y[offset + i] = m[1] * x + m[5] * y + m[9] * z + m[13];
                centers.z[offset + i] = m[2] * x + m[6] * y + m[10] * z + m[14];
            }
        } finally {
            buffer.release();
        }
    }
    return centers;
}

// Preserve the original 1%-99% initial Y focus. X/Z start with their entire
// center domains so introducing those axes never silently trims the model.
function axisDomain(arrays, focus = false) {
    let min = Infinity, max = -Infinity;
    const values = focus ? [] : null;
    for (const array of arrays) {
        for (const v of array) {
            if (!Number.isFinite(v)) continue;
            if (v < min) min = v;
            if (v > max) max = v;
            if (focus) values.push(v);
        }
    }
    assert(min !== Infinity, 'No finite Gaussian centers for axis.');
    const full = { min, max };
    if (!focus) return { full, focus: full };
    values.sort((a, b) => a - b);
    return { full, focus: interval(values[Math.floor((values.length - 1) * .01)],
        values[Math.ceil((values.length - 1) * .99)]) };
}

function withinXYZ(centers, index, ranges) {
    for (const axis of ['x', 'y', 'z']) {
        const v = centers[axis][index], r = ranges[axis];
        if (!Number.isFinite(v) || v < r.min || v > r.max) return false;
    }
    return true;
}

// Display precision is not geometry precision: maintain exact internal bounds,
// including full-domain extrema, and serialize them unrounded in snapshot JSON.
function display3(value) {
    // UI only: three decimal places; stored XYZ bounds retain full precision.
    const fixed = Number(value).toFixed(3);
    return fixed === '-0.000' ? '0.000' : fixed;
}

// Preview edits only bit 2 (locked). All remaining flag bits are conserved.
// Detect changed selection/deletion flags before attempting restoration.
class PreviewMask {
    constructor(splat, centers) {
        this.splat = splat;
        this.instances = splat.instances;
        this.centers = centers;
        this.original = this.instances.flags.slice(0, this.instances.count);
        this.sourceRows = this.instances.sourceRow.slice(0, this.instances.count);
        this.paletteIds = this.instances.palette.slice(0, this.instances.count);
        this.world = splat.worldTransform.clone();
        this.transforms = new Map();
        for (let i = 0; i < this.instances.count; i++) {
            const id = this.instances.transformIndex(i);
            if (!this.transforms.has(id)) this.transforms.set(id, transformOf(splat, id));
        }
        this.applied = null;
    }
    verify(scene) {
        assert(modelAttached(scene, this.splat) && this.splat.instances === this.instances && this.splat.visible,
            'Selected model membership/visibility changed during preview.');
        const n = this.original.length;
        assert(this.instances.count === n && this.splat.worldTransform.equals(this.world),
            'Geometry or layer transform changed during preview.');
        for (let i = 0; i < n; i++) {
            assert(this.instances.sourceRow[i] === this.sourceRows[i] && this.instances.palette[i] === this.paletteIds[i],
                'Instance source/palette mapping changed during preview.');
            const filtered = this.applied && !withinXYZ(this.centers, i, this.applied);
            assert(this.instances.flags[i] === (this.original[i] | (filtered ? 2 : 0)),
                'Unexpected edit to Gaussian flags during preview.');
        }
        for (const [id, saved] of this.transforms) {
            assert(transformOf(this.splat, id).equals(saved), 'Palette transform changed during preview.');
        }
    }
    // Set only bit 2 using native mutators so instance counts/GPU dirty spans stay valid.
    restore(scene = null) {
        if (scene) assert(modelAttached(scene, this.splat), 'Selected model was removed.');
        assert(this.splat.instances === this.instances, 'Selected model instances changed.');
        const n = this.original.length;
        assert(this.instances.count === n && this.splat.worldTransform.equals(this.world),
            'Geometry or layer transform changed before restoration.');
        for (let i = 0; i < n; i++) {
            assert(this.instances.sourceRow[i] === this.sourceRows[i] && this.instances.palette[i] === this.paletteIds[i],
                'Instance source/palette mapping changed before restoration.');
            const filtered = this.applied && !withinXYZ(this.centers, i, this.applied);
            assert(this.instances.flags[i] === (this.original[i] | (filtered ? 2 : 0)),
                'Gaussian flags changed outside XYZ preview; refusing unsafe restoration.');
        }
        for (const [id, saved] of this.transforms)
            assert(transformOf(this.splat, id).equals(saved), 'Palette transform changed before restoration.');
        this.instances.clearBits(indicesFromPredicate(n, i => !(this.original[i] & 2)), 2);
        this.instances.setBits(indicesFromPredicate(n, i => !!(this.original[i] & 2)), 2);
        this.instances.flush();
        for (let i = 0; i < n; i++) {
            assert(this.instances.flags[i] === this.original[i], 'Unexpected edit during preview restoration.');
        }
        this.applied = null;
    }
    apply(range) {
        this.restore();
        this.instances.setBits(indicesFromPredicate(this.original.length, i =>
            !withinXYZ(this.centers, i, range)), 2);
        this.instances.flush();
        this.applied = Object.fromEntries(Object.entries(range).map(([axis, r]) => [axis, { ...r }]));
    }
}

// Native SuperSplat export accepts explicit Splat layers (scene.write operation.splats).
// Build a standalone *subset* of the current instance list, never mutate the
// live model or rely on the preview-only locked flag.  This range interface is
// intentionally limited to the two methods read by Splat.createLayer() in the
// audited 3.7.0 revision. Re-audit when upgrading SuperSplat.
function filteredSubsetRanges(centers, ranges) {
    const n = centers.x.length;
    assert(centers.y.length === n && centers.z.length === n, 'XYZ center arrays are inconsistent.');
    let count = 0, start = -1;
    const runs = [];
    for (let i = 0; i <= n; i++) {
        const keep = i < n && withinXYZ(centers, i, ranges);
        if (keep) {
            count++;
            if (start === -1) start = i;
        } else if (start !== -1) {
            runs.push([start, i - start]);
            start = -1;
        }
    }
    return { count, forEachRun(fn) { for (const [offset, length] of runs) fn(offset, length); } };
}

function createFilteredExportLayers(masks, ranges) {
    const layers = [];
    try {
        for (const mask of masks) {
            const indices = filteredSubsetRanges(mask.centers, ranges);
            if (indices.count === 0) continue;
            assert(typeof mask.splat.createLayer === 'function',
                'Native subset layer API is unavailable in this SuperSplat version.');
            const layer = mask.splat.createLayer(indices, `${mask.splat.name} (XYZ filtered)`);
            layers.push(layer); // track immediately so a later assertion still cleans up
            assert(layer.worldTransform.equals(mask.splat.worldTransform),
                'Subset transform differs from source; refusing a potentially misaligned export.');
        }
        assert(layers.length, 'No Gaussian centers are inside the selected XYZ range.');
        return layers;
    } catch (error) {
        for (const layer of layers.reverse()) layer.destroy();
        throw error;
    }
}

const FILTER_EXPORT_TYPES = new Set(['ply', 'splat', 'sog', 'spz']);
function filteredExportOptions(format, choices) {
    assert(FILTER_EXPORT_TYPES.has(format), 'Unsupported filtered export format.');
    assert(choices?.filename, 'Missing export filename.');
    return {
        fileType: format === 'ply' && choices.compressedPly ? 'compressedPly' : format,
        options: {
            filename: choices.filename,
            splatIdx: 'all',
            serializeSettings: { shBands: choices.shBands },
            ...(format === 'sog' ? { sogIterations: choices.sogIterations } : {}),
            ...(format === 'spz' ? { spzVersion: choices.spzVersion } : {})
        }
    };
}

// This sidecar is a provenance report for the filtered *model* export, not
// snapshot metadata. The native serializer bakes the edited transforms (and
// undoes the loader's initial rotation) in its own coordinate convention, so
// downstream readers must NOT apply this post-load adjustment to the file again.
function filteredExportReport(masks, ranges, options, fileType, sectionId, userAdjustment) {
    const mapping = userAdjustment ?? null;
    const counts = masks.map(mask => filteredSubsetRanges(mask.centers, ranges).count);
    const sourceCount = masks.reduce((sum, mask) => sum + mask.instances.count, 0);
    const selectedCount = counts.reduce((sum, count) => sum + count, 0);
    return {
        version: 1,
        report_type: 'supersplat_xyz_filtered_model_export',
        editor: 'SuperSplat Editor (version not recorded)',
        model_file: options.filename,
        model_format: fileType,
        source_model_name: masks.length === 1 ? masks[0].splat.name : null,
        source_layers: masks.map((mask, index) => ({
            name: mask.splat.name,
            gaussian_instances: mask.instances.count,
            selected_instances: counts[index]
        })),
        source_gaussian_instances: sourceCount,
        selected_gaussian_instances: selectedCount,
        export_options: {
            ...(options.serializeSettings.shBands !== undefined ? { sh_bands: options.serializeSettings.shBands } : {}),
            ...(options.sogIterations !== undefined ? { sog_iterations: options.sogIterations } : {}),
            ...(options.spzVersion !== undefined ? { spz_version: options.spzVersion } : {})
        },
        section_id: sectionId,
        portviewer_xyz_filter: {
            version: 1, coordinate_frame: 'editor_world',
            x_min: ranges.x.min, x_max: ranges.x.max,
            y_min: ranges.y.min, y_max: ranges.y.max,
            z_min: ranges.z.min, z_max: ranges.z.max
        },
        model_to_snapshot: mapping ? toRows(mapping) : null,
        mapping_status: mapping ? 'declared_uniform' : 'unknown_per_gaussian_or_multiple_models',
        // A valid affine mapping does not establish physical/geometric accuracy.
        geometry_validation: 'not_verified',
        model_to_snapshot_semantics: 'post_load_user_adjustment_only',
        matrix_input_frame: 'post_load_editor_world',
        matrix_output_frame: 'adjusted_editor_world',
        matrix_serialization: 'nested_4x4_rows',
        export_coordinate_space: 'normalized_ply_space',
        // U is provenance in this report, not a second file-space transform.
        // Native serialization has already baked the editing transform.
        model_adjustment_baked_into_export: true,
        exported_geometry_transforms: 'baked_by_native_exporter_with_initial_load_rotation_reversed',
        matrix_application_to_exported_model: 'do_not_apply_again'
    };
}

// Derive a paired report name without altering the native export filename.
function modelReportName(filename, suffix = '') {
    const stem = filename.replace(/\.(?:compressed\.ply|ply|splat|sog|spz)$/i, '');
    return `${stem}.export${suffix}.json`;
}

async function saveFilteredExportReport(report, directory) {
    const data = new TextEncoder().encode(JSON.stringify(report, null, 2));
    if (directory) {
        // Never silently overwrite an existing report when the native export
        // dialog targets the same folder. Repeat exports get an incremented name.
        let name;
        for (let i = 0; ; i++) {
            name = modelReportName(report.model_file, i ? `-${i + 1}` : '');
            try {
                await directory.getFileHandle(name);
            } catch (error) {
                if (error.name === 'NotFoundError') break;
                throw error;
            }
        }
        const file = await directory.getFileHandle(name, { create: true });
        const stream = await file.createWritable();
        try {
            await stream.write(data);
            await stream.close();
        } catch (error) {
            try { await stream.abort(); } catch (_) { /* best effort */ }
            throw error;
        }
        return { delivery: 'saved_in_export_folder', filename: name };
    }
    const filename = modelReportName(report.model_file);
    download(data, filename, 'application/json');
    return { delivery: 'browser_download_requested', filename };
}

// The native save dialog can create its selected file immediately. Semantic exports
// write elsewhere, so a newly created empty dialog file would otherwise remain
// in the semantic root. Only remove a SAME-ENTRY, zero-byte file whose filesystem
// timestamp is no earlier than this specific export dialog. Do not touch an old,
// nonempty, unverifiable, or unrelated file. Cleanup is always best-effort.
async function cleanupUnusedNativeExportTarget(fileTarget, nativeDirectory, startedAt) {
    const handle = fileTarget?.handle;
    const name = handle?.name;
    if (!handle?.getFile || !handle?.isSameEntry ||
        !nativeDirectory?.getFileHandle || !nativeDirectory?.removeEntry ||
        !name || /[\\/\x00-\x1f]/.test(name)) return { cleaned: false, reason: 'unverified target' };
    try {
        const fromDirectory = await nativeDirectory.getFileHandle(name);
        if (!(await fromDirectory.isSameEntry(handle))) return { cleaned: false, reason: 'different file' };
        const file = await handle.getFile();
        // File.lastModified resolution can vary between browsers; tolerate one
        // second while refusing to delete a historical empty user file.
        if (file.size !== 0 || !Number.isFinite(file.lastModified) ||
            file.lastModified < startedAt - 1000 || file.lastModified > Date.now() + 1000)
            return { cleaned: false, reason: 'existing or nonempty file' };
        await nativeDirectory.removeEntry(name);
        return { cleaned: true };
    } catch (error) {
        return { cleaned: false, reason: fmtError(error) };
    }
}

// Keep native dialogs and native serializers; pass an isolated list of subset
// layers through the source-verified scene.write operation.splats override.
// Do not reuse scene.export: its default getSplats() exports the whole model.
async function exportFilteredModel(scene, masks, ranges, format, isReady, reportContext) {
    assert(FILTER_EXPORT_TYPES.has(format), 'Unsupported filtered export format.');
    const events = scene.events;
    assert(events.functions?.has('scene.write') && events.functions?.has('show.exportPopup'),
        'Native export services are unavailable.');
    // Recheck before and after the dialog, since external actions may change the scene.
    const verify = () => {
        assert(isReady(), 'XYZ filter was disabled or changed during export.');
        assert(masks.length === 1, 'Select exactly one model for filtered export.');
        selectedModel(scene, masks[0].splat);
        masks[0].verify(scene);
    };
    verify();
    const directory = window.showDirectoryPicker ? await events.invoke('scene.getExportDirectory') : undefined;
    const dialogStartedAt = Date.now();
    const dialog = await events.invoke('show.exportPopup', format,
        masks.map(mask => mask.splat.name), { directory });
    if (!dialog) return null; // Cancelled; no model/report output.
    verify();
    const { fileTarget, ...choices } = dialog;
    const { fileType, options } = filteredExportOptions(format, choices);
    // Semantic output always goes into a newly created hierarchy-named folder.
    // The native dialog still supplies serializer settings; its filename is not
    // used for semantic exports. No overwrite of previous semantic results.
    const semanticStem = reportContext?.semanticOutputStem || null;
    let semanticFolder = null, semanticFilename = null;
    if (semanticStem) {
        assert(!/[\\/:*?"<>|\x00-\x1f]/.test(semanticStem) && semanticStem.length <= 220,
            'Invalid semantic output name.');
        const parent = dialog.directory ?? directory;
        assert(parent?.getDirectoryHandle,
            'Semantic model export requires selecting a writable folder in the native export dialog.');
        let exists = false;
        try { await parent.getDirectoryHandle(semanticStem); exists = true; }
        catch (error) { if (error?.name !== 'NotFoundError') throw error; }
        assert(!exists, `Semantic output folder already exists: ${semanticStem}. Retry to generate a new timestamp.`);
        semanticFolder = await parent.getDirectoryHandle(semanticStem, {create:true});
        const extension = fileType === 'compressedPly' ? 'compressed.ply' : fileType;
        semanticFilename = `${semanticStem}.${extension}`;
        options.filename = semanticFilename;
    }
    assert(reportContext && typeof reportContext.userAdjustment === 'function',
        'Model adjustment tracker is unavailable; refusing export without its report.');
    const report = filteredExportReport(masks, ranges, options, fileType,
        String(reportContext.sectionId ?? '').trim(), reportContext.userAdjustment(masks.map(mask => mask.splat)));
    if (reportContext.semantic) report.semantic = structuredClone(reportContext.semantic);
    const layers = createFilteredExportLayers(masks, ranges);
    let ok = false;
    try {
        const stream = semanticFolder ?
            await (await semanticFolder.getFileHandle(semanticFilename, {create:true})).createWritable() :
            fileTarget ? await fileTarget.handle.createWritable() : undefined;
        // With throwOnError, native scene.write propagates failures so our
        // finally block always destroys temporary layers, even on errors.
        ok = await events.invoke('scene.write', fileType, options, stream,
            { splats: layers, throwOnError: true });
    } finally {
        for (const layer of layers.reverse()) layer.destroy();
        if (!ok) {
            if (semanticFolder) {
                try { await semanticFolder.removeEntry(semanticFilename); } catch (_) { /* residual folder reported */ }
            } else await fileTarget?.discard?.();
        }
    }
    if (ok !== true) return { modelExported: false };
    // The semantic model has been written and closed in its own folder. It is
    // safe to inspect the unused native target now; never remove nonempty data.
    const placeholder = semanticStem ? await cleanupUnusedNativeExportTarget(
        fileTarget, dialog.directory ?? directory, dialogStartedAt) : null;
    try {
        verify();
    } catch (error) {
        return { modelExported: true, placeholder, reportError: `Scene changed after model export: ${fmtError(error)}` };
    }
    try {
        const sidecar = await saveFilteredExportReport(report, semanticFolder ?? dialog.directory ?? directory);
        return { modelExported: true, placeholder, report: sidecar, mappingStatus: report.mapping_status };
    } catch (error) {
        // Do not misreport an already-successful model export as failed.
        return { modelExported: true, placeholder, reportError: fmtError(error) };
    }
}

function toRows(m) {
    return [0, 1, 2, 3].map(r => [0, 1, 2, 3].map(c => m[c * 4 + r]));
}
function mappingForTransformIds(splat, ids) {
    if (!ids.size) return null;
    let common = null;
    for (const id of ids) {
        const t = transformOf(splat, id), m = t.data;
        if (!Array.from(m).every(Number.isFinite) || Math.abs(m[3]) > 1e-6 ||
            Math.abs(m[7]) > 1e-6 || Math.abs(m[11]) > 1e-6 || Math.abs(m[15] - 1) > 1e-6 ||
            (common && !common.equals(t))) return null;
        common = t;
    }
    return common;
}
function commonMapping(splats) {
    if (splats.length !== 1) return null;
    const splat = splats[0];
    const ids = new Set();
    for (let i = 0; i < splat.instances.count; i++) ids.add(splat.instances.transformIndex(i));
    return mappingForTransformIds(splat, ids);
}
// Semantic viewport rendering runs repeatedly. Cache only the immutable set
// of palette IDs verified by PreviewMask; resolve live matrices for those IDs
// without rescanning every Gaussian on each animation frame. A subsequent
// palette edit is rejected by PreviewMask.verify at the next range operation.
function semanticMappingReader(splat) {
    const ids = new Set();
    for (let i = 0; i < splat.instances.count; i++) ids.add(splat.instances.transformIndex(i));
    return () => mappingForTransformIds(splat, ids);
}
// The exported adjustment is measured relative to the *post-load* model state.
// Never substitute the native file-loading rotation for a user adjustment.
const MATRIX_IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

function isAffine4(m) {
    return m?.length === 16 && Array.from(m).every(Number.isFinite) &&
        Math.abs(m[3]) <= 1e-6 && Math.abs(m[7]) <= 1e-6 &&
        Math.abs(m[11]) <= 1e-6 && Math.abs(m[15] - 1) <= 1e-6;
}

// Column-major affine inverse. A non-invertible initial transform cannot
// establish a unique relative adjustment and must not be reported as uniform.
function invertAffine4(m) {
    if (!isAffine4(m)) return null;
    const a = m[0], b = m[4], c = m[8];
    const d = m[1], e = m[5], f = m[9];
    const g = m[2], h = m[6], i = m[10];
    const det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
    const scale = Math.max(Math.abs(a), Math.abs(b), Math.abs(c), Math.abs(d),
        Math.abs(e), Math.abs(f), Math.abs(g), Math.abs(h), Math.abs(i));
    if (!Number.isFinite(det) || scale === 0 || Math.abs(det) <= 1e-12 * scale ** 3) return null;
    const A = (e * i - f * h) / det, B = (c * h - b * i) / det, C = (b * f - c * e) / det;
    const D = (f * g - d * i) / det, E = (a * i - c * g) / det, F = (c * d - a * f) / det;
    const G = (d * h - e * g) / det, H = (b * g - a * h) / det, I = (a * e - b * d) / det;
    const x = m[12], y = m[13], z = m[14];
    const inverse = [A, D, G, 0, B, E, H, 0, C, F, I, 0,
        -(A * x + B * y + C * z),
        -(D * x + E * y + F * z),
        -(G * x + H * y + I * z), 1];
    return inverse.every(Number.isFinite) ? inverse : null;
}

function relativeModelMatrix(current, initial) {
    if (!isAffine4(current) || !isAffine4(initial)) return null;
    const inverse = invertAffine4(initial);
    if (!inverse) return null;
    // Exact identity when no model adjustment was made, even if the loader
    // initially rotated the model (e.g. Rz(180 degrees)).
    if (Array.from(current).every((v, i) => v === initial[i])) return MATRIX_IDENTITY.slice();
    const adjustment = matMul4(current, inverse);
    return isAffine4(adjustment) ? adjustment : null;
}

// scene.elementAdded fires after Scene.add() has awaited splat.add(), when
// the imported entity and its initial transform are established. Track each
// layer once; never recapture the baseline at snapshot time. A missing or
// nonuniform baseline must fail closed instead of silently producing Identity.
function trackInitialModelTransforms(scene) {
    const initial = new WeakMap();
    function remember(element) {
        if (!element || element.scene !== scene || !element.instances || !element.resource?.source ||
            initial.has(element)) return;
        initial.set(element, commonMapping([element])?.data.slice() ?? null);
    }
    const listener = scene.events.on('scene.elementAdded', remember);
    // Handle a model that completed loading before the external module started.
    // This is reliable only when no user edit preceded module initialization.
    for (const element of scene.elements) remember(element);
    return {
        userAdjustment(splats) {
            if (splats.length !== 1) return null;
            const baseline = initial.get(splats[0]);
            const current = commonMapping(splats);
            return baseline && current ? relativeModelMatrix(current.data, baseline) : null;
        },
        dispose() { listener.off(); }
    };
}

function matMul4(a, b) {
    const c = new Array(16).fill(0);
    for (let col = 0; col < 4; col++) for (let row = 0; row < 4; row++)
        for (let k = 0; k < 4; k++) c[col * 4 + row] += a[k * 4 + row] * b[col * 4 + k];
    return c;
}

// Classify the camera's viewing axis independently of the Y-floor filter.
// PlayCanvas cameras face local -Z. For an oblique pose, do not fabricate
// a cardinal axis; the existing camera quaternion remains authoritative.
function snapshotView(rotation) {
    const { x, y, z, w } = rotation;
    const length = Math.hypot(x, y, z, w);
    if (!Number.isFinite(length) || length < 1e-12) return { axis: null, direction: null, coordinate_frame: 'editor_world' };
    const qx = x / length, qy = y / length, qz = z / length, qw = w / length;
    const forward = [
        -2 * (qx * qz + qy * qw),
        -2 * (qy * qz - qx * qw),
        -1 + 2 * (qx * qx + qy * qy)
    ];
    const magnitudes = forward.map(Math.abs);
    const index = magnitudes.indexOf(Math.max(...magnitudes));
    if (magnitudes[index] < 0.999) return { axis: null, direction: null, coordinate_frame: 'editor_world' };
    const axis = ['X', 'Y', 'Z'][index];
    return { axis, direction: `${forward[index] >= 0 ? '+' : '-'}${axis}`, coordinate_frame: 'editor_world' };
}

// Preserve the one canonical transformation at portviewer_floor.model_to_snapshot.
// Unlike the legacy Y-only filter, XYZ captures select the primary section axis
// from the captured orthographic camera orientation. The primary bounds use
// matching x_min/x_max, y_min/y_max, or z_min/z_max keys. coordinate_frame
// stays editor_world: camera direction does not change the coordinate system.
// For oblique orthographic views, do not invent a cardinal axis or range.
function sectionMetadata(preview, view) {
    if (!preview?.ranges) return {};
    const ranges = preview.ranges;
    for (const axis of ['x', 'y', 'z']) {
        assert(ranges?.[axis] && Number.isFinite(ranges[axis].min) &&
            Number.isFinite(ranges[axis].max) && ranges[axis].min <= ranges[axis].max,
        `Missing or invalid ${axis.toUpperCase()} capture range.`);
    }
    const axisKey = ['X', 'Y', 'Z'].includes(view.axis) ? view.axis.toLowerCase() : null;
    const range = axisKey ? ranges[axisKey] : null;
    const identifier = String(preview.section_id ?? '').trim() || null;
    const modelMapping = preview.model_to_snapshot ?? null;
    const mappingStatus = preview.mapping_status ?? 'unknown_per_gaussian_or_multiple_models';
    // Keep the legacy Y-only key sequence unchanged for Y captures; for X/Z
    // adapt BOTH the axis and the min/max property names to the selected view.
    const primaryBounds = axisKey ? {
        [`${axisKey}_min`]: range.min,
        [`${axisKey}_max`]: range.max
    } : {};
    const floor = {
        version: 1, axis: view.axis, coordinate_frame: 'editor_world',
        ...primaryBounds,
        // No gravity/vertical confirmation control exists in this standalone UI.
        // Do not report user confirmation just because a snapshot was captured.
        floor_id: identifier, vertical_confirmed: false,
        model_id: null, association_basis: null,
        ...(preview.source_model_name ? { source_model_name: preview.source_model_name } : {}),
        geometry_validation: 'not_verified',
        model_to_snapshot: modelMapping,
        mapping_status: mappingStatus
    };
    const section = {
        version: 1, coordinate_frame: 'editor_world',
        axis: view.axis, direction: view.direction,
        range_min: range ? range.min : null,
        range_max: range ? range.max : null,
        section_id: identifier,
        geometry_validation: 'not_verified'
    };
    const xyz = {
        version: 1, coordinate_frame: 'editor_world',
        x_min: ranges.x.min, x_max: ranges.x.max,
        y_min: ranges.y.min, y_max: ranges.y.max,
        z_min: ranges.z.min, z_max: ranges.z.max
    };
    return { portviewer_floor: floor, portviewer_section: section, portviewer_xyz_filter: xyz };
}

function download(bytes, name, type) {
    const url = URL.createObjectURL(new Blob([bytes], { type }));
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// Pick a parent folder in the *button click* handler, before offscreen capture
// yields control. File System Access pickers require transient user activation.
function chooseSnapshotDirectory() {
    assert(typeof window.showDirectoryPicker === 'function',
        'Snapshot folder saving requires Chrome/Edge on localhost or HTTPS.');
    return window.showDirectoryPicker({ mode: 'readwrite' });
}

function snapshotFolderName(sectionId, date = new Date()) {
    const label = String(sectionId ?? '').trim() || 'unlabeled';
    const safe = label.replace(/[\\/:*?"<>|\x00-\x1f]/g, '_')
        .replace(/\s+/g, '_').replace(/_+/g, '_')
        .replace(/^[._]+|[._]+$/g, '').slice(0, 64) || 'unlabeled';
    const timestamp = date.toISOString().replace(/[-:.]/g, ''); // UTC, milliseconds
    return `topdown_${safe}_${timestamp}`;
}

async function saveSnapshotFiles(parent, stem, png, metadata) {
    // Refuse to reuse an existing folder; never overwrite an earlier capture.
    let exists = false;
    try { await parent.getDirectoryHandle(stem); exists = true; }
    catch (error) { if (error?.name !== 'NotFoundError') throw error; }
    assert(!exists, `Snapshot folder already exists: ${stem}. Retry to use a new timestamp.`);

    const folder = await parent.getDirectoryHandle(stem, { create: true });
    const write = async (filename, bytes) => {
        const file = await folder.getFileHandle(filename, { create: true });
        const stream = await file.createWritable();
        try {
            await stream.write(bytes);
            await stream.close();
        } catch (error) {
            try { await stream.abort(); } catch (_) { /* best effort */ }
            throw error;
        }
    };
    try {
        await write(`${stem}.png`, png);
        await write(`${stem}.json`, new TextEncoder().encode(JSON.stringify(metadata, null, 2)));
    } catch (error) {
        throw new Error(`Snapshot folder ${stem} may be incomplete: ${fmtError(error)}`);
    }
    return stem;
}

// Temporary fit-to-bounds for a SEMANTIC snapshot. The editor's 3.9.2 Camera
// has normalized distance; derive it from its real orthographic formula rather
// than guessing a world-space camera distance. This does not affect the normal
// hierarchy navigation and always restores the previous focal point and zoom.
// Only use with a true top-down orthographic view.
function semanticSnapshotFitDistance(camera, bounds, width, height, margin = 0.08) {
    assert(bounds?.x && bounds?.z && width > 0 && height > 0, 'Invalid semantic snapshot framing bounds.');
    const extentX = bounds.x.max - bounds.x.min, extentZ = bounds.z.max - bounds.z.min;
    assert([extentX, extentZ].every(Number.isFinite) && extentX >= 0 && extentZ >= 0,
        'Semantic snapshot extent is invalid.');
    const aspect = width / height;
    const halfHeight = Math.max(extentZ / 2, extentX / (2 * aspect), 0.00001) * (1 + margin);
    const sceneRadius = camera.sceneRadius, fovFactor = camera.fovFactor, fov = camera.fov;
    assert([sceneRadius, fovFactor, fov].every(v => Number.isFinite(v) && v > 0),
        'Editor camera cannot provide stable orthographic snapshot framing.');
    const horizontalFactor = width > height ? height / width : 1;
    return halfHeight * fovFactor / (sceneRadius * (fov / 90) * horizontalFactor);
}
async function withSemanticSnapshotFraming(scene, bounds, width, height, task) {
    const camera = scene.camera;
    assert(camera.ortho && camera.setFocalPoint && camera.setDistance && camera.onUpdate &&
        camera.focalPointTween?.value && camera.distanceTween?.value,
        'Fit Snapshot requires a top-down orthographic Editor camera.');
    const frame = camera.captureFrame();
    // Confirm actual Y-down orientation. Do not silently rotate the viewport.
    const forward = frame.rotation;
    assert(forward && [forward.x,forward.y,forward.z,forward.w].every(Number.isFinite),
        'Snapshot camera orientation is invalid.');
    const direction = snapshotView(forward);
    assert(direction.axis === 'Y' && direction.direction === '-Y',
        'Fit Snapshot requires a top-down Y-down orthographic view. Use Top View / Navigate.');
    const previous = { focal: { ...camera.focalPointTween.value },
        distance: camera.distanceTween.value.distance };
    const focal = {
        x: (bounds.x.min + bounds.x.max) / 2,
        y: (bounds.y.min + bounds.y.max) / 2,
        z: (bounds.z.min + bounds.z.max) / 2
    };
    const distance = semanticSnapshotFitDistance(camera, bounds, width, height);
    const makePoint = point => {
        const v = frame.position.clone();
        return v.set(point.x,point.y,point.z);
    };
    try {
        camera.setFocalPoint(makePoint(focal), 0);
        camera.setDistance(distance, 0);
        camera.onUpdate(0);
        scene.forceRender = true;
        return await task();
    } finally {
        camera.setFocalPoint(makePoint(previous.focal), 0);
        camera.setDistance(previous.distance, 0);
        camera.onUpdate(0);
        scene.forceRender = true;
    }
}

// Native render.image already owns the offscreen RGBA readback and encodePng.
// A narrow stream-like sink retains the native PNG bytes. At postrender, while
// offscreen mode is active, captureFrame() returns immutable matching matrices.
// Managed calls inject the PUBLIC editor.viewport.captureFrame() wrapper, which
// delegates to this same camera method in the verified v3.7.0 source. The
// fallback keeps pure snapshot-helper tests independent of the Plugin Manager.
async function captureSnapshot(scene, metadata = null, width = SIZE[0], height = SIZE[1], directory, sectionId = null, captureFrame = () => scene.camera.captureFrame(), verifyTarget = null, sourceModelName = null, semanticOverlay = null) {
    const events = scene.events;
    verifyTarget?.();
    assert(scene.camera.ortho, 'Switch to orthographic view before exporting.');
    assert(directory, 'Select a snapshot destination folder first.');
    assert(!scene.__customCaptureBusy, 'Another custom capture is active.');
    assert(events.functions?.has('render.image'), 'Native image renderer is unavailable.');
    assert(width > 0 && height > 0 && width <= scene.graphicsDevice.maxTextureSize &&
        height <= scene.graphicsDevice.maxTextureSize, 'Unsupported snapshot dimensions.');
    scene.__customCaptureBusy = true;
    let frame = null, png = null, closed = false;
    const saved = {
        overlays: scene.camera.renderOverlays,
        gizmo: scene.gizmoLayer.enabled,
        centers: scene.centersLayer.enabled,
        color: scene.camera.camera.clearColor.clone()
    };
    const handle = events.on('postrender', () => {
        if (!frame && scene.camera.targetSize.width === width && scene.camera.targetSize.height === height) {
            frame = captureFrame();
        }
    });
    const sink = {
        async write(bytes) { png = new Uint8Array(bytes); },
        async close() { closed = true; }
    };
    try {
        const transparent = saved.color.clone();
        transparent.set(0, 0, 0, 0);
        scene.camera.clearPass.setClearColor(transparent);
        const ok = await events.invoke('render.image', {
            width, height, transparentBg: true, showDebug: false,
            format: 'png', projection: 'standard'
        }, sink);
        assert(ok === true && closed && png && png.length >= 24, 'Native image capture failed.');
        assert(png[0] === 137 && png[1] === 80 && png[2] === 78 && png[3] === 71, 'Invalid PNG output.');
        assert(frame && frame.ortho && frame.target.width === width && frame.target.height === height,
            'Offscreen camera frame was not captured at the PNG resolution.');
        const view = Array.from(frame.view.data), projection = Array.from(frame.projection.data);
        // Use the captured offscreen camera orientation, not a stale View Cube
        // button selection or a user-entered floor label, for section metadata.
        const viewInfo = snapshotView(frame.rotation);
        const stem = metadata?.semantic_output_stem || snapshotFolderName(sectionId ?? metadata?.section_id);
        const meta = {
            version: 1,
            ...sectionMetadata(metadata, viewInfo),
            ...(metadata?.semantic ? { semantic: structuredClone(metadata.semantic) } : {}),
            ...((metadata?.source_model_name || sourceModelName) ? {
                source_model_name: metadata?.source_model_name || sourceModelName
            } : {}),
            image: `${stem}.png`, image_width: width, image_height: height,
            ...(semanticOverlay ? { semantic_overlay: { polygon_count: semanticOverlay.rooms?.length || 0,
                labels_rendered: !!semanticOverlay.rooms?.length } } : {}),
            coordinate_system: 'playcanvas', projection: 'orthographic',
            snapshot_view: viewInfo,
            matrix_storage: 'column-major', multiplication_order: 'P * V * world',
            pixel_origin: 'top-left',
            clip_to_pixel: 'NDC x[-1,1] -> [0,W]; y mapped to top-left pixel coords',
            view_matrix: view, projection_matrix: projection,
            view_projection_matrix: matMul4(projection, view),
            position: [frame.position.x, frame.position.y, frame.position.z],
            rotation: [frame.rotation.x, frame.rotation.y, frame.rotation.z, frame.rotation.w]
        };
        // Avoid writing a PNG/JSON pair with ambiguous model scope if the
        // selected layer disappeared or changed while the native renderer ran.
        verifyTarget?.();
        if (semanticOverlay?.rooms?.length) {
            const { annotateSemanticSnapshotPng } = await import('./semantic-view.js');
            png = await annotateSemanticSnapshotPng(png, meta, semanticOverlay);
            verifyTarget?.();
        }
        await saveSnapshotFiles(directory, stem, png, meta);
        return meta;
    } finally {
        handle.off();
        scene.camera.renderOverlays = saved.overlays;
        scene.gizmoLayer.enabled = saved.gizmo;
        scene.centersLayer.enabled = saved.centers;
        scene.camera.camera.clearColor.copy(saved.color);
        // Native render.image restores the rendering clear pass to transparent
        // black. CameraComponent.clearColor is a different state (often white);
        // copying it into clearPass makes the entire viewport wash out.
        const clear = saved.color.clone();
        clear.set(0, 0, 0, 0);
        scene.camera.clearPass.setClearColor(clear);
        scene.forceRender = true;
        scene.__customCaptureBusy = false;
    }
}

function makeButton(text, click) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = text;
    button.addEventListener('click', click);
    return button;
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

async function openPreview(scene, initialTransforms, session = null, target = null, host = null, snapshotButton = null) {
    if (!target) {
        const visible = splatsIn(scene);
        assert(visible.length === 1, 'Select one loaded model before starting XYZ preview.');
        target = visible[0];
    }
    selectedModel(scene, target);
    if (document.getElementById('custom-xyz-semantic-preview')) return;
    assert(!document.getElementById('custom-xyz-preview'),
        'XYZ Filter preview is already running. Close the basic plugin before XYZ Semantic.');
    assert(!scene.events.invoke('timeline.playing'), 'Pause playback before opening spatial preview.');
    const panel = document.createElement('section');
    panel.id = 'custom-xyz-semantic-preview';
    panel.className = 'blocks-shortcuts';
    panel.setAttribute('aria-label', 'XYZ visibility preview');
    panel.style.cssText = host
        ? 'position:static;width:100%;box-sizing:border-box;margin-top:12px;padding:10px;background:#292b30;color:#eee;border:1px solid #505158;border-radius:7px;font:13px sans-serif'
        : 'position:fixed;z-index:1002;right:clamp(16px,4vw,72px);bottom:102px;width:min(520px,calc(100vw - 32px));max-height:calc(100vh - 150px);overflow-y:auto;box-sizing:border-box;padding:14px;background:#252526;color:#eee;border:1px solid #777;border-radius:8px;font:14px sans-serif;box-shadow:0 3px 14px #0007';
    const axisSection = axis => {
        const cap = axis.toUpperCase();
        return `<div style="margin:10px 0;padding:10px;background:#303135;border:1px solid #505158;border-radius:7px">
            <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:8px">
                <strong>${cap} Axis</strong><span id="${axis}-domain" style="font-size:11px;color:#c7c7c7"></span>
            </div>
            <div style="display:grid;grid-template-columns:92px minmax(0,1fr) 92px;gap:12px;align-items:center">
                <label style="font-size:12px;min-width:0">Min
                    <input id="${axis}-min" aria-label="${cap} minimum" type="number" step="0.001" style="display:block;margin-top:5px;width:100%;box-sizing:border-box;min-width:0;background:#222;color:#fff;border:1px solid #777;border-radius:5px;padding:5px 3px;font:inherit">
                </label>
                <div id="${axis}-slider" role="group" aria-label="${cap} interval" style="position:relative;height:34px;margin:10px 11px 0;touch-action:none;user-select:none;cursor:pointer;min-width:0">
                    <div style="position:absolute;left:0;right:0;top:14px;height:6px;border-radius:3px;background:#60646a;pointer-events:none"></div>
                    <div id="${axis}-selected" style="position:absolute;top:14px;height:6px;background:#77b6f8;border-radius:3px;cursor:grab;touch-action:none;z-index:1"></div>
                    <button id="${axis}-min-handle" data-handle="min" type="button" role="slider" aria-label="Minimum ${cap}" style="position:absolute;top:6px;left:0;width:22px;height:22px;border-radius:50%;border:2px solid #d9e8ff;background:#357dc8;transform:translateX(-50%);cursor:ew-resize;touch-action:none;z-index:3;padding:0"></button>
                    <button id="${axis}-max-handle" data-handle="max" type="button" role="slider" aria-label="Maximum ${cap}" style="position:absolute;top:6px;left:100%;width:22px;height:22px;border-radius:50%;border:2px solid #d9e8ff;background:#357dc8;transform:translateX(-50%);cursor:ew-resize;touch-action:none;z-index:4;padding:0"></button>
                </div>
                <label style="font-size:12px;min-width:0">Max
                    <input id="${axis}-max" aria-label="${cap} maximum" type="number" step="0.001" style="display:block;margin-top:5px;width:100%;box-sizing:border-box;min-width:0;background:#222;color:#fff;border:1px solid #777;border-radius:5px;padding:5px 3px;font:inherit">
                </label>
            </div>
            <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;margin-top:8px">
                <span id="${axis}-current" style="font-size:12px;color:#aad4ff"></span>
                <button id="${axis}-reset" type="button">Reset</button>
            </div>
        </div>`;
    };
    panel.innerHTML = `<div id="xyz-preview-header" style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:10px;padding-bottom:7px">
            <h3 style="margin:0;font-size:15px;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">XYZ visibility preview</h3>
            ${host ? '' : '<button id="xyz-preview-minimize" type="button" aria-label="Minimize XYZ visibility preview">Minimize</button>'}
        </div>
        <div id="xyz-preview-body">
        <p id="target" style="font-size:12px;color:#aad4ff;margin:0 0 8px"></p>
        <label><input id="enabled" type="checkbox"> Enable filter (Editor world X/Y/Z)</label>
        ${['x', 'y', 'z'].map(axisSection).join('')}
        <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
            <button id="reset" type="button">Clear filter</button>
            <span style="font-size:11px;color:#c2c2c2">Drag handles or selected ranges; click tracks; or type values.</span>
        </div>
        <div id="semantic-slot"></div>
        ${host ? '<div id="snapshot-slot" style="display:none"></div>' : ''}
        <p id="status" role="status">Reading Gaussian centers…</p>
        <p style="display:none"><label>Section identifier (optional) <input id="floor" type="text" maxlength="120"></label></p>
        <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:10px">
            ${host ? '' : '<button id="snapshot" type="button">Top-Down Snapshot (1920x1080)</button>'}
            ${host ? '' : '<button id="close" type="button">Restore and close</button>'}
        </div>
        <div id="xyz-export-format-row" style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin-top:9px">
            <label style="font-size:12px">Filtered export format
                <select id="export-format" aria-label="Filtered model format" style="margin-left:4px;background:#303238;color:white;border:1px solid #777;padding:4px">
                    <option value="ply">PLY / Compressed PLY</option>
                    <option value="splat">SPLAT</option>
                    <option value="sog">SOG</option>
                    <option value="spz">SPZ</option>
                </select>
            </label>
            <button id="export-filtered" type="button" style="display:none">Export filtered model...</button>
        </div></div>`;
    if (host) host.append(panel);
    else if (session?.uiHost) session.uiHost.append(panel);
    else document.body.append(panel);
    const get = id => $(panel, id);
    // One visible Snapshot control, mounted immediately below Clear filter.
    // The button and its original two-path handler are owned by the main panel.
    // Semantic UI owns visible snapshots; retain legacy hidden button for regression compatibility.
    if (host && snapshotButton) get('snapshot-slot').append(snapshotButton);
    // The managed UI has ONE floating window; the preview is an inline section.
    const windowControls = host ? null : attachPluginWindow(panel, get('xyz-preview-body'), get('xyz-preview-minimize'));
    const status = text => { get('status').textContent = text; };
    get('target').textContent = `Selected model: ${target.name || '(unnamed)'} · Other models hidden during preview.`;
    let close;
    const closed = new Promise(resolve => { close = resolve; });
    if (!host) get('close').onclick = close;
    // Let the manager stop this preview during plugin deactivation.
    const closeRequested = () => close();
    if (session) {
        session.closePreview = closeRequested;
        if (session.stopping) closeRequested();
    }
    const masks = [];
    let lockedColor, originalColor;
    try {
        lockedColor = scene.events.invoke('lockedClr');
        assert(lockedColor && typeof lockedColor.clone === 'function' && typeof lockedColor.copy === 'function',
            'Native locked-color service is unavailable.');
        originalColor = lockedColor.clone();
    } catch (error) {
        windowControls?.dispose();
        panel.remove();
        if (session?.closePreview === closeRequested) session.closePreview = null;
        if (session) session.snapshotPreview = null;
        throw error;
    }
    // A reserved ID prevents the original frozen xyz-filter from entering its
    // own preview while XYZ Semantic owns Gaussian flags. Never run two masks.
    const previewInterlock = document.createElement('span');
    previewInterlock.id = 'custom-xyz-preview';
    previewInterlock.style.display = 'none';
    panel.append(previewInterlock);
    let semanticUI = null;
    let running = Promise.resolve(), capturing = false, active = true;
    let isolation = null;
    let targetRemoved = false;
    const removedListener = scene.events?.on?.('scene.elementRemoved', element => {
        if (element === target) {
            targetRemoved = true;
            active = false;
            status('Selected model removed. Closing XYZ preview; no GPU restoration will be attempted for it.');
            close();
        }
    });
    const inFlight = new Set();
    // Export/snapshot pickers and native writes must finish before restoring masks.
    const withOperation = fn => {
        const promise = fn(); // start synchronously (folder picker needs user gesture)
        inFlight.add(promise);
        void promise.then(() => inFlight.delete(promise), () => inFlight.delete(promise));
        return promise;
    };
    let refreshTask = null, refreshDirty = false;
    const sliderTimers = new Map();
    let cancelTimers = () => {};
    const axes = ['x', 'y', 'z'];
    // Only short operations enter the native queue. Never hold it while the UI is open.
    const enqueue = fn => { running = running.then(() => scene.commandQueue.enqueue(fn)); return running; };
    try {
        await enqueue(async () => {
            selectedModel(scene, target);
            const centers = await readWorldCenters(target);
            if (!modelAttached(scene, target)) return; // removed during source read
            selectedModel(scene, target);
            masks.push(new PreviewMask(target, centers));
        });
        assert(!session?.stopping && !targetRemoved && masks.length, 'XYZ preview was closed while loading.');
        // Explicit isolation prevents the shared locked-color alpha from
        // changing the appearance of unrelated visible models.
        isolation = isolateModel(scene, target, true);
        const domains = Object.fromEntries(axes.map(axis => [axis, axisDomain(masks.map(m => m.centers[axis]), axis === 'y')]));
        const ranges = Object.fromEntries(axes.map(axis => [axis,
            { ...(axis === 'y' ? domains[axis].focus : domains[axis].full) }]));
        const full = Object.fromEntries(axes.map(axis => [axis, domains[axis].full]));
        // Semantic editors observe the ONE native XYZ preview; no parallel mask.
        const rangeObservers = new Set();
        const reportRangeChange = axis => {
            if (axis !== 'y') return;
            const live = { min: ranges.y.min, max: ranges.y.max };
            for (const listener of rangeObservers) {
                try { listener(live, get('enabled').checked); }
                catch (error) { status(`Semantic Y link: ${fmtError(error)}`); }
            }
        };
        const syncAxis = axis => {
            const r = ranges[axis], d = full[axis];
            const span = d.max - d.min;
            const ratio = v => span > 0 ? Math.max(0, Math.min(1, (v - d.min) / span)) : .5;
            const minPct = ratio(r.min) * 100, maxPct = ratio(r.max) * 100;
            get(`${axis}-min`).value = display3(r.min);
            get(`${axis}-max`).value = display3(r.max);
            get(`${axis}-domain`).textContent = `Full ${axis.toUpperCase()}: ${display3(d.min)} to ${display3(d.max)}`;
            get(`${axis}-current`).textContent = `Filtered ${axis.toUpperCase()}: ${display3(r.min)} to ${display3(r.max)}`;
            const minHandle = get(`${axis}-min-handle`), maxHandle = get(`${axis}-max-handle`);
            minHandle.style.left = `${minPct}%`;
            maxHandle.style.left = `${maxPct}%`;
            get(`${axis}-selected`).style.left = `${minPct}%`;
            get(`${axis}-selected`).style.width = `${Math.max(0, maxPct - minPct)}%`;
            const together = minPct === maxPct;
            minHandle.style.transform = together ? 'translateX(calc(-50% - 7px))' : 'translateX(-50%)';
            maxHandle.style.transform = together ? 'translateX(calc(-50% + 7px))' : 'translateX(-50%)';
            for (const [handle, side] of [[minHandle, 'min'], [maxHandle, 'max']]) {
                handle.setAttribute('aria-valuemin', String(side === 'min' ? d.min : r.min));
                handle.setAttribute('aria-valuemax', String(side === 'min' ? r.max : d.max));
                handle.setAttribute('aria-valuenow', String(r[side]));
                handle.setAttribute('aria-valuetext', `${display3(r[side])} model units`);
            }
            reportRangeChange(axis);
        };
        axes.forEach(syncAxis);
        const refresh = () => {
            refreshDirty = true;
            if (refreshTask) return refreshTask;
            refreshTask = (async () => {
                try {
                    while (refreshDirty && active) {
                        refreshDirty = false;
                        await enqueue(() => {
                            assert(active, 'Preview is no longer valid.');
                            if (targetRemoved || !modelAttached(scene, target)) {
                                active = false;
                                status('Selected model removed. Closing preview; select another model to continue.');
                                close();
                                return;
                            }
                            isolation.ensure();
                            for (const mask of masks) mask.verify(scene);
                            const enabled = get('enabled').checked;
                            lockedColor.a = enabled ? 0 : originalColor.a;
                            for (const mask of masks) enabled ? mask.apply(ranges) : mask.restore();
                            scene.forceRender = true;
                            status(enabled ? 'Filter active. Camera navigation remains available.' : 'Filter inactive.');
                        });
                    }
                } catch (e) {
                    active = false;
                    const reason = fmtError(e).replace(/[.\s]+$/, '');
                    status(`Preview invalidated: ${reason}. Restore and close, then select a model again.`);
                } finally {
                    refreshTask = null;
                    if (refreshDirty && active) void refresh();
                }
            })();
            return refreshTask;
        };
        let lastRefresh = 0;
        const scheduleRefresh = (axis, final = false) => {
            if (!active || capturing) return;
            const timer = sliderTimers.get(axis);
            if (timer !== undefined) { clearTimeout(timer); sliderTimers.delete(axis); }
            const now = performance.now();
            if (final || now - lastRefresh >= 120) {
                lastRefresh = now;
                void refresh();
            } else {
                sliderTimers.set(axis, setTimeout(() => {
                    sliderTimers.delete(axis);
                    lastRefresh = performance.now();
                    if (active && !capturing) void refresh();
                }, 120 - (now - lastRefresh)));
            }
        };
        cancelTimers = () => {
            for (const timer of sliderTimers.values()) clearTimeout(timer);
            sliderTimers.clear();
        };
        for (const axis of axes) {
            const d = full[axis];
            const span = d.max - d.min;
            const slider = get(`${axis}-slider`);
            let dragging = null;
            const changeSide = (side, v, final = false) => {
                if (!active || capturing || !Number.isFinite(v)) return;
                const r = ranges[axis], bounded = Math.max(d.min, Math.min(d.max, v));
                ranges[axis] = side === 'min' ?
                    interval(Math.min(bounded, r.max), r.max) : interval(r.min, Math.max(bounded, r.min));
                syncAxis(axis);
                scheduleRefresh(axis, final);
            };
            const fromPointer = clientX => {
                const rect = slider.getBoundingClientRect();
                const t = rect.width > 0 ? Math.max(0, Math.min(1, (clientX - rect.left) / rect.width)) : .5;
                if (t === 0 || span === 0) return d.min;
                if (t === 1) return d.max;
                // Preserve the original pointer quantization; readouts use three decimal places.
                return Math.max(d.min, Math.min(d.max, Math.round((d.min + t * span) * 1000) / 1000));
            };
            const moveRange = (clientX, final = false) => {
                const rect = slider.getBoundingClientRect();
                if (rect.width <= 0) return;
                const { min, max } = dragging.startRange;
                const width = max - min;
                const shift = Math.max(d.min - min, Math.min(d.max - max,
                    (clientX - dragging.startX) / rect.width * span));
                ranges[axis] = interval(min + shift, min + shift + width);
                syncAxis(axis);
                scheduleRefresh(axis, final);
            };
            for (const side of ['min', 'max']) {
                const input = get(`${axis}-${side}`);
                input.onchange = () => {
                    if (!active || capturing) return;
                    const v = input.valueAsNumber;
                    if (!Number.isFinite(v)) { syncAxis(axis); status(`${axis.toUpperCase()} ${side} must be a number.`); return; }
                    changeSide(side, v, true);
                };
                const handle = get(`${axis}-${side}-handle`);
                handle.addEventListener('keydown', e => {
                    if (!active || capturing) return;
                    const sign = ({ ArrowLeft: -1, ArrowDown: -1, ArrowRight: 1, ArrowUp: 1 })[e.key];
                    if (sign === undefined && e.key !== 'Home' && e.key !== 'End') return;
                    e.preventDefault();
                    const current = ranges[axis][side];
                    const target = e.key === 'Home' ? (side === 'min' ? d.min : ranges[axis].min) :
                        e.key === 'End' ? (side === 'min' ? ranges[axis].max : d.max) : current + sign * 0.001;
                    changeSide(side, target, true);
                });
            }
            get(`${axis}-reset`).onclick = () => {
                if (!active || capturing) return;
                ranges[axis] = { ...d };
                syncAxis(axis);
                scheduleRefresh(axis, true);
            };
            slider.addEventListener('pointerdown', e => {
                if (!active || capturing || e.button !== 0) return;
                const handle = e.target.closest('[data-handle]');
                const selected = !handle && e.target === get(`${axis}-selected`);
                const value = fromPointer(e.clientX);
                const side = selected ? 'range' : (handle?.dataset.handle ??
                    (Math.abs(value - ranges[axis].min) <= Math.abs(value - ranges[axis].max) ? 'min' : 'max'));
                dragging = { id: e.pointerId, side, startX: e.clientX, startRange: { ...ranges[axis] } };
                e.preventDefault();
                slider.setPointerCapture(e.pointerId);
                if (!handle && !selected) changeSide(side, value);
            });
            slider.addEventListener('pointermove', e => {
                if (dragging?.id !== e.pointerId) return;
                if (dragging.side === 'range') moveRange(e.clientX);
                else changeSide(dragging.side, fromPointer(e.clientX));
            });
            const finishDrag = e => {
                if (dragging?.id !== e.pointerId) return;
                if (dragging.side === 'range') moveRange(e.clientX, true);
                else changeSide(dragging.side, fromPointer(e.clientX), true);
                dragging = null;
                if (slider.hasPointerCapture(e.pointerId)) slider.releasePointerCapture(e.pointerId);
            };
            slider.addEventListener('pointerup', finishDrag);
            slider.addEventListener('pointercancel', e => {
                if (dragging?.id === e.pointerId) { dragging = null; scheduleRefresh(axis, true); }
            });
        }
        get('enabled').onchange = () => { if (active && !capturing) { cancelTimers(); void refresh(); } };
        get('reset').onclick = () => {
            if (!active || capturing) return;
            cancelTimers();
            for (const axis of axes) {
                ranges[axis] = { ...full[axis] };
                syncAxis(axis);
            }
            get('enabled').checked = false;
            void refresh();
        };
        // Semantic actions share the existing ONE PreviewMask. They never
        // create a second filter or call into the basic XYZ Filter plugin.
        const snapshotRanges = () => Object.fromEntries(axes.map(axis => [axis, { ...ranges[axis] }]));
        const stageRanges = async (requested, enable) => {
            cancelTimers();
            for (const axis of axes) {
                const req = requested[axis], domain = full[axis];
                assert(req && Number.isFinite(req.min) && Number.isFinite(req.max) && req.min <= req.max,
                    `Invalid semantic ${axis.toUpperCase()} range.`);
                const lo = Math.max(domain.min, req.min), hi = Math.min(domain.max, req.max);
                assert(lo <= hi, `Semantic region is outside the model ${axis.toUpperCase()} domain.`);
                ranges[axis] = { min: lo, max: hi };
                syncAxis(axis);
            }
            get('enabled').checked = !!enable;
            await refresh();
            await running;
            assert(active && !targetRemoved, 'Preview no longer active.');
        };
        const semanticSnapshot = context => withOperation(async () => {
            assert(active && !capturing, 'Another operation is already running.');
            const request = chooseSnapshotDirectory(); // Synchronous user activation.
            capturing = true;
            const controls = [...panel.querySelectorAll('input,button,select')];
            const disabled = controls.map(c => c.disabled);
            controls.forEach(c => { c.disabled = true; });
            const before = snapshotRanges(), priorEnabled = get('enabled').checked;
            try {
                const directory = await request;
                if (context.target.type !== 'building') {
                    const frame = scene.camera.captureFrame();
                    const view = snapshotView(frame.rotation);
                    assert(frame.ortho && view.axis === 'Y' && view.direction === '-Y',
                        'Select Top View / Navigate for a top-down orthographic floor/room snapshot.');
                }
                await stageRanges(context.bounds, true);
                const mapping = initialTransforms.userAdjustment([target]);
                const actual = snapshotRanges();
                const metadata = {
                    ranges: actual, section_id: context.semantic.room_id || context.semantic.floor_id || '',
                    source_model_name: target.name || '(unnamed)',
                    model_to_snapshot: mapping ? toRows(mapping) : null,
                    mapping_status: mapping ? 'declared_uniform' : 'unknown_per_gaussian_or_multiple_models',
                    semantic: { ...context.semantic, world_xyz_bounds: actual },
                    semantic_output_stem: context.stem
                };
                const { width, height, fit } = context.snapshot || { width: SIZE[0], height: SIZE[1], fit: false };
                assert(Number.isInteger(width) && Number.isInteger(height) && width > 0 && height > 0,
                    'Invalid semantic snapshot dimensions.');
                metadata.semantic_capture = { width, height, fit_to_region: !!fit, fit_margin: fit ? 0.08 : null };
                const revision = isolation.revision();
                const runCapture = () => captureSnapshot(scene, metadata, width, height, directory,
                    metadata.section_id, session?.editor ? () => session.editor.viewport.captureFrame() : undefined,
                    () => {
                        isolation.ensure();
                        assert(isolation.revision() === revision, 'Scene changed during semantic snapshot.');
                        masks[0].verify(scene);
                    }, target.name || '(unnamed)', context.overlay);
                const result = fit ? await withSemanticSnapshotFraming(scene, actual, width, height, runCapture) : await runCapture();
                status(`Semantic snapshot saved: ${result.image}`);
                return result;
            } catch (e) {
                status(`Semantic snapshot: ${fmtError(e)}`);
                if (e?.name !== 'AbortError') throw e;
            } finally {
                try { if (active) await stageRanges(before, priorEnabled); }
                catch (e) { active = false; status(`Semantic preview restoration failed: ${fmtError(e)}`); close(); }
                controls.forEach((c,i) => { c.disabled=disabled[i]; });
                capturing = false;
            }
        });
        const semanticExport = context => withOperation(async () => {
            assert(active && !capturing, 'Another operation is already running.');
            capturing = true;
            const controls = [...panel.querySelectorAll('input,button,select')];
            const disabled = controls.map(c => c.disabled);
            controls.forEach(c => { c.disabled = true; });
            const before = snapshotRanges(), priorEnabled = get('enabled').checked;
            try {
                // Export full semantic Y extent, never the current ceiling-free
                // or temporary wall-tracing preview. Native subset exporter below.
                await stageRanges(context.bounds, true);
                const chosen = snapshotRanges();
                const result = await exportFilteredModel(scene, masks, chosen,
                    get('export-format').value,
                    () => active && get('enabled').checked && axes.every(a =>
                        ranges[a].min === chosen[a].min && ranges[a].max === chosen[a].max), {
                        userAdjustment: splats => initialTransforms.userAdjustment(splats),
                        sectionId: context.semantic.room_id || context.semantic.floor_id || '',
                        semantic: { ...context.semantic, world_xyz_bounds: chosen },
                        semanticOutputStem: context.stem
                    });
                if (!result) status('Semantic model export cancelled.');
                else if (result.reportError) status(`Model exported; report error: ${result.reportError}`);
                else status(result.modelExported ? 'Semantic model subset exported with report.' : 'Semantic model export not completed.');
                return result;
            } catch (e) {
                status(`Semantic export failed: ${fmtError(e)}`);
                throw e;
            } finally {
                try { if (active) await stageRanges(before, priorEnabled); }
                catch (e) { active = false; status(`Semantic preview restoration failed: ${fmtError(e)}`); close(); }
                controls.forEach((c,i) => { c.disabled=disabled[i]; });
                capturing = false;
            }
        });
        const semanticPreview = {
            full, worldCenters: masks[0].centers,
            getRanges: snapshotRanges, enabled: () => get('enabled').checked,
            busy: () => capturing || !active,
            setRanges: async (requested, enable) => {
                assert(active && !capturing, 'Cannot change filter during an operation.');
                await stageRanges(requested, enable);
            },
            onRangesChanged: listener => {
                assert(typeof listener === 'function', 'Y range observer must be a function.');
                rangeObservers.add(listener);
                return () => rangeObservers.delete(listener);
            },
            snapshotSemantic: semanticSnapshot,
            exportSemantic: semanticExport
        };
        if (session?.editor?.viewport?.setCamera && session.editor.viewport.info) {
            const { attachSemanticUI } = await import('./semantic-ui.js');
            const readSemanticMapping = semanticMappingReader(target);
            semanticUI = attachSemanticUI({ scene, editor: session.editor, target, preview: semanticPreview,
                holder: get('semantic-slot'), exportFormatRow: get('xyz-export-format-row'), modelToWorld: () => {
                    if (!modelAttached(scene, target)) return null;
                    const m = readSemanticMapping();
                    return m ? Array.from(m.data) : null;
                } });
            if (session) session.semanticUI = semanticUI;
        }
        get('export-filtered').onclick = () => withOperation(async () => {
            if (!active) { status('Preview is invalid. Restore and close, then reopen for the selected model.'); return; }
            if (capturing) { status('Another snapshot or export is in progress.'); return; }
            if (!get('enabled').checked) {
                status('Enable XYZ filtering before exporting a filtered model.');
                return;
            }
            capturing = true; // Blocks slider edits and snapshot capture during the export dialog/write.
            const controls = [...panel.querySelectorAll('input,button,select')];
            const disabledBefore = controls.map(c => c.disabled);
            controls.forEach(c => { c.disabled = true; });
            try {
                cancelTimers();
                await refresh();
                await running;
                const selected = Object.fromEntries(axes.map(axis => [axis, { ...ranges[axis] }]));
                const result = await exportFilteredModel(scene, masks, selected,
                    get('export-format').value, () => active && get('enabled').checked &&
                    axes.every(axis => ranges[axis].min === selected[axis].min &&
                        ranges[axis].max === selected[axis].max), {
                        userAdjustment: splats => initialTransforms.userAdjustment(splats),
                        sectionId: get('floor').value
                    });
                if (!result) status('Filtered model export cancelled.');
                else if (result.reportError) status(`Model exported, but JSON report failed: ${result.reportError}`);
                else if (result.report?.delivery === 'saved_in_export_folder')
                    status(`Model and ${result.report.filename} saved in the selected folder.${result.mappingStatus && result.mappingStatus !== 'declared_uniform' ? ' Model adjustment unavailable; see JSON mapping_status.' : ''}`);
                else if (result.report) status(`Model exported; JSON report download requested: ${result.report.filename}${result.mappingStatus && result.mappingStatus !== 'declared_uniform' ? ' (model adjustment unavailable; see JSON mapping_status)' : ''}`);
                else status('Filtered model export did not complete.');
            } catch (e) {
                status(`Filtered export failed: ${fmtError(e)}`);
                console.error('Filtered model export failed:', e);
            } finally {
                controls.forEach((c, i) => { c.disabled = disabledBefore[i]; });
                capturing = false;
            }
        });
        const capturePreviewSnapshot = () => withOperation(async () => {
            if (!active) { status('Preview is invalid. Restore and close, then reopen for the selected model.'); return; }
            if (capturing) { status('Another snapshot or export is in progress.'); return; }
            capturing = true;
            const controls = [...panel.querySelectorAll('input,button')];
            const disabledBefore = controls.map(c => c.disabled);
            controls.forEach(c => { c.disabled = true; });
            try {
                // Must open from this click, before any async filter/camera work.
                let directory;
                try { directory = await chooseSnapshotDirectory(); }
                catch (error) {
                    if (error?.name === 'AbortError') { status('Snapshot cancelled.'); return; }
                    throw error;
                }
                cancelTimers();
                // Apply the latest slider values even if their throttled update
                // was still pending when Snapshot was clicked.
                await refresh();
                await running;
                isolation.ensure();
                for (const mask of masks) mask.verify(scene);
                let metadata = { source_model_name: target.name || '(unnamed)' };
                if (get('enabled').checked) {
                    const mapping = initialTransforms.userAdjustment([target]);
                    // Snapshot view/section axis is resolved from the *captured*
                    // camera frame in captureSnapshot(). The current numeric
                    // intervals remain independent of the viewing direction.
                    metadata = {
                        ranges: Object.fromEntries(axes.map(axis => [axis, { ...ranges[axis] }])),
                        section_id: get('floor').value.trim(),
                        source_model_name: target.name || '(unnamed)',
                        model_to_snapshot: mapping ? toRows(mapping) : null,
                        mapping_status: mapping ? 'declared_uniform' : 'unknown_per_gaussian_or_multiple_models'
                    };
                }
                const sceneRevision = isolation.revision();
                const result = await captureSnapshot(scene, metadata, SIZE[0], SIZE[1],
                    directory, get('floor').value.trim(),
                    session?.editor ? () => session.editor.viewport.captureFrame() : undefined,
                    () => {
                        isolation.ensure();
                        assert(isolation.revision() === sceneRevision,
                            'Scene changed during snapshot capture. Retry after loading completes.');
                        masks[0].verify(scene);
                    }, target.name || '(unnamed)');
                status(`Snapshot saved in folder: ${result.image.slice(0, -4)}${metadata?.ranges && !metadata.model_to_snapshot ? ' (model adjustment unavailable; see JSON mapping_status)' : ''}`);
            } catch (e) { status(`Snapshot failed: ${fmtError(e)}`); }
            finally { controls.forEach((c, i) => { c.disabled = disabledBefore[i]; }); capturing = false; }
        });
        if (host && session) session.snapshotPreview = capturePreviewSnapshot;
        else get('snapshot').onclick = capturePreviewSnapshot;
        status('Filter inactive.');
        await closed;
        cancelTimers();
        if (refreshTask) await refreshTask.catch(() => {});
        await running.catch(() => {});
    } catch (e) {
        status(`XYZ preview failed: ${fmtError(e)}`);
        await closed;
    } finally {
        await Promise.allSettled([...inFlight]);
        active = false;
        cancelTimers();
        const errors = [];
        removedListener?.off();
        try {
            await scene.commandQueue.enqueue(() => {
                lockedColor.copy(originalColor);
                for (const mask of masks) {
                    // A detached/destroyed model owns no live GPU flags to restore.
                    if (targetRemoved || !modelAttached(scene, mask.splat)) continue;
                    try { mask.restore(scene); } catch (e) { errors.push(fmtError(e)); }
                }
                scene.forceRender = true;
            });
        } catch (e) { errors.push(fmtError(e)); }
        try { isolation?.restore(); } catch (e) { errors.push(`Visibility restore: ${fmtError(e)}`); }
        try { await semanticUI?.dispose(); } catch (e) { errors.push(`Semantic UI cleanup: ${fmtError(e)}`); }
        if (errors.length) document.body?.append?.(previewInterlock); // fail closed if restoration was unsafe
        else previewInterlock.remove();
        if (session) session.semanticUI = null;
        windowControls?.dispose();
        panel.remove();
        if (session?.closePreview === closeRequested) session.closePreview = null;
        if (session) session.snapshotPreview = null;
        if (errors.length) {
            const message = `XYZ preview restoration incomplete: ${errors.join('; ')}`;
            if (session) session.restoreError = message;
            window.alert(message);
            throw new Error(message);
        }
    }
}


// === MANAGED PLUGIN ENTRY ===

/**
 * Activatable plugin adapter. The existing geometry/snapshot helpers above are
 * intentionally unchanged aside from strict late-baseline handling and managed
 * preview teardown. The v1.7 manager calls open() only on user selection.
 */
export async function activate({ editor, uiHost, plugin }) {
    assert(uiHost && typeof uiHost.append === 'function', 'Plugin Manager UI host unavailable.');
    assert(typeof editor?.viewport?.captureFrame === 'function',
        'Required public Editor API viewport.captureFrame is unavailable.');
    let scene = null;
    // Subscribe as soon as the Scene event bus is ready; do not postpone model
    // baseline tracking while waiting for optional snapshot/export services.
    for (let attempt = 0; attempt < 300; attempt++) {
        scene = window.scene;
        if (scene?.events?.on && Array.isArray(scene.elements)) break;
        await wait(50);
    }
    assert(scene?.events?.on && Array.isArray(scene.elements),
        'Required SuperSplat Scene event services unavailable.');
    const initialTransforms = trackInitialModelTransforms(scene);
    try {
        for (let attempt = 0; attempt < 300; attempt++) {
            if (scene.events.functions?.has('render.image') && scene.camera?.captureFrame &&
                scene.commandQueue?.enqueue) break;
            await wait(50);
        }
        assert(scene.events.functions?.has('render.image') && scene.camera?.captureFrame &&
            scene.commandQueue?.enqueue, 'Required SuperSplat snapshot/export services unavailable.');
    } catch (error) {
        initialTransforms.dispose();
        throw error;
    }
    // As in the original standalone extension, pre-existing layers are sampled
    // at activation. For reliable provenance, enable Startup and load the model
    // only after activation: earlier user edits cannot be inferred retroactively.
    const session = { uiHost, editor, stopping: false, closePreview: null, snapshotPreview: null };
    const tasks = new Set();
    let stopped = false;
    let toolPanel = null;
    let previewTask = null;
    let lastFailure = null;
    let shutdownError = null;
    let selected = null;

    const track = promise => {
        tasks.add(promise);
        void promise.then(() => tasks.delete(promise), () => tasks.delete(promise));
        return promise;
    };
    const btnStyle = 'background:#303238;color:white;border:1px solid #777;border-radius:4px;padding:7px 10px;cursor:pointer';
    const makePanel = () => {
        const panel = document.createElement('section');
        panel.setAttribute('aria-label', 'XYZ Semantic, Snapshot and Export');
        panel.style.cssText = 'position:fixed;left:24px;bottom:24px;z-index:1100;width:min(440px,calc(100vw - 32px));height:min(70vh,740px);min-width:min(330px,calc(100vw - 32px));min-height:120px;max-width:calc(100vw - 32px);max-height:calc(100vh - 48px);resize:both;overflow:hidden;display:flex;flex-direction:column;box-sizing:border-box;background:#252526;color:#eee;border:1px solid #777;border-radius:8px;padding:12px;box-shadow:0 3px 14px #0008;font:13px system-ui,sans-serif';
        const title = document.createElement('strong');
        title.textContent = plugin?.name || 'XYZ Semantic';
        title.style.cssText = 'flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
        const header = document.createElement('div');
        header.style.cssText = 'flex:0 0 auto;background:#252526;display:flex;align-items:center;justify-content:space-between;gap:8px;padding-bottom:7px';
        const minimize = document.createElement('button');
        minimize.type = 'button';
        minimize.textContent = 'Minimize';
        minimize.setAttribute('aria-label', 'Minimize XYZ Semantic main window');
        header.append(title, minimize);
        const body = document.createElement('div');
        body.style.cssText = 'flex:1 1 auto;min-height:0;overflow-y:auto;overflow-x:hidden;padding-right:6px;scrollbar-gutter:stable';
        const info = document.createElement('p');
        info.textContent = 'XYZ uses internal Scene APIs. Snapshot uses the current camera and includes filtering metadata when XYZ filtering is enabled.';
        info.style.cssText = 'font-size:12px;max-width:350px;line-height:1.4';
        const status = document.createElement('p');
        status.setAttribute('role', 'status');
        status.style.cssText = 'font-size:12px;color:#c9d0d8';
        status.textContent = 'Ready. For reliable model-adjustment provenance, activate before importing a model.';
        const modelRow = document.createElement('div');
        modelRow.style.cssText = 'display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin:8px 0';
        const modelLabel = document.createElement('label');
        modelLabel.textContent = 'Loaded Model: ';
        const modelSelect = document.createElement('select');
        modelSelect.setAttribute('aria-label', 'Loaded Model');
        modelSelect.style.cssText = 'max-width:230px;background:#303238;color:#fff;padding:5px;border:1px solid #777';
        const refreshModels = makeButton('Refresh models', () => updateModels());
        refreshModels.style.cssText = btnStyle;
        modelLabel.append(modelSelect);
        modelRow.append(modelLabel);
        const updateModels = () => {
            const models = loadedSplats(scene);
            if (!models.includes(selected)) selected = models.length === 1 ? models[0] : null;
            modelSelect.replaceChildren?.();
            // Avoid inserting model names as HTML: filenames are untrusted text.
            const addOption = (label, value) => {
                const option = document.createElement('option');
                option.textContent = label;
                option.value = value;
                modelSelect.append(option);
            };
            addOption(models.length ? 'Select model…' : 'No 3DGS models loaded', '');
            models.forEach((model, i) => addOption(`${model.name || '(unnamed)'} (#${i + 1})${model.visible ? '' : ' [hidden]'}`, String(i)));
            modelSelect.value = selected ? String(models.indexOf(selected)) : '';
            modelSelect.disabled = switchingModel || !models.length;
            refreshModels.disabled = switchingModel;
            status.textContent = models.length && !selected ? 'Select a loaded model to continue.' :
                (selected ? `Selected model: ${selected.name || '(unnamed)'}` : 'No 3DGS model is loaded.');
        };
        const actions = document.createElement('div');
        actions.style.cssText = 'display:flex;flex-wrap:wrap;gap:6px';
        const snapshot = makeButton('Top-Down Snapshot (1920×1080)', () => {
            if (stopped || snapshot.disabled) return;
            if (previewTask) {
                if (session.snapshotPreview) session.snapshotPreview();
                else status.textContent = 'XYZ preview is initializing; retry Snapshot when its controls appear.';
                return;
            }
            try { selectedModel(scene, selected); }
            catch (e) { updateModels(); status.textContent = `Snapshot unavailable: ${fmtError(e)}`; return; }
            const target = selected;
            // Capture user activation synchronously within this click handler.
            let directoryRequest;
            try { directoryRequest = chooseSnapshotDirectory(); }
            catch (e) { status.textContent = `Snapshot failed: ${fmtError(e)}`; return; }
            snapshot.disabled = true;
            track((async () => {
                try {
                    const directory = await directoryRequest;
                    if (stopped) return;
                    const isolation = isolateModel(scene, target, true);
                    let meta;
                    const sceneRevision = isolation.revision();
                    const instances = target.instances;
                    const count = instances.count;
                    const transform = target.worldTransform.clone();
                    try {
                        meta = await captureSnapshot(scene, null, SIZE[0], SIZE[1], directory, null,
                            () => editor.viewport.captureFrame(), () => {
                                isolation.ensure();
                                assert(isolation.revision() === sceneRevision,
                                    'Scene changed during snapshot capture. Retry after loading completes.');
                                assert(target.instances === instances && target.instances.count === count &&
                                    target.worldTransform.equals(transform),
                                    'Selected model changed during snapshot capture. Retry.');
                            }, target.name || '(unnamed)');
                    } finally { isolation.restore(); }
                    if (!stopped) status.textContent = `Snapshot saved: ${meta.image}`;
                } catch (e) {
                    if (!stopped) status.textContent = e?.name === 'AbortError' ? 'Snapshot cancelled.' : `Snapshot failed: ${fmtError(e)}`;
                } finally { snapshot.disabled = false; }
            })());
        });
        // The XYZ controls are permanently part of the merged window. Opening
        // the window or selecting a model starts the existing reversible preview
        // session automatically; no second button/popup is needed.
        snapshot.style.cssText = btnStyle;
        const previewHost = document.createElement('div');
        previewHost.setAttribute('aria-label', 'XYZ visibility preview controls');
        previewHost.textContent = 'Select a loaded model to display XYZ controls.';
        let switchingModel = false;
        const startPreview = () => {
            if (stopped || panel.hidden || previewTask || switchingModel || !selected) return;
            let target;
            try { target = selectedModel(scene, selected); }
            catch (e) { status.textContent = `Preview unavailable: ${fmtError(e)}`; return; }
            previewHost.replaceChildren?.();
            previewHost.textContent = '';
            const running = (async () => {
                try { await openPreview(scene, initialTransforms, session, target, previewHost, snapshot); }
                catch (e) {
                    if (session.restoreError) lastFailure = new Error(session.restoreError);
                    if (!stopped) status.textContent = `XYZ preview failed: ${fmtError(e)}`;
                } finally {
                    previewTask = null;
                    if (!stopped) {
                        updateModels();
                        if (!panel.hidden && !switchingModel && !session.restoreError)
                            previewHost.textContent = 'Select or refresh a model to initialize XYZ controls.';
                    }
                }
            })();
            previewTask = track(running);
        };
        // A model switch must first restore the old model's native preview
        // state. Selection is then rebound to the new model, never both at once.
        modelSelect.onchange = () => {
            if (switchingModel) return;
            if (session.semanticUI?.dirty() && !window.confirm('Discard unsaved semantic edits before changing models?')) {
                updateModels(); return;
            }
            const models = loadedSplats(scene);
            const next = modelSelect.value === '' ? null : models[Number(modelSelect.value)] ?? null;
            if (!previewTask) {
                selected = next;
                updateModels();
                startPreview();
                return;
            }
            switchingModel = true;
            modelSelect.disabled = true;
            refreshModels.disabled = true;
            status.textContent = 'Restoring previous preview before changing models…';
            const prior = previewTask;
            session.closePreview?.();
            void prior.then(() => {
                if (stopped || panel.hidden || session.restoreError) return;
                selected = next;
            }).catch(e => {
                status.textContent = `Model switch failed: ${fmtError(e)}`;
            }).finally(() => {
                switchingModel = false;
                if (!stopped) {
                    updateModels();
                    if (!panel.hidden && !session.restoreError) startPreview();
                }
            });
        };
        // A flex panel with inline `display:flex` remains visible when only the
        // HTML `hidden` property is set. Close must also hide its CSS display.
        const hidePanel = () => { panel.hidden = true; panel.style.display = 'none'; };
        const hide = makeButton('Close', () => {
            if (stopped || hide.disabled) return;
            if (session.semanticUI?.dirty() && !window.confirm('Semantic changes have not been saved. Close and discard them?')) return;
            if (!previewTask && !tasks.size) { hidePanel(); return; }
            hide.disabled = true;
            if (previewTask) session.closePreview?.();
            const pending = [...tasks];
            void Promise.allSettled(pending).then(results => {
                if (stopped) return;
                const rejected = results.find(r => r.status === 'rejected');
                if (rejected || session.restoreError || lastFailure) {
                    status.textContent = `Could not close safely: ${fmtError(rejected?.reason || session.restoreError || lastFailure)}`;
                    return;
                }
                hidePanel();
            }).finally(() => { hide.disabled = false; });
        });
        hide.style.cssText = btnStyle;
        actions.append(hide, refreshModels);
        body.append(info, actions, modelRow, status, previewHost);
        panel.append(header, body);
        uiHost.append(panel);
        panel.windowControls = attachPluginWindow(panel, body, minimize);
        panel.updateModels = updateModels;
        panel.startPreview = startPreview;
        updateModels();
        return panel;
    };

    // Keep selection honest when models are imported or removed while the
    // plugin is open; no automatic rebinding to another model during preview.
    const modelAdded = scene.events.on('scene.elementAdded', () => {
        if (toolPanel && !previewTask) {
            toolPanel.updateModels?.();
            if (!toolPanel.hidden) toolPanel.startPreview?.();
        }
    });
    const modelRemoved = scene.events.on('scene.elementRemoved', element => {
        if (selected === element) selected = null;
        if (toolPanel && !previewTask) toolPanel.updateModels?.();
    });

    return {
        async open() {
            assert(!stopped, 'XYZ Semantic plugin is inactive.');
            if (!toolPanel) toolPanel = makePanel();
            toolPanel.updateModels?.();
            toolPanel.hidden = false;
            toolPanel.style.display = 'flex';
            toolPanel.windowControls?.restoreWindow();
            toolPanel.startPreview?.();
        },
        // An activated plugin is Running whenever its controls, preview,
        // capture/export task, or restoration are still active.
        isRunning() {
            if (shutdownError) throw shutdownError;
            if (lastFailure || session.restoreError)
                throw new Error(`XYZ preview cleanup failed: ${fmtError(lastFailure || session.restoreError)}`);
            return !!((toolPanel && !toolPanel.hidden) || previewTask || tasks.size || session.closePreview);
        },
        async deactivate() {
            if (stopped) {
                if (shutdownError) throw shutdownError;
                return;
            }
            stopped = true;
            session.stopping = true;
            session.closePreview?.();
            // Force Deactivate may request preview closure. Wait for its native
            // operations and restoration; never claim success on cleanup failure.
            try {
                const results = await Promise.allSettled([...tasks]);
                const rejected = results.filter(r => r.status === 'rejected');
                if (rejected.length)
                    throw new Error(`XYZ operation did not settle cleanly: ${fmtError(rejected[0].reason)}`);
                if (lastFailure || session.restoreError)
                    throw new Error(`XYZ preview did not restore cleanly: ${fmtError(lastFailure || session.restoreError)}`);
            } catch (error) {
                shutdownError = error;  // Prevent a later retry from falsely reporting success.
                throw error;
            } finally {
                initialTransforms.dispose();
                modelAdded.off();
                modelRemoved.off();
                toolPanel?.windowControls?.dispose();
                toolPanel?.remove();
                toolPanel = null;
            }
        }
    };
}
