// Session-scoped, read-only project resources; no general filesystem serving.
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {pipeline} from 'node:stream/promises';
const resourceName=/^model-\d+\.(ply|splat|ksplat|spz|sog)$/;
export const modelResourceName=(model,index)=>`model-${index}${path.extname(model.filename).toLowerCase()}`;
const identity=s=>({dev:s.dev,ino:s.ino,size:s.size,mtimeMs:s.mtimeMs});
const matches=(s,e)=>s.isFile()&&Object.entries(identity(s)).every(([k,v])=>e[k]===v);
export async function mapProjectResources(project){
  return Promise.all(project.models.map(async(m,i)=>{
    const name=modelResourceName(m,i), st=await fs.stat(m.file);
    if(!resourceName.test(name)||!st.isFile()||!Number.isSafeInteger(st.size))throw Error('Invalid project resource');
    return {name,file:m.file,...identity(st)};
  }));
}
// Private cross-process handoff, outside the static document root. The core
// launcher journal is deliberately not modified. The random session ID is the
// ownership marker, not a browser-supplied filesystem path.
export const resourceStorageRoot=path.dirname(fileURLToPath(import.meta.url));
function mappingPath(sessionId,root){
  if(!/^[a-f0-9]{48}$/.test(sessionId))throw Error('Invalid project resource session');
  return path.join(root,`.editor-project-${sessionId}.json`);
}
export async function saveProjectResources(dist,sessionId,entries,root=resourceStorageRoot){
  const [served,privateRoot]=await Promise.all([fs.realpath(dist),fs.realpath(root)]);
  const rel=path.relative(served,privateRoot);
  if(!rel||(!path.isAbsolute(rel)&&rel!=='..'&&!rel.startsWith('..'+path.sep)))throw Error('Project resource mapping must be outside dist');
  const file=mappingPath(sessionId,root),next=file+'.next';
  // Publish only a complete document. A killed starter may leave .next; the
  // verified staging owner authorizes its removal during session cleanup.
  const handle=await fs.open(next,'wx',0o600);
  try{
    try{
      const exists=await fs.lstat(file).catch(e=>{if(e.code==='ENOENT')return null;throw e;});
      if(exists)throw Error('Project resource mapping already exists');
      await handle.writeFile(JSON.stringify({schema_version:1,sessionId,entries}));
    }finally{await handle.close();}
    await fs.rename(next,file);
  }catch(e){await fs.unlink(next).catch(()=>{});throw e;}
}
async function readMapping(sessionId,root){
  const file=mappingPath(sessionId,root),st=await fs.lstat(file);
  if(!st.isFile()||st.isSymbolicLink())throw Error('Unsafe private project resource mapping');
  const doc=JSON.parse(await fs.readFile(file,'utf8'));
  if(doc.schema_version!==1||doc.sessionId!==sessionId||!Array.isArray(doc.entries))throw Error('Project resource mapping ownership not verified');
  return doc.entries;
}
export const loadProjectResources=(sessionId,root=resourceStorageRoot)=>readMapping(sessionId,root);
export async function removeProjectResources(sessionId,root=resourceStorageRoot,{stagingOwned=false}={}){
  const file=mappingPath(sessionId,root),next=file+'.next';
  // Never parse an unpublished, possibly truncated document. Its exact name
  // and the independent staging ownership marker establish cleanup authority.
  const pending=await fs.lstat(next).catch(e=>{if(e.code==='ENOENT')return null;throw e;});
  if(pending&&(!stagingOwned||!pending.isFile()||pending.isSymbolicLink()||pending.nlink!==1))throw Error('Unsafe unpublished project resource mapping; inspect manually');
  let published=true;
  try{await readMapping(sessionId,root);}catch(e){if(e.code==='ENOENT')published=false;else throw e;}
  if(published)await fs.unlink(file);
  if(pending)await fs.unlink(next);
}
function rangeFor(value,size){
  if(value===undefined)return null;
  const m=/^bytes=(\d*)-(\d*)$/.exec(value);
  if(!m||(!m[1]&&!m[2])||size===0)return false;
  let start=m[1]?Number(m[1]):Math.max(0,size-Number(m[2]));
  let end=m[1]&&m[2]?Math.min(Number(m[2]),size-1):size-1;
  if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start>=size||start>end)return false;
  return {start,end};
}
export function projectResourceHandler({sessionId,editorOrigin,entries,log=console.error,maxActive=8}){
  if(!/^[a-f0-9]{48}$/.test(sessionId)||!Array.isArray(entries)||!entries.length)throw Error('Invalid project resource mapping');
  const map=new Map();
  for(const e of entries){
    if(!e||!resourceName.test(e.name)||map.has(e.name)||typeof e.file!=='string'||!path.isAbsolute(e.file)||!Number.isSafeInteger(e.size)||e.size<0||!['dev','ino','mtimeMs'].every(k=>Number.isFinite(e[k])))throw Error('Invalid project resource entry');
    map.set(e.name,Object.freeze({...e}));
  }
  const prefix=`/project-resources/${sessionId}/`, active=new Map();let closing=false;
  const cors={'Access-Control-Allow-Origin':editorOrigin,'Vary':'Origin','Cache-Control':'no-store','Access-Control-Expose-Headers':'Content-Range, Accept-Ranges, Content-Length'};
  const reply=(res,status,headers={})=>{if(!res.destroyed&&!res.headersSent){res.writeHead(status,headers);res.end();}};
  async function send(req,res,e,signal){
    let file;
    try{
      // Verify the resolved source and the opened file, not a request-supplied path.
      const actual=await fs.realpath(e.file);
      if(actual!==e.file||!matches(await fs.stat(actual),e)){reply(res,409,cors);return;}
      file=await fs.open(actual,'r');
      if(!matches(await file.stat(),e)){reply(res,409,cors);return;}
      if(signal.aborted){res.destroy();return;}
      const range=rangeFor(req.headers.range,e.size);
      if(range===false){reply(res,416,{...cors,'Content-Range':`bytes */${e.size}`});return;}
      const headers={...cors,'Content-Type':'application/octet-stream','Accept-Ranges':'bytes','Content-Length':range?range.end-range.start+1:e.size};
      if(range)headers['Content-Range']=`bytes ${range.start}-${range.end}/${e.size}`;
      res.writeHead(range?206:200,headers);
      if(req.method==='HEAD'||e.size===0){res.end();return;}
      await pipeline(file.createReadStream({autoClose:false,start:range?.start??0,end:range?.end??e.size-1}),res,{signal});
    }catch(error){
      if(!signal.aborted){log(`[Project resource] ${e.name}: ${error.code??'read failed'}`);if(!res.headersSent)reply(res,error.code==='ENOENT'?404:500,cors);else res.destroy();}
    }finally{if(file)await file.close().catch(error=>log(`[Project resource] ${e.name}: close failed: ${error.code??'unknown'}`));}
  }
  function handle(req,res){
    if(!req.url?.startsWith('/project-resources/'))return false;
    if(req.headers.origin!==editorOrigin){reply(res,403);return true;}
    const name=req.url.startsWith(prefix)?req.url.slice(prefix.length):'';
    const e=map.get(name);
    if(!e){reply(res,404,cors);return true;}
    if(closing){reply(res,503,cors);return true;}
    if(req.method==='OPTIONS'){
      if(!['GET','HEAD'].includes(req.headers['access-control-request-method'])||!['','range'].includes((req.headers['access-control-request-headers']??'').toLowerCase()))reply(res,403,cors);
      else reply(res,204,{...cors,'Access-Control-Allow-Methods':'GET, HEAD','Access-Control-Allow-Headers':'Range'});
      return true;
    }
    if(!['GET','HEAD'].includes(req.method)){reply(res,405,{...cors,Allow:'GET, HEAD, OPTIONS'});return true;}
    if(active.size>=maxActive){reply(res,503,{...cors,'Retry-After':'1'});return true;}
    const abort=new AbortController();const cancel=()=>abort.abort();res.once('close',cancel);
    const job=send(req,res,e,abort.signal).finally(()=>{res.off('close',cancel);active.delete(abort);});
    active.set(abort,job);return true;
  }
  async function close(){closing=true;for(const abort of active.keys())abort.abort();await Promise.allSettled([...active.values()]);}
  return {handle,close};
}
