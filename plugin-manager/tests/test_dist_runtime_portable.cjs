'use strict';
const {removeFixture,fixtureScope,listen,closeServer,closeBackend,freePort}=require('./fixture-utils.cjs');
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const {spawn}=require('node:child_process');
const http=require('node:http');
const root=path.resolve(__dirname,'../..');
const manager=path.join(root,'plugin-manager');

async function eventually(url,child){
    for(let i=0;i<100;i++){
        if(child.exitCode!==null || child.signalCode!==null)throw Error(`backend exited ${child.exitCode}`);
        try{return await fetch(url);}catch{await new Promise(r=>setTimeout(r,30));}
    }
    throw Error('backend did not start');
}
test('C-P01: only backend files under dist/runtime work without source checkout',async t=>{
    const tmp=await fs.mkdtemp(path.join(os.tmpdir(),'spm-final-dist-'));
    const scope=fixtureScope(t,tmp);
    const dist=path.join(tmp,'supersplat','dist');const runtime=path.join(dist,'runtime');
    await fs.mkdir(path.join(dist,'plugins'),{recursive:true});
    await fs.mkdir(runtime);
    await fs.writeFile(path.join(dist,'plugins','manifest.json'),JSON.stringify({schema_version:1,plugins:[]}));
    await fs.writeFile(path.join(runtime,'package.json'),'\u007b"type":"module","private":true\u007d');
    for(const name of ['management-server.cjs','management-core.cjs','custom-editor.js','plugin-compat.cjs','typescript-loader.cjs','native-process.cjs']){
        await fs.copyFile(path.join(manager,name),path.join(runtime,name));
    }
    const port=await freePort();
    const args=[path.join(runtime,'management-server.cjs'),'--dist',dist,'--port',String(port),
        '--editor-origin','http://127.0.0.1:3013'];
    const child=spawn(process.execPath,args,{stdio:['ignore','pipe','pipe','ipc'],windowsHide:true});
    const stderr=[];child.stderr.on('data',c=>stderr.push(String(c)));child.stdout.resume();
    const closed=new Promise(resolve=>{child.once('error',error=>resolve({error}));child.once('close',(code,signal)=>resolve({code,signal}));});
    scope.defer(async()=>{
        if(child.connected)child.send({type:'manager-shutdown'},()=>{});
        let timer;const result=await Promise.race([closed,new Promise(resolve=>{timer=setTimeout(()=>resolve(null),10000);})]);clearTimeout(timer);
        if(!result){child.kill();throw Error('Fixture Manager did not complete IPC shutdown');}
        assert.equal(result.code,0,stderr.join('')||JSON.stringify(result));
    });
    const url=`http://127.0.0.1:${port}`;
    const response=await eventually(url+'/api/plugins/capabilities',child);assert.equal(response.status,200,stderr.join(''));assert.equal((await response.json()).native_authorization,'interactive-v4');
    assert.equal((await fetch(url+'/index.html')).status,404);
    const cat=(await (await fetch(url+'/api/plugins',{headers:{Origin:'http://127.0.0.1:3013'}})).json());
    assert.equal(cat.plugins.length,0);
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(runtime,'.supersplat-native-approvals.json'),'utf8')),{schema_version:2,approvals:[]});
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(dist,'plugins','native-approvals.json'),'utf8')),{schema_version:2,plugins:[]});
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(dist,'plugins','manifest.json'),'utf8')),{schema_version:1,plugins:[]});
});
test('C-P02: deployment adds backend code only and root scripts use original environment',async()=>{
    const launch=await fs.readFile(path.join(root,'editor_services.mjs'),'utf8');
    const deploy=await fs.readFile(path.join(root,'deploy_runtime.ps1'),'utf8');
    const maintenance=await fs.readFile(path.join(root,'maintain_editor.ps1'),'utf8');
    const bat=await fs.readFile(path.join(root,'maintain_editor.bat'),'utf8');
    const run=await fs.readFile(path.join(root,'run_supersplatEditor_p3013.bat'),'utf8');
    const stop=await fs.readFile(path.join(root,'stop_supersplatEditor_p3013.bat'),'utf8');
    assert.match(launch,/const source = path.join\(root, 'supersplat'\)/);
    assert.match(launch,/const dist = path.join\(source, 'dist'\)/);
    assert.match(launch,/const runtime = path.join\(dist, 'runtime'\)/);
    assert.match(launch,/path.join\(source, 'node_modules', 'serve'\)/);
    assert.match(launch,/path.join\(root, 'logs', 'run_logs'\)/);
    assert.match(launch,/spawnLogged\(\[serveCli, 'dist', '-C'/);
    assert.match(launch,/pkg.scripts\?\.serve !== 'serve dist -C'/);
    assert.doesNotMatch(launch,/serveStatic|dist.node_modules/);
    assert.match(deploy,/\$Dest = Join-Path \$Dist 'runtime'/);
    assert.match(deploy,/\$BackendFiles = @\('management-server\.cjs'/);
    assert.match(deploy,/\$ServePkg = Join-Path \$Source 'node_modules\\serve\\package.json'/);
    assert.doesNotMatch(deploy,/& \$Npm|Copy-Item.*node_modules|Get-FileHash|runtime_templates/);
    assert.match(deploy,/Legacy\/unknown item under dist/);
    assert.match(deploy,/Unrecognized file under dist\/runtime/);
    assert.match(maintenance,/function AssertCleanNativeNamespaces/);
    assert.match(maintenance,/AssertCleanNativeNamespaces\s+RestorePluginStore/);
    assert.match(maintenance,/function RestoreRuntime/);
    assert.match(maintenance,/function RestoreFailedBuild/);
    assert.match(maintenance,/runtime_deploy/);
    assert.match(maintenance,/NOT_APPLICABLE_SAME_ORIGIN/);
    assert.doesNotMatch(bat,/"%ROOT%deploy_runtime\.ps1"/);
    assert.match(run, /%ROOT%editor_services\.mjs/);
    assert.match(run, /node "%HELPER%" start "%EDITOR_PORT%" "%MANAGEMENT_PORT%"/);
    assert.match(stop, /%ROOT%editor_services\.mjs/);
    assert.match(stop, /node "%HELPER%" stop/);
    for(const f of ['editor_services.mjs','run_supersplatEditor_p3013.bat','stop_supersplatEditor_p3013.bat']){
        assert.ok(await fs.stat(path.join(root,f)));
    }
});
test('C-P03: deployed runtime resolves TypeScript from supersplat/node_modules',async t=>{
    const tmp=await fs.mkdtemp(path.join(os.tmpdir(),'spm-final-env-'));
    t.after(()=>removeFixture(tmp));
    const source=path.join(tmp,'supersplat');
    const runtime=path.join(source,'dist','runtime');
    const modulePath=path.join(source,'node_modules','typescript');
    await fs.mkdir(runtime,{recursive:true});
    await fs.mkdir(modulePath,{recursive:true});
    await fs.writeFile(path.join(modulePath,'index.js'),'module.exports={createSourceFile(){return true}};\n');
    await fs.copyFile(path.join(manager,'typescript-loader.cjs'),path.join(runtime,'typescript-loader.cjs'));
    await fs.writeFile(path.join(runtime,'check.cjs'),`const assert=require('node:assert/strict');const l=require('./typescript-loader.cjs');assert.ok(l.typeScriptFrom(${JSON.stringify(source)}).createSourceFile);`);
    const c=spawn(process.execPath,[path.join(runtime,'check.cjs')],{stdio:['ignore','pipe','pipe']});
    const errs=[];c.stderr.on('data',b=>errs.push(String(b)));
    assert.equal(await new Promise((resolve,reject)=>{c.on('error',reject);c.on('exit',resolve);}),0,errs.join(''));
});
test('C-P04: startup scripts must remain outside dist and backend process is explicit',async()=>{
    const ps=await fs.readFile(path.join(root,'editor_services.mjs'),'utf8');
    assert.match(ps,/path.join\(runtime,'management-server\.cjs'\)/);
    assert.match(ps,/'--dist', dist/);
    assert.match(ps,/'--no-port-switching'/);
    assert.match(ps,/terminateOwned\(backend,/);
    assert.match(ps,/terminateOwned\(staticChild,/);
    assert.match(ps,/assertListenerOwned\(editorPort, staticChild\)/);
    assert.match(ps,/assertListenerOwned\(managementPort, backend\)/);
    assert.match(ps,/stateFile = path.join\(root, '\.editor-services\.json'\)/);
    assert.match(ps,/supervisorStatus\(s\)/);
    assert.match(ps,/awaitPortsFree\(editorPort, managementPort\)/);
    assert.doesNotMatch(ps,/process\.kill\(/);
});

test('C-P05: v1.12 maintenance gates and runtime port handoff (source assertions)',async()=>{
    const maintenance=await fs.readFile(path.join(root,'maintain_editor.ps1'),'utf8');
    const launch=await fs.readFile(path.join(root,'editor_services.mjs'),'utf8');
    const deploy=await fs.readFile(path.join(root,'deploy_runtime.ps1'),'utf8');
    assert.match(maintenance,/\[ValidateRange\(1024,65535\)\]\[int\]\$EditorPort = 3013/);
    assert.match(maintenance,/\$DeployedManagementPort = Get-ManagementPortFromHtml \$DeployedHtml/);
    assert.match(maintenance,/-EditorPort ' \+ \$EditorPort \+ ' -ManagementPort ' \+ \$DeployedManagementPort/);
    assert.doesNotMatch(maintenance,/-EditorPort 3013 -ManagementPort 3014/);
    assert.match(maintenance,/Assert-MaintenancePortsIdle\s+Require/);
    assert.match(maintenance,/RetireLegacyNativeApproval/);
    assert.match(maintenance,/legacy-native-approvals\.json/);
    assert.match(maintenance,/Native approval preservation failed/);
    assert.match(deploy,/Native approval preservation failed/);
    assert.match(deploy,/initializeApprovalState/);
    assert.match(maintenance,/Require \(\$Changes.Count -eq 0\)/);
    assert.match(maintenance,/\$ManagementCore, \$ManagementServer, \$NativeProcess/);
    assert.match(deploy,/\$BackendFiles = @\([^)]*'native-process\.cjs'/s);
    assert.match(launch,/caps.api_version === 1 && caps.native_service === 1/);
    assert.match(launch,/caps.native_authorization === 'interactive-v4'/);
    assert.match(launch,/await managementReady\(managementPort\)/);
    // Windows must shut down Manager via IPC, not OS-level process.kill().
    // Manager logging is piped to supervisor-owned files; retain the IPC channel.
    assert.match(launch,/name === 'management' \? \['ignore', 'pipe', 'pipe', 'ipc'\] : \['ignore', out, err\]/);
    assert.match(launch,/input\.pipe\(output\)/);
    assert.match(launch,/child.send\(\{type:'manager-shutdown'\}/);
    assert.match(launch,/runtime\/native-process\.cjs/);
});

// Isolated upstream CLI fixture: verifies argv/cwd, real deployed Manager,
// supervisor ownership and shutdown without requiring an Editor checkout.
const execFile=require('node:util').promisify(require('node:child_process').execFile);
async function launcherFixture(t){
    const tmp=await fs.mkdtemp(path.join(os.tmpdir(),'spm launch '));
    const source=path.join(tmp,'supersplat'),dist=path.join(source,'dist'),runtime=path.join(dist,'runtime');
    const serve=path.join(source,'node_modules','serve'),ts=path.join(source,'node_modules','typescript');
    const ep=await freePort();let mp=await freePort();while(mp===ep)mp=await freePort();
    const launcher=path.join(tmp,'editor_services.mjs');
    const run=(...args)=>execFile(process.execPath,[launcher,...args.map(String)],{cwd:tmp,timeout:35000,windowsHide:true});
    const scope=fixtureScope(t,tmp);
    scope.defer(async()=>{
        // Preserve state and service logs if controlled shutdown fails.
        if(await fs.stat(launcher).then(()=>true,e=>{if(e.code==='ENOENT')return false;throw e;}))await run('stop');
    });
    for(const dir of [runtime,path.join(dist,'plugins'),serve,ts])await fs.mkdir(dir,{recursive:true});
    await fs.copyFile(path.join(root,'editor_services.mjs'),launcher);
    for(const name of ['management-server.cjs','management-core.cjs','custom-editor.js','plugin-compat.cjs','typescript-loader.cjs','native-process.cjs'])await fs.copyFile(path.join(manager,name),path.join(runtime,name));
    await fs.copyFile(path.join(runtime,'custom-editor.js'),path.join(dist,'custom-editor.js'));
    await fs.writeFile(path.join(runtime,'package.json'),JSON.stringify({type:'module',private:true}));
    await fs.writeFile(path.join(dist,'plugins','manifest.json'),JSON.stringify({schema_version:1,plugins:[]}));
    await fs.writeFile(path.join(source,'package.json'),JSON.stringify({scripts:{serve:'serve dist -C'}}));
    await fs.writeFile(path.join(serve,'package.json'),JSON.stringify({bin:{serve:'cli.cjs'}}));
    await fs.writeFile(path.join(ts,'package.json'),JSON.stringify({name:'typescript',version:'0.0.0-test'}));
    await fs.writeFile(path.join(serve,'cli.cjs'),`const assert=require('node:assert/strict'),fs=require('node:fs'),http=require('node:http'),path=require('node:path');
const args=process.argv.slice(2);assert.deepEqual(args.slice(0,3),['dist','-C','-l']);assert.equal(args[4],'--no-port-switching');assert.equal(path.basename(process.cwd()),'supersplat');
const port=Number(args[3].split(':').at(-1));http.createServer((q,r)=>r.end(fs.readFileSync('dist/index.html'))).listen(port,'127.0.0.1');`);
    const html=`<html><script type="module" src="./custom-editor.js" data-management-origin="http://127.0.0.1:${mp}"></script></html>`;
    await fs.writeFile(path.join(dist,'index.html'),html);
    return {tmp,dist,runtime,run,ep,mp,html,state:path.join(tmp,'.editor-services.json')};
}
test('C-P06: supervisor custom ports, real management backend, duplicate rejection and native cleanup',{timeout:65000},async t=>{
    const x=await launcherFixture(t),editor=`http://127.0.0.1:${x.ep}`,backend=`http://127.0.0.1:${x.mp}`;
    await x.run('start',x.ep,x.mp);
    const state=JSON.parse(await fs.readFile(x.state,'utf8'));
    assert.equal(state.schema,2);assert.equal(state.editorPort,x.ep);assert.equal(state.managementPort,x.mp);
    assert.equal(await(await fetch(editor)).text(),x.html);
    const caps=await(await fetch(backend+'/api/plugins/capabilities')).json();
    assert.equal(caps.native_service,1);assert.equal(caps.native_authorization,'interactive-v4');
    await assert.rejects(x.run('start',x.ep,x.mp),/already running/);
    const nativePort=await freePort(),id='launcher-native';
    const meta={id,name:id,classification:'Test',version:'1.0.0',author:'test',date:'2026-11-18',description:'Native lifecycle fixture',entry:'./index.js',native_service:{entry:'./native/service.mjs'}};
    const nativeCode=`import http from 'node:http';const s=http.createServer((q,r)=>r.end(String(process.pid)));const stop=()=>s.close(()=>{if(process.connected)process.disconnect()});process.on('disconnect',stop);process.on('message',m=>{if(m?.type==='native-stop')stop()});s.listen(${nativePort},'127.0.0.1',()=>process.send({type:'native-ready'}));`;
    const files=Object.entries({'plugin.json':JSON.stringify(meta),'index.js':'export function activate(){return {open(){},deactivate(){}}}','native/service.mjs':nativeCode}).map(([path,data])=>({path,data_base64:Buffer.from(data).toString('base64')}));
    const write=(suffix,body)=>fetch(backend+'/api/plugins/'+suffix,{method:'POST',headers:{Origin:editor,'Content-Type':'application/json','X-SuperSplat-Plugin-Manager':'1'},body:JSON.stringify(body)});
    const installed=await write('install',{files});assert.equal(installed.status,201,await installed.clone().text());
    const rec=(await installed.json()).plugin;
    await require('../native-process.cjs').authorize(x.dist,id);
    const started=await write(`native/${id}/start`,{folder:rec.folder});assert.equal(started.status,200,await started.clone().text());
    const nativeUrl=`http://127.0.0.1:${nativePort}`;assert.equal((await fetch(nativeUrl)).status,200);
    await x.run('stop');
    // The Manager itself must complete native cleanup before the supervisor
    // accepts a clean exit; test actual log evidence, not only closed TCP ports.
    const managementLog=await fs.readFile(path.join(state.logs,'management.stdout.log'),'utf8');
    assert.match(managementLog,/\[Native shutdown\] All tracked native services verified stopped/);
    await assert.rejects(fs.stat(x.state),{code:'ENOENT'});
    await assert.rejects(fetch(editor));await assert.rejects(fetch(backend));
    let stopped=false;
    for(let i=0;i<100;i++){try{await fetch(nativeUrl,{signal:AbortSignal.timeout(500)});}catch{stopped=true;break;}await new Promise(r=>setTimeout(r,50));}
    assert.ok(stopped,'Native service should stop when Manager exits');
    assert.equal(await fs.readFile(path.join(x.dist,'index.html'),'utf8'),x.html);
});
test('C-P07: reject incorrect hook, missing native module and occupied port',{timeout:30000},async t=>{
    const x=await launcherFixture(t);
    let wrong=await freePort();while(wrong===x.mp||wrong===x.ep)wrong=await freePort();
    await assert.rejects(x.run('start',x.ep,wrong),/Editor hook must target/);
    const mod=path.join(x.runtime,'native-process.cjs');await fs.rename(mod,mod+'.bak');
    await assert.rejects(x.run('start',x.ep,x.mp),/Missing supersplat\/dist\/runtime\/native-process/);
    await fs.rename(mod+'.bak',mod);
    const occupant=http.createServer((q,r)=>r.end('unrelated'));
    await new Promise((resolve,reject)=>{occupant.once('error',reject);occupant.listen(x.ep,'127.0.0.1',resolve);});
    try{await assert.rejects(x.run('start',x.ep,x.mp),/unavailable/);assert.equal(await(await fetch(`http://127.0.0.1:${x.ep}`)).text(),'unrelated');}
    finally{await new Promise(r=>occupant.close(r));}
    await assert.rejects(fs.stat(x.state),{code:'ENOENT'});
    assert.equal(await fs.readFile(path.join(x.dist,'index.html'),'utf8'),x.html);
});

// Exercise both Manager log streams through the actual replacement launcher.
// Only the temporary fixture's copied server is instrumented.
test('C-P08: piped Manager logs preserve both streams through controlled shutdown',{timeout:35000},async t=>{
    const x=await launcherFixture(t);
    const out='PIPE-STDOUT:'+ 'S'.repeat(512*1024)+'\n';
    const err='PIPE-STDERR:'+ 'E'.repeat(512*1024)+'\n';
    await fs.appendFile(path.join(x.runtime,'management-server.cjs'),`\nprocess.stdout.write(${JSON.stringify(out)});process.stderr.write(${JSON.stringify(err)});\nprocess.once('beforeExit',()=>{process.stdout.write('PIPE-STDOUT-END\\n');process.stderr.write('PIPE-STDERR-END\\n');});\n`);
    await x.run('start',x.ep,x.mp);
    const state=JSON.parse(await fs.readFile(x.state,'utf8'));
    await x.run('stop');
    const stdout=await fs.readFile(path.join(state.logs,'management.stdout.log'),'utf8');
    const stderr=await fs.readFile(path.join(state.logs,'management.stderr.log'),'utf8');
    assert.ok(stdout.includes(out),'Complete Manager stdout payload must reach the log');
    assert.ok(stderr.includes(err),'Complete Manager stderr payload must reach the log');
    assert.match(stdout,/PIPE-STDOUT-END/);
    assert.match(stderr,/PIPE-STDERR-END/);
    assert.match(stdout,/\[Native shutdown\] All tracked native services verified stopped/);
    await assert.rejects(fs.stat(x.state),{code:'ENOENT'});
    await assert.rejects(fetch(`http://127.0.0.1:${x.ep}`));
    await assert.rejects(fetch(`http://127.0.0.1:${x.mp}`));
});
