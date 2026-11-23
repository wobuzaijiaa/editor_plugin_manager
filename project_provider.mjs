// Project-specific provider policy. No changes to Manager or native authorization.
import fs from 'node:fs/promises';
import path from 'node:path';
import {createRequire} from 'node:module';
export const ID='project-restoration', VERSION='0.1.5';
export const METHODS=['files.importUrl','layers.list','layers.rename','layers.active','layers.setActive','transform'];
// Single metadata definition used to provision the bundled module. The separate
// downloadable plugin.json is generated from the same definition.
export const BUNDLED_METADATA={id:ID,name:'Project Restoration',classification:'Project',version:VERSION,
  author:'Editor Plugin Manager project',date:'2026-11-22',description:'Launcher project import provider. Activation registers the provider; the launcher project page controls restoration.',
  entry:'./project_restore.mjs',project_restoration_contract:1,requires:{editor_api:METHODS,internal_api:[]}};
async function installBundled(mp,ep){
  const files=[{path:'plugin.json',data_base64:Buffer.from(JSON.stringify(BUNDLED_METADATA,null,2)+'\n').toString('base64')},
    {path:'project_restore.mjs',data_base64:(await fs.readFile(new URL('./project_restore.mjs',import.meta.url))).toString('base64')}];
  const response=await fetch(`http://127.0.0.1:${mp}/api/plugins/install`,{method:'POST',headers:{Origin:`http://127.0.0.1:${ep}`,'X-SuperSplat-Plugin-Manager':'1','Content-Type':'application/json'},body:JSON.stringify({files}),signal:AbortSignal.timeout(10000)});
  if(response.status!==201)throw Error(`Manager install HTTP ${response.status}: ${(await response.text()).slice(0,500)}`);
  return response.json();
}
const json=async f=>JSON.parse((await fs.readFile(f,'utf8')).replace(/^\uFEFF/,''));
async function packageFiles(dir, prefix='', out=[]){
  for(const entry of await fs.readdir(dir,{withFileTypes:true})){
    const name=prefix+entry.name;
    if(entry.isSymbolicLink())throw Error('Linked plugin content');
    if(entry.isDirectory())await packageFiles(path.join(dir,entry.name),name+'/',out);
    else if(entry.isFile()&&name!=='audit.json'){
      if(out.length>=100)throw Error('Plugin package exceeds file limit');
      const file=path.join(dir,entry.name),s=await fs.stat(file);
      if(s.size>50*1024*1024||out.reduce((n,f)=>n+f.data.length,0)+s.size>50*1024*1024)throw Error('Plugin package exceeds size limit');
      out.push({name,data:await fs.readFile(file)});
    } else if(!entry.isFile())throw Error('Unsupported plugin content');
  }return out;
}
export async function chooseProvider(dist,mp,ep,log=console.log){
  const bundled={kind:'bundled',version:VERSION};
  let catalog,rec,selected=bundled,notice;
  try{
    const root=path.join(dist,'plugins');
    const currentInventory=await json(path.join(root,'editor-api.json')).catch(()=>null);
    const missing=METHODS.filter(m=>!currentInventory?.available_methods?.includes(m));
    log(`[Project] Bundled ${VERSION} static API check: ${!currentInventory?'NOT_ASSESSED':missing.length?'MISSING '+missing.join(', '):'PASS'}; runtime check required.`);
    catalog=await json(path.join(root,'manifest.json'));
    if(catalog.schema_version!==1||!Array.isArray(catalog.plugins))throw Error('Invalid plugin catalog');
    rec=catalog.plugins.find(p=>p.id===ID);
    if(!rec){
      log(`[Project] Installed provider absent; provisioning bundled ${VERSION} through Manager.`);
      let installationError;
      try{
        const result=await installBundled(mp,ep);
        notice=`Project Restoration ${VERSION} installed through Manager; audit=${result.compatibility?.status??'unknown'}.`;
        log(`[Project] INFO: ${notice}`);
      }catch(e){installationError=e;log(`[Project] Install attempt failed: ${e.message}`);}
      // Manager may have committed despite a lost response, or another client
      // may have installed the same ID. Read authoritative catalog; never overwrite.
      catalog=await json(path.join(root,'manifest.json'));
      if(catalog.schema_version!==1||!Array.isArray(catalog.plugins))throw Error('Invalid plugin catalog after provision attempt');
      rec=catalog.plugins.find(p=>p.id===ID);
      if(!rec)throw installationError??Error('Manager installation not present in catalog');
      if(installationError)log('[Project] Existing registration found after install attempt; checking that release.');
    }
    try{
      if(!/^project-restoration_\d{8}T\d{9}Z$/.test(rec.folder)||typeof rec.enabled!=='boolean')throw Error('Invalid catalog record');
      const dir=path.join(root,rec.folder);
      if((await fs.lstat(dir)).isSymbolicLink())throw Error('Linked provider directory');
      const meta=await json(path.join(dir,'plugin.json')), audit=await json(path.join(dir,'audit.json'));
      log(`[Project] Installed ${meta.version}; Startup=${rec.enabled}; audit=${audit.status}; Editor commit=${audit.editor_commit??'unknown'}; package=${audit.package_sha256??'unknown'}`);
      for(const notice of audit.notices??[])log(`[Project] Audit: ${String(notice).slice(0,1000)}`);
      if(meta.id!==ID||meta.project_restoration_contract!==1||meta.native_service||!/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(meta.version))throw Error('Unsupported restoration provider contract');
      const {packageDigest}=createRequire(path.join(dist,'runtime','plugin-compat.cjs'))('./plugin-compat.cjs');
      if(audit.package_sha256!==packageDigest(await packageFiles(dir)))throw Error('Package differs from install audit; reinstall modified release');
      if(!['STATIC_COMPATIBLE','REVIEW_REQUIRED','NOT_ASSESSED'].includes(audit.status))throw Error(`Static compatibility ${audit.status}`);
      const required=meta.requires?.editor_api;
      if(!Array.isArray(required)||!METHODS.every(m=>required.includes(m))||required.some(m=>typeof m!=='string'||!/^\w+(\.\w+)*$/.test(m)))throw Error('Incomplete Editor API declaration');
      const inventory=currentInventory;
      if(inventory&&(!Array.isArray(inventory.available_methods)||required.some(m=>!inventory.available_methods.includes(m))))throw Error('Current Editor inventory missing required API');
      if(inventory?.commit!==audit.editor_commit)log('[Project] Install audit is from another/unknown Editor build; current runtime check required.');
      selected={kind:'installed',version:meta.version,folder:rec.folder,required};
    }catch(e){selected={...bundled,reason:`Installed provider rejected: ${e.message}`};log(`[Project] ${selected.reason}; bundled ${VERSION}`);}
    // Backend's existing optimistic configuration API. No direct catalog writes.
    const enabled=selected.kind==='installed';
    if(rec.enabled!==enabled){
      const next=structuredClone(catalog);next.plugins.find(p=>p.id===ID).enabled=enabled;
      const response=await fetch(`http://127.0.0.1:${mp}/api/plugins/config`,{method:'PUT',headers:{Origin:`http://127.0.0.1:${ep}`,'X-SuperSplat-Plugin-Manager':'1','Content-Type':'application/json'},body:JSON.stringify({catalog:next,expected_catalog:catalog}),signal:AbortSignal.timeout(5000)});
      if(!response.ok)throw Error(`Manager Startup save HTTP ${response.status}: ${(await response.text()).slice(0,500)}`);
      log(`[Project] Manager Startup saved: ${enabled}`);
    }
    if(selected.kind==='bundled')log(`[Project] WARNING: Fallback selected (${VERSION}): ${selected.reason}`);
    log(`[Project] Selected provider: ${selected.kind} ${selected.version}`);return {...selected,...(notice?{notice}:{})};
  }catch(e){const reason=`Provider selection failed: ${e.message}`;log(`[Project] WARNING: Fallback selected (${VERSION}): ${reason}. No automatic replacement.`);return {...bundled,reason,...(notice?{notice}:{})};}
}
// The browser has only a project-scoped credential, never the supervisor token.
export function projectReportHandler({state,editorOrigin,guiLog,sessionLog}){
  let last='unconfirmed', count=0, queue=Promise.resolve();
  async function persist(message){
    const line=`[${new Date().toISOString()}] [Project ${state.projectId.slice(0,8)}] ${message.replace(/[\r\n\u0000-\u001f]/g,' ')}\n`;
    await fs.appendFile(sessionLog,line,'utf8');
    // GUI also appends to this file; tolerate a short Windows sharing conflict.
    for(let i=0;i<10;i++){try{await fs.appendFile(guiLog,line,'utf8');return;}catch(e){if(i===9){console.error('Project GUI log append failed; diagnostics retained in '+sessionLog+': '+e.message);return;}await new Promise(r=>setTimeout(r,50));}}
  }
  const record=message=>{const task=queue.then(()=>persist(message));queue=task.catch(e=>console.error('Project diagnostics failed: '+e.message));return task;};
  return {async handle(req,res){
    if(!state.project||req.url!==`/project-report/${state.projectId}`)return false;
    if(req.headers.origin!==editorOrigin||req.method!=='POST'||state.phase!=='running'){res.writeHead(403);res.end();return true;}
    res.setHeader('Access-Control-Allow-Origin',editorOrigin);res.setHeader('Vary','Origin');
    if(++count>10000){res.writeHead(429);res.end();return true;}
    try{
      const parts=[];let size=0;for await(const chunk of req){size+=chunk.length;if(size>8192){res.writeHead(413);res.end();return true;}parts.push(chunk);}
      const event=JSON.parse(Buffer.concat(parts).toString('utf8'));
      if(typeof event.message!=='string'||event.message.length>4000||!['begin','info','warning','success','failed','partial'].includes(event.status))throw Error('Invalid report');
      if(!['info','warning'].includes(event.status))last=event.status;
      await record(`${event.status.toUpperCase()}: ${event.message}`);res.writeHead(204);res.end();
    }catch(e){if(!res.headersSent)res.writeHead(400);res.end();}return true;
  },record,async finish(){await queue;await record(`Session end; last browser restoration status: ${last==='begin'?'UNCONFIRMED':last.toUpperCase()}`);}};
}

// Relay only human-facing project notifications through the already-owned watch
// process. The supervisor has already persisted these lines; do not log twice.
export function projectNotificationReader(file){
  let offset=0,carry=Buffer.alloc(0);
  return async (emit=console.log)=>{
    const handle=await fs.open(file,'r').catch(e=>{if(e.code==='ENOENT')return null;throw e;});
    if(!handle)return;
    try{
      const chunk=Buffer.alloc(65536);const {bytesRead}=await handle.read(chunk,0,chunk.length,offset);offset+=bytesRead;
      const data=Buffer.concat([carry,chunk.subarray(0,bytesRead)]);let start=0,end;
      while((end=data.indexOf(10,start))!==-1){
        const line=data.subarray(start,end).toString('utf8');start=end+1;
        const match=line.match(/^\[[^\]]+\] \[Project [a-f0-9]{8}\] (WARNING|SUCCESS|FAILED|PARTIAL): (.*)$/);
        if(match)emit(`[Project notification] ${match[1]}: ${match[2]}`);
      }
      carry=data.subarray(start);
    }finally{await handle.close();}
  };
}
