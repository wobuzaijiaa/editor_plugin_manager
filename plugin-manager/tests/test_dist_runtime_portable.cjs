'use strict';
/**
 * Architecture C deployed-backend contract.
 *
 * Intentional scope: does the Plugin Manager still operate when only its backend
 * files are deployed under dist/runtime, and does its TypeScript adapter resolve
 * the Editor checkout's dependency?
 *
 * Launcher, BAT, maintenance-script and supervisor process-ownership tests belong
 * to their own respective suites. No source-code regex assertions here.
 */
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const {spawn}=require('node:child_process');
const {fixtureScope}=require('./fixture-utils.cjs');

const manager=path.resolve(__dirname,'..');
const EDITOR_ORIGIN='http://127.0.0.1:3013';
const BACKEND_FILES=[
    'management-server.cjs','management-core.cjs','custom-editor.js',
    'plugin-compat.cjs','typescript-loader.cjs','native-process.cjs'
];

async function waitForReady(base,child,stderr){
    for(let i=0;i<100;i++){
        if(child.exitCode!==null || child.signalCode!==null)
            throw Error(`Deployed Manager exited early (${child.exitCode}): ${stderr.join('')}`);
        try{
            const result=await fetch(base+'/api/plugins/capabilities',{signal:AbortSignal.timeout(1000)});
            if(result.ok)return result;
            throw Error(`Capabilities returned HTTP ${result.status}`);
        }catch(e){
            if(e.message.startsWith('Capabilities returned'))throw e;
            await new Promise(r=>setTimeout(r,50));
        }
    }
    throw Error(`Deployed Manager did not become ready: ${stderr.join('')}`);
}

function pluginPackage(){
    const meta={
        id:'portable-smoke',name:'Portable Smoke',classification:'Utility',
        version:'0.1.0',author:'Test',date:'2026-11-23',
        description:'Verify deployed Manager package management',entry:'./index.js',
        requires:{editor_api:[],internal_api:[]}
    };
    const files={
        'plugin.json':JSON.stringify(meta),
        'index.js':'export function activate(){return {deactivate(){}};}'
    };
    return {files:Object.entries(files).map(([file,data])=>({
        path:file,data_base64:Buffer.from(data).toString('base64')
    }))};
}

test('C-P01: deployed Management backend works without source checkout',
    {timeout:30000},async t=>{
    const tmp=await fs.mkdtemp(path.join(os.tmpdir(),'spm-deployed-runtime-'));
    const scope=fixtureScope(t,tmp);
    const dist=path.join(tmp,'dist');
    const runtime=path.join(dist,'runtime');
    const plugins=path.join(dist,'plugins');
    await fs.mkdir(runtime,{recursive:true});
    await fs.mkdir(plugins,{recursive:true});
    await fs.writeFile(path.join(runtime,'package.json'),'{"type":"module","private":true}\n');
    await fs.writeFile(path.join(plugins,'manifest.json'),'{"schema_version":1,"plugins":[]}\n');
    for(const name of BACKEND_FILES)
        await fs.copyFile(path.join(manager,name),path.join(runtime,name));

    // Let the OS select a free port; the backend reports its actual bound port.
    // The CLI expects a configured port, so obtain one from the fixture helper.
    const {freePort}=require('./fixture-utils.cjs');
    const port=await freePort();
    const child=spawn(process.execPath,[path.join(runtime,'management-server.cjs'),
        '--dist',dist,'--port',String(port),'--editor-origin',EDITOR_ORIGIN],{
        stdio:['ignore','pipe','pipe','ipc'],windowsHide:true
    });
    const stdout=[],stderr=[];
    child.stdout.on('data',part=>stdout.push(String(part)));
    child.stderr.on('data',part=>stderr.push(String(part)));
    const closed=new Promise(resolve=>{
        child.once('error',error=>resolve({error}));
        child.once('close',(code,signal)=>resolve({code,signal}));
    });
    scope.defer(async()=>{
        if(child.connected)child.send({type:'manager-shutdown'},()=>{});
        let timer;
        const exit=await Promise.race([closed,new Promise(resolve=>{
            timer=setTimeout(()=>resolve(null),10000);
        })]);
        clearTimeout(timer);
        if(!exit){child.kill();throw Error('Deployed Manager did not stop after IPC shutdown');}
        assert.equal(exit.code,0,stderr.join('')||JSON.stringify(exit));
    });

    const base=`http://127.0.0.1:${port}`;
    const cap=await waitForReady(base,child,stderr);
    const capabilities=await cap.json();
    assert.equal(capabilities.api_version,1);
    assert.equal(capabilities.native_service,1);
    assert.equal(capabilities.native_authorization,'interactive-v4');
    assert.equal((await fetch(base+'/index.html')).status,404,
        'Independent management backend must not serve Editor assets');

    const readCatalog=async()=>{
        const response=await fetch(base+'/api/plugins',{headers:{Origin:EDITOR_ORIGIN}});
        assert.equal(response.status,200);
        return response.json();
    };
    const write=async(method,url,value)=>fetch(base+'/api/plugins/'+url,{
        method,headers:{Origin:EDITOR_ORIGIN,'Content-Type':'application/json',
            'X-SuperSplat-Plugin-Manager':'1'},body:JSON.stringify(value)
    });
    assert.equal((await readCatalog()).plugins.length,0);
    const installed=await write('POST','install',pluginPackage());
    assert.equal(installed.status,201,await installed.text());
    const catalog=await readCatalog();
    assert.equal(catalog.plugins.length,1);
    const record=catalog.plugins[0];
    assert.equal(record.id,'portable-smoke');
    assert.ok(record.folder && !/[\\/]/.test(record.folder),'Unexpected plugin folder');
    assert.match(await fs.readFile(path.join(plugins,record.folder,'index.js'),'utf8'),/activate/);

    const updated=structuredClone(catalog);
    updated.plugins[0].enabled=true;
    updated.plugins[0].settings={test_flag:true};
    const saved=await write('PUT','config',{catalog:updated,expected_catalog:catalog});
    assert.equal(saved.status,200,await saved.text());
    const afterSave=await readCatalog();
    assert.equal(afterSave.plugins[0].enabled,true);
    assert.deepEqual(afterSave.plugins[0].settings,{test_flag:true});
    const removed=await write('DELETE','portable-smoke',{expected_catalog:afterSave});
    assert.equal(removed.status,200,await removed.text());
    assert.equal((await readCatalog()).plugins.length,0);
});

test('C-P02: deployed TypeScript loader resolves Editor-local package',async t=>{
    const tmp=await fs.mkdtemp(path.join(os.tmpdir(),'spm-typescript-local-'));
    const scope=fixtureScope(t,tmp);
    const source=path.join(tmp,'supersplat');
    const runtime=path.join(source,'dist','runtime');
    const typescript=path.join(source,'node_modules','typescript');
    await fs.mkdir(runtime,{recursive:true});
    await fs.mkdir(typescript,{recursive:true});
    await fs.copyFile(path.join(manager,'typescript-loader.cjs'),path.join(runtime,'typescript-loader.cjs'));
    await fs.writeFile(path.join(typescript,'index.js'),
        'module.exports={createSourceFile(){return "editor-local";}};\n');
    const loader=require('node:module').createRequire(path.join(runtime,'check.cjs'));
    const adapter=loader('./typescript-loader.cjs');
    assert.equal(adapter.typeScriptFrom(source).createSourceFile(),'editor-local');
});
