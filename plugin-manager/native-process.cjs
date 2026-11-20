'use strict';
/** Optional generic native-service lifecycle. Local consent is obtained outside the browser; HTTP cannot grant approval. */
const fs=require('node:fs/promises');
const net=require('node:net');
const path=require('node:path');
const {createHash,randomUUID}=require('node:crypto');
const {fork,execFile}=require('node:child_process');
const {promisify}=require('node:util');
const {pathToFileURL}=require('node:url');
function requireValue(ok,message,status=400){if(!ok)throw Object.assign(Error(message),{status});}
const approvalPath=dist=>path.join(dist,'runtime','.supersplat-native-approvals.json');
const statusPath=dist=>path.join(dist,'plugins','native-approvals.json');
async function writeJson(file,value){
    const tmp=file+'.'+randomUUID()+'.tmp';
    try{await fs.writeFile(tmp,JSON.stringify(value,null,2)+'\n',{flag:'wx',mode:0o600});await fs.rename(tmp,file);}finally{await fs.rm(tmp,{force:true});}
}
const validPort=port=>Number.isInteger(port)&&port>=1024&&port<=65535;
const portError=(message,port)=>Object.assign(Error(message),{status:409,code:'PORT_IN_USE',port});
const toRecord=({id,folder,sha256,port})=>({id,folder,sha256,...(port===undefined?{}:{port})});
async function publishStatus(dist,approvals){
    // Read-only discovery projection; never consulted as execution authority.
    await writeJson(statusPath(dist),{schema_version:2,plugins:approvals.map(({id,folder,port})=>({id,folder,approval_recorded:true,...(port===undefined?{}:{port})}))});
}
async function readApprovals(dist){
    let data;
    try{data=JSON.parse(await fs.readFile(approvalPath(dist),'utf8'));}catch(e){if(e.code==='ENOENT')return [];throw e;}
    requireValue([1,2].includes(data?.schema_version)&&Array.isArray(data.approvals),'Invalid local native approval file',403);
    const ids=new Set(), ports=new Set();
    for(const p of data.approvals){
        requireValue(p&&typeof p.id==='string'&&typeof p.folder==='string'&&/^[a-f0-9]{64}$/.test(p.sha256)&&
            (p.port===undefined||validPort(p.port)),'Invalid local native approval record',403);
        requireValue(!ids.has(p.id),'Duplicate native approval identity',403);ids.add(p.id);
        if(p.port!==undefined){requireValue(!ports.has(p.port),'Duplicate approved native ports',403);ports.add(p.port);}
    }
    return data.approvals.map(toRecord);
}
async function commitApprovals(dist,approvals){
    // A failed projection update must not leave an undiscoverable new assignment.
    const old=await readApprovals(dist);
    await writeJson(approvalPath(dist),{schema_version:2,approvals});
    try{await publishStatus(dist,approvals);}
    catch(error){
        try{await writeJson(approvalPath(dist),{schema_version:2,approvals:old});await publishStatus(dist,old);}
        catch(rollback){error.message+=`; registry rollback failed: ${rollback.message}`;}
        throw error;
    }
}
async function syncStatus(dist){
    const file=approvalPath(dist);
    await fs.mkdir(path.dirname(file),{recursive:true});
    try{await fs.access(file);}catch(e){
        if(e.code!=='ENOENT')throw e;
        await writeJson(file,{schema_version:2,approvals:[]});
    }
    const approvals=await readApprovals(dist);
    // On initial deployment, import schema v1 without granting any TCP port.
    const stored=JSON.parse(await fs.readFile(file,'utf8'));
    if(stored.schema_version===1){
        // Preserve the exact old authority for an explicit v1.12 rollback.
        try{await fs.copyFile(file,file+'.schema-v1.backup',fs.constants.COPYFILE_EXCL);}
        catch(error){if(error.code!=='EEXIST')throw error;}
        await writeJson(file,{schema_version:2,approvals});
    }
    await publishStatus(dist,approvals);
}
async function revoke(dist,record){
    const approvals=await readApprovals(dist),next=approvals.filter(p=>p.id!==record.id||p.folder!==record.folder);
    if(next.length!==approvals.length)await commitApprovals(dist,next);
}
async function saveApproval(dist,record,identity,port){
    const approvals=(await readApprovals(dist)).filter(p=>p.id!==record.id);
    if(port!==undefined){
        requireValue(validPort(port),'Invalid approved native port');
        if(approvals.some(p=>p.port===port))throw portError(`Port ${port} is assigned to another plugin`,port);
    }
    approvals.push(toRecord({id:record.id,folder:record.folder,sha256:identity.sha256,port}));
    await fs.mkdir(path.dirname(approvalPath(dist)),{recursive:true});
    await commitApprovals(dist,approvals);
    return {id:record.id,folder:record.folder,entry:identity.metadata.native_service.entry,sha256:identity.sha256,...(port===undefined?{}:{port})};
}
function isManaged(identity){return identity.metadata.native_service.port?.required===true;}
// Non-intrusive bind inspection: do not open an unsolicited TCP connection to
// a plugin's service. Immediate socket destruction after connect can deliver
// ECONNRESET to otherwise healthy native listeners on Windows (Node 26).
// A failed bind is combined with the owned child's native-ready IPC signal;
// bind failure alone is neither proof of listener PID nor an HTTP health check.
async function canBind(port){
    return new Promise((resolve,reject)=>{
        const probe=net.createServer();
        probe.once('error',error=>{
            if(error.code==='EADDRINUSE'||error.code==='EACCES')resolve(false);
            else reject(error);
        });
        probe.listen(port,'127.0.0.1',()=>probe.close(()=>resolve(true)));
    });
}
async function waitPortReleased(port,{tries=24,delay=100}={}){
    for(let i=0;i<tries;i++){
        if(await canBind(port))return true;
        if(i+1<tries)await new Promise(resolve=>setTimeout(resolve,delay));
    }
    throw Object.assign(Error(`Native port ${port} remains unavailable after the owned child exited; refusing to terminate an unknown listener`),
        {status:409,code:'NATIVE_PORT_NOT_RELEASED',port});
}
async function assertPortAvailable({port,id,dist,editorOrigin,getManagementPort,excludeOwn=false}){
    requireValue(validPort(port),'Native port must be an integer from 1024 to 65535');
    const editorPort=Number(new URL(editorOrigin).port),managerPort=Number(getManagementPort());
    if(port===editorPort||port===managerPort)throw portError(`Port ${port} is reserved for the Editor or Manager`,port);
    const existing=await readApprovals(dist);
    if(existing.some(p=>p.port===port&&p.id!==id))throw portError(`Port ${port} is assigned to another native plugin`,port);
    if(excludeOwn)return;
    await new Promise((resolve,reject)=>{
        const server=net.createServer();
        server.once('error',error=>reject(error.code==='EADDRINUSE'
            ? portError(`Port ${port} is occupied by another listener`,port)
            : Object.assign(Error(`Port ${port} could not be checked: ${error.message}`),{status:409,code:'NATIVE_PORT_UNAVAILABLE',port})));
        server.listen(port,'127.0.0.1',()=>server.close(resolve));
    });
}
async function nativeEntry(dist,record){
    const root=path.resolve(dist,'plugins');
    requireValue(/^[a-z0-9]+(?:-[a-z0-9]+)*_\d{8}T\d{9}Z$/.test(record.folder)&&record.folder.startsWith(record.id+'_'),'Unsafe installed release');
    const dir=path.join(root,record.folder);
    requireValue((await fs.realpath(dir))===path.join(await fs.realpath(root),record.folder),'Native release must not be a link',403);
    const {validateMetadata}=await import(pathToFileURL(path.join(__dirname,'custom-editor.js')).href);
    const metadata=validateMetadata(JSON.parse(await fs.readFile(path.join(dir,'plugin.json'),'utf8')),record.id);
    requireValue(metadata.native_service?.entry==='./native/service.mjs','Plugin does not declare a native service',403);
    const entry=path.join(dir,'native','service.mjs');
    const nativeDir=await fs.lstat(path.dirname(entry)).catch(()=>null);
    const stat=await fs.lstat(entry).catch(()=>null);
    requireValue(nativeDir?.isDirectory()&&!nativeDir.isSymbolicLink()&&stat?.isFile()&&!stat.isSymbolicLink()&&stat.nlink===1,'Native entry is missing or invalid',403);
    return {dir,entry,metadata};
}
async function releaseIdentity(dist,record){
    const {dir,entry,metadata}=await nativeEntry(dist,record);
    const hash=createHash('sha256');let count=0,bytes=0;
    async function walk(folder,prefix=''){
        for(const name of (await fs.readdir(folder)).sort()){
            const full=path.join(folder,name),rel=prefix+name,stat=await fs.lstat(full);
            requireValue(!stat.isSymbolicLink(),'Native package contains a symbolic link',403);
            if(stat.isDirectory()){await walk(full,rel+'/');continue;}
            requireValue(stat.isFile()&&stat.nlink===1,'Native package contains a nonregular or linked file',403);
            // Generated advisory audit is not part of the installed package contents.
            if(rel==='audit.json')continue;
            requireValue(++count<=101&&(bytes+=stat.size)<=51*1024*1024,'Native package exceeds installed package limits');
            const data=await fs.readFile(full);
            hash.update(JSON.stringify([rel,data.length])+'\n').update(data);
        }
    }
    await walk(dir);
    return {dir,entry,sha256:hash.digest('hex'),metadata};
}
async function installedRecord(dist,id){
    requireValue(/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id),'Invalid plugin ID');
    const {validateCatalog}=await import(pathToFileURL(path.join(__dirname,'custom-editor.js')).href);
    const catalog=validateCatalog(JSON.parse(await fs.readFile(path.join(dist,'plugins','manifest.json'),'utf8')));
    const record=catalog.plugins.find(p=>p.id===id);requireValue(record,'Plugin is not installed');
    return record;
}
async function authorize(dist,id,{port,editorOrigin='http://127.0.0.1:3013',getManagementPort=()=>3014}={}){
    const record=await installedRecord(dist,id),identity=await releaseIdentity(dist,record);
    if(isManaged(identity)){
        requireValue(validPort(port),'Port-managed native authorization requires --port <1024..65535>');
        await assertPortAvailable({port,id,dist,editorOrigin,getManagementPort});
    }else requireValue(port===undefined,'Portless native service cannot accept a port');
    return saveApproval(dist,record,identity,port);
}
// A short-lived Windows desktop dialog, not a browser prompt or a persistent service.
// The script is fixed; package metadata is passed as text in environment variables.
// Cancel is the default, and closing the dialog / timeout / parent death never approves.
const consentScript=String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$parent = [System.Diagnostics.Process]::GetProcessById([int]$env:SPM_CONSENT_PARENT)
$form = New-Object System.Windows.Forms.Form
$form.Text = 'SuperSplat Plugin Manager - Native execution permission'
$form.StartPosition = 'CenterScreen'
$form.ClientSize = New-Object System.Drawing.Size(620, 390)
$form.FormBorderStyle = 'FixedDialog'
$form.MaximizeBox = $false
$form.MinimizeBox = $false
$form.TopMost = $true
$form.ShowInTaskbar = $true
$details = New-Object System.Windows.Forms.TextBox
$details.Multiline = $true
$details.ReadOnly = $true
$details.ScrollBars = 'Vertical'
$details.Location = New-Object System.Drawing.Point(16, 16)
$details.Size = New-Object System.Drawing.Size(588, 240)
$details.Text = 'Allow this installed plugin to execute native code with your Windows user privileges? Only allow code you trust. Permission is remembered for this exact release. Do not approve unexpected requests.' + [Environment]::NewLine + [Environment]::NewLine + $env:SPM_CONSENT_DETAILS
$form.Controls.Add($details)
$managed = $env:SPM_CONSENT_MANAGED -eq '1'
if ($managed) {
    $portLabel = New-Object System.Windows.Forms.Label
    $portLabel.Text = 'Authorized native TCP port (1024-65535):'
    $portLabel.Location = New-Object System.Drawing.Point(16, 270)
    $portLabel.AutoSize = $true
    $form.Controls.Add($portLabel)
    $portInput = New-Object System.Windows.Forms.TextBox
    $portInput.Location = New-Object System.Drawing.Point(275, 267)
    $portInput.Size = New-Object System.Drawing.Size(90, 24)
    $portInput.Text = $env:SPM_CONSENT_PORT
    $form.Controls.Add($portInput)
}
$allow = New-Object System.Windows.Forms.Button
$allow.Text = 'Allow execution'
$allow.Location = New-Object System.Drawing.Point(354, 335)
$allow.Size = New-Object System.Drawing.Size(124, 32)
$allow.DialogResult = [System.Windows.Forms.DialogResult]::None
$form.Controls.Add($allow)
$cancel = New-Object System.Windows.Forms.Button
$cancel.Text = 'Cancel'
$cancel.Location = New-Object System.Drawing.Point(488, 335)
$cancel.Size = New-Object System.Drawing.Size(116, 32)
$cancel.DialogResult = [System.Windows.Forms.DialogResult]::Cancel
$form.Controls.Add($cancel)
$form.CancelButton = $cancel
$form.AcceptButton = $cancel
$allow.Add_Click({
    if ($managed) {
        [int]$selected = 0
        if (-not [int]::TryParse($portInput.Text, [ref]$selected) -or $selected -lt 1024 -or $selected -gt 65535) {
            [System.Windows.Forms.MessageBox]::Show('Select an integer TCP port from 1024 to 65535.','Invalid port') | Out-Null
            return
        }
    }
    $form.DialogResult = [System.Windows.Forms.DialogResult]::Yes
    $form.Close()
})
$form.Add_Shown({
    $form.BringToFront()
    $form.Activate()
    $cancel.Select()
    [Console]::WriteLine('SPM_NATIVE_SHOWN')
    [Console]::Out.Flush()
})
$elapsed = [System.Diagnostics.Stopwatch]::StartNew()
$script:timedOut = $false
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 250
$timer.Add_Tick({ if ($parent.HasExited -or $elapsed.Elapsed.TotalSeconds -ge 60) { $script:timedOut = -not $parent.HasExited; $form.DialogResult = [System.Windows.Forms.DialogResult]::Cancel; $form.Close() } })
$timer.Start()
try { $result = $form.ShowDialog(); if ($parent.HasExited) { $result = [System.Windows.Forms.DialogResult]::Cancel } } finally { $timer.Stop(); $timer.Dispose(); $form.Dispose(); $parent.Dispose() }
if ($result -eq [System.Windows.Forms.DialogResult]::Yes) {
    if ($managed) { [Console]::WriteLine('SPM_NATIVE_PORT ' + [int]$portInput.Text) }
    [Console]::WriteLine('SPM_NATIVE_ALLOW'); exit 0
}
if ($script:timedOut) { exit 3 }
exit 2
`;
async function confirmNativeExecution({record,identity,signal,port,reason}){
    requireValue(process.platform==='win32','Native execution is not authorized for this installed release. Interactive approval requires a Windows desktop. For headless maintenance only, from supersplat run: node ./dist/runtime/native-process.cjs --authorize <installed-plugin-id>.',403);
    const executable=path.join(process.env.SystemRoot||'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
    const display=value=>String(value).replace(/[\x00-\x1f\x7f]/g,' ').slice(0,120);
    const details=[`Plugin ID: ${record.id}`,`Name: ${display(identity.metadata.name)}`,`Version: ${display(identity.metadata.version)}`,`Release: ${record.folder}`,`Entry: ${identity.metadata.native_service.entry}`,`SHA-256: ${identity.sha256}`,...(isManaged(identity)?[`Port requested: ${port??identity.metadata.native_service.port.preferred}`, ...(reason?[`Reason: ${reason}`]:[])]:[])].join('\r\n');
    try{
        console.info('[Native authorization] Requesting desktop consent:',record.id);
        const execution=promisify(execFile)(executable,['-NoProfile','-STA','-WindowStyle','Normal','-EncodedCommand',Buffer.from(consentScript.replace(/\r\n/g,'\n'),'utf16le').toString('base64')],{
            env:{...process.env,SPM_CONSENT_PARENT:String(process.pid),SPM_CONSENT_DETAILS:details,SPM_CONSENT_MANAGED:isManaged(identity)?'1':'0',SPM_CONSENT_PORT:String(port??identity.metadata.native_service.port?.preferred??'')},windowsHide:false,timeout:75000,signal
        });
        execution.child.stdout?.on('data',chunk=>{if(String(chunk).includes('SPM_NATIVE_SHOWN'))console.info('[Native authorization] Dialog shown:',record.id);});
        const {stdout}=await execution;
        requireValue(stdout.trim().split(/\r?\n/).at(-1)==='SPM_NATIVE_ALLOW','Native authorization dialog did not confirm consent',503);
        if(isManaged(identity)){
            const match=stdout.match(/^SPM_NATIVE_PORT (\d+)$/m);
            const selected=Number(match?.[1]);
            requireValue(validPort(selected),'Native authorization did not return a valid port',503);
            return {approved:true,port:selected};
        }
        return true;
    }catch(e){
        if(signal.aborted)throw signal.reason;
        if(e.code===2){console.info('[Native authorization] User cancelled:',record.id);return false;}
        if(e.code===3||e.killed){console.warn('[Native authorization] Dialog timed out:',record.id);throw Object.assign(Error('Native authorization timed out without confirmation. No service was started. Check the Windows desktop and management logs.'),{status:504});}
        console.warn('[Native authorization dialog]',record.id,e.code||e.status||'error',String(e.stderr||'').slice(0,2000));
        throw Object.assign(Error('Local native authorization dialog unavailable or timed out. Check the Windows desktop session and management logs.'),{status:503});
    }
}
function createNativeProcesses({dist,editorOrigin,startTimeout=12000,stopTimeout=5000,confirmNative=confirmNativeExecution,getManagementPort=()=>null}){
    const children=new Map(), observations=new Map(), usedPorts=new Map(), events=[];let eventSequence=0,closing=false,closeTask=null;const shutdown=new AbortController();
    const usedKey=(rec,port)=>`${rec.id}/${rec.folder}/${port}`;
    function snapshot(rec,child,port,listener=null){
        const result={id:rec.id,folder:rec.folder,state:child?.ready?'running':child?'starting':'stopped',
            ...(port===undefined?{}:{port})};
        if(port!==undefined)result.listener=listener??(child?.ready?'unverified':'stopped');
        return result;
    }
    function note(rec,port,state,detail){
        if(port===undefined)return;
        const previous=observations.get(rec.id);
        const current={id:rec.id,folder:rec.folder,port,listener:state,...(detail?{detail}:{})};
        observations.set(rec.id,current);
        if(!previous||previous.folder!==current.folder||previous.port!==port||previous.listener!==state){
            events.push({sequence:++eventSequence,id:rec.id,folder:rec.folder,port,listener:state});
            if(events.length>256)events.shift();
            console.log(`[Native listener] ${rec.id} port=${port} ${state}${detail?` (${detail})`:''}`);
        }
    }
    async function observe(rec,state){
        if(state?.port===undefined)return null;
        let outcome;
        try{outcome=await canBind(state.port)?'unreachable':'listening';}
        catch(error){outcome='unverified';note(rec,state.port,outcome,error.message);return outcome;}
        // A non-connecting bind check is paired with the Manager-owned child;
        // port occupancy alone never establishes process ownership.
        if(children.get(rec.id)!==state||!state.ready)return 'unverified';
        note(rec,state.port,outcome);
        return outcome;
    }
    async function stoppedListener(rec,port){
        if(port===undefined)return null;
        try{
            const state=await canBind(port)
                ?(usedPorts.has(usedKey(rec,port))?'released':'available'):'occupied';
            note(rec,port,state);
            return state;
        }catch(error){note(rec,port,'unverified',error.message);return 'unverified';}
    }
    async function status(rec){
        const state=children.get(rec.id),approval=(await readApprovals(dist)).find(p=>p.id===rec.id&&p.folder===rec.folder);
        const port=state?.port??approval?.port;
        const listener=state?.ready?await observe(rec,state):state?'starting':await stoppedListener(rec,port);
        return snapshot(rec,state,port,listener);
    }
    async function listenerSummary(){
        const approvals=await readApprovals(dist);
        const result=[];
        for(const approval of approvals){
            const state=children.get(approval.id),rec={id:approval.id,folder:approval.folder};
            const port=state?.folder===approval.folder?state.port:approval.port;
            const listener=state?.ready?await observe(rec,state):state?'starting':await stoppedListener(rec,port);
            result.push({...snapshot(rec,state?.folder===approval.folder?state:null,port,listener),
                ...(state?.folder===approval.folder&&state?.child?.pid?{pid:state.child.pid}:{})});
        }
        return {services:result,events:[...events]};
    }
    // Observation is passive; native port assignments and lifecycle are not inferred from TCP probes.
    const monitor=setInterval(()=>{
        for(const [id,state] of children){if(state.ready&&!state.monitoring){
            state.monitoring=true;
            void observe({id,folder:state.folder},state).finally(()=>{state.monitoring=false;});
        }}
    },1500);monitor.unref();
    async function stop(rec){
        const state=children.get(rec.id);
        if(!state){
            const result=await status(rec);
            if(result.port!==undefined && result.listener==='occupied' &&
               observations.get(rec.id)?.folder===rec.folder)
                throw Object.assign(Error(`Native port ${result.port} is still occupied; no owned child remains to terminate`),
                    {status:409,code:'NATIVE_PORT_NOT_RELEASED',port:result.port});
            return result;
        }
        if(state.folder!==rec.folder)throw Object.assign(Error('Native process release mismatch'),{status:409});
        const child=state.child;
        if(child.connected)try{child.send({type:'native-stop'},()=>{});}catch{}
        // Terminate only the child handle owned by this Manager; never kill by port/PID lookup.
        const gentle=setTimeout(()=>{if(child.exitCode===null&&child.signalCode===null)child.kill();},stopTimeout);
        const forced=setTimeout(()=>{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');},stopTimeout+2000);
        let hardTimer;
        try{
            await Promise.race([state.closed,new Promise((_,reject)=>{hardTimer=setTimeout(()=>reject(Object.assign(
                Error('Native child did not exit after controlled shutdown'),{status:409,code:'NATIVE_STOP_TIMEOUT'})),stopTimeout+5000);})]);
        }finally{clearTimeout(gentle);clearTimeout(forced);clearTimeout(hardTimer);}
        if(state.releaseCheck)await state.releaseCheck;
        return status(rec);
    }
    function normalizeConsent(value,identity,port){
        if(value===false||value==null)return null;
        if(!isManaged(identity))return value===true||value?.approved===true?{}:null;
        // The injected confirmNative hook supports explicit port responses; a boolean
        // success is only retained for isolated headless test fixtures.
        const selected=value===true?port:value?.approved===true?value.port:null;
        requireValue(validPort(selected),'Native port authorization did not return a selected port',403);
        return {port:selected};
    }
    async function launch(rec,identity,port,signal){
        // Arguments are computed from verified local approval, not the browser request.
        const args=['--editor-origin',editorOrigin,...(port===undefined?[]:['--port',String(port)])];
        const child=fork(identity.entry,args,{cwd:identity.dir,execArgv:[],stdio:['ignore','inherit','inherit','ipc'],windowsHide:true});
        const state={child,folder:rec.folder,sha256:identity.sha256,port,ready:false};children.set(rec.id,state);
        state.closed=new Promise(resolve=>child.once('close',()=>{
            if(children.get(rec.id)===state)children.delete(rec.id);
            if(state.port!==undefined&&state.ready){
                state.releaseCheck=waitPortReleased(state.port).then(()=>{
                    const used=usedPorts.get(usedKey(rec,state.port));if(used)used.released=true;
                    note(rec,state.port,'released');
                }).catch(error=>{note(rec,state.port,'occupied',error.message);throw error;});
                // An unexpected exit is also monitored, even when no stop() caller awaits.
                state.releaseCheck.catch(error=>console.error('[Native listener cleanup]',rec.id,error.message));
            }else if(state.port!==undefined)note(rec,state.port,'unverified');
            resolve();
        }));
        state.started=new Promise((resolve,reject)=>{
            const timer=setTimeout(()=>finish(Error('Native service readiness timed out')),startTimeout);
            function finish(err){clearTimeout(timer);signal.removeEventListener('abort',onAbort);child.off('message',onMessage);child.off('close',onClose);child.off('error',onError);if(err)reject(err);else{state.ready=true;resolve();}}
            const onMessage=msg=>{
                if(msg?.type==='native-start-error'&&msg.code==='PORT_IN_USE')return finish(portError(`Port ${port} is in use during native binding`,port));
                if(msg?.type==='native-ready'){
                    if(port!==undefined&&msg.port!==port)return finish(Object.assign(Error('Native service reported a different port'),{status:409,code:'NATIVE_PORT_MISMATCH'}));
                    finish();
                }
            };
            const onClose=()=>finish(Error('Native service exited before readiness; inspect management logs'));
            const onError=e=>finish(e);
            const onAbort=()=>finish(signal.reason);
            child.on('message',onMessage);child.once('close',onClose);child.once('error',onError);
            signal.addEventListener('abort',onAbort,{once:true});if(signal.aborted)onAbort();
        });
        child.on('error',e=>console.warn('[Native service]',rec.id,e.message));
        try{
            await state.started;
            // Check the loopback port cannot be rebound after native-ready IPC.
            // Do not connect to the service: a probe may reset its sockets on Windows.
            // The owned child handle and reported bound port remain the identity contract.
            if(children.get(rec.id)!==state||child.exitCode!==null||child.signalCode!==null)
                throw Object.assign(Error('Native service exited after readiness'),{status:409,code:'NATIVE_EARLY_EXIT'});
            if(port!==undefined&&await canBind(port))throw Object.assign(
                Error(`Native port ${port} is not bound after readiness`),
                {status:409,code:'NATIVE_LISTENER_UNREACHABLE',port});
            if(port!==undefined)usedPorts.set(usedKey(rec,port),{id:rec.id,folder:rec.folder,port,released:false});
            note(rec,port,'listening');
            return state;
        }
        catch(error){try{await stop(rec);}catch(cleanup){error.message+=`; child cleanup failed: ${cleanup.message}`;}throw error;}
    }
    async function start(rec,{signal:requestSignal,forceReassign=false}={}){
        const signal=requestSignal?AbortSignal.any([shutdown.signal,requestSignal]):shutdown.signal;
        function checkActive(){requireValue(!closing,'Management backend is shutting down',503);if(signal.aborted)throw signal.reason;}
        checkActive();
        let identity=await releaseIdentity(dist,rec);
        const managed=isManaged(identity);
        let approval=(await readApprovals(dist)).find(p=>p.id===rec.id&&p.folder===rec.folder&&p.sha256===identity.sha256);
        const existing=children.get(rec.id);
        if(existing){
            requireValue(existing.folder===rec.folder&&existing.sha256===identity.sha256,'Native service release changed; stop it before restarting',409);
            if(forceReassign)await stop(rec);
            else {await existing.started;return status(rec);}
        }
        // A legacy approval without port does not authorize an undeclared TCP assignment.
        let proposed=managed?approval?.port:undefined;
        let requiresConsent=!approval||(managed&&proposed===undefined)||forceReassign;
        let reason=forceReassign?'User requested a port change':null;
        for(let attempt=0;attempt<5;attempt++){
            checkActive();
            if(managed&&!requiresConsent){
                try{await assertPortAvailable({port:proposed,id:rec.id,dist,editorOrigin,getManagementPort});}
                catch(error){if(error.code!=='PORT_IN_USE')throw error;requiresConsent=true;reason=error.message;}
            }
            if(requiresConsent){
                const value=normalizeConsent(await confirmNative({record:rec,identity,signal,port:proposed??identity.metadata.native_service.port?.preferred,reason}),identity,proposed??identity.metadata.native_service.port?.preferred);
                checkActive();
                if(!value)throw Object.assign(Error('Native execution authorization cancelled.'),{status:403,code:'NATIVE_AUTH_CANCELLED'});
                // Recheck the exact installed release after the desktop dialog.
                const current=await installedRecord(dist,rec.id);
                requireValue(current.folder===rec.folder,'Installed native release changed during authorization; retry',409);
                const checked=await releaseIdentity(dist,current);
                requireValue(checked.sha256===identity.sha256,'Native package changed during authorization; retry',409);
                identity=checked;
                proposed=managed?value.port:undefined;
            }
            checkActive();
            try{
                if(managed)await assertPortAvailable({port:proposed,id:rec.id,dist,editorOrigin,getManagementPort});
                const state=await launch(rec,identity,proposed,signal);
                if(!approval||approval.port!==proposed||forceReassign){
                    try{await saveApproval(dist,rec,identity,proposed);}
                    catch(e){await stop(rec);throw e;}
                    approval={id:rec.id,folder:rec.folder,sha256:identity.sha256,...(proposed===undefined?{}:{port:proposed})};
                }
                checkActive();
                return status(rec);
            }catch(error){
                if(!managed||error.code!=='PORT_IN_USE')throw error;
                console.warn('[Native port conflict]',rec.id,error.message);
                reason=error.message;requiresConsent=true;
            }
        }
        throw Object.assign(Error('Native port reassignment attempts exhausted'),{status:409,code:'NATIVE_PORT_CONFLICT'});
    }
    async function reassign(rec,{signal}={}){
        const identity=await releaseIdentity(dist,rec);
        requireValue(isManaged(identity),'Port reassignment requires a managed native port',409);
        return start(rec,{signal,forceReassign:true});
    }
    return {authorizationMode:'interactive-v4',start,stop,reassign,eligible:rec=>nativeEntry(dist,rec),revoke:rec=>revoke(dist,rec),syncStatus:()=>syncStatus(dist),status,listenerSummary,
        async close(){
            if(closing&&closeTask)return closeTask;
            closing=true;clearInterval(monitor);
            shutdown.abort(Object.assign(Error('Management backend is shutting down'),{status:503}));
            const task=(async()=>{
                const targets=[...children].map(([id,state])=>({id,folder:state.folder}));
                const results=await Promise.allSettled(targets.map(rec=>stop(rec)));
                const failures=results.filter(r=>r.status==='rejected');
                // Unexpected exits may have removed a child from the active map before
                // shutdown. Check every listener this Manager previously confirmed running.
                const previous=[...usedPorts.values()].filter(entry=>!entry.released);
                const leftover=await Promise.allSettled(previous.map(async entry=>{
                    await waitPortReleased(entry.port);entry.released=true;
                    note(entry,entry.port,'released');
                }));
                for(const result of leftover)if(result.status==='rejected')failures.push(result);
                if(failures.length)throw Object.assign(Error(`Native shutdown incomplete: ${failures.map(r=>r.reason.message).join('; ')}`),
                    {status:409,code:'NATIVE_SHUTDOWN_INCOMPLETE'});
                console.log(`[Native listener] Verified shutdown of ${targets.length} tracked native service(s); ${usedPorts.size} previously used port(s) checked`);
            })();
            closeTask=task;
            try{return await task;}
            catch(error){if(closeTask===task)closeTask=null;throw error;}
        }};

}
if(require.main===module){
    const args=process.argv.slice(2),dist=path.resolve(__dirname,'..');
    const usage='From deployed runtime: node ./dist/runtime/native-process.cjs --authorize <installed-plugin-id> [--port <port>] [--dist ./dist]';
    async function main(){
        requireValue(path.basename(__dirname)==='runtime'&&path.basename(dist)==='dist','Use the deployed controller inside supersplat/dist/runtime. '+usage);
        requireValue(args[0]==='--authorize'&&args[1],usage);
        let port,requestedDist;
        for(let i=2;i<args.length;i+=2){
            requireValue(args[i+1]!==undefined,usage);
            if(args[i]==='--port')port=Number(args[i+1]);
            else if(args[i]==='--dist')requestedDist=path.resolve(args[i+1]);
            else throw Error(usage);
        }
        if(requestedDist)requireValue(requestedDist===dist,'Explicit --dist does not identify this deployed runtime store. '+usage);
        const result=await authorize(dist,args[1],{port});
        console.log('Authorized native execution for this exact installed release:',JSON.stringify(result,null,2));
    }
    main().catch(e=>{console.error(e.message);process.exitCode=1;});
}
module.exports={createNativeProcesses,authorize,initializeApprovalState:syncStatus};
