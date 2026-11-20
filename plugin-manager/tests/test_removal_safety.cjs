'use strict';
const {removeFixture,fixtureScope,listen,closeServer,closeBackend,freePort}=require('./fixture-utils.cjs');
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {stagePackageRemoval}=require('../management-core.cjs');

test('REMOVE-01 retries temporary Windows rename rejection, then succeeds',async()=>{
    let calls=0,delays=[];
    const outcome=await stagePackageRemoval('original','trash',{
        rename:async()=>{calls++;if(calls<3)throw Object.assign(new Error('locked'),{code:'EPERM'});},
        sleep:async ms=>{delays.push(ms);}
    });
    assert.equal(calls,3);assert.equal(outcome.attempts,3);
    assert.deepEqual(delays,[100,250]);
});

test('REMOVE-02 persistent EPERM aborts before changing package or manifest',async t=>{
    const root=await fs.mkdtemp(path.join(os.tmpdir(),'spm-removal-'));
    t.after(()=>removeFixture(root));
    const folder=path.join(root,'scene-info_20261108T003704787Z');
    const trash=path.join(root,'.spm-trash-test');
    await fs.mkdir(folder);await fs.writeFile(path.join(folder,'index.js'),'code');
    const manifest=path.join(root,'manifest.json');
    await fs.writeFile(manifest,'catalog-before');
    let calls=0;
    await assert.rejects(stagePackageRemoval(folder,trash,{
        rename:async()=>{calls++;throw Object.assign(new Error('denied'),{code:'EPERM'});},
        sleep:async()=>{}
    }),e=>{
        assert.equal(e.status,409);assert.equal(e.code,'PLUGIN_REMOVE_RENAME_FAILED');
        assert.equal(e.filesystemCode,'EPERM');assert.equal(e.attempts,4);
        assert.equal(e.catalogChanged,false);
        assert.match(e.message,/manifest remain unchanged/);
        return true;
    });
    assert.equal(calls,4);
    assert.equal(await fs.readFile(manifest,'utf8'),'catalog-before');
    assert.equal(await fs.readFile(path.join(folder,'index.js'),'utf8'),'code');
    await assert.rejects(fs.access(trash),{code:'ENOENT'});
});

test('REMOVE-03 unknown filesystem failure is not retried or misclassified as permission problem',async()=>{
    let calls=0;
    await assert.rejects(stagePackageRemoval('original','trash',{
        rename:async()=>{calls++;throw Object.assign(new Error('missing'),{code:'ENOENT'});},
        sleep:async()=>{throw Error('no retry expected');}
    }),e=>{assert.equal(e.status,500);assert.equal(e.filesystemCode,'ENOENT');
        assert.equal(e.attempts,1);return true;});
    assert.equal(calls,1);
});


test('REMOVE-04 attempt diagnostics remain accurate when Windows error changes mid-retry',async()=>{
    let calls=0;
    await assert.rejects(stagePackageRemoval('old','trash',{
        rename:async()=>{calls++;throw Object.assign(new Error('failed'),{code:calls===1?'EPERM':'ENOENT'});},
        sleep:async()=>{}
    }),e=>{assert.equal(e.attempts,2);assert.equal(e.filesystemCode,'ENOENT');
        assert.equal(e.status,500);return true;});
    assert.equal(calls,2);
});

const {removePackageTransaction}=require('../management-core.cjs');
function deniedStage(code='EPERM') {
    const error=Object.assign(new Error('rename denied'), {
        code:'PLUGIN_REMOVE_RENAME_FAILED', filesystemCode:code, attempts:4, catalogChanged:false
    });
    return async()=>{throw error;};
}
async function removalFixture(t) {
    const root=await fs.mkdtemp(path.join(os.tmpdir(),'spm-removal-fallback-'));
    t.after(()=>removeFixture(root));
    const dir=path.join(root,'scene-info_20261108T003704787Z');
    const trash=path.join(root,'.spm-trash-test');
    const manifest=path.join(root,'manifest.json');
    await fs.mkdir(dir);
    await fs.writeFile(path.join(dir,'index.js'),'export const sample = 1;');
    const initial={schema_version:1,plugins:[{id:'scene-info',folder:path.basename(dir),enabled:true,settings:{}}]};
    const next={schema_version:1,plugins:[]};
    await fs.writeFile(manifest,JSON.stringify(initial));
    const saveCatalog=async (_root,value)=>fs.writeFile(manifest,JSON.stringify(value));
    return {root,dir,trash,manifest,initial,next,saveCatalog};
}

test('REMOVE-05 rename EPERM uses catalog-first direct deletion (no static-server coordination)',async t=>{
    const x=await removalFixture(t);
    const result=await removePackageTransaction(x.root,x.dir,x.trash,x.next,{
        stage:deniedStage(),saveCatalog:x.saveCatalog
    });
    assert.equal(result.status,'Removed');
    assert.equal(result.method,'catalog-first');
    assert.equal(result.packageDeleted,true);
    assert.deepEqual(JSON.parse(await fs.readFile(x.manifest,'utf8')),x.next);
    await assert.rejects(fs.access(x.dir),{code:'ENOENT'});
});

test('REMOVE-06 denied rename and partial direct-delete failure never republishes damaged release',async t=>{
    const x=await removalFixture(t);
    let removed=0;
    const result=await removePackageTransaction(x.root,x.dir,x.trash,x.next,{
        stage:deniedStage('EACCES'),saveCatalog:x.saveCatalog,
        remove:async(folder)=>{
            assert.equal(folder,x.dir);
            await fs.rm(path.join(folder,'index.js'));removed++;
            throw Object.assign(new Error('resource busy'),{code:'EBUSY'});
        }
    });
    assert.equal(removed,1);
    assert.equal(result.packageDeleted,false);
    assert.match(result.warning,/residual files may remain/);
    assert.deepEqual(JSON.parse(await fs.readFile(x.manifest,'utf8')),x.next);
    assert.equal((await fs.stat(x.dir)).isDirectory(),true);
});

test('REMOVE-07 failed catalog save prevents direct deletion after rename denial',async t=>{
    const x=await removalFixture(t);
    let removalAttempted=false;
    await assert.rejects(removePackageTransaction(x.root,x.dir,x.trash,x.next,{
        stage:deniedStage(),
        saveCatalog:async()=>{throw Object.assign(new Error('save denied'),{code:'EACCES'});},
        remove:async()=>{removalAttempted=true;}
    }),/save denied/);
    assert.equal(removalAttempted,false);
    assert.deepEqual(JSON.parse(await fs.readFile(x.manifest,'utf8')),x.initial);
    assert.equal(await fs.readFile(path.join(x.dir,'index.js'),'utf8'),'export const sample = 1;');
});

test('REMOVE-08 non-permission staging errors never use catalog-first fallback',async t=>{
    const x=await removalFixture(t);
    let touched=false;
    await assert.rejects(removePackageTransaction(x.root,x.dir,x.trash,x.next,{
        stage:deniedStage('ENOENT'),saveCatalog:async()=>{touched=true;},
        remove:async()=>{touched=true;}
    }),{code:'PLUGIN_REMOVE_RENAME_FAILED'});
    assert.equal(touched,false);
    assert.deepEqual(JSON.parse(await fs.readFile(x.manifest,'utf8')),x.initial);
});

test('REMOVE-09 successful staging restores original on catalog save error',async t=>{
    const x=await removalFixture(t);
    await assert.rejects(removePackageTransaction(x.root,x.dir,x.trash,x.next,{
        stage:(a,b)=>fs.rename(a,b),
        saveCatalog:async()=>{throw Error('cannot persist');}
    }),/cannot persist/);
    assert.deepEqual(JSON.parse(await fs.readFile(x.manifest,'utf8')),x.initial);
    assert.equal(await fs.readFile(path.join(x.dir,'index.js'),'utf8'),'export const sample = 1;');
    await assert.rejects(fs.access(x.trash),{code:'ENOENT'});
});

test('REMOVE-10 successful staging with deletion failure reports orphaned staged directory',async t=>{
    const x=await removalFixture(t);
    const result=await removePackageTransaction(x.root,x.dir,x.trash,x.next,{
        stage:(a,b)=>fs.rename(a,b),saveCatalog:x.saveCatalog,
        remove:async()=>{throw Object.assign(new Error('locked'),{code:'EBUSY'});}
    });
    assert.equal(result.status,'Removed');
    assert.equal(result.method,'staged');
    assert.equal(result.packageDeleted,false);
    assert.match(result.warning,/temporary directory/);
    assert.deepEqual(JSON.parse(await fs.readFile(x.manifest,'utf8')),x.next);
    assert.equal(await fs.readFile(path.join(x.trash,'index.js'),'utf8'),'export const sample = 1;');
});
