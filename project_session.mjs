// Project staging is deliberately separate from process ownership and deployment profiles.
import fs from 'node:fs/promises';
import path from 'node:path';
import {constants} from 'node:fs';
export const extension = /\.(ply|splat|ksplat|spz|sog)$/i;
const presets = {colmap:[0,0,180],xgrids:[-90,0,0],none:[0,0,0]};
const projectIdPattern=/^[a-f0-9]{32}$/;
const isoUtc=v=>typeof v==='string'&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(v)&&!Number.isNaN(Date.parse(v));
const absoluteLocation=v=>typeof v==='string'&&(path.isAbsolute(v)||path.win32.isAbsolute(v));
export function normalizeProject(p) {
  if(!p||![1,2].includes(p.schema_version)||typeof p.auto_restore!=='boolean'||!Array.isArray(p.models))throw Error('Invalid project.json');
  const v2=p.schema_version===2;
  const name=v2?p.project_name:p.name;
  if(typeof name!=='string'||!name.trim())throw Error('Invalid project.json name');
  if(v2){
    if(typeof p.project_id!=='string'||!projectIdPattern.test(p.project_id)||!absoluteLocation(p.project_path)||
       !(p.created_at===null||isoUtc(p.created_at))||!isoUtc(p.updated_at))throw Error('Invalid project metadata');
  }
  const ids=new Set(),models=[];
  for(const m of p.models){
    const modelName=v2?m?.model_name:m?.name;
    if(!m||typeof m.id!=='string'||!m.id||ids.has(m.id)||typeof modelName!=='string'||!modelName.trim()||
       typeof m.path!=='string'||!m.path.trim()||!extension.test(m.path)||typeof m.enabled!=='boolean')throw Error('Invalid or duplicate project model');
    ids.add(m.id);
    const r=m.rotation;
    if(!r||!['editor-default','colmap','xgrids','none','custom'].includes(r.preset)||![r.x,r.y,r.z].every(v=>Number.isFinite(v)&&Math.abs(v)<=360))throw Error(`Invalid rotation for ${modelName}`);
    if(Object.hasOwn(presets,r.preset)&&![r.x,r.y,r.z].every((v,i)=>v===presets[r.preset][i]))throw Error(`Preset angles disagree for ${modelName}`);
    if(v2){
      const segments=m.path.replaceAll('\\','/').split('/');
      if(m.legacy_external!==true&&(segments.includes('..')||segments.includes('.')))throw Error(`Unsafe relative model path for ${modelName}`);
      if(segments.length===3&&segments[0]?.toLowerCase()==='models'&&/^[a-f0-9]{32}$/.test(segments[1])&&segments[1]!==m.id&&m.legacy_external!==true)throw Error(`Unsafe managed model path for ${modelName}`);
      if(m.legacy_external!==undefined&&m.legacy_external!==true)throw Error(`Invalid legacy ownership flag for ${modelName}`);
    }
    models.push({...m,name:modelName});
  }
  return {schema_version:p.schema_version,name,models,auto_restore:p.auto_restore};
}
// Maintain the original validator's identity-return behavior for v1 callers.
export function validateProject(p) {normalizeProject(p);return p;}

const readJson=async f=>JSON.parse((await fs.readFile(f,'utf8')).replace(/^\uFEFF/,''));
export async function prepareProject(file,dist) {
  if(!file)return null;
  const projectFile=path.resolve(file);
  if(path.basename(projectFile).toLowerCase()!=='project.json')throw Error('Expected a project.json file');
  const p=normalizeProject(await readJson(projectFile));
  if(!p.auto_restore||!p.models.some(m=>m.enabled))return null;
  const models=[];
  for(const m of p.models.filter(m=>m.enabled)){
    const resolved=path.resolve(path.dirname(projectFile),m.path);
    if(p.schema_version===2&&m.legacy_external!==true&&m.path.replaceAll('\\','/').toLowerCase()===`models/${m.id}/${path.basename(m.path)}`.toLowerCase()){
      // A managed path may never be redirected through a symlink or junction.
      const parent=path.dirname(projectFile),folder=path.join(parent,'models',m.id);
      for(const entry of [parent,path.join(parent,'models'),folder,resolved]){
        const st=await fs.lstat(entry).catch(()=>{throw Error(`Missing model: ${m.name} (${m.path})`);});
        if(st.isSymbolicLink())throw Error(`Unsafe managed model link: ${m.name}`);
      }
    }
    const file=await fs.realpath(resolved).catch(()=>{throw Error(`Missing model: ${m.name} (${m.path})`);});
    if(!(await fs.stat(file)).isFile())throw Error(`Not a model file: ${m.name}`);
    models.push({...m,file,filename:path.basename(m.path)});
  }
  return {name:p.name,models};
}
function stageDir(dist,token){if(!/^[a-f0-9]{48}$/.test(token))throw Error('Invalid project session identity');return path.join(dist,`__editor_project_${token}`);}
// Preserve the original Editor entry point. The staged document lives one
// directory below it, so a relative base must be resolved from the original root.
export function projectPage(html,token){
  if(!/^[a-f0-9]{48}$/.test(token))throw Error('Invalid project session identity');
  const heads=[...html.matchAll(/<head(?:\s[^>]*)?>/gi)];
  if(heads.length!==1||!/<\/head\s*>/i.test(html))throw Error('Project page requires a normal Editor index head');
  const pos=heads[0].index+heads[0][0].length;
  const end=html.slice(pos).search(/<\/head\s*>/i);
  if(end<0)throw Error('Project page requires a normal Editor index head');
  let head=html.slice(pos,pos+end);
  // Ignore comments and raw-text elements; match a real base tag, including
  // quoted attributes. HTML uses the first base element with an href.
  const tags=[...head.matchAll(/<!--[\s\S]*?-->|<(script|style|title|textarea)\b(?:"[^"]*"|'[^']*'|[^'">])*>[\s\S]*?<\/\1\s*>|<[a-z][\w:-]*\b(?:"[^"]*"|'[^']*'|[^'">])*>/gi)].filter(m=>/^<base\b/i.test(m[0]));
  const attrs=tag=>[...tag.slice(5,-1).matchAll(/([^\s=/'"<>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g)];
  const active=tags.find(m=>attrs(m[0]).some(a=>a[1].toLowerCase()==='href'));
  let base='<base href="/">';
  if(active){
    const tag=active[0],href=attrs(tag).find(a=>a[1].toLowerCase()==='href');
    const raw=(href[2]??href[3]??href[4]??'').trim();
    // Absolute/root-relative bases retain their original values. Other paths
    // are anchored at /, retaining HTML entities and browser URL semantics.
    const value=/^(?:\/|[a-z][a-z0-9+.-]*:)/i.test(raw)?raw:(['','.','./'].includes(raw)?'/':'/'+raw);
    if(value===raw&&[href[2],href[3],href[4]].some(v=>v!==undefined))base=tag;
    else {
      const quote=href[3]!==undefined?"'":'"';
      base=tag.slice(0,5+href.index)+'href='+quote+value+quote+tag.slice(5+href.index+href[0].length);
    }
    head=head.slice(0,active.index)+head.slice(active.index+tag.length);
  } else if(tags.length){
    // A target-only base can be reused without losing its target attribute.
    const first=tags[0],tag=first[0];
    base=tag.replace(/\s*\/?>$/,' href="/">');
    head=head.slice(0,first.index)+head.slice(first.index+tag.length);
  }
  return html.slice(0,pos)+'\n'+base+'\n<script type="module" src="/__editor_project_'+token+'/project_restore.mjs"></script>\n'+head+html.slice(pos+end);
}
export async function stageProject(dist,token,project,log=console.log){
  const dir=stageDir(dist,token);
  if((await fs.lstat(dist)).isSymbolicLink())throw Error('Project staging requires an ordinary dist directory');
  await fs.mkdir(dir); // exclusive, never reuse another directory
  await fs.writeFile(path.join(dir,'owner.txt'),token,{flag:'wx'});
  const models=[];
  for(const [i,m] of project.models.entries()){
    const filename=`model-${i}${path.extname(m.filename).toLowerCase()}`;
    const dest=path.join(dir,filename);
    try {await fs.link(m.file,dest);log(`Project model ${m.name}: linked`);}
    catch(e){if(!['EXDEV','EPERM','EACCES','ENOTSUP','EOPNOTSUPP','EMLINK','ENOSYS','EINVAL'].includes(e.code))throw e;log(`Project model ${m.name}: copying (may take time)`);await fs.copyFile(m.file,dest,constants.COPYFILE_EXCL);}
    models.push({id:m.id,name:m.name,filename:m.filename,url:filename,rotation:m.rotation});
  }
  const html=await fs.readFile(path.join(dist,'index.html'),'utf8');
  await fs.writeFile(path.join(dir,'index.html'),projectPage(html,token),{flag:'wx'});
  await fs.copyFile(new URL('./project_restore.mjs',import.meta.url),path.join(dir,'project_restore.mjs'),constants.COPYFILE_EXCL);
  await fs.writeFile(path.join(dir,'manifest.json'),JSON.stringify({schema_version:1,name:project.name,models}),{flag:'wx'});
}
export async function cleanupProject(dist,token){
  const dir=stageDir(dist,token), st=await fs.lstat(dir).catch(e=>{if(e.code==='ENOENT')return null;throw e;});
  if(!st)return;
  if(!st.isDirectory()||st.isSymbolicLink()||(await fs.lstat(dist)).isSymbolicLink())throw Error('Unsafe project staging directory; inspect manually');
  const files=await fs.readdir(dir,{withFileTypes:true});
  if(files.length===0){await fs.rmdir(dir);return;}
  if(!files.some(f=>f.name==='owner.txt'&&f.isFile())||await fs.readFile(path.join(dir,'owner.txt'),'utf8')!==token)throw Error('Project staging ownership not verified; inspect manually');
  if(files.some(f=>!f.isFile()||!(/^(owner\.txt|manifest\.json|index\.html|project_restore\.mjs|model-\d+\.(ply|splat|ksplat|spz|sog))$/.test(f.name))))throw Error('Unexpected project staging content; inspect manually');
  for(const f of files.filter(f=>f.name!=='owner.txt'))await fs.unlink(path.join(dir,f.name));
  await fs.unlink(path.join(dir,'owner.txt'));await fs.rmdir(dir);
}
export async function configureProject(dist,token,provider,reportUrl){
  const file=path.join(stageDir(dist,token),'manifest.json');
  const manifest=await readJson(file);
  await fs.writeFile(file,JSON.stringify({...manifest,provider,reportUrl}));
}
export const projectUrl=(origin,token)=>`${origin}/__editor_project_${token}/index.html`;
