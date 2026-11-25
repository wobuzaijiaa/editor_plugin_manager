/* XYZ Semantic v0.1.0: pure, Editor-independent schema, convex geometry and transforms. */
const fail = message => { throw new Error(message); };
const finite = v => typeof v === 'number' && Number.isFinite(v);
const label = (v, key) => typeof v === 'string' && v.trim() && v.length <= 160 ? v.trim() : fail(`${key} must be a nonempty string (max 160).`);
const unique = (ids, id, kind) => { if (ids.has(id)) fail(`Duplicate ${kind} ID: ${id}`); ids.add(id); };
export const IDENTITY = Object.freeze([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
export function affine(matrix) {
    return Array.isArray(matrix) && matrix.length === 16 && matrix.every(finite) &&
        [3, 7, 11].every(i => Math.abs(matrix[i]) <= 1e-7) && Math.abs(matrix[15] - 1) <= 1e-7;
}
export function multiply4(a, b) {
    const out = Array(16).fill(0);
    for (let col = 0; col < 4; col++) for (let row = 0; row < 4; row++)
        for (let i = 0; i < 4; i++) out[4 * col + row] += a[4 * i + row] * b[4 * col + i];
    return out;
}
export function inverse4(matrix) {
    if (!Array.isArray(matrix) || matrix.length !== 16 || !matrix.every(finite)) return null;
    // Gauss-Jordan inverse, row-major augmented working array; input/output column-major.
    const a = Array.from({ length: 4 }, (_, r) =>
        [...Array.from({ length: 4 }, (_, c) => matrix[c * 4 + r]), ...Array.from({ length: 4 }, (_, c) => +(c === r))]);
    for (let c = 0; c < 4; c++) {
        let pivot = c;
        for (let r = c + 1; r < 4; r++) if (Math.abs(a[r][c]) > Math.abs(a[pivot][c])) pivot = r;
        if (!(Math.abs(a[pivot][c]) > 1e-14)) return null;
        [a[c], a[pivot]] = [a[pivot], a[c]];
        const divisor = a[c][c];
        for (let j = 0; j < 8; j++) a[c][j] /= divisor;
        for (let r = 0; r < 4; r++) if (r !== c) {
            const factor = a[r][c];
            for (let j = 0; j < 8; j++) a[r][j] -= factor * a[c][j];
        }
    }
    const out = Array.from({ length: 16 }, (_, i) => a[i % 4][4 + Math.floor(i / 4)]);
    return out.every(finite) ? out : null;
}
export function transformPoint(m, p) {
    const w = m[3] * p[0] + m[7] * p[1] + m[11] * p[2] + m[15];
    if (!Number.isFinite(w) || Math.abs(w) < 1e-12) fail('Invalid point projection.');
    return [
        (m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12]) / w,
        (m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13]) / w,
        (m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14]) / w
    ];
}
export function polygonBounds(polygon) {
    return {
        x: { min: Math.min(...polygon.map(p => p[0])), max: Math.max(...polygon.map(p => p[0])) },
        z: { min: Math.min(...polygon.map(p => p[1])), max: Math.max(...polygon.map(p => p[1])) }
    };
}
// Optional, explicit recovery for a draft drawn out of order or with interior
// clicks. The strict polygon validator remains the authoritative save gate.
// Convex hull discards interior points and is therefore NEVER applied silently.
export function convexHull(vertices) {
    if (!Array.isArray(vertices) || vertices.length > 256 || vertices.some(p =>
        !Array.isArray(p) || p.length !== 2 || !p.every(finite)))
        fail('Invalid convex-hull vertices.');
    const sorted = vertices.map(p => [...p]).sort((a,b) => a[0]-b[0] || a[1]-b[1]);
    const uniquePoints = sorted.filter((p,i) => i===0 || p[0]!==sorted[i-1][0] || p[1]!==sorted[i-1][1]);
    if (uniquePoints.length < 3) fail('At least three distinct positions are required.');
    const turn = (a,b,c) => (b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0]);
    const lower=[], upper=[];
    for (const point of uniquePoints) {
        while (lower.length>=2 && turn(lower[lower.length-2], lower[lower.length-1],point)<=0) lower.pop();
        lower.push(point);
    }
    for (const point of uniquePoints.slice().reverse()) {
        while (upper.length>=2 && turn(upper[upper.length-2], upper[upper.length-1],point)<=0) upper.pop();
        upper.push(point);
    }
    return validatePolygon([...lower.slice(0,-1),...upper.slice(0,-1)]);
}

export function validatePolygon(vertices) {
    if (!Array.isArray(vertices) || vertices.length < 3 || vertices.length > 256) fail('A room needs 3–256 polygon vertices.');
    const pts = vertices.map((p, i) => {
        if (!Array.isArray(p) || p.length !== 2 || !p.every(finite)) fail(`Invalid polygon vertex ${i}.`);
        return [...p];
    });
    const cross = (a, b, c) => (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
    const size = Math.max(1, ...pts.flatMap(p => p.map(Math.abs)));
    const tolerance = size * size * 1e-12;
    let sign = 0, twiceArea = 0;
    for (let i = 0; i < pts.length; i++) {
        const a = pts[i], b = pts[(i + 1) % pts.length], c = pts[(i + 2) % pts.length];
        if (Math.hypot(a[0] - b[0], a[1] - b[1]) <= 1e-9 * size)
            fail('Polygon contains a zero-length edge.');
        const turn = cross(a, b, c);
        // Strict convexity: prevents degeneracy, collinearity and self intersections.
        if (Math.abs(turn) <= tolerance) fail('Room polygon must be strictly convex (no collinear vertices).');
        if (sign && Math.sign(turn) !== sign) fail('Room polygon must be convex and non-self-intersecting.');
        sign = Math.sign(turn);
        twiceArea += a[0] * b[1] - b[0] * a[1];
    }
    if (Math.abs(twiceArea) <= tolerance) fail('Room polygon area is zero.');
    // Local turning directions alone do not reject all star polygons.
    const orient = (a,b,c) => (b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0]);
    for(let i=0;i<pts.length;i++) for(let j=i+1;j<pts.length;j++) {
        if(j===i+1 || (i===0 && j===pts.length-1))continue;
        const a=pts[i],b=pts[(i+1)%pts.length],c=pts[j],d=pts[(j+1)%pts.length];
        if(orient(a,b,c)*orient(a,b,d)<-tolerance*tolerance &&
            orient(c,d,a)*orient(c,d,b)<-tolerance*tolerance)
            fail('Room polygon is self-intersecting.');
    }
    return pts;
}
export function validateFloorRange(yMin, yMax, viewMax) {
    if (![yMin, yMax, viewMax].every(finite) || !(yMin < viewMax && viewMax <= yMax))
        fail('Floor requires finite y_min < view_y_max <= y_max.');
}
export function validateDocument(doc) {
    if (!doc || typeof doc !== 'object' || Array.isArray(doc) || doc.schema_version !== 1)
        fail('Unsupported semantic.json schema_version (expected 1).');
    const model = doc.model;
    if (!model || typeof model !== 'object') fail('Missing model binding.');
    label(model.model_id, 'model_id');
    label(model.name, 'model.name');
    if (model.coordinate_space !== 'model_anchored_y_up' || model.matrix_order !== 'column_major' ||
        !affine(model.semantic_to_model) || !inverse4(model.semantic_to_model))
        fail('Invalid or singular semantic_to_model coordinate binding.');
    if (!Array.isArray(doc.floors) || doc.floors.length > 512) fail('Invalid floor list.');
    const floorIds = new Set(), roomIds = new Set();
    for (const floor of doc.floors) {
        label(floor.floor_id, 'floor_id');
        label(floor.name, 'floor.name');
        unique(floorIds, floor.floor_id, 'floor');
        validateFloorRange(floor.y_min, floor.y_max, floor.view_y_max);
        if (!Array.isArray(floor.rooms) || floor.rooms.length > 10000) fail(`Invalid rooms for ${floor.floor_id}.`);
        for (const room of floor.rooms) {
            label(room.room_id, 'room_id');
            label(room.name, 'room.name');
            unique(roomIds, room.room_id, 'room');
            validatePolygon(room.polygon_xz);
        }
    }
    // Optional v0.1.7 metadata; accept older v0.1.x documents unchanged.
    if ('document_id' in doc) label(doc.document_id, 'document_id');
    for (const field of ['created_at', 'updated_at']) if (field in doc &&
        !(typeof doc[field] === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(doc[field]) && !Number.isNaN(Date.parse(doc[field]))))
        fail(`Invalid ${field}.`);
    for (const floor of doc.floors) {
        for (const field of ['created_at', 'updated_at']) if (field in floor &&
            !(typeof floor[field] === 'string' && !Number.isNaN(Date.parse(floor[field])))) fail(`Invalid floor ${field}.`);
        for (const room of floor.rooms) for (const field of ['created_at', 'updated_at'])
            if (field in room && !(typeof room[field] === 'string' && !Number.isNaN(Date.parse(room[field]))))
                fail(`Invalid room ${field}.`);
    }
    // JSON-only structure, no exotic prototypes or functions from imported documents.
    return JSON.parse(JSON.stringify(doc));
}
export function newDocument(modelId, modelName, semanticToModel, documentId = null) {
    const now = new Date().toISOString();
    return validateDocument({ schema_version: 1,
        ...(documentId ? { document_id: documentId } : {}), created_at: now, updated_at: now,
        model: { model_id: modelId, name: modelName, coordinate_space: 'model_anchored_y_up',
            matrix_order: 'column_major', semantic_to_model: semanticToModel }, floors: [] });
}
export function addFloor(doc, floor) {
    const next = structuredClone(doc);
    next.floors.push({ floor_id: floor.floor_id, name: floor.name,
        created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
        y_min: floor.y_min, y_max: floor.y_max, view_y_max: floor.view_y_max, rooms: [] });
    return validateDocument(next);
}
export function editFloor(doc, id, changes) {
    const next = structuredClone(doc), floor = next.floors.find(f => f.floor_id === id);
    if (!floor) fail('Floor not found.');
    for (const key of ['name', 'y_min', 'y_max', 'view_y_max']) if (key in changes) floor[key] = changes[key];
    floor.updated_at = new Date().toISOString();
    return validateDocument(next);
}
export function removeFloor(doc, id) {
    const next = structuredClone(doc);
    const count = next.floors.length;
    next.floors = next.floors.filter(f => f.floor_id !== id);
    if (count === next.floors.length) fail('Floor not found.');
    return validateDocument(next);
}
export function addRoom(doc, floorId, room) {
    const next = structuredClone(doc), floor = next.floors.find(f => f.floor_id === floorId);
    if (!floor) fail('Floor not found.');
    floor.rooms.push({ room_id: room.room_id, name: room.name, polygon_xz: room.polygon_xz,
        created_at: new Date().toISOString(), updated_at: new Date().toISOString() });
    return validateDocument(next);
}
export function editRoom(doc, floorId, roomId, changes) {
    const next = structuredClone(doc), floor = next.floors.find(f => f.floor_id === floorId);
    const room = floor?.rooms.find(r => r.room_id === roomId);
    if (!room) fail('Room not found.');
    for (const key of ['name', 'polygon_xz']) if (key in changes) room[key] = changes[key];
    room.updated_at = new Date().toISOString();
    return validateDocument(next);
}
export function removeRoom(doc, floorId, roomId) {
    const next = structuredClone(doc), floor = next.floors.find(f => f.floor_id === floorId);
    if (!floor) fail('Floor not found.');
    const count = floor.rooms.length;
    floor.rooms = floor.rooms.filter(r => r.room_id !== roomId);
    if (count === floor.rooms.length) fail('Room not found.');
    return validateDocument(next);
}
export function semanticWorldMatrix(doc, currentModelToWorld) {
    if (!affine(currentModelToWorld) || !inverse4(currentModelToWorld)) fail('Uniform model transform unavailable.');
    return multiply4(currentModelToWorld, doc.model.semantic_to_model);
}
export function worldBoundsForTarget(doc, modelToWorld, bounds, target, mode = 'view') {
    const world = semanticWorldMatrix(doc, modelToWorld);
    if (!target || target.type === 'building') return Object.fromEntries(['x','y','z'].map(k => [k, { ...bounds[k] }]));
    const floor = doc.floors.find(f => f.floor_id === target.floorId);
    if (!floor) fail('Selected floor is missing.');
    const local = {
        x: { ...bounds.x },
        y: { min: floor.y_min, max: mode === 'view' ? floor.view_y_max : floor.y_max },
        z: { ...bounds.z }
    };
    if (target.type === 'room') {
        const room = floor.rooms.find(r => r.room_id === target.roomId);
        if (!room) fail('Selected room is missing.');
        const poly = polygonBounds(room.polygon_xz);
        local.x = poly.x; local.z = poly.z;
    }
    const pts = [];
    for (const x of [local.x.min, local.x.max]) for (const y of [local.y.min, local.y.max])
        for (const z of [local.z.min, local.z.max]) pts.push(transformPoint(world, [x, y, z]));
    return Object.fromEntries(['x', 'y', 'z'].map((key, axis) => [key, {
        min: Math.min(...pts.map(p => p[axis])), max: Math.max(...pts.map(p => p[axis]))
    }]));
}
export function semanticProvenance(doc, target, mode, actualBounds) {
    const floor = target?.floorId ? doc.floors.find(f => f.floor_id === target.floorId) : null;
    const room = target?.roomId ? floor?.rooms.find(r => r.room_id === target.roomId) : null;
    return { schema_version: 1, target_type: target?.type || 'building',
        model_id: doc.model.model_id, floor_id: floor?.floor_id ?? null, floor_name: floor?.name ?? null,
        room_id: room?.room_id ?? null, room_name: room?.name ?? null,
        ...(room ? { polygon_xz: room.polygon_xz.map(p => [...p]) } : {}),
        selection_method: room ? 'world_xyz_aabb_of_convex_polygon_prism' : 'world_xyz_aabb',
        range_purpose: mode === 'export' ? 'full_height_export' : 'ceiling_free_snapshot',
        coordinate_space: doc.model.coordinate_space,
        world_xyz_bounds: structuredClone(actualBounds)
    };
}
export function horizontalAlignment(matrix, tol = 1e-5) {
    // For editing with a world-horizontal plane, semantic Y must be world vertical.
    const a = Math.hypot(matrix[0], matrix[1], matrix[2]);
    const b = Math.hypot(matrix[8], matrix[9], matrix[10]);
    const y = Math.hypot(matrix[4], matrix[5], matrix[6]);
    return a > 0 && b > 0 && y > 0 && Math.abs(matrix[1]) <= tol * a &&
        Math.abs(matrix[9]) <= tol * b && Math.abs(matrix[4]) <= tol * y && Math.abs(matrix[6]) <= tol * y;
}

// v0.2.0: camera-position-only semantic lookup. This never infers location from
// an orbit target, the view focus, picked splats, or the current filter range.
export function insideConvexPolygonXZ(point, polygon, tolerance = 1e-9) {
    if (!Array.isArray(point) || point.length !== 2 || !point.every(finite) ||
        !Array.isArray(polygon) || polygon.length < 3) return false;
    const bbox = polygonBounds(polygon);
    const scale = Math.max(1, bbox.x.max - bbox.x.min, bbox.z.max - bbox.z.min);
    const epsilon = Math.max(0, tolerance) * scale * scale;
    let sign = 0;
    for (let i = 0; i < polygon.length; i++) {
        const a = polygon[i], b = polygon[(i + 1) % polygon.length];
        const turn = (b[0] - a[0]) * (point[1] - a[1]) -
            (b[1] - a[1]) * (point[0] - a[0]);
        if (Math.abs(turn) <= epsilon) continue;
        const nextSign = Math.sign(turn);
        if (sign && sign !== nextSign) return false;
        sign = nextSign;
    }
    return true;
}

const polygonArea = polygon => Math.abs(polygon.reduce((twice, a, i) => {
    const b = polygon[(i + 1) % polygon.length];
    return twice + a[0] * b[1] - a[1] * b[0];
}, 0)) / 2;

// modelBounds is a conservative semantic-local AABB derived from the original
// selected model bounds. It is NOT a building footprint; exterior is approximate.
// The supplied camera position must be in Editor WORLD space.
export function locateSemanticCamera(doc, modelToWorld, modelBounds, cameraWorld) {
    if (!doc?.model || !Array.isArray(doc.floors)) fail('Bind or import a semantic document first.');
    if (!Array.isArray(cameraWorld) || cameraWorld.length !== 3 || !cameraWorld.every(finite))
        fail('Camera position is unavailable.');
    if (!modelBounds || ['x', 'y', 'z'].some(axis =>
        !modelBounds[axis] || !finite(modelBounds[axis].min) || !finite(modelBounds[axis].max) ||
        modelBounds[axis].min > modelBounds[axis].max)) fail('Building bounds are unavailable.');
    const inverse = inverse4(semanticWorldMatrix(doc, modelToWorld));
    if (!inverse) fail('Semantic coordinate transform is not invertible.');
    const p = transformPoint(inverse, cameraWorld);
    const result = { level: 'exterior', buildingName: doc.model.name,
        floorId: null, floorName: null, roomId: null, roomName: null,
        cameraWorld: [...cameraWorld], cameraLocal: p,
        source: 'camera_position', envelope: 'model_aabb_approximation' };
    const inside = ['x', 'y', 'z'].every((axis, i) => {
        const { min, max } = modelBounds[axis];
        const epsilon = 1e-9 * Math.max(1, max - min);
        return p[i] >= min - epsilon && p[i] <= max + epsilon;
    });
    if (!inside) return { ...result, label: `${doc.model.name} / Exterior` };
    result.level = 'building';
    result.label = doc.model.name;
    const floors = doc.floors.filter(floor => p[1] >= floor.y_min - 1e-9 &&
        p[1] <= floor.y_max + 1e-9).sort((a, b) =>
        (a.y_max - a.y_min) - (b.y_max - b.y_min) || a.floor_id.localeCompare(b.floor_id));
    if (!floors.length) return result;
    // If rooms overlap, the smaller containing polygon wins; ties use stable IDs.
    const matches=[];
    for (const floor of floors) for (const room of floor.rooms) {
        if (insideConvexPolygonXZ([p[0], p[2]], room.polygon_xz)) {
            matches.push({ floor, room, area: polygonArea(room.polygon_xz) });
        }
    }
    matches.sort((a, b) => a.area - b.area ||
        a.floor.floor_id.localeCompare(b.floor.floor_id) || a.room.room_id.localeCompare(b.room.room_id));
    const matched = matches[0];
    const floor = matched?.floor || floors[0];
    result.level='floor';result.floorId=floor.floor_id;result.floorName=floor.name;
    result.label = `${doc.model.name} / ${floor.name}`;
    if (matched) {
        result.level='room';result.roomId=matched.room.room_id;result.roomName=matched.room.name;
        result.label += ` / ${matched.room.name}`;
    }
    return result;
}
