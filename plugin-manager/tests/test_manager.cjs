'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {pathToFileURL} = require('node:url');
const path = require('node:path');
const ready = import(pathToFileURL(path.join(__dirname,'../custom-editor.js')).href);
const meta={id:'scene-info',name:'Scene Information',classification:'Utility',version:'0.1.0',
    author:'repo@gjt',date:'2026-11-05',description:'Scene stats',entry:'./index.js',settings_schema:[],requires:{editor_api:['inspect.scene'],internal_api:[]}};
const folder='scene-info_20261105T174600000Z';
const catalog=(enabled=false)=>({schema_version:1,plugins:[{id:'scene-info',folder,enabled,settings:{}}]});
function env(PluginManager,{auto=false, apiCaps=true,module}={}){
  let activations=0,closes=0,opens=0,running=false;
  let disk=catalog(auto);
  const api={
    capabilities:async()=>apiCaps?{api_version:1,install:true,save:true,remove:true}:null,
    save:async(next,expected)=>{
      if(JSON.stringify(expected)!==JSON.stringify(disk)) throw Error('catalog changed');
      disk=JSON.parse(JSON.stringify(next));return {catalog:disk};
    },
    remove:async(id,expected)=>{
      if(JSON.stringify(expected)!==JSON.stringify(disk)) throw Error('catalog changed');
      disk={schema_version:1,plugins:disk.plugins.filter(p=>p.id!==id)};return {status:'Removed'};
    },
    install:async files=>{
      assert.ok(files.some(x=>x.path==='plugin.json'));
      if(disk.plugins.some(p=>p.id===meta.id))throw Error('already installed');
      const p={id:meta.id,folder,enabled:false,settings:{}};
      disk={schema_version:1,plugins:[...disk.plugins,p]};return {plugin:p,metadata:meta};
    }
  };
  const manager=new PluginManager({editor:{viewport:{},inspect:{scene:async()=>({})}},api,catalogReader:async()=>JSON.parse(JSON.stringify(disk)),
    inventoryReader:async()=>({schema_version:1,commit:'4069712370df3425c386610f28a814403e835543',available_methods:['inspect.scene']}),
    auditReader:async()=>({status:'STATIC_COMPATIBLE',editor_commit:'4069712370df3425c386610f28a814403e835543'}),
    metadataReader:async()=>meta,importer:async()=>module || {activate:async()=>{
      activations++;return {open(){opens++;running=true;},isRunning(){return running;},async deactivate(){closes++;running=false;}};
    }},logger:{error(){}}});
  return {manager,api,disk:()=>disk,changeDisk:x=>disk=x,closeUI:()=>{running=false;manager.emit();},
    counters:()=>({activations,closes,opens})};
}
function fakeFile(path,content){const bytes=Buffer.from(content);return {webkitRelativePath:path,size:bytes.length,
  arrayBuffer:async()=>Uint8Array.from(bytes).buffer,text:async()=>content};}
const sourceFiles=()=>[fakeFile('scene-info/plugin.json',JSON.stringify(meta)),fakeFile('scene-info/index.js','export async function activate(){}')];
test('PM-01 manifest and package validation',async()=>{
 const {validateCatalog,validateMetadata}=await ready;
 assert.equal(validateCatalog({schema_version:1,plugins:[]}).plugins.length,0);
 assert.throws(()=>validateCatalog({schema_version:1,plugins:[{id:'../evil',folder,enabled:true}]}));
 assert.throws(()=>validateMetadata({...meta,entry:'./../escape.js'}));
});
test('PM-02 upload converts selected folder to safe relative files',async()=>{
 const {prepareUpload}=await ready;
 const upload=await prepareUpload(sourceFiles());
 assert.equal(upload.metadata.name,meta.name);
 assert.deepEqual(upload.files.map(x=>x.path).sort(),['index.js','plugin.json']);
 assert.equal(Buffer.from(upload.files[0].data_base64,'base64').length,Buffer.byteLength(JSON.stringify(meta)));
});
test('PM-03 rejects package with traversal or missing plugin.json',async()=>{
 const {prepareUpload}=await ready;
 await assert.rejects(prepareUpload([fakeFile('scene-info/index.js','x'),fakeFile('scene-info/asset.css','y')]),/plugin.json/);
 await assert.rejects(prepareUpload([fakeFile('scene-info/plugin.json',JSON.stringify(meta)),fakeFile('scene-info/../index.js','x')]),/Invalid plugin/);
});
test('PM-04 startup respects saved enabled state',async()=>{
 const {PluginManager}=await ready;
 const off=env(PluginManager);await off.manager.initialize();
 assert.equal(off.manager.state('scene-info'),'Installed');
 assert.equal(off.counters().activations,0);
 const on=env(PluginManager,{auto:true});await on.manager.initialize();
 assert.equal(on.manager.state('scene-info'),'Active');
 assert.equal(on.counters().activations,1);
});
test('PM-05 activation and cleanup do not duplicate state',async()=>{
 const {PluginManager}=await ready;
 const x=env(PluginManager);await x.manager.initialize();
 await x.manager.activate('scene-info');await x.manager.activate('scene-info');
 await x.manager.open('scene-info');x.closeUI();await x.manager.deactivate('scene-info');
 await x.manager.activate('scene-info');
 assert.deepEqual(x.counters(),{activations:2,closes:1,opens:1});
});
test('PM-06 failed cleanup leaves Error but Remove reports cleanup failure and deletes registration',async()=>{
 const {PluginManager}=await ready;
 const x=env(PluginManager,{module:{activate:async()=>({open(){},deactivate:async()=>{throw Error('mask unsafe');}})}});
 await x.manager.initialize();await x.manager.activate('scene-info');
 await assert.rejects(x.manager.deactivate('scene-info',{confirm:()=>true}),/mask unsafe/);
 assert.equal(x.manager.state('scene-info'),'Error');
 const removed=await x.manager.remove('scene-info',{confirm:()=>true});
 assert.equal(removed.removed,true);assert.equal(removed.cleanup.status,'failed');
 assert.equal(removed.reloadRequired,true);assert.equal(x.disk().plugins.length,0);
});

test('PM-07 Startup must first be activated, then persists with optimistic catalog check',async()=>{
 const {PluginManager}=await ready;
 const x=env(PluginManager);await x.manager.initialize();
 assert.throws(()=>x.manager.desired('scene-info',true),/Activate the plugin successfully/);
 await x.manager.activate('scene-info');
 x.manager.desired('scene-info',true);await x.manager.save();
 assert.equal(x.disk().plugins[0].enabled,true);
 await x.manager.deactivate('scene-info');
 assert.equal(x.manager.record('scene-info').enabled,true);
 x.manager.desired('scene-info',false);
 x.changeDisk(catalog(false));
 await assert.rejects(x.manager.save(),/catalog changed/);
});
test('PM-08 Refresh preserves active plugin, rejects changed folder',async()=>{
 const {PluginManager}=await ready;
 const x=env(PluginManager);await x.manager.initialize();await x.manager.activate('scene-info');
 await x.manager.refresh();assert.equal(x.manager.state('scene-info'),'Active');
 x.changeDisk({schema_version:1,plugins:[]});
 await assert.rejects(x.manager.refresh(),/may still be running/);
});
test('PM-09 HTTP install registers module without activating',async()=>{
 const {PluginManager}=await ready;
 const x=env(PluginManager);x.changeDisk({schema_version:1,plugins:[]});await x.manager.initialize();
 const entry=await x.manager.installFiles(sourceFiles());
 assert.equal(entry.state,'Installed');assert.equal(x.disk().plugins.length,1);
 assert.equal(x.counters().activations,0);
 await x.manager.activate('scene-info');assert.equal(x.counters().activations,1);
});
test('PM-10 Remove cleans up active plugins and removes saved configuration',async()=>{
 const {PluginManager}=await ready;
 const x=env(PluginManager);await x.manager.initialize();await x.manager.activate('scene-info');
 x.manager.desired('scene-info',true);await x.manager.save();
 const result=await x.manager.remove('scene-info');
 assert.equal(result.removed,true);assert.equal(result.cleanup.status,'succeeded');
 assert.equal(result.reloadRequired,false);assert.equal(x.disk().plugins.length,0);
 assert.equal(x.counters().closes,1);assert.equal(x.manager.record('scene-info'),undefined);
});

test('PM-11 read-only static hosting keeps plugin activation working',async()=>{
 const {PluginManager}=await ready;
 const x=env(PluginManager,{apiCaps:false});await x.manager.initialize();
 assert.equal(x.manager.capabilities,null);
 await x.manager.activate('scene-info');assert.equal(x.manager.state('scene-info'),'Active');
 await assert.rejects(x.manager.save(),/local plugin-management/);
 await assert.rejects(x.manager.remove('scene-info'),/local plugin-management/);
});
test('PM-12 batch handles independent states',async()=>{
 const {PluginManager}=await ready;
 const x=env(PluginManager);await x.manager.initialize();
 const result=await x.manager.batch(['scene-info','unknown'],'activate');
 assert.equal(result[0].ok,true);assert.equal(result[1].skipped,true);
});

test('PM-13 missing declared Editor method receives INCOMPATIBLE diagnostic',async()=>{
 const {checkCompatibility,validateMetadata}=await ready;
 const bad=validateMetadata({...meta,requires:{editor_api:['inspect.nonexistent'],internal_api:[]}});
 const result=checkCompatibility(bad,{available_methods:['inspect.scene'],commit:'4069712370df3425c386610f28a814403e835543'},
    {inspect:{scene(){}}},{status:'STATIC_COMPATIBLE',editor_commit:'4069712370df3425c386610f28a814403e835543'});
 assert.equal(result.status,'INCOMPATIBLE');
 assert.deepEqual(result.missing,['inspect.nonexistent']);
});
test('PM-14 declared internal API is advisory and never blocks activation',async()=>{
 const {PluginManager,validateMetadata}=await ready;
 const x=env(PluginManager);await x.manager.initialize();
 const entry=x.manager.entries.get('scene-info');
 entry.meta=validateMetadata({...meta,requires:{editor_api:['inspect.scene'],internal_api:['window.scene']}});
 entry.compatibility={status:'REVIEW_REQUIRED',missing:[]};
 await x.manager.activate('scene-info');
 assert.equal(x.manager.state('scene-info'),'Active');
 assert.equal(x.manager.entries.get('scene-info').compatibility.status,'REVIEW_REQUIRED');
});

test('PM-15 static INCOMPATIBLE classification does not block runtime activation',async()=>{
 const {PluginManager,validateMetadata}=await ready;
 const x=env(PluginManager);await x.manager.initialize();
 const entry=x.manager.entries.get('scene-info');
 entry.meta=validateMetadata({...meta,requires:{editor_api:['inspect.nonexistent'],internal_api:[]}});
 entry.audit={status:'INCOMPATIBLE',editor_commit:'4069712370df3425c386610f28a814403e835543'};
 await x.manager.activate('scene-info');
 assert.equal(x.manager.state('scene-info'),'Active');
 assert.equal(entry.compatibility.status,'INCOMPATIBLE');
 assert.equal(x.counters().activations,1);
});
test('PM-16 missing requirements are advisory without compatibility approval',async()=>{
 const {PluginManager,validateMetadata}=await ready;
 const x=env(PluginManager);await x.manager.initialize();
 const entry=x.manager.entries.get('scene-info');
 entry.meta=validateMetadata({...meta,requires_declared:false,requires:{editor_api:[],internal_api:[]}});
 entry.audit={status:'NOT_ASSESSED',editor_commit:'4069712370df3425c386610f28a814403e835543'};
 await x.manager.activate('scene-info');
 assert.equal(x.manager.state('scene-info'),'Active');
 assert.equal(x.manager.dirty,false);
});

test('PM-17 startup executes saved plugin regardless of compatibility screening',async()=>{
 const {PluginManager,validateMetadata}=await ready;
 const x=env(PluginManager,{auto:true});
 x.manager.metadataReader=async()=>validateMetadata({...meta,requires_declared:false,requires:{editor_api:[],internal_api:[]}});
 x.manager.auditReader=async()=>({status:'INCOMPATIBLE',editor_commit:'4069712370df3425c386610f28a814403e835543',package_sha256:'a'.repeat(64)});
 await x.manager.initialize();
 assert.equal(x.manager.state('scene-info'),'Active');
 assert.equal(x.manager.startupFindings.length,0);
});

test('PM-18 enabling startup after activation persists without compatibility approval',async()=>{
 const {PluginManager}=await ready;
 const x=env(PluginManager);await x.manager.initialize();
 await x.manager.activate('scene-info');x.manager.desired('scene-info',true);
 assert.equal(x.manager.record('scene-info').startup_approval,undefined);
 await x.manager.save();
 const y=env(PluginManager,{auto:true});await y.manager.initialize();
 assert.equal(y.manager.state('scene-info'),'Active');
});

test('PM-19 prior version-specific approval is ignored by startup execution',async()=>{
 const {PluginManager,validateMetadata}=await ready;
 const x=env(PluginManager,{auto:true});
 x.manager.metadataReader=async()=>validateMetadata({...meta,requires_declared:false,requires:{editor_api:[],internal_api:[]}});
 x.manager.auditReader=async()=>({status:'NOT_ASSESSED',editor_commit:'4069712370df3425c386610f28a814403e835543',package_sha256:'d'.repeat(64)});
 const withOld=catalog(true);withOld.plugins[0].startup_approval={editor_commit:'4069712370df3425c386610f28a814403e835543',package_sha256:'a'.repeat(64)};
 x.changeDisk(withOld);
 await x.manager.initialize();
 assert.equal(x.manager.state('scene-info'),'Active');
 assert.equal(x.manager.startupFindings.length,0);
});

test('PM-20 removed reassess and reinstall actions do not exist',async()=>{
 const {PluginManager,localPluginApi}=await ready;
 const x=env(PluginManager);await x.manager.initialize();
 assert.equal(x.manager.reassess,undefined);
 assert.equal(x.manager.reinstallFiles,undefined);
 assert.equal(localPluginApi.reassess,undefined);
 assert.equal(localPluginApi.reinstall,undefined);
});

test('PM-21 Remove then Install gives fresh Startup/settings and new release',async()=>{
 const {PluginManager}=await ready;const x=env(PluginManager);
 await x.manager.initialize();await x.manager.activate('scene-info');
 x.manager.desired('scene-info',true);x.manager.changeSettings('scene-info',{});await x.manager.save();
 const removed=await x.manager.remove('scene-info');assert.equal(removed.reloadRequired,false);
 const fresh=await x.manager.installFiles(sourceFiles());
 assert.equal(fresh.state,'Installed');assert.equal(x.manager.record('scene-info').enabled,false);
 assert.deepEqual(x.manager.record('scene-info').settings,{});
 assert.equal(x.manager.reloadRequiredIds.has('scene-info'),false);
});

test('PM-22 installation rejects duplicate ID until removed',async()=>{
 const {PluginManager}=await ready;const x=env(PluginManager);
 await x.manager.initialize();
 await assert.rejects(x.manager.installFiles(sourceFiles()),/already installed/);
 await x.manager.remove('scene-info');
 assert.equal((await x.manager.installFiles(sourceFiles())).state,'Installed');
});

test('PM-23 Deactivate Closed directly; Running requires warning/confirmation',async()=>{
 const {PluginManager}=await ready;const x=env(PluginManager);
 await x.manager.initialize();await x.manager.activate('scene-info');
 assert.equal(x.manager.displayStatus('scene-info'),'Active · Closed');
 await x.manager.open('scene-info');assert.equal(x.manager.displayStatus('scene-info'),'Active · Running');
 await assert.rejects(x.manager.deactivate('scene-info'),/Confirm.*warning/);
 assert.equal(x.manager.state('scene-info'),'Active');
 await assert.rejects(x.manager.deactivate('scene-info',{confirm:()=>false}),/cancelled/);
 const result=await x.manager.deactivate('scene-info',{confirm:({condition})=>condition==='Running'});
 assert.equal(result.verification,'plugin_reported');
 assert.equal(x.manager.displayStatus('scene-info'),'Inactive');
 await x.manager.activate('scene-info');await x.manager.deactivate('scene-info');
 assert.equal(x.manager.state('scene-info'),'Inactive');
});

test('PM-24 Running Deactivate uses same cleanup and reports plugin verification',async()=>{
 const {PluginManager}=await ready;const x=env(PluginManager);
 await x.manager.initialize();await x.manager.activate('scene-info');await x.manager.open('scene-info');
 let prompted=0;
 const result=await x.manager.deactivate('scene-info',{confirm:()=>{prompted++;return true;}});
 assert.equal(prompted,1);assert.equal(result.verification,'plugin_reported');
 assert.equal(x.manager.state('scene-info'),'Inactive');
 assert.match(x.manager.entries.get('scene-info').lastWarning,/plugin/);
});

test('PM-25 legacy isRunning missing: Unknown requires warning, cleanup may succeed',async()=>{
 const {PluginManager}=await ready;
 const x=env(PluginManager,{module:{activate:async()=>({open(){},async deactivate(){}})}});
 await x.manager.initialize();await x.manager.activate('scene-info');
 assert.equal(x.manager.displayStatus('scene-info'),'Active · Unknown');
 await assert.rejects(x.manager.deactivate('scene-info'),/Confirm.*warning/);
 await x.manager.deactivate('scene-info',{confirm:()=>true});
 assert.equal(x.manager.state('scene-info'),'Inactive');
});

test('PM-26 Remove after unsuccessful cleanup still deletes release but blocks same-ID activation',async()=>{
 const {PluginManager}=await ready;
 const x=env(PluginManager,{module:{activate:async()=>({open(){},isRunning(){return true;},async deactivate(){throw Error('failed to restore masks');}})}});
 await x.manager.initialize();await x.manager.activate('scene-info');
 const removed=await x.manager.remove('scene-info',{confirm:()=>true});
 assert.equal(removed.cleanup.status,'failed');assert.equal(removed.reloadRequired,true);
 assert.equal(x.manager.reloadRequiredIds.has('scene-info'),true);
 await x.manager.installFiles(sourceFiles());
 await assert.rejects(x.manager.activate('scene-info'),/Reload the Editor/);
 await x.manager.refresh();
 await assert.rejects(x.manager.activate('scene-info'),/Reload the Editor/);
});

test('PM-27 isRunning throws: Error visible, Remove tries cleanup then reports it',async()=>{
 const {PluginManager}=await ready;
 let cleaned=0;
 const x=env(PluginManager,{module:{activate:async()=>({open(){},isRunning(){throw Error('status broken');},async deactivate(){cleaned++;}})}});
 await x.manager.initialize();await x.manager.activate('scene-info');
 assert.equal(x.manager.displayStatus('scene-info'),'Error');
 assert.match(x.manager.entries.get('scene-info').error,/status broken/);
 const result=await x.manager.remove('scene-info',{confirm:()=>true});
 assert.equal(cleaned,1);
 assert.equal(result.cleanup.status,'failed'); // Post-cleanup isRunning still throws; uncertain.
 assert.equal(result.reloadRequired,true);
});

test('PM-28 Remove without cleanup handle reports uncertainty from partial activation',async()=>{
 const {PluginManager}=await ready;const x=env(PluginManager,{module:{activate:async()=>{throw Error('partial activation');}}});
 await x.manager.initialize();
 await assert.rejects(x.manager.activate('scene-info'),/partial activation/);
 assert.equal(x.manager.entries.get('scene-info').handle,null);
 const result=await x.manager.remove('scene-info',{confirm:()=>true});
 assert.equal(result.cleanup.status,'unavailable');
 assert.equal(result.reloadRequired,true);assert.equal(x.disk().plugins.length,0);
});

test('PM-29 startup failure is recorded, without silently skipping the plugin',async()=>{
 const {PluginManager}=await ready;
 const x=env(PluginManager,{auto:true,module:{activate:async()=>{throw Error('missing runtime service');}}});
 await x.manager.initialize();
 assert.equal(x.manager.state('scene-info'),'Error');
 assert.equal(x.manager.startupFindings.length,1);
 assert.match(x.manager.startupFindings[0].reason,/missing runtime service/);
});
test('PM-30 missing audit inventory does not stop plugin startup',async()=>{
 const {PluginManager}=await ready;const x=env(PluginManager,{auto:true});
 x.manager.inventoryReader=async()=>{throw Error('not generated');};
 await x.manager.initialize();
 assert.equal(x.manager.state('scene-info'),'Active');
 assert.equal(x.manager.entries.get('scene-info').compatibility.status,'NOT_ASSESSED');
 assert.match(x.manager.auditWarnings[0],/not generated/);
});
test('PM-31 cleanup returning while still Running is Error; package can still be removed',async()=>{
 const {PluginManager}=await ready;
 const x=env(PluginManager,{module:{activate:async()=>({open(){},isRunning(){return true;},async deactivate(){}})}});
 await x.manager.initialize();await x.manager.activate('scene-info');
 await assert.rejects(x.manager.deactivate('scene-info',{confirm:()=>true}),/still running/);
 assert.equal(x.manager.state('scene-info'),'Error');
 const result=await x.manager.remove('scene-info',{confirm:()=>true});assert.equal(result.cleanup.status,'failed');
 assert.equal(result.reloadRequired,true);
});

test('PM-32 failed server deletion retains installed catalog and accurate cleanup status',async()=>{
 const {PluginManager}=await ready;const x=env(PluginManager);
 await x.manager.initialize();await x.manager.activate('scene-info');
 x.api.remove=async()=>{throw Error('server unavailable');};
 await assert.rejects(x.manager.remove('scene-info'),/Package removal failed.*cleanup: succeeded/);
 assert.equal(x.manager.state('scene-info'),'Inactive');
 assert.equal(x.manager.record('scene-info').id,'scene-info');
 assert.equal(x.counters().closes,1);
});

test('PM-33 installed inactive package removes without importing JS',async()=>{
 const {PluginManager}=await ready;const x=env(PluginManager);
 await x.manager.initialize();const result=await x.manager.remove('scene-info');
 assert.equal(result.cleanup.status,'not_required');assert.equal(result.reloadRequired,false);
 assert.equal(x.counters().activations,0);
});

test('PM-34 Remove Error without runtime side effects does not require reload',async()=>{
 const {PluginManager}=await ready;const x=env(PluginManager);
 x.manager.metadataReader=async()=>{throw Error('broken metadata');};
 await x.manager.initialize();assert.equal(x.manager.state('scene-info'),'Error');
 const result=await x.manager.remove('scene-info');
 assert.equal(result.cleanup.status,'not_required');assert.equal(result.reloadRequired,false);
});

test('PM-35 batch records independent removal results and cleanup warnings',async()=>{
 const {PluginManager}=await ready;
 const x=env(PluginManager,{module:{activate:async()=>({open(){},isRunning(){return true;},async deactivate(){throw Error('pending work');}})}});
 await x.manager.initialize();await x.manager.activate('scene-info');
 const results=await x.manager.batch(['scene-info','ghost'],'remove',{confirm:()=>true});
 assert.equal(results[0].ok,true);assert.equal(results[0].value.reloadRequired,true);
 assert.equal(results[1].skipped,true);
});

test('PM-36 legacy import failure with possible top-level effects requires reload after removal',async()=>{
 const {PluginManager}=await ready;const x=env(PluginManager);
 await x.manager.initialize();x.manager.importer=async()=>{throw Error('dependency evaluated then failed');};
 await assert.rejects(x.manager.activate('scene-info'),/dependency evaluated/);
 const result=await x.manager.remove('scene-info',{confirm:()=>true});assert.equal(result.cleanup.status,'unavailable');
 assert.equal(result.reloadRequired,true);
});

test('PM-37 Deactivate can retry a failed cleanup through the same warned action',async()=>{
 const {PluginManager}=await ready;
 let fails=true;
 const x=env(PluginManager,{module:{activate:async()=>({open(){},isRunning(){return false;},async deactivate(){if(fails)throw Error('temporary');}})}});
 await x.manager.initialize();await x.manager.activate('scene-info');
 await assert.rejects(x.manager.deactivate('scene-info'),/temporary/);
 assert.equal(x.manager.state('scene-info'),'Error');
 fails=false;
 const result=await x.manager.deactivate('scene-info',{confirm:()=>true});
 assert.equal(result.verification,'plugin_reported');assert.equal(x.manager.state('scene-info'),'Inactive');
});

test('PM-38 Refresh recovers metadata-only Error without treating it as an active handle',async()=>{
 const {PluginManager}=await ready;const x=env(PluginManager);
 let bad=true;
 x.manager.metadataReader=async()=>{if(bad)throw Error('manifest metadata mismatch');return meta;};
 await x.manager.initialize();assert.equal(x.manager.state('scene-info'),'Error');
 await assert.rejects(x.manager.activate('scene-info'),/metadata is unavailable/);
 bad=false;await x.manager.refresh();assert.equal(x.manager.state('scene-info'),'Installed');
 await x.manager.activate('scene-info');assert.equal(x.manager.state('scene-info'),'Active');
});

test('PM-39 batch Deactivate handles an Error with a retained cleanup handle',async()=>{
 const {PluginManager}=await ready;const x=env(PluginManager,{module:{activate:async()=>({open(){},isRunning(){return true;},async deactivate(){}})}});
 await x.manager.initialize();await x.manager.activate('scene-info');
 await assert.rejects(x.manager.deactivate('scene-info',{confirm:()=>true}),/still running/);
 const result=await x.manager.batch(['scene-info'],'deactivate',{confirm:()=>true});
 assert.equal(result[0].ok,false);assert.match(result[0].error,/still running/);
});


test('PM-40 cleanup failure requires an explicit second confirmation before package deletion',async()=>{
 const {PluginManager}=await ready;
 const x=env(PluginManager,{module:{activate:async()=>({open(){},async deactivate(){throw Error('cleanup failed');}})}});
 await x.manager.initialize();await x.manager.activate('scene-info');
 let removed=0;const originalRemove=x.api.remove;
 x.api.remove=async(...args)=>{removed++;return originalRemove(...args);};
 await assert.rejects(x.manager.remove('scene-info'),/removal cancelled.*cleanup was not confirmed/i);
 assert.equal(removed,0);assert.equal(x.disk().plugins.length,1);
 assert.equal(x.manager.state('scene-info'),'Error');
 const result=await x.manager.remove('scene-info',{confirm:({cleanup,message})=>{
   assert.equal(cleanup.status,'failed');assert.match(message,/Reload the Editor/);return true;
 }});
 assert.equal(result.removed,true);assert.equal(result.reloadRequired,true);
 assert.equal(removed,1);assert.equal(x.disk().plugins.length,0);
});

test('PM-41 batch Remove propagates refusal when cleanup cannot be confirmed',async()=>{
 const {PluginManager}=await ready;
 const x=env(PluginManager,{module:{activate:async()=>{throw Error('partial startup');}}});
 await x.manager.initialize();await assert.rejects(x.manager.activate('scene-info'),/partial startup/);
 const result=await x.manager.batch(['scene-info'],'remove',{confirm:()=>false});
 assert.equal(result[0].ok,false);assert.match(result[0].error,/removal cancelled/i);
 assert.equal(x.disk().plugins.length,1);
});

test('PM-42 browser distinguishes unregistered plugin from incomplete disk deletion',async()=>{
 const {PluginManager}=await ready;
 const x=env(PluginManager);
 await x.manager.initialize();
 const original=x.api.remove;
 x.api.remove=async(...args)=>({...await original(...args),packageDeleted:false,
    warning:'Residual files may remain in the old release directory.'});
 const outcome=await x.manager.remove('scene-info');
 assert.equal(outcome.removed,true);
 assert.equal(outcome.packageDeleted,false);
 assert.match(outcome.serverWarning,/Residual files/);
 assert.equal(x.disk().plugins.length,0);
});


test('PM-43 Refresh recovers management capabilities after backend starts; Remove works without Editor reload', async () => {
 const {PluginManager}=await ready;
 const x=env(PluginManager,{apiCaps:false});
 await x.manager.initialize();
 assert.equal(x.manager.capabilities,null);
 await assert.rejects(x.manager.remove('scene-info'),/local plugin-management HTTP server/);
 let probes=0;
 x.api.capabilities=async()=>{
   probes++;
   return {api_version:1,install:true,save:true,remove:true};
 };
 await x.manager.refresh();
 assert.equal(probes,1);
 assert.equal(x.manager.capabilities.remove,true);
 assert.equal(x.manager.state('scene-info'),'Installed');
 const result=await x.manager.remove('scene-info');
 assert.equal(result.removed,true);
 assert.equal(x.disk().plugins.length,0);
});

test('PM-44 Refresh notices backend outage and recovery, preserving plugin runtime state', async () => {
 const {PluginManager}=await ready;
 const x=env(PluginManager);
 await x.manager.initialize();
 await x.manager.activate('scene-info');
 x.api.capabilities=async()=>null;
 await x.manager.refresh();
 assert.equal(x.manager.capabilities,null);
 assert.equal(x.manager.state('scene-info'),'Active');
 await assert.rejects(x.manager.remove('scene-info'),/local plugin-management HTTP server/);
 x.api.capabilities=async()=>({api_version:1,install:true,save:true,remove:true});
 await x.manager.refresh();
 assert.equal(x.manager.capabilities.remove,true);
 assert.equal(x.manager.state('scene-info'),'Active');
 const result=await x.manager.remove('scene-info');
 assert.equal(result.cleanup.status,'succeeded');
 assert.equal(x.disk().plugins.length,0);
});
