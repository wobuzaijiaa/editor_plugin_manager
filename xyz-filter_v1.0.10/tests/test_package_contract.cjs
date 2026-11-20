'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const meta = JSON.parse(fs.readFileSync(path.join(root, 'plugin.json'), 'utf8'));
const source = fs.readFileSync(path.join(root, 'index.js'), 'utf8');

test('XYZ-P01 single-folder package declares public and internal API requirements', () => {
    assert.equal(meta.id, 'xyz-filter');
    assert.match(meta.version, /^1\.0\.10$/);
    assert.equal(meta.entry, './index.js');
    assert.deepEqual(meta.requires.editor_api, ['viewport.captureFrame']);
    for (const dependency of [
        'scene.elements', 'scene.events', 'scene.commandQueue', 'scene.camera',
        'splat.instances', 'splat.resource.source', 'splat.transformPalette', 'splat.createLayer'
    ]) assert(meta.requires.internal_api.includes(dependency), `Undeclared internal dependency: ${dependency}`);
    assert.deepEqual(meta.third_party, []);
    assert.match(source, /export async function activate\(/);
    assert.match(source, /XYZ uses internal Scene APIs\./);
});

test('XYZ-P02 all test source references stay inside the selected plugin folder', () => {
    const files = fs.readdirSync(__dirname).filter(name => name.endsWith('.cjs'));
    assert(files.length >= 10, 'Expected all regression files in tests/');
    for (const name of files) {
        if (name === path.basename(__filename)) continue; // self-test contains negative path literals
        const code = fs.readFileSync(path.join(__dirname, name), 'utf8');
        assert(!code.includes("'../xyz-filter/index.js'"), `${name}: outdated path`);
        assert(!code.includes("'../external/custom-editor.js'"), `${name}: standalone path`);
    }
});
