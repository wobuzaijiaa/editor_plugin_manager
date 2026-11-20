'use strict';
/** Static validation of the single installed plugin store. No imported plugin code is executed. */
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

function verify(condition, reason) { if (!condition) throw new Error(reason); }
const idRe = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const folderRe = /^[a-z0-9]+(?:-[a-z0-9]+)*_\d{8}T\d{9}Z$/;
function safeEntry(value) {
    verify(typeof value === 'string' && value.startsWith('./') &&
        !/[\\:?#]/.test(value) && value.slice(2).split('/').every(x =>
            x && x !== '.' && x !== '..' && !x.startsWith('.')) &&
        /\.(?:js|mjs)$/.test(value), 'Unsafe entry path');
    return value.slice(2);
}
function validateStore(root) {
    verify(fs.statSync(root).isDirectory(), 'plugins directory missing');
    const manifestPath = path.join(root, 'manifest.json');
    const catalog = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    verify(catalog && catalog.schema_version === 1 && Array.isArray(catalog.plugins), 'Unsupported manifest schema');
    const found = new Set();
    const folders = new Set();
    for (const record of catalog.plugins) {
        verify(record && idRe.test(record.id || '') && folderRe.test(record.folder || '') &&
            record.folder.startsWith(record.id + '_') && typeof record.enabled === 'boolean' &&
            (record.settings === undefined || (record.settings && typeof record.settings === 'object' &&
                !Array.isArray(record.settings))), 'Invalid installed plugin record');
        if (record.startup_approval !== undefined) {
            verify(record.startup_approval && typeof record.startup_approval === 'object' &&
                /^[0-9a-f]{40}$/.test(record.startup_approval.editor_commit || '') &&
                /^[0-9a-f]{64}$/.test(record.startup_approval.package_sha256 || ''),
                'Invalid saved plugin review approval for ' + record.id);
        }
        verify(!found.has(record.id) && !folders.has(record.folder), 'Duplicate installed plugin');
        found.add(record.id); folders.add(record.folder);
        const dir = path.join(root, record.folder);
        verify(fs.statSync(dir).isDirectory() && !fs.lstatSync(dir).isSymbolicLink(), 'Invalid plugin folder');
        const meta = JSON.parse(fs.readFileSync(path.join(dir, 'plugin.json'), 'utf8'));
        verify(meta.id === record.id, 'Manifest/metadata ID differs');
        for (const field of ['name', 'classification', 'version', 'author', 'date', 'description']) {
            verify(typeof meta[field] === 'string' && meta[field].trim(), 'Invalid metadata: ' + field);
        }
        verify(/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(meta.version) &&
            /^\d{4}-\d{2}-\d{2}$/.test(meta.date), 'Invalid version/date');
        const entry = path.join(dir, safeEntry(meta.entry));
        verify(fs.existsSync(entry) && fs.statSync(entry).isFile() && !fs.lstatSync(entry).isSymbolicLink(),
            'Missing plugin module: ' + meta.entry);
        if (meta.native_service !== undefined) {
            verify(meta.native_service?.entry === './native/service.mjs', 'Invalid native entry: ' + record.id);
            const native = path.join(dir, 'native');
            const service = path.join(native, 'service.mjs');
            verify(fs.existsSync(native) && fs.lstatSync(native).isDirectory() && fs.existsSync(service) &&
                fs.lstatSync(service).isFile() && fs.lstatSync(service).nlink===1, 'Missing or unsafe native service: ' + record.id);
        }
        if (meta.settings_schema !== undefined) {
            verify(Array.isArray(meta.settings_schema) && meta.settings_schema.length <= 30, 'Invalid settings schema');
        }
    }
    // Unregistered timestamped package folders are not silently deleted: report them for review.
    const orphanFolders = fs.readdirSync(root, { withFileTypes: true })
        .filter(x => x.isDirectory() && folderRe.test(x.name) && !folders.has(x.name))
        .map(x => x.name);
    return { schema_version: 1, installed_count: catalog.plugins.length, orphan_folders: orphanFolders };
}
if (require.main === module) {
    try {
        verify(process.argv.length >= 3, 'Usage: node validate-plugin-store.cjs <dist/plugins>');
        const result = validateStore(path.resolve(process.argv[2]));
        process.stdout.write(JSON.stringify(result, null, 2) + '\n');
        if (result.orphan_folders.length) process.stderr.write('WARNING: Unregistered plugin folders need review.\n');
    } catch (error) {
        process.stderr.write('Plugin-store validation failed: ' + (error.stack || error) + '\n');
        process.exitCode = 1;
    }
}
module.exports = { validateStore };
