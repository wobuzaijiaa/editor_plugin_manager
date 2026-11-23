export const VERSION='0.1.5';
const providerKey=Symbol.for('editor-launcher.restoration-provider.v1');
const methods=['files.importUrl','layers.list','layers.rename','layers.active','layers.setActive','transform'];
export const missingApi=(editor,required=methods)=>required.filter(name=>typeof name.split('.').reduce((v,k)=>v?.[k],editor)!=='function');
// Manager activation is registration only; the launcher page owns scene mutation.
export function activate({editor,plugin}){
  const win=globalThis.window;
  const provider={version:plugin.version,folder:new URL('.',import.meta.url).pathname.split('/').filter(Boolean).at(-1),restore,missing:missingApi(editor)};
  if(win)win[providerKey]=provider;
  if(provider.missing.length)throw Error('Required Editor API unavailable: '+provider.missing.join(', '));
  return {open(){},isRunning(){return false;},deactivate(){if(win?.[providerKey]===provider)delete win[providerKey];}};
}
export async function restore(editor, manifest, base, report=()=>{}, signal){
  if(manifest?.schema_version!==1||!Array.isArray(manifest.models))throw Error('Invalid staged project manifest');
  if((await editor.layers.list()).length)throw Error('Scene is not empty. Refresh the project URL to restore into a fresh scene.');
  const failures=[];
  for(const m of manifest.models){
    if(signal?.aborted)break;
    try {
      if(!/^model-\d+\.(ply|splat|ksplat|spz|sog)$/.test(m.url))throw Error('Invalid staged model URL');
      const r=m.rotation;
      if(!r||!['editor-default','colmap','xgrids','none','custom'].includes(r.preset)||![r.x,r.y,r.z].every(v=>Number.isFinite(v)&&Math.abs(v)<=360))throw Error('Invalid import rotation');
      const result=await editor.files.importUrl(new URL(m.url,base).href,m.filename,{signal});
      const id=result.createdLayer;
      const layer=result.layers?.find(l=>l.id===id);
      if(id==null||!layer)throw Error('Import did not return the created layer identity');
      if(signal?.aborted)break;
      if(r.preset!=='editor-default'){
        const actual=layer.rotation;
        // Use actual PlayCanvas math objects already supplied by the public API.
        const target=actual.clone().setFromEulerAngles(r.x,r.y,r.z);
        const delta=actual.clone().mul2(target,actual.clone().invert());
        const center=layer.position.clone().set(0,0,0);
        await editor.transform(id,'layer',{rotate:delta,center},{signal});
        const after=(await editor.layers.list()).find(l=>l.id===id)?.rotation;
        const dot=after&&Math.abs(after.x*target.x+after.y*target.y+after.z*target.z+after.w*target.w);
        if(!Number.isFinite(dot)||Math.abs(1-dot)>1e-4)throw Error('Target rotation verification failed');
        // The Transform panel displays the editing pivot, not the layer entity.
        // A layer edit does not place that pivot; a changed active selection does.
        // Selecting the same id is a no-op. Rebind only this active layer and
        // do not steal a different selection made while the import was running.
        if(editor.layers.active()===id){
          editor.layers.setActive(null);
          editor.layers.setActive(id);
        }
      }
      if(m.name!==layer.name)await editor.layers.rename(id,m.name,{signal});
      report(`Loaded: ${m.name}${r.preset==='editor-default'?' (native import orientation)':` target rotation (${r.x}, ${r.y}, ${r.z}) verified; active pivot refresh requested when selected`}`);
    } catch(e){failures.push({id:m.id,error:e.message});report(`FAILED: ${m.name}: ${e.message}. A partially imported layer may remain.`);}
  }
  return failures;
}
// Same source release serves as Manager plugin and bundled page implementation.
export async function startProjectPage({window:win=globalThis.window,document:doc=globalThis.document,base=new URL('./',import.meta.url),fetcher=globalThis.fetch,wait=ms=>new Promise(r=>setTimeout(r,ms)),attempts=600,providerAttempts=150}={}){
  const key=Symbol.for('editor-launcher.project-restore');
  if(win[key])return;
  win[key]=true;
  const panel=doc.createElement('section');panel.style.cssText='position:fixed;top:90px;right:24px;z-index:1400;width:340px;max-height:55vh;overflow:auto;padding:12px;background:#292f38;color:white;border:1px solid #888;border-radius:6px;font:13px system-ui';
  const title=doc.createElement('strong');title.textContent='Project restoration';
  const content=doc.createElement('pre');content.style.cssText='white-space:pre-wrap;overflow-wrap:anywhere';
  const close=doc.createElement('button');close.textContent='Hide';close.onclick=()=>panel.hidden=true;
  const retry=doc.createElement('button');retry.textContent='Reload with bundled restoration';retry.hidden=true;retry.onclick=()=>{const url=new URL(win.location.href);url.searchParams.set('restoration','bundled');win.location.assign(url.href);};
  panel.append(title,content,retry,close);doc.body.append(panel);
  let endpoint,queue=Promise.resolve();
  const report=(s,status='info')=>{
    if(status==='warning'){title.textContent='Project restoration — Warning';panel.style.borderColor='#e7b64a';}
    if(status==='failed'||status==='partial'){title.textContent='Project restoration — Error';panel.style.borderColor='#ef7777';}
    if(status==='success'){title.textContent=s.startsWith('Fallback completed')?'Project restoration — Fallback completed':'Project restoration — Complete';}
    content.textContent+=s+'\n';console.log('[Launcher project]',s);
    if(endpoint)queue=queue.then(async()=>{try{const res=await fetcher(endpoint,{method:'POST',headers:{'Content-Type':'text/plain'},body:JSON.stringify({status,message:s.slice(0,4000)}),keepalive:true,signal:AbortSignal.timeout(5000)});if(!res.ok)throw Error('HTTP '+res.status);}catch(e){console.warn('[Launcher project] Diagnostics delivery failed:',e);}});
  };
  const abort=new AbortController();win.addEventListener('pagehide',()=>abort.abort(),{once:true});
  try {
    const response=await fetcher(new URL('manifest.json',base),{cache:'no-store',signal:abort.signal});
    if(!response.ok)throw Error(`Manifest HTTP ${response.status}`);
    const manifest=await response.json();endpoint=manifest.reportUrl;
    report(`Restoring ${manifest.name??'project'}; bundled version ${VERSION}`,'begin');
    if(manifest.provider?.notice)report(manifest.provider.notice);
    report('Waiting for Editor...');
    let editor;
    for(let i=0;i<attempts&&!abort.signal.aborted;i++){
      const e=win.editor;
      if(!missingApi(e).length){editor=e;break;}
      await wait(100);
    }
    if(abort.signal.aborted)return;
    if(!editor)throw Error('Required Editor API unavailable: '+missingApi(win.editor).join(', ')+'. Normal Editor remains available.');
    report('Bundled runtime API: PASS');
    let run=restore, fallbackReason;
    const selected=manifest.provider, forced=win.location&&new URL(win.location.href).searchParams.get('restoration')==='bundled';
    if(selected?.kind==='installed'&&!forced){
      report(`Waiting for Manager activation: ${selected.folder}, version ${selected.version}`);
      const missing=missingApi(editor,selected.required??methods);
      if(missing.length){fallbackReason='Installed runtime API unavailable: '+missing.join(', ');report('Installed runtime API: FAILED: '+missing.join(', '));}
      else{
        report('Installed runtime API: PASS');
        let provider;
        for(let i=0;i<providerAttempts&&!abort.signal.aborted;i++){
          const candidate=win[providerKey];
          if(candidate?.version===selected.version&&candidate.folder===selected.folder){provider=candidate;break;}
          await wait(100);
        }
        if(abort.signal.aborted)return;
        if(provider&&!provider.missing?.length&&typeof provider.restore==='function'){
          run=provider.restore;report(`Manager provider activation registration: PASS; installed ${provider.version}`);
        }else fallbackReason='Installed provider unavailable or activation unconfirmed. Check Manager for activation details.';
      }
    }
    const usingFallback=run===restore;
    if(usingFallback){
      fallbackReason=forced?'Fresh-page recovery override':fallbackReason??selected?.reason??'Installed provider not available';
      report(`Fallback selected: bundled ${VERSION}. ${fallbackReason}. Restoration not yet completed.`,'warning');
    }
    // Even failed activation may have modified the scene. Never retry here if so.
    if((await editor.layers.list()).length)throw Error('Scene is not empty; no automatic fallback. Reload a fresh project page.');
    const failures=await run(editor,manifest,base,report,abort.signal);
    if(!abort.signal.aborted){
      if(!Array.isArray(failures))throw Error('Provider returned invalid restoration result');
      report(failures.length?`${usingFallback?'Bundled fallback':'Installed restoration'} failed: ${failures.length} model(s). Refresh after correcting the issue.`:usingFallback?`Fallback completed: bundled ${VERSION}; all ${manifest.models.length} model(s) restored.`:`Project restoration complete: installed ${selected.version}.`,failures.length?((await editor.layers.list()).length?'partial':'failed'):'success');
      retry.hidden=!failures.length||usingFallback;
    }
  }catch(e){if(!abort.signal.aborted){report(`Project restoration failed: ${e.message}`,'failed');retry.hidden=false;}}
  finally{await queue;}
}
// Manager imports from /plugins/<release>/... and must not auto-start a scene.
if(typeof window!=='undefined'&&typeof document!=='undefined'&&/\/__editor_project_[a-f0-9]{48}\/project_restore\.mjs$/.test(new URL(import.meta.url).pathname)){
  const run=()=>void startProjectPage();
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',run,{once:true});else run();
}
