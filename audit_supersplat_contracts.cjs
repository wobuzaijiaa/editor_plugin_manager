'use strict';
/**
 * A01-A18 upstream API continuity screen. The .md audit is documentation only.
 * B01-B10 belong to maintain_editor.ps1, not this script.
 * Exit 0 means no static blocker, NOT semantic/runtime compatibility approval.
 */
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const crypto = require('node:crypto');

const sha256 = p => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const git = (root, ...args) => cp.execFileSync('git', ['-C', root, ...args], {
  encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']
}).trim();
function argsToOptions(argv) {
  const result = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!argv[i]?.startsWith('--') || !argv[i + 1]) throw Error('Expected --name value arguments');
    result[argv[i].slice(2)] = argv[i + 1];
  }
  for (const name of ['source', 'extension', 'output']) {
    if (!result[name]) throw Error(`Missing --${name}`);
  }
  return result;
}

// Contract owners are risk-mapping inputs, not proof that changed internals are compatible.
// Keep these synchronized with the A01-A18 inventory in the audit document.
const OWNERS = {
  A01: ['src/main.ts', 'src/editor-api.ts'],
  A02: ['src/events.ts', 'src/main.ts'],
  A03: ['src/render.ts', 'src/events.ts'],
  A04: ['src/camera.ts'],
  A05: ['src/camera.ts', 'src/scene.ts', 'src/render.ts'],
  A06: ['src/scene.ts', 'src/splat.ts'],
  A07: ['src/splat.ts', 'src/transform-palette.ts', 'src/gaussian-instances.ts'],
  A08: ['src/editor-splat-resource.ts', 'src/asset-loader.ts', 'src/gaussian-instances.ts'],
  A09: ['src/gaussian-instances.ts', 'src/splat-state.ts'],
  A10: ['src/command-queue.ts', 'src/scene.ts'],
  A11: ['src/scene.ts', 'src/editor-api.ts'],
  A12: ['src/splat.ts', 'src/gaussian-instances.ts'],
  A13: ['src/export-options.ts', 'src/splat-serialize.ts', 'src/scene.ts', 'src/main.ts', 'src/file-handler.ts'],
  A14: ['src/events.ts', 'src/main.ts'],
  A15: ['package.json', 'package-lock.json'], // PlayCanvas API: runtime semantics untestable statically
  A16: [], // Browser DOM / pointer interaction, manual browser check
  A17: [], // Browser File System Access API, manual browser check
  A18: ['src/main.ts', 'rollup.config.mjs', 'package.json', 'package-lock.json']
};

// Source-symbol existence is a conservative continuity screen. Every marker's
// matched path is logged, and no symbol match is called a semantic API PASS.
const MARKERS = {
  A01: ['captureFrame'],
  A02: ['invoke(', 'functions'],
  A03: ['render.image'],
  A04: ['captureFrame(', 'targetSize'],
  A05: ['clearPass', 'renderOverlays'],
  A06: ['elements'],
  A07: ['getTransform(', 'transformIndex('],
  A08: ['sourceRow', 'sourcePool'],
  A09: ['setBits(', 'clearBits(', 'flush('],
  A10: ['commandQueue'],
  A11: ['scene.elementAdded'],
  A12: ['createLayer(', 'forEachRun'],
  A13: ['scene.write', 'show.exportPopup', 'scene.getExportDirectory'],
  A14: ['timeline.playing', 'lockedClr'],
  A15: [], A16: [], A17: [],
  A18: ['webp.wasm']
};
const EXTENSION_MARKERS = {
  A01: ['window.scene', 'window.editor'],
  A03: ['render.image'], A07: ['transformIndex'], A08: ['sourceRow'],
  A09: ['setBits(', 'clearBits('], A12: ['createLayer'],
  A13: ['scene.write', 'show.exportPopup'], A17: ['showDirectoryPicker']
};
// Historical baseline for optional Git change-impact reporting, NOT a build PIN.
// Actual build eligibility depends on the static screen, never on this SHA.
const REFERENCE_COMMIT = '4069712370df3425c386610f28a814403e835543';
const CONTRACT_IDS = Array.from({ length: 18 }, (_, i) => `A${String(i + 1).padStart(2, '0')}`);
const isOwnerMatch = (p, entry) => entry.endsWith('/') ? p.startsWith(entry) : p === entry;

function audit(o) {
  const source = path.resolve(o.source);
  const extensionFile = path.resolve(o.extension);
  const extension = fs.readFileSync(extensionFile, 'utf8');
  const pkg = JSON.parse(fs.readFileSync(path.join(source, 'package.json'), 'utf8'));
  const head = git(source, 'rev-parse', 'HEAD');

  const result = {
    schema_version: 3,
    type: 'supersplat_a01_a18_static_continuity_screen',
    contract_group: 'A01-A18',
    package_version: String(pkg.version ?? ''), // informational; PowerShell owns version audit
    target_commit: head,
    custom_editor_sha256: sha256(extensionFile), // latest file, no historical hash comparison
    gate: 'FAIL', // PASS or FAIL: controls whether build is allowed
    review_status: 'NONE', // NONE or REVIEW_REQUIRED: does not veto candidate build
    api_compatibility: 'NOT_VERIFIED',
    upgrade_approval: 'NOT_ASSESSED',
    reference_commit: REFERENCE_COMMIT,
    source_diff_status: 'NOT_ASSESSED',
    source_changes: [],
    affected_contracts: [],
    unmapped_changes: [],
    contracts: [],
    errors: [], warnings: [],
    note: 'Static PASS allows build; REVIEW_REQUIRED indicates follow-up source/runtime review. Neither is a compatibility certificate.'
  };

  // Inventory lives in this executable; Markdown is never a runtime dependency.
  if (CONTRACT_IDS.some(id => !Object.hasOwn(OWNERS, id) || !Object.hasOwn(MARKERS, id)) ||
      Object.keys(OWNERS).length !== CONTRACT_IDS.length) {
    result.errors.push('Embedded A01-A18 contract inventory is incomplete.');
  }
  // Diff is informational. A missing historical object triggers REVIEW_REQUIRED,
  // not a failed build and not an implicit pin check.
  const reference = REFERENCE_COMMIT;
  try {
    git(source, 'cat-file', '-e', `${reference}^{commit}`);
    const raw = head.toLowerCase() === reference.toLowerCase() ? '' :
      git(source, 'diff', '--name-status', '-M', reference, head, '--');
    result.source_diff_status = 'AVAILABLE';
    result.source_changes = raw.split(/\r?\n/).filter(Boolean).map(line => {
      const [status, ...paths] = line.split('\t');
      return { status, paths };
    });
  } catch (_) {
    result.source_diff_status = 'REFERENCE_COMMIT_UNAVAILABLE';
    result.warnings.push('Historical commit not in local Git checkout; manual source review required.');
  }

  const changed = [...new Set(result.source_changes.flatMap(x => x.paths))];
  const tracked = git(source, 'ls-files', '--', 'src', 'rollup.config.mjs', 'copy-and-watch.mjs')
    .split(/\r?\n/).filter(Boolean);
  const sources = new Map();
  for (const file of tracked) {
    if (!/\.(?:ts|js|mjs|html|json)$/.test(file)) continue;
    const full = path.join(source, file);
    if (fs.existsSync(full) && fs.statSync(full).isFile()) sources.set(file, fs.readFileSync(full, 'utf8'));
  }

  for (const [id, paths] of Object.entries(OWNERS)) {
    const changedOwners = changed.filter(p => paths.some(owner => isOwnerMatch(p, owner)));
    const markers = (MARKERS[id] || []).map(text => {
      const foundIn = [...sources].filter(([, content]) => content.includes(text)).map(([file]) => file);
      const status = foundIn.length ? 'PASS' : 'FAIL';
      if (status === 'FAIL') result.errors.push(`${id}: missing upstream source marker ${JSON.stringify(text)}`);
      return { marker: text, status, found_in: foundIn };
    });
    const extMarkers = (EXTENSION_MARKERS[id] || []).map(text => {
      const found = extension.includes(text);
      if (!found) result.errors.push(`${id}: latest custom-editor.js missing ${JSON.stringify(text)}`);
      return { marker: text, status: found ? 'PASS' : 'FAIL' };
    });
    // A15-A17 cannot be semantically checked by upstream source markers.
    const staticStatus = [...markers, ...extMarkers].some(item => item.status === 'FAIL') ? 'FAIL' :
      (markers.length || extMarkers.length ? 'PASS_STATIC' : 'NOT_AUTOMATABLE');
    const status = changedOwners.length || (result.source_diff_status !== 'AVAILABLE') ? 'REVIEW_REQUIRED' : 'NONE';
    result.contracts.push({ id, static_status: staticStatus, change_review: status,
      changed_owner_files: changedOwners, upstream_markers: markers, extension_markers: extMarkers });
    if (changedOwners.length) result.affected_contracts.push({ id, changed_files: changedOwners, status: 'REVIEW_REQUIRED' });
  }
  result.unmapped_changes = changed.filter(p => !Object.values(OWNERS).some(paths => paths.some(owner => isOwnerMatch(p, owner))));
  // Missing source-history data is not evidence of compatibility, but it does not
  // prevent an independent build used for later manual acceptance.
  if (result.source_diff_status !== 'AVAILABLE' || result.affected_contracts.length || result.unmapped_changes.length) {
    result.review_status = 'REVIEW_REQUIRED';
  }
  if (result.affected_contracts.length) result.warnings.push('Upstream interface owners changed; inspect signatures, callers and runtime semantics.');
  if (result.unmapped_changes.length) result.warnings.push('Unmapped upstream changes require source-level review.');
  result.gate = result.errors.length ? 'FAIL' : 'PASS';
  return result;
}

let options, report;
try {
  options = argsToOptions(process.argv.slice(2));
  report = audit(options);
} catch (error) {
  if (!options?.output) { console.error(error.stack || String(error)); process.exit(2); }
  report = { schema_version: 3, type: 'supersplat_a01_a18_static_continuity_screen',
    contract_group: 'A01-A18', gate: 'FAIL', review_status: 'REVIEW_REQUIRED',
    errors: [String(error.message || error)], warnings: [] };
}
try {
  fs.mkdirSync(path.dirname(path.resolve(options.output)), { recursive: true });
  fs.writeFileSync(options.output, JSON.stringify(report, null, 2) + '\n');
} catch (error) { console.error(error.stack || String(error)); process.exit(2); }
console.log(`A01_A18_SCREEN=${report.gate} REVIEW=${report.review_status} CHANGED=${report.affected_contracts?.length ?? 0} ERRORS=${report.errors.length}`);
for (const error of report.errors) console.error('FAIL:', error);
for (const contract of (report.affected_contracts || [])) console.log('REVIEW_REQUIRED:', contract.id, contract.changed_files.join(', '));
process.exit(report.gate === 'PASS' ? 0 : 1);
