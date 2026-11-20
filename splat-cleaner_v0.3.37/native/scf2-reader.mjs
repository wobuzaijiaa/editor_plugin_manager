import fs from 'node:fs';
import { MAX_ROWS, NAMES, geometryByteLength, HEADER_BYTES, STRIDE } from '../native-protocol.mjs';

// Read fixed local SCF2 geometry in bounded blocks.
// No imports of playcanvas, webgpu or SplatTransform; the installed CLI owns GPU execution.
export function openGeometry(input) {
    const fd = fs.openSync(input, 'r');
    let closed = false;
    const close = () => { if (!closed) { closed = true; fs.closeSync(fd); } };
    try {
        const header = Buffer.alloc(HEADER_BYTES);
        if (fs.readSync(fd, header, 0, HEADER_BYTES, 0) !== HEADER_BYTES || header.toString('ascii', 0, 4) !== 'SCF2') throw Error('Invalid SCF2 header');
        const count = header.readUInt32LE(4);
        if (count > MAX_ROWS || fs.fstatSync(fd).size !== geometryByteLength(count)) throw Error('Invalid SCF2 size');
        const blockRows = 32768, block = Buffer.alloc(blockRows * STRIDE);
        let first = -1, end = -1;
        const getRow = (i, row) => {
            if (closed || !Number.isInteger(i) || i < 0 || i >= count) throw Error('Invalid SCF2 row access');
            if (i < first || i >= end) {
                first = Math.floor(i / blockRows) * blockRows; end = Math.min(first + blockRows, count);
                const bytes = (end - first) * STRIDE; let done = 0;
                while (done < bytes) {
                    const got = fs.readSync(fd, block, done, bytes - done, HEADER_BYTES + first * STRIDE + done);
                    if (!got) throw Error('Truncated SCF2 block');
                    done += got;
                }
            }
            const offset = (i - first) * STRIDE;
            if (block.readUInt32LE(offset + 44) !== i) throw Error('SCF2 ID mismatch');
            for (let k = 0; k < 11; k++) {
                const v = block.readFloatLE(offset + k * 4);
                if (k === 10 ? Number.isNaN(v) : !Number.isFinite(v)) throw Error('Invalid SCF2 geometry');
                if (k >= 7 && k <= 9 && (!Number.isFinite(Math.exp(v)) || Math.exp(v) <= 0)) throw Error('Invalid SCF2 scale');
                row[NAMES[k]] = v;
            }
            if (Math.hypot(row.rot_0,row.rot_1,row.rot_2,row.rot_3) < 1e-10) throw Error('Invalid SCF2 quaternion');
            row._cleaner_instance_id = i;
        };
        return {count,getRow,close};
    } catch (err) { close(); throw err; }
}
