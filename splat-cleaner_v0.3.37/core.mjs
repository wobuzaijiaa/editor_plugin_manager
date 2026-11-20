/** Splat Cleaner v0.3.37 — v0.3.7 core selection semantics; SNS report describes bidirectional support. */
export const DENSITY_NAMES = ['sparse', 'medium', 'dense'];
export const AXES = ['x', 'y', 'z'];
// Phase 1: diagnostic attribution. Values are stable within this plugin release.
export const RULE_BITS = Object.freeze({ size: 0x01, opacity: 0x02, sns: 0x04, floaters: 0x08, splatTransformFloaters: 0x10 });
export const assert = (ok, message) => { if (!ok) throw new Error(message); };
export const finite = Number.isFinite;
export const tick = () => new Promise(resolve => setTimeout(resolve, 0));

export function domains(centers) {
    const n = centers.x.length;
    assert(n > 0 && centers.y.length === n && centers.z.length === n, 'Missing or inconsistent Gaussian centers.');
    const bounds = Object.fromEntries(AXES.map(a => [a, { min: Infinity, max: -Infinity }]));
    for (let i = 0; i < n; i++) for (const a of AXES) {
        const v = centers[a][i];
        // Fail closed. An arbitrary remote outlier must not silently distort voxel resolution.
        assert(finite(v), `Nonfinite world-space ${a.toUpperCase()} coordinate at instance ${i}.`);
        bounds[a].min = Math.min(bounds[a].min, v);
        bounds[a].max = Math.max(bounds[a].max, v);
    }
    const longest = Math.max(...AXES.map(a => bounds[a].max - bounds[a].min));
    assert(finite(longest) && longest > 0, 'Model bounding box is degenerate or nonfinite.');
    return { bounds, longest };
}

/** Fixed voxel grid, 128^3 maximum (8 MiB per Uint32Array grid), O(N + 27M).
 *  The levels are descriptive classes, never an inferred Gaussian quality label.
 */
export async function analyzeDensity(centers, { resolution = 128, progress = () => {}, cancelled = () => false } = {}) {
    assert(Number.isInteger(resolution) && resolution >= 8 && resolution <= 128, 'Voxel resolution out of range.');
    const { bounds, longest } = domains(centers);
    const h = longest / resolution;
    const dims = AXES.map(a => Math.max(1, Math.min(resolution, Math.ceil((bounds[a].max - bounds[a].min) / h))));
    const [nx, ny, nz] = dims;
    const flat = (x, y, z) => (z * ny + y) * nx + x;
    const voxelCount = nx * ny * nz;
    const counts = new Uint32Array(voxelCount);
    const ids = new Uint32Array(centers.x.length);
    const n = ids.length;
    for (let i = 0; i < n; i++) {
        if (i % 100000 === 0) { assert(!cancelled(), 'Analysis cancelled.'); progress(i, n); await tick(); }
        const x = Math.min(nx - 1, Math.max(0, Math.floor((centers.x[i] - bounds.x.min) / h)));
        const y = Math.min(ny - 1, Math.max(0, Math.floor((centers.y[i] - bounds.y.min) / h)));
        const z = Math.min(nz - 1, Math.max(0, Math.floor((centers.z[i] - bounds.z.min) / h)));
        const id = flat(x, y, z);
        ids[i] = id;
        counts[id]++;
    }
    const support = new Uint32Array(voxelCount);
    const occupied = [];
    for (let z = 0; z < nz; z++) for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
        const id = flat(x, y, z);
        if (counts[id] === 0) continue;
        let sum = 0;
        for (let dz = -1; dz <= 1; dz++) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx, yy = y + dy, zz = z + dz;
            if (xx >= 0 && xx < nx && yy >= 0 && yy < ny && zz >= 0 && zz < nz) sum += counts[flat(xx, yy, zz)];
        }
        support[id] = sum;
        occupied.push(sum);
    }
    occupied.sort((a, b) => a - b);
    const low = occupied[Math.floor((occupied.length - 1) / 3)];
    const high = occupied[Math.floor((occupied.length - 1) * 2 / 3)];
    const cellClass = new Uint8Array(voxelCount);
    // All equal means a single medium class, not 'everything is sparse'.
    const uniform = occupied[0] === occupied[occupied.length - 1];
    for (let id = 0; id < voxelCount; id++) {
        cellClass[id] = uniform ? 1 : low === high ? (support[id] < low ? 0 : support[id] === low ? 1 : 2) :
            support[id] <= low ? 0 : support[id] <= high ? 1 : 2;
    }
    const classes = new Uint8Array(n);
    const classCounts = [0, 0, 0];
    for (let i = 0; i < n; i++) {
        if (i % 300000 === 0) { assert(!cancelled(), 'Analysis cancelled.'); await tick(); }
        const c = cellClass[ids[i]];
        classes[i] = c;
        classCounts[c]++;
    }
    progress(n, n);
    return { classes, classCounts, bounds, resolution, voxelWidth: h,
        dimensions: dims, cutoffs: [low, high], occupiedCells: occupied.length,
        method: 'voxel_3x3x3_center_occupancy' };
}

/** Optional, center-based spatial-component inspection. This is not Gaussian overlap,
 *  rendered visibility, or proof of a floater. Uses a robust sampled extent for
 *  voxel scale, but indexes ALL model centers (including distant candidates).
 *  Maximum occupied-cell count bounds connectivity cost; no pairwise search.
 */
export async function analyzeComponents(centers, {
    divisions = 96, maxOccupiedCells = 500000, cancelled = () => false,
    progress = () => {}
} = {}) {
    const n = centers.x.length;
    assert(n > 0 && centers.y.length === n && centers.z.length === n, 'Missing Gaussian centers.');
    assert(Number.isInteger(divisions) && divisions >= 12 && divisions <= 128, 'Invalid component resolution.');
    assert(Number.isInteger(maxOccupiedCells) && maxOccupiedCells >= 1000, 'Invalid occupied-cell limit.');
    const raw = domains(centers);
    // Deterministic subsample: the 1st–99th percentile span reduces the influence
    // of extreme bounds without discarding their Gaussians from component analysis.
    const stride = Math.max(1, Math.ceil(n / 16384));
    const origins = {}, spans = [];
    for (const axis of AXES) {
        const sample = [];
        for (let i = 0; i < n; i += stride) sample.push(centers[axis][i]);
        sample.sort((a, b) => a - b);
        const lo = sample[Math.floor((sample.length - 1) * 0.01)];
        const hi = sample[Math.floor((sample.length - 1) * 0.99)];
        origins[axis] = lo;
        spans.push(hi - lo);
    }
    const robustSpan = Math.max(...spans);
    // A degenerate sampled range needs fallback rather than divide by zero.
    const usedFallback = !(Number.isFinite(robustSpan) && robustSpan > 0);
    // Avoid fragmenting small models with a resolution designed for millions of points.
    const effectiveDivisions = Math.min(divisions, Math.max(12, Math.floor(Math.cbrt(n) * 1.5)));
    let width = (usedFallback ? raw.longest : robustSpan) / effectiveDivisions;
    assert(Number.isFinite(width) && width > 0, 'Unable to choose component voxel width.');
    let voxels, lookup, ids, iterations = 0;
    for (; iterations < 7; iterations++) {
        assert(!cancelled(), 'Component analysis cancelled.');
        lookup = new Map(); voxels = []; ids = new Uint32Array(n);
        let overflow = false;
        for (let i = 0; i < n; i++) {
            if (i % 100000 === 0) {
                assert(!cancelled(), 'Component analysis cancelled.');
                progress('index', i, n);
                await tick();
            }
            const xyz = AXES.map(axis => Math.floor((centers[axis][i] - origins[axis]) / width));
            assert(xyz.every(v => Number.isSafeInteger(v) && Math.abs(v) <= 1e9),
                'Extreme model coordinates prevent reliable voxel indexing.');
            const key = xyz.join(',');
            let id = lookup.get(key);
            if (id === undefined) {
                if (voxels.length >= maxOccupiedCells) { overflow = true; break; }
                id = voxels.length;
                lookup.set(key, id);
                voxels.push({ xyz, count: 0 });
            }
            ids[i] = id;
            voxels[id].count++;
        }
        if (!overflow) break;
        width *= 2;
    }
    assert(iterations < 7, 'Component grid remained too large; narrow the model or review the source bounds.');
    const voxelComponents = new Int32Array(voxels.length).fill(-1);
    const counts = [], cellCounts = [];
    // 26-connected voxel adjacency: touching corners count as connected.
    for (let id = 0; id < voxels.length; id++) {
        if (voxelComponents[id] !== -1) continue;
        assert(!cancelled(), 'Component analysis cancelled.');
        const group = counts.length, queue = [id];
        voxelComponents[id] = group;
        let size = 0;
        for (let head = 0; head < queue.length; head++) {
            if (head % 4096 === 0 && (head > 0 || id % 512 === 0)) {
                assert(!cancelled(), 'Component analysis cancelled.');
                progress('connect', id, voxels.length);
                await tick();
            }
            const cell = voxels[queue[head]];
            size += cell.count;
            const [x,y,z] = cell.xyz;
            for (let dz = -1; dz <= 1; dz++) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
                if (!(dx || dy || dz)) continue;
                const neighbor = lookup.get(`${x+dx},${y+dy},${z+dz}`);
                if (neighbor !== undefined && voxelComponents[neighbor] === -1) {
                    voxelComponents[neighbor] = group;
                    queue.push(neighbor);
                }
            }
        }
        counts.push(size); cellCounts.push(queue.length);
    }
    const labels = new Uint32Array(n);
    for (let i = 0; i < n; i++) labels[i] = voxelComponents[ids[i]];
    let main = 0;
    for (let i = 1; i < counts.length; i++) if (counts[i] > counts[main]) main = i;
    progress('done', n, n);
    return {
        labels, sizes: Uint32Array.from(counts), cellCounts: Uint32Array.from(cellCounts),
        largestId: main, componentCount: counts.length, voxelWidth: width,
        occupiedCells: voxels.length, resolutionDivisions: effectiveDivisions,
        robustExtentFallback: usedFallback, coarseningPasses: iterations,
        method: 'robust_extent_voxel_26_connected_components',
        limitation: 'center-based voxel connectivity; disconnected does not prove a floater; legitimate sparse structures may fragment'
    };
}

export function insideROI(centers, i, roi) {
    return AXES.every(a => finite(centers[a][i]) && centers[a][i] >= roi[a].min && centers[a][i] <= roi[a].max);
}
export function validateROI(roi) {
    for (const a of AXES) assert(roi?.[a] && finite(roi[a].min) && finite(roi[a].max) && roi[a].min <= roi[a].max,
        `Invalid ${a.toUpperCase()} ROI bounds.`);
}

/** In-place median-of-three quickselect, bounded by a deterministic sort fallback. */
export function percentile(values, p) {
    assert(finite(p) && p >= 0 && p <= 100 && values.length > 0, 'Invalid percentile selection.');
    const k = Math.floor((values.length - 1) * p / 100);
    let lo = 0, hi = values.length - 1, steps = 0;
    while (lo < hi && steps++ < 96) {
        const mid = (lo + hi) >> 1;
        const a = values[lo], b = values[mid], c = values[hi];
        const pivot = a < b ? (b < c ? b : a < c ? c : a) : (a < c ? a : b < c ? c : b);
        let lt = lo, at = lo, gt = hi;
        while (at <= gt) {
            const v = values[at];
            if (v < pivot) { [values[lt], values[at]] = [values[at], values[lt]]; lt++; at++; }
            else if (v > pivot) { [values[gt], values[at]] = [values[at], values[gt]]; gt--; }
            else at++;
        }
        if (k < lt) hi = lt - 1;
        else if (k > gt) lo = gt + 1;
        else return values[k];
    }
    if (lo < hi) { const sorted = Array.from(values.subarray(lo, hi + 1)).sort((x, y) => x - y); return sorted[k - lo]; }
    return values[k];
}

// The browser supplies one mode. Preserve the established boolean contract for
// older direct callers of computeSelection/buildReport (no second threshold).
export function resolveOpacityMode(config) {
    const mode=config.opacityMode ?? (config.opacityEnabled ? 'independent' : 'off');
    assert(['off','independent','restrict-sns'].includes(mode), 'Invalid opacity mode.');
    return mode==='restrict-sns' && config.snsEnabled===false ? 'off' : mode;
}
export function validOpacityThreshold(value) {
    return Number.isFinite(value) && value>=0 && value<=1;
}

/** Compute ROI/class scope and candidate mask separately from viewport display. */
export function computeSelection(centers, density, config, { sizes = null, opacity = null, components = null, splatTransformMask = null, snsMask = null } = {}) {
    validateROI(config.roi);
    assert(density?.classes?.length === centers.x.length, 'Reanalyze before computing candidates.');
    if (config.sizeEnabled)
        assert(sizes?.length === centers.x.length, 'Size data unavailable for selected model.');
    if (config.snsEnabled) {
        assert(snsMask?.length === centers.x.length, 'Run scale-normalized support analysis before enabling SNS.');
        assert(snsMask.every(v=>v===0 || v===1), 'Invalid SNS candidate mask.');
    }
    const opacityMode = resolveOpacityMode(config);
    const snsOpacityActive = !!config.snsEnabled && opacityMode==='restrict-sns';
    const independentOpacity = opacityMode==='independent';
    const opacityActive = independentOpacity || snsOpacityActive;
    if (opacityActive) {
        assert(opacity?.length === centers.x.length, 'Opacity data unavailable for selected model.');
        assert(validOpacityThreshold(config.opacityThreshold), 'Opacity threshold must be from 0 to 1.');
    }
    if (config.splatTransformEnabled) {
        assert(splatTransformMask?.length === centers.x.length,
            'Run SplatTransform floater analysis before enabling this candidate rule.');
        assert(splatTransformMask.every(v => v === 0 || v === 1), 'Invalid SplatTransform candidate mask.');
    }
    const selectedComponentId = config.selectedComponentId ?? null;
    if (config.floaterEnabled || selectedComponentId !== null) {
        assert(components?.labels?.length === centers.x.length && components?.sizes?.length,
            'Find spatial components before using floater candidates.');
        if (config.floaterEnabled) assert(Number.isInteger(config.maxComponentGaussians) && config.maxComponentGaussians >= 1 &&
            config.maxComponentGaussians <= 1000000, 'Floater component-size limit must be from 1 to 1000000.');
        if (selectedComponentId !== null) assert(Number.isInteger(selectedComponentId) &&
            selectedComponentId >= 0 && selectedComponentId < components.sizes.length &&
            selectedComponentId !== components.largestId, 'Select a valid detached component, not the protected main component.');
    }
    const n = centers.x.length;
    const scope = new Uint8Array(n), candidates = new Uint8Array(n), ruleBits = new Uint8Array(n);
    const sizeSamples = config.sizeEnabled ? new Float32Array(n) : null;
    let inScope = 0;
    const selectedDensity = config.density ?? 'all';
    assert(selectedDensity === 'all' || DENSITY_NAMES.includes(selectedDensity), 'Invalid density class.');
    for (let i = 0; i < n; i++) {
        const match = insideROI(centers, i, config.roi) && (selectedDensity === 'all' || DENSITY_NAMES[density.classes[i]] === selectedDensity);
        if (!match) continue;
        scope[i] = 1; inScope++;
        if (sizeSamples) { assert(finite(sizes[i]) && sizes[i] > 0, 'Nonfinite/invalid Gaussian scale; size filter disabled.'); sizeSamples[inScope - 1] = sizes[i]; }
    }
    let threshold = null;
    if (config.sizeEnabled) {
        assert(inScope >= 3, 'Size percentile requires at least three Gaussians in the selected scope.');
        const copy = sizeSamples.slice(0, inScope);
        threshold = percentile(copy, config.sizePercentile ?? 99);
    }
    const byRule = { size: 0, opacity: 0, sns: 0, floaters: 0, splatTransformFloaters: 0 };
    let snsGpuOverlap=0;
    const selectedGroups = new Set();
    let count = 0;
    for (let i = 0; i < n; i++) {
        if (!scope[i]) continue;
        const large = !!config.sizeEnabled && sizes[i] > threshold;
        const belowOpacity = opacityActive && opacity[i] < config.opacityThreshold;
        const faint = independentOpacity && belowOpacity;
        const snsCandidate = !!config.snsEnabled && snsMask[i] === 1 &&
            (!snsOpacityActive || belowOpacity);
        const componentId = (config.floaterEnabled || selectedComponentId !== null) ? components.labels[i] : null;
        const floater = componentId !== null && componentId !== components.largestId &&
            ((!!config.floaterEnabled && components.sizes[componentId] <= config.maxComponentGaussians) ||
             componentId === selectedComponentId);
        if (floater) { byRule.floaters++; selectedGroups.add(componentId); }
        const stFloater = !!config.splatTransformEnabled && splatTransformMask[i] === 1;
        if (stFloater) byRule.splatTransformFloaters++;
        if (snsCandidate && stFloater) snsGpuOverlap++;
        if (large) byRule.size++;
        if (faint) byRule.opacity++;
        if (snsCandidate) byRule.sns++;
        let bits = 0;
        if (large) bits |= RULE_BITS.size;
        if (faint) bits |= RULE_BITS.opacity;
        if (snsCandidate) bits |= RULE_BITS.sns;
        if (floater) bits |= RULE_BITS.floaters;
        if (stFloater) bits |= RULE_BITS.splatTransformFloaters;
        ruleBits[i] = bits;
        if (bits !== 0) { candidates[i] = 1; count++; }
    }
    return { scope, candidates, ruleBits, scopedCount: inScope, candidateCount: count, retainedCount: n - count,
        ruleCounts: byRule, snsGpuOverlap, selectedFloaterComponents: selectedGroups.size, sizeResolvedThreshold: threshold };
}

/** One-rule inspection mask for enabled/evaluated rules in the frozen selection. */
export function candidateMaskForRule(selection, bit) {
    assert(Object.values(RULE_BITS).includes(bit), 'Unknown candidate attribution rule.');
    assert(selection?.ruleBits instanceof Uint8Array &&
        selection.ruleBits.length === selection.candidates?.length, 'Missing or stale candidate attribution.');
    const out = new Uint8Array(selection.ruleBits.length);
    for (let i = 0; i < out.length; i++) out[i] = (selection.ruleBits[i] & bit) !== 0 ? 1 : 0;
    return out;
}

/** Phase 2 data helper only; does not alter cleaning results or display. */
export function classifyRulePair(selection, bitA, bitB) {
    assert(Object.values(RULE_BITS).includes(bitA) && Object.values(RULE_BITS).includes(bitB) && bitA !== bitB,
        'Choose two different known cleaning rules.');
    assert(selection?.ruleBits instanceof Uint8Array &&
        selection.ruleBits.length === selection.candidates?.length, 'Missing or stale candidate attribution.');
    const classes = new Uint8Array(selection.ruleBits.length);
    for (let i = 0; i < classes.length; i++) {
        const a = (selection.ruleBits[i] & bitA) !== 0, b = (selection.ruleBits[i] & bitB) !== 0;
        classes[i] = a ? (b ? 3 : 1) : (b ? 2 : 0);
    }
    return classes;
}

export function subsetRuns(candidates) {
    const runs = [];
    let start = -1, count = 0;
    for (let i = 0; i <= candidates.length; i++) {
        const keep = i < candidates.length && !candidates[i];
        if (keep) { count++; if (start < 0) start = i; }
        else if (start >= 0) { runs.push([start, i - start]); start = -1; }
    }
    return { count, forEachRun(fn) { for (const [offset, length] of runs) fn(offset, length); }, runs };
}

export function previewHidden(selection, mode, isolate) {
    const n = selection.candidates.length;
    assert(['original', 'candidates', 'cleaned'].includes(mode), 'Unknown visualization mode.');
    const hidden = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
        if (isolate && !selection.scope[i]) hidden[i] = 1;
        else if (mode === 'candidates' && !selection.candidates[i]) hidden[i] = 1;
        else if (mode === 'cleaned' && selection.candidates[i]) hidden[i] = 1;
    }
    return hidden;
}

export function buildReport({ modelName, filename, format, density, config, selection, total,
    attributeStatus, components = null, adjustment = null, splatTransform = null, sns = null }) {
    const opacityMode=resolveOpacityMode(config);
    const snsOpacityActive=!!config.snsEnabled && opacityMode==='restrict-sns';
    return {
        report_type: 'supersplat_splat_cleaner_export', version: 2, tool_version: '0.3.37',
        editor: 'SuperSplat 3.8.0 (target baseline)', source_model_name: modelName || null,
        model_file: filename, model_format: format,
        source_gaussian_instances: total,
        scoped_gaussian_instances: selection.scopedCount,
        candidate_gaussian_instances: selection.candidateCount,
        selected_gaussian_instances: selection.retainedCount,
        candidate_by_rule: selection.ruleCounts,
        analysis: {
            density_method: density.method, voxel_divisions_longest_axis: density.resolution,
            voxel_neighborhood: [3, 3, 3], density_cutoffs: density.cutoffs,
            density_is_exact_neighbor_distance: false, density_category_counts: density.classCounts,
            occupied_voxels: density.occupiedCells,
            scale_normalized_support: sns,
            splat_transform_floaters: splatTransform,
            connected_components: components ? {
                method: components.method, voxel_width_world: components.voxelWidth,
                occupied_voxels: components.occupiedCells, component_count: components.componentCount,
                largest_component_gaussians: components.sizes[components.largestId],
                coarsening_passes: components.coarseningPasses, limitation: components.limitation
            } : null,
            size_descriptor: attributeStatus.size === 'available' ? 'max_world_principal_scale_uniform_transforms' : null,
            size_availability: attributeStatus.size || null, opacity_availability: attributeStatus.opacity || null
        },
        selection: {
            coordinate_frame: 'editor_world', xyz_roi: Object.fromEntries(AXES.flatMap(a => [[`${a}_min`, config.roi[a].min], [`${a}_max`, config.roi[a].max]])),
            density_classes: config.density === 'all' ? DENSITY_NAMES : [config.density],
            size: { enabled: !!config.sizeEnabled, type: 'upper_percentile', percentile: config.sizePercentile, resolved_threshold: selection.sizeResolvedThreshold },
            opacity: { enabled: opacityMode==='independent', type: 'below', threshold: opacityMode==='independent' ? config.opacityThreshold : null, source_interpretation: config.opacityEncoding || 'linear', mode: opacityMode, shared_threshold: opacityMode!=='off' ? config.opacityThreshold : null },
            scale_normalized_support: {
                enabled: !!config.snsEnabled, experimental: true,
                method: 'bidirectional_oriented_ellipsoid_center_support',
                k_standard_deviations: config.snsEnabled ? config.snsK : null,
                minimum_neighbors: config.snsEnabled ? config.snsMinNeighbors : null,
                interpretation: "fewer than m distinct neighbors for which either center is inside the other Gaussian's oriented k-sigma ellipsoid; not a rendering-quality measurement",
                opacity_filter: {
                    enabled: snsOpacityActive,
                    type: 'below',
                    cutoff: snsOpacityActive ? config.opacityThreshold : null,
                    source_interpretation: config.opacityEncoding || 'linear'
                },
                full_model_neighbors_roi_scoped_selection: true
            },
            floater_components: {
                enabled: !!config.floaterEnabled || config.selectedComponentId != null,
                type: 'user_selected_or_small_disconnected_occupied_voxel_components',
                max_component_gaussians: config.floaterEnabled ? config.maxComponentGaussians : null,
                explicitly_selected_component_id: config.selectedComponentId ?? null,
                selected_components_in_scope: selection.selectedFloaterComponents ?? 0,
                largest_component_always_preserved: true,
                user_review_required: true
            },
            splat_transform_floaters: {
                enabled: !!config.splatTransformEnabled,
                source: 'SplatTransform filterFloaters / GPU voxel contribution',
                parameters: config.splatTransformEnabled ? splatTransform?.parameters ?? null : null,
                global_analysis_roi_scoped_selection: true
            },
            enabled_rule_combination: 'OR' 
        },
        model_to_snapshot: adjustment, mapping_status: 'not_assessed',
        geometry_validation: 'not_verified', model_adjustment_baked_into_export: true,
        matrix_application_to_exported_model: 'do_not_apply_again',
        export_membership_note: 'Count reflects subset layer instances before any additional native serializer exclusions; visual preview flags are not export membership.'
    };
}
