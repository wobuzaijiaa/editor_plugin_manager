'use strict';
const {removeFixture,fixtureScope,listen,closeServer,closeBackend,freePort}=require('./fixture-utils.cjs');
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const {spawnSync}=require('node:child_process');
const {auditManagerContract}=require('../audit-manager-contract.cjs');

async function fixture(t) {
    const source=await fs.mkdtemp(path.join(os.tmpdir(),'spm-mandatory-'));
    t.after(()=>removeFixture(source));
    await fs.mkdir(path.join(source,'src'));
    await fs.writeFile(path.join(source,'src','main.ts'),'(window as any).editor = createEditorAPI();');
    await fs.writeFile(path.join(source,'src','editor-api.ts'),
        'const createEditorAPI = () => { return {inspect:{},viewport:{}}; };');
    const manager=path.join(source,'custom-editor.js');
    await fs.writeFile(manager,'const ready = window.editor?.viewport && window.editor?.inspect;');
    return {source,manager};
}
test('CORE-01 mandatory bootstrap passes without generated API inventory',async t=>{
    const {source,manager}=await fixture(t);
    const result=auditManagerContract(source,manager);
    assert.equal(result.status,'PASS_STATIC');
    assert.equal(result.inventory_dependency,'NONE');
    assert.ok(!Object.hasOwn(result,'source_commit'));
});
test('CORE-02 missing window.editor bootstrap fails closed',async t=>{
    const {source,manager}=await fixture(t);
    await fs.writeFile(path.join(source,'src','main.ts'),'window.scene = {};');
    const result=auditManagerContract(source,manager);
    assert.equal(result.status,'FAIL');
    assert.ok(result.missing.includes('native_editor_global_declared'));
});
test('CORE-03 missing required top-level Editor surface fails closed',async t=>{
    const {source,manager}=await fixture(t);
    await fs.writeFile(path.join(source,'src','editor-api.ts'),
        'const createEditorAPI = () => {return {inspect:{}, files:{}};};');
    const result=auditManagerContract(source,manager);
    assert.equal(result.status,'FAIL');
    assert.ok(result.missing.includes('typed_viewport_root_available'));
});
test('CORE-04 Manager bootstrap changes and direct scene access fail closed',async t=>{
    const {source,manager}=await fixture(t);
    await fs.writeFile(manager,'const e = window.editor?.viewport; const scene=window.scene;');
    const result=auditManagerContract(source,manager);
    assert.equal(result.status,'FAIL');
    assert.ok(result.missing.includes('plugin_manager_waits_for_inspection'));
    assert.ok(result.missing.includes('manager_no_direct_scene_global'));
});
test('CORE-05 mandatory CLI needs no --inventory and writes a report',async t=>{
    const {source,manager}=await fixture(t);
    const output=path.join(source,'manager-contract.json');
    const result=spawnSync(process.execPath,[path.join(__dirname,'../audit-manager-contract.cjs'),
        '--source',source,'--manager',manager,'--output',output],{encoding:'utf8'});
    assert.equal(result.status,0,result.stderr);
    const report=JSON.parse(await fs.readFile(output,'utf8'));
    assert.equal(report.status,'PASS_STATIC');
});
test('CORE-06 Manager deployment script separates mandatory tests and reference tests',async()=>{
    const ps1=await fs.readFile(path.join(__dirname,'../../maintain_editor.ps1'),'utf8');
    assert.match(ps1,/test_manager_contract\.cjs/);
    assert.match(ps1,/test_editor_api_audit\.cjs/);
    assert.match(ps1,/Advisory reference.auditor tests failed/);
    assert.match(ps1,/Optional compatibility screening|Installed.plugin compatibility audit unavailable/);
    assert.doesNotMatch(ps1,/--manager .* --inventory /);
});

test('CORE-07 window.editor assignment must originate from typed Editor factory',async t=>{
    const {source,manager}=await fixture(t);
    await fs.writeFile(path.join(source,'src','main.ts'),'window.editor = {};');
    const result=auditManagerContract(source,manager);
    assert.equal(result.status,'FAIL');
    assert.ok(result.missing.includes('native_editor_uses_typed_factory'));
    await fs.writeFile(path.join(source,'src','main.ts'),
        'const main = () => { const editor = createEditorAPI(); window.editor = editor; };');
    assert.equal(auditManagerContract(source,manager).status,'PASS_STATIC');
});
