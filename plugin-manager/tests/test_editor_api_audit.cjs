'use strict';
const {removeFixture,fixtureScope,listen,closeServer,closeBackend,freePort}=require('./fixture-utils.cjs');
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const fsp=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {typeScriptFrom}=require('../audit-editor-api.cjs');
const ts=typeScriptFrom(path.resolve(__dirname,'../../supersplat'));
const {inventory,diffInventory}=require('../audit-editor-api.cjs');
const {packageAudit}=require('../plugin-compat.cjs');
const SHA='4069712370df3425c386610f28a814403e835543';
async function fixture(t) {
 const temp=await fsp.mkdtemp(path.join(os.tmpdir(),'spm-api-'));
 t.after(()=>removeFixture(temp));
 await fsp.mkdir(path.join(temp,'src'));
 await fsp.writeFile(path.join(temp,'package.json'),JSON.stringify({name:'supersplat',version:'3.7.0'}));
 const src=`const createEditorAPI = () => {
  const session = createEditorSession();
  return {
    inspect: {scene: (options?:any) => ({}), layer:async(id:number)=>({}), histogram:()=>({}), timeline:()=>({}),properties:()=>[]},
    layers: {list:()=>[], active:()=>1, setActive:()=>{},setVisible:()=>{},rename:()=>{},update:()=>{}},
    selection: {all:()=>{},none:()=>{},invert:()=>{},byVolume:()=>{},byProperty:()=>{},hide:()=>{},unhide:()=>{},delete:()=>{},restoreDeleted:()=>{},restore:()=>{},duplicate:()=>{},separate:()=>{}},
    color:{apply:()=>{},reset:()=>{}},transform:()=>{},
    history:{undo:()=>{},redo:()=>{},canUndo:()=>{},canRedo:()=>{}},
    viewport:{...session.viewport, captureFrame:()=>{}, pickDepth:()=>{}},
    timeline:{update:()=>{},setKeys:()=>{},moveKey:()=>{},deleteKeys:()=>{}},
    files:session.files,
    on:(event:string,fn:()=>void)=>()=>{}
  };
};`;
 const session=`const createEditorSession = () => {return {
  viewport:{assertIdle:()=>{},ready:()=>{},info:()=>{},setCamera:()=>{},focus:()=>{},setView:()=>{}},
  files:{importUrl:()=>{},export:()=>{}}
 };};`;
 await fsp.writeFile(path.join(temp,'src','editor-api.ts'),src);
 await fsp.writeFile(path.join(temp,'src','editor-session.ts'),session);
 await fsp.writeFile(path.join(temp,'src','editor-timeline.ts'),'export type Timeline = {};');
 return temp;
}
test('API-01 complete public typed method inventory resolves session spreads and files',async t=>{
 const source=await fixture(t);const inv=inventory(source,SHA,ts);
 assert.ok(inv.method_count>=40);
 for(const name of ['inspect.scene','layers.list','selection.byProperty','viewport.setCamera','viewport.captureFrame','files.export','on'])
   assert.ok(inv.available_methods.includes(name),name);
 assert.equal(inv.supersplat_version,'3.7.0');
 assert.equal(inv.inventory_kind,'typed_editor_api_static');
 assert.equal(inv.method_count,inv.available_methods.length);
});
test('API-02 changed methods/signatures reported without claiming runtime proof',async t=>{
 const source=await fixture(t);const before=inventory(source,SHA,ts);
 const target=path.join(source,'src','editor-api.ts');
 fs.writeFileSync(target,fs.readFileSync(target,'utf8').replace('scene: (options?:any)','scene: (options?:string)'));
 const after=inventory(source,'5555555555555555555555555555555555555555',ts);
 const diff=diffInventory(before,after);
 assert.equal(diff.status,'REVIEW_REQUIRED');
 assert.deepEqual(diff.signature_changed,['inspect.scene']);
 assert.equal(diffInventory(before,before).status,'UNCHANGED');
});
test('API-03 plugin package screens declared methods, imports and internal dependencies',async t=>{
 const source=await fixture(t);const inv=inventory(source,SHA,ts);
 const meta={id:'test',requires:{editor_api:['inspect.scene'],internal_api:[]}};
 const files=[{name:'index.js',data:Buffer.from("import {t} from './lib.js'; export function activate({editor}){return editor.inspect.scene()}")},
              {name:'lib.js',data:Buffer.from('export const t=1;')}];
 assert.equal(packageAudit(files,meta,inv,ts).status,'STATIC_COMPATIBLE');
 assert.equal(packageAudit(files,{...meta,requires:{editor_api:['inspect.unknown'],internal_api:[]}},inv,ts).status,'INCOMPATIBLE');
 assert.equal(packageAudit(files.filter(f=>f.name==='index.js'),meta,inv,ts).status,'INCOMPATIBLE');
 assert.equal(packageAudit(files,{...meta,requires:{editor_api:['inspect.scene'],internal_api:['window.scene']}},inv,ts).status,'REVIEW_REQUIRED');
 assert.equal(packageAudit([{name:'index.js',data:Buffer.from("import pkg from 'third-party-package';")}],meta,inv,ts).status,'REVIEW_REQUIRED');
});
test('API-04 installed plugins are reassessed after changing Editor API inventory',async t=>{
 const source=await fixture(t);
 const dist=path.join(source,'dist');const root=path.join(dist,'plugins');
 const folder='scene-info_20261105T174600000Z';
 await fsp.mkdir(path.join(root,folder),{recursive:true});
 await fsp.writeFile(path.join(root,'manifest.json'),JSON.stringify({schema_version:1,plugins:[{id:'scene-info',folder,enabled:true,settings:{}}]}));
 const meta={id:'scene-info',name:'Scene Information',classification:'Utility',version:'0.1.0',
  author:'repo@gjt',date:'2026-11-05',description:'Scene stats',entry:'./index.js',requires:{editor_api:['inspect.scene'],internal_api:[]}};
 await fsp.writeFile(path.join(root,folder,'plugin.json'),JSON.stringify(meta));
 await fsp.writeFile(path.join(root,folder,'index.js'),"export function activate({editor}){return editor.inspect.scene()}\n");
 const inv=inventory(source,SHA,ts);
 await fsp.writeFile(path.join(root,'editor-api.json'),JSON.stringify(inv));
 const {auditStore}=require('../audit-plugin-store.cjs');
 const before=await auditStore(dist,ts);
 assert.equal(before.counts.STATIC_COMPATIBLE,1);
 const changed={...inv,available_methods:inv.available_methods.filter(x=>x!=='inspect.scene')};
 await fsp.writeFile(path.join(root,'editor-api.json'),JSON.stringify(changed));
 const after=await auditStore(dist,ts);
 assert.equal(after.counts.INCOMPATIBLE,1);
 assert.equal(JSON.parse(await fsp.readFile(path.join(root,'manifest.json'),'utf8')).plugins[0].enabled,true);
});
test('API-05 legacy package without declared requirements remains unassessed',async t=>{
 const source=await fixture(t); const inv=inventory(source,SHA,ts);
 const legacy={id:'legacy',requires:{editor_api:[],internal_api:[]},requires_declared:false};
 const audit=packageAudit([{name:'index.js',data:Buffer.from('export function activate(){return {open(){},deactivate(){}}}') }],legacy,inv,ts);
 assert.equal(audit.status,'NOT_ASSESSED');
});

test('API-06 Manager bootstrap audit is independent of the optional API inventory',async t=>{
 const source=await fixture(t);
 const main=path.join(source,'src','main.ts');
 await fsp.writeFile(main,'(window as any).editor = createEditorAPI();');
 const manager=path.join(source,'manager.js');
 await fsp.writeFile(manager,'const editor = window.editor; if (window.editor?.viewport && window.editor?.inspect) {}');
 const {auditManagerContract}=require('../audit-manager-contract.cjs');
 const ok=auditManagerContract(source,manager,ts);
 assert.equal(ok.status,'PASS_STATIC');
 assert.equal(ok.inventory_dependency,'NONE');
 await fsp.writeFile(main,'window.scene = {};');
 const bad=auditManagerContract(source,manager,ts);
 assert.equal(bad.status,'FAIL');
 assert.ok(bad.missing.includes('native_editor_global_declared'));
});

test('API-07 package fingerprint is stable across reassessment and ignores generated audit.json',async t=>{
 const source=await fixture(t);const inv=inventory(source,SHA,ts);
 const meta={id:'example',requires_declared:false,requires:{editor_api:[],internal_api:[]}};
 const files=[{name:'index.js',data:Buffer.from('export function activate(){}')},
   {name:'plugin.json',data:Buffer.from('{"id":"example"}') }];
 const first=packageAudit(files,meta,inv,ts);
 assert.match(first.package_sha256,/^[0-9a-f]{64}$/);
 const withGenerated=[...files,{name:'audit.json',data:Buffer.from(JSON.stringify(first))}];
 assert.equal(packageAudit(withGenerated,meta,inv,ts).package_sha256,first.package_sha256);
 assert.equal(packageAudit([...files].reverse(),meta,inv,ts).package_sha256,first.package_sha256);
 assert.notEqual(packageAudit(files.map(f=>f.name==='index.js'?{...f,data:Buffer.from('export function activate(){return 1}')} :f),meta,inv,ts).package_sha256,first.package_sha256);
});

async function internalFixture(t){
 const source=await fixture(t);
 const s=path.join(source,'src');
 await fsp.writeFile(path.join(s,'main.ts'), 'window.scene = new Scene(); window.editor = {};');
 await fsp.writeFile(path.join(s,'scene.ts'), `class Scene {
  events: Events;
  elements: Element[] = [];
  camera = new Camera();
  commandQueue: CommandQueue;
  get graphicsDevice(){return this.camera.device;}
  call(){this.events.function('render.image', () => true);}
}`);
 await fsp.writeFile(path.join(s,'splat.ts'), `class Splat extends Element {
  instances: GaussianInstances;
  resource: EditorSplatResource;
  transformPalette: TransformPalette;
  createLayer(ranges: IndexRanges, name: string){ return null; }
}`);
 await fsp.writeFile(path.join(s,'extras.ts'), `class Element { get worldTransform(){return null;} }
class Events {function(name: string, fn:()=>void){} on(name:string,fn:()=>void){} }
class Camera { captureFrame(){return null;} device: Device; }
class GaussianInstances { setBits(indices: object, bits: number){} flush(){} }
class TransformPalette { getTransform(index:number, out:object){} }
class EditorSplatResource {source: ExternalSource; sourcePool: ExternalPool;}
class CommandQueue {enqueue(work:()=>void){} }
`);
 return source;
}
test('INT-01 inventories public-to-plugin internal Scene and Splat member paths', async t=>{
 const source=await internalFixture(t);
 const {inventoryInternals}=require('../audit-editor-internals.cjs');
 const result=inventoryInternals(source,SHA,ts);
 const paths=new Set(result.interfaces.map(x=>x.path));
 for(const name of ['scene.events','scene.elements','scene.camera','scene.camera.captureFrame',
   'scene.commandQueue.enqueue','splat.instances','splat.instances.setBits',
   'splat.resource.source','splat.createLayer','splat.worldTransform','splat.transformPalette.getTransform'])
   assert.ok(paths.has(name),name);
 assert.ok(result.events.some(e=>e.name==='render.image'));
 assert.ok(result.source_sha256['src/scene.ts']);
 assert.equal(result.entry_roots.scene.startsWith('window.scene'),true);
 assert.equal(result.assurance.includes('NOT_STABILITY'),true);
});
test('INT-02 detects changed internal signatures and removed internal properties',async t=>{
 const source=await internalFixture(t);
 const {inventoryInternals,diffInternals}=require('../audit-editor-internals.cjs');
 const before=inventoryInternals(source,SHA,ts);
 const file=path.join(source,'src','splat.ts');
 const old=fs.readFileSync(file,'utf8');
 fs.writeFileSync(file,old.replace('createLayer(ranges: IndexRanges, name: string)',
   'createLayer(ranges: IndexRanges, name: string, strict?: boolean)').replace('transformPalette: TransformPalette;',''));
 const after=inventoryInternals(source,'5'.repeat(40),ts);
 const diff=diffInternals(before,after);
 assert.equal(diff.status,'REVIEW_REQUIRED');
 assert.ok(diff.changed.includes('splat.createLayer'));
 assert.ok(diff.removed.includes('splat.transformPalette'));
 assert.equal(diffInternals(before,before).status,'UNCHANGED');
});
test('INT-03 per-plugin internal audit distinguishes found, missing and unresolved',async t=>{
 const source=await internalFixture(t);
 const {inventoryInternals}=require('../audit-editor-internals.cjs');
 const {auditInternalRequirements}=require('../plugin-compat.cjs');
 const inv={...inventory(source,SHA,ts),internal_inventory:inventoryInternals(source,SHA,ts)};
 const meta={requires:{editor_api:[],internal_api:['scene.elements','splat.createLayer','splat.absentMember','splat.resource.source.mystery']}};
 const evidence=auditInternalRequirements(meta,inv);
 assert.deepEqual(evidence.found,['scene.elements','splat.createLayer']);
 assert.deepEqual(evidence.missing,['splat.absentMember']);
 assert.deepEqual(evidence.unresolved,['splat.resource.source.mystery']);
 const files=[{name:'index.js',data:Buffer.from('export function activate(){return {open(){},deactivate(){}}}') }];
 const audit=packageAudit(files,meta,inv,ts);
 assert.equal(audit.status,'INCOMPATIBLE');
 assert.equal(audit.evaluation.internal_interfaces,'MISSING_REQUIRED');
 assert.equal(packageAudit(files,{...meta,requires:{editor_api:[],internal_api:['splat.createLayer']}},inv,ts).status,'REVIEW_REQUIRED');
});
test('INT-04 unrecoverable internal root exposure fails closed, no fake inventory',async t=>{
 const source=await internalFixture(t);
 const {inventoryInternals}=require('../audit-editor-internals.cjs');
 await fsp.writeFile(path.join(source,'src','main.ts'),'window.editor = {};');
 assert.throws(()=>inventoryInternals(source,SHA,ts),/window.scene/);
});
test('INT-05 CLI embeds matching internal catalog into the public inventory for HTTP installation',async t=>{
 const source=await internalFixture(t);
 const {spawnSync}=require('node:child_process');
 const pub=path.join(source,'public-inventory.json');
 const internal=path.join(source,'internal-inventory.json');
 const diff=path.join(source,'internal-diff.json');
 await fsp.writeFile(pub,JSON.stringify(inventory(source,SHA,ts)));
 const result=spawnSync(process.execPath,[path.join(__dirname,'../audit-editor-internals.cjs'),
   '--source',source,'--commit',SHA,'--output',internal,'--combined',pub,'--diff',diff],{encoding:'utf8'});
 assert.equal(result.status,0,result.stderr);
 const merged=JSON.parse(await fsp.readFile(pub,'utf8'));
 const standalone=JSON.parse(await fsp.readFile(internal,'utf8'));
 assert.equal(merged.internal_inventory.commit,SHA);
 assert.equal(merged.internal_inventory.interface_count,standalone.interface_count);
 assert.equal(merged.available_methods.includes('inspect.scene'),true);
 assert.equal(JSON.parse(await fsp.readFile(diff,'utf8')).status,'NO_PREVIOUS_INVENTORY');
});
