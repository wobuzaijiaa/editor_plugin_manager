// Project staging is deliberately separate from process ownership and deployment profiles.
import fs from 'node:fs/promises';
import path from 'node:path';
import {constants} from 'node:fs';
export const extension = /\.(ply|splat|ksplat|spz|sog)$/i;
const presets = {colmap:[0,0,180],xgrids:[-90,0,0],none:[0,0,0]};
export function validateProject(p) {
  if(p?.schema_version!==1||typeof p.name!=='string'||!p.name.trim()||typeof p.auto_restore!=='boolean'||!Array.isArray(p.models))throw Error('Invalid project.json');
  const ids=new Set();
  for(const m of p.models){
    if(!m||typeof m.id!=='string'||!m.id||ids.has(m.id)||typeof m.name!=='string'||!m.name.trim()||typeof m.path!=='string'||!m.path.trim()||!extension.test(m.path)||typeof m.enabled!=='boolean')throw Error('Invalid or duplicate project model');
    ids.add(m.id);
    const r=m.rotation;
    if(!r||!['editor-default','colmap','xgrids','none','custom'].includes(r.preset)||![r.x,r.y,r.z].every(v=>Number.isFinite(v)&&Math.abs(v)<=360))throw Error(`Invalid rotation for ${m.name}`);
    if(Object.hasOwn(presets,r.preset)&&![r.x,r.y,r.z].every((v,i)=>v===presets[r.preset][i]))throw Error(`Preset angles disagree for ${m.name}`);
  }
  return p;
}
const readJson=async f=>JSON.parse((await fs.readFile(f,'utf8')).replace(/^\uFEFF/,''));
export async function prepareProject(file,dist) {
  if(!file)return null;
  const projectFile=path.resolve(file);
  if(path.basename(projectFile).toLowerCase()!=='project.json')throw Error('Expected a project.json file');
  const p=validateProject(await readJson(projectFile));
  if(!p.auto_restore||!p.models.some(m=>m.enabled))return null;
  const models=[];
  for(const m of p.models.filter(m=>m.enabled)){
    const file=await fs.realpath(path.resolve(path.dirname(projectFile),m.path)).catch(()=>{throw Error(`Missing model: ${m.name} (${m.path})`);});
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
