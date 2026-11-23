#!/usr/bin/env node
// Architecture C shared launcher: standard, portable or self-contained.
// Deployment profile is explicit in launcher_config.json; no dependency fallback.
// Single lifecycle implementation, derived from corrected self-contained baseline.
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { prepareProject, stageProject, cleanupProject, projectUrl, configureProject } from './project_session.mjs';
import {chooseProvider,projectReportHandler,projectNotificationReader,VERSION} from './project_provider.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const configFile = path.join(root, 'launcher_config.json');
// A resolved active profile is immutable for the command and fingerprinted in its session.
const within = (base, target) => { const rel=path.relative(base,target); return !rel || (!path.isAbsolute(rel)&&rel!=='..'&&!rel.startsWith('..'+path.sep)); };
function expand(value) {
  if(typeof value!=='string'||!value.trim()||/[\r\n\0]/.test(value))throw Error('Invalid configured path');
  return value.replace(/%([^%]+)%/g,(_,key)=>{const v=process.env[key];if(!v)throw Error(`Undefined environment variable %${key}%`);return v;});
}
function resolvePath(value, executable=false) {
  const text=expand(value);
  if(executable && !/[\\/]/.test(text) && !path.isAbsolute(text)) {
    for(const entry of (process.env.PATH||'').split(path.delimiter)) {
      const dir=entry.replace(/^"|"$/g,'');if(!path.isAbsolute(dir))continue;
      const candidate=path.join(dir,text);
      if(fs.statSync(candidate,{throwIfNoEntry:false})?.isFile())return candidate;
    }
    throw Error(`Node executable not found on PATH: ${text}`);
  }
  return path.resolve(root,text);
}
function readProfile() {
  const config=JSON.parse(fs.readFileSync(configFile,'utf8').replace(/^\uFEFF/,''));
  if(config?.schema_version!==1||typeof config.active_profile!=='string'||!Object.hasOwn(config.profiles||{},config.active_profile))throw Error('Expected schema_version 1 and a valid active_profile');
  const name=config.active_profile, selected=config.profiles[name];
  const paths={};
  for(const key of ['editor_root','dist','management_backend','node','serve','typescript','splat_transform','vulkan_loader','logs']) {
    const value=selected.paths?.[key];
    if(value===null&&['typescript','splat_transform','vulkan_loader'].includes(key))paths[key]=null;
    else paths[key]=resolvePath(value,key==='node');
  }
  const ports={editor:selected.ports?.editor,management:selected.ports?.management};
  if(!Object.values(ports).every(p=>Number.isInteger(p)&&p>=1024&&p<=65535)||ports.editor===ports.management)throw Error('Invalid profile default ports');
  const policies={management_origin:selected.policies?.management_origin,native_environment:selected.policies?.native_environment};
  if(!['validate','synchronize'].includes(policies.management_origin)||!['system','bundled'].includes(policies.native_environment))throw Error('Invalid profile policies');
  if(paths.management_backend!==path.join(paths.dist,'runtime','management-server.cjs'))throw Error('Management backend must be the deployed dist/runtime/management-server.cjs');
  if(!within(paths.editor_root,paths.dist)||paths.dist===paths.editor_root)throw Error('dist must be within editor_root');
  if(policies.native_environment==='bundled') {
    for(const key of ['node','serve','typescript','splat_transform','vulkan_loader'])if(paths[key]&&!within(root,paths[key]))throw Error(`Bundled ${key} must be inside deployment root`);
    if(!paths.typescript)throw Error('Bundled TypeScript path required');
  }
  return {profile:name,paths,ports,policies};
}
let effective;
try { effective=readProfile(); } catch(e) { console.error(`ERROR: Invalid launcher_config.json: ${e.message}`); process.exit(1); }
const {profile,paths,ports,policies}=effective;
const fingerprint=crypto.createHash('sha256').update(JSON.stringify(effective)).digest('hex');
const source=paths.editor_root, dist=paths.dist, runtime=path.dirname(paths.management_backend);
const defaults=[ports.editor,ports.management];
const bundled=policies.native_environment==='bundled';
const stateFile=path.join(root,'.editor-services.json');
const logs=paths.logs;
const host = '127.0.0.1';
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const portNumber = raw => {
  if (!/^\d+$/.test(String(raw ?? ''))) throw Error(`Invalid port: ${raw}`);
  const p = Number(raw);
  if (p < 1024 || p > 65535) throw Error(`Port must be between 1024 and 65535: ${raw}`);
  return p;
};
const origin = port => `http://${host}:${port}`;
const inside = (base, p) => p === base || p.startsWith(base + path.sep);
async function readState() { return JSON.parse(await fsp.readFile(stateFile, 'utf8')); }
async function available(port) {
  await new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(port, host, () => s.close(resolve));
  }).catch(e => { throw Error(`Port ${port} unavailable: ${e.message}`); });
}
// Resolve the existing Cleaner CLI discovery contract without changing the plugin.
// Configured package directory must use one of the npm layouts Cleaner supports.
function nativePrefix(dir) {
  const scope=path.dirname(dir), modules=path.dirname(scope);
  if(path.basename(dir)!=='splat-transform'||path.basename(scope)!=='@playcanvas'||path.basename(modules)!=='node_modules')throw Error('SplatTransform path must end in node_modules/@playcanvas/splat-transform');
  const parent=path.dirname(modules);
  return path.basename(parent)==='lib'?path.dirname(parent):parent;
}
function managerEnvironment() {
  const env={...process.env};
  const inheritedPath=Object.entries(env).find(([key])=>key.toUpperCase()==='PATH')?.[1]||'';
  const shims=['splat-transform','splat-transform.cmd','splat-transform.ps1'];
  const configured=paths.splat_transform;
  for(const key of Object.keys(env)) {
    if(key.toUpperCase()==='PATH'||((configured||bundled)&&key.toUpperCase()==='NPM_CONFIG_PREFIX')||((paths.typescript||bundled)&&key.toUpperCase()==='NODE_PATH'))delete env[key];
  }
  const dirs=[path.dirname(paths.node),...inheritedPath.split(path.delimiter).filter(Boolean).map(dir=>path.resolve(root,dir.replace(/^"|"$/g,'')))];
  env.PATH=[...new Set(dirs.filter(dir=>!(configured||bundled)||!shims.some(shim=>fs.existsSync(path.join(dir,shim)))))].join(path.delimiter);
  if(paths.typescript)env.NODE_PATH=path.dirname(paths.typescript);
  if(configured) {
    const prefix=nativePrefix(configured);
    const pkg=path.join(configured,'package.json');
    // Missing optional package must not accidentally select another installation.
    env.NPM_CONFIG_PREFIX='';
    if(fs.existsSync(pkg)) {
      const first=path.join(prefix,'node_modules','@playcanvas','splat-transform');
      if(first!==configured&&fs.existsSync(path.join(first,'package.json')))throw Error('Competing SplatTransform package in configured npm prefix');
      const alternate=path.join(prefix,'lib','node_modules','@playcanvas','splat-transform');
      if(alternate!==configured&&fs.existsSync(path.join(alternate,'package.json')))throw Error('Competing SplatTransform package in configured npm prefix');
      env.NPM_CONFIG_PREFIX=prefix;
    }
  } else if(bundled)env.NPM_CONFIG_PREFIX='';
  return env;
}
async function checkBundledPath(dir, label) {
  if(bundled && dir && fs.existsSync(dir) && !within(await fsp.realpath(root),await fsp.realpath(dir)))throw Error(`Bundled ${label} resolves outside deployment root`);
}
async function checkDependencies() {
  for(const [key,dir] of Object.entries(paths))if(['node','serve','typescript','splat_transform','vulkan_loader'].includes(key))await checkBundledPath(dir,key);
  if(paths.typescript) {
    if(!(await fsp.stat(path.join(paths.typescript,'package.json')).catch(()=>null))?.isFile())throw Error('TypeScript compatibility-audit dependency missing: '+paths.typescript);
    // Check the exact resolution used by the unchanged Manager loader. NODE_PATH
    // can provide a configured external package, but cannot override a nearer one.
    try {
      const code=`const p=require('node:path'),fs=require('node:fs'),{createRequire}=require('node:module');const [loader,dist,expected]=process.argv.slice(1);const req=createRequire(loader);let found;for(const place of [p.dirname(dist),p.resolve(p.dirname(loader),'..','supersplat')]){try{found=req.resolve('typescript',{paths:[place]});break;}catch(e){if(e.code!=='MODULE_NOT_FOUND')throw e;}}found??=req.resolve('typescript');const real=fs.realpathSync(found),base=fs.realpathSync(expected);if(!real.startsWith(base+p.sep))throw Error('Resolved TypeScript differs: '+real);const ts=req(loader).typeScriptFrom(p.dirname(dist));if(typeof ts.createSourceFile!=='function'||typeof ts.forEachChild!=='function')throw Error('TypeScript JavaScript Compiler API unavailable');`;
      execFileSync(process.execPath,['-e',code,path.join(runtime,'typescript-loader.cjs'),dist,paths.typescript],{cwd:root,env:managerEnvironment(),encoding:'utf8',windowsHide:true,timeout:10000,stdio:['ignore','pipe','pipe']});
    } catch(e){throw Error('TypeScript compatibility resolution failed: '+(e.stderr?.trim()||e.message));}
  }
  if(paths.splat_transform) {
    const pkg=path.join(paths.splat_transform,'package.json');
    if(!fs.existsSync(pkg))console.warn('Optional SplatTransform unavailable: '+paths.splat_transform);
    else {
      const meta=JSON.parse(await fsp.readFile(pkg,'utf8'));
      const bin=typeof meta.bin==='string'?meta.bin:meta.bin?.['splat-transform'];
      if(meta.name!=='@playcanvas/splat-transform'||typeof bin!=='string'||!bin)throw Error('Invalid configured SplatTransform package');
      const cli=await fsp.realpath(path.resolve(paths.splat_transform,bin));
      if(!within(await fsp.realpath(paths.splat_transform),cli)||!(await fsp.stat(cli)).isFile())throw Error('Invalid configured SplatTransform CLI');
    }
  }
  if(paths.vulkan_loader) {
    if(path.dirname(paths.vulkan_loader)!==path.dirname(paths.node)||path.basename(paths.vulkan_loader).toLowerCase()!=='vulkan-1.dll')throw Error('Configured Vulkan loader must be vulkan-1.dll beside the Node executable');
    if(!(await fsp.stat(paths.vulkan_loader).catch(()=>null))?.isFile())console.warn('Optional Vulkan loader unavailable: '+paths.vulkan_loader);
  }
  managerEnvironment(); // Validate native prefix before spawning any services.
}

function spawnLogged(args, name, sessionLogs, cwd = root) {
  const out = fs.openSync(path.join(sessionLogs, `${name}.stdout.log`), 'a');
  const err = fs.openSync(path.join(sessionLogs, `${name}.stderr.log`), 'a');
  let pipeOwnsFiles = false;
  try {
    // Diagnostic only: avoid inherited file descriptors in Manager's stdio.
    // Keep the existing IPC channel and leave the Editor serve child unchanged.
    const child = spawn(process.execPath, args, { cwd, windowsHide: true,
      ...(name === 'management' ? {env: managerEnvironment()} : {}),
      stdio: name === 'management' ? ['ignore', 'pipe', 'pipe', 'ipc'] : ['ignore', out, err] });
    if (name === 'management') {
      const stdoutLog = fs.createWriteStream(path.join(sessionLogs, `${name}.stdout.log`), {fd: out, autoClose: true});
      const stderrLog = fs.createWriteStream(path.join(sessionLogs, `${name}.stderr.log`), {fd: err, autoClose: true});
      pipeOwnsFiles = true;
      for (const [input, output] of [[child.stdout, stdoutLog], [child.stderr, stderrLog]]) {
        output.on('error', error => {
          console.error(`Manager diagnostic log write failed: ${error.message}`);
          input.resume();
        });
        input.on('error', error => {
          console.error(`Manager diagnostic log pipe failed: ${error.message}`);
          output.end();
        });
        input.pipe(output);
      }
    }
    return child;
  } finally { if (!pipeOwnsFiles) { fs.closeSync(out); fs.closeSync(err); } }
}
async function checkDist(managementPort, synchronizeOrigin = false) {
  for (const file of ['index.html', 'custom-editor.js', 'plugins/manifest.json',
    'runtime/management-server.cjs', 'runtime/management-core.cjs', 'runtime/custom-editor.js',
    'runtime/native-process.cjs', 'runtime/plugin-compat.cjs', 'runtime/typescript-loader.cjs',
    'runtime/package.json']) {
    if (!(await fsp.stat(path.join(dist, file)).catch(() => null))?.isFile())
      throw Error(`Missing dist/${file}. Deploy the matching v1.13.3 runtime.`);
  }
  const [browserManager, backendManager] = await Promise.all([
    fsp.readFile(path.join(dist, 'custom-editor.js')),
    fsp.readFile(path.join(runtime, 'custom-editor.js'))
  ]);
  if (!browserManager.equals(backendManager)) throw Error('Browser and runtime Manager copies differ; redeploy runtime');
  const indexFile = path.join(dist, 'index.html');
  const original = await fsp.readFile(indexFile);
  const html = original.toString('utf8');
  if (!Buffer.from(html, 'utf8').equals(original)) throw Error('dist/index.html must be valid UTF-8');
  const hooks = [...html.matchAll(/<script\b[^>]*>/gi)].filter(m =>
    /\bsrc\s*=\s*(["'])\.\/custom-editor\.js\1/i.test(m[0]));
  const hook = hooks[0];
  const match = hook?.[0].match(/^<script type="module" src="\.\/custom-editor\.js" data-management-origin="http:\/\/127\.0\.0\.1:(\d+)">$/);
  if (hooks.length !== 1 || !match || !html.startsWith('</script>', hook.index + hook[0].length))
    throw Error('Expected exactly one canonical Manager module hook with a loopback management origin in dist/index.html. Redeploy the matching runtime.');
  portNumber(match[1]);
  const expected = `<script type="module" src="./custom-editor.js" data-management-origin="${origin(managementPort)}">`;
  const needsSync = hook[0] !== expected;
  if (needsSync && (policies.management_origin === 'validate' || !synchronizeOrigin))
    throw Error(`Editor hook must target ${origin(managementPort)} before startup/supervision; deploy the matching management origin for the validate policy.`);
  const serveDir = paths.serve;
  if (policies.management_origin === 'validate') {
    const pkg = JSON.parse(await fsp.readFile(path.join(source, 'package.json'), 'utf8'));
    if (pkg.scripts?.serve !== 'serve dist -C') throw Error('Upstream serve script changed; review this launcher for the current Editor version.');
    if (!paths.typescript) throw Error('TypeScript compatibility-audit dependency required by validated upstream deployment');
  }
  if (!(await fsp.stat(path.join(serveDir, 'package.json')).catch(() => null))?.isFile())
    throw Error(`Missing ${bundled ? 'bundled' : profile} serve package at ${serveDir}. Restore the required package.`);
  if (bundled && !inside(await fsp.realpath(root), await fsp.realpath(serveDir)))
    throw Error('Bundled serve resolves outside the portable root');
  const serve = JSON.parse(await fsp.readFile(path.join(serveDir, 'package.json'), 'utf8'));
  if (serve.name !== 'serve') throw Error(bundled ? 'Invalid bundled serve package identity' : 'Invalid serve package identity');
  const bin = typeof serve.bin === 'string' ? serve.bin : serve.bin?.serve;
  if (typeof bin !== 'string' || !bin.trim()) throw Error('Unable to locate original serve CLI entry');
  const serveCli = path.resolve(serveDir, bin);
  if (serveCli === serveDir || !inside(serveDir, serveCli) ||
      !inside(await fsp.realpath(serveDir), await fsp.realpath(serveCli)) ||
      !(await fsp.stat(serveCli)).isFile()) throw Error('Invalid original serve CLI entry');
  await checkDependencies();
  if (needsSync) {
    // Start only, after state/port and dependency checks. Change precisely the
    // existing hook in the portable copy; the supervisor independently validates it.
    if ((await fsp.lstat(dist)).isSymbolicLink() || (await fsp.lstat(indexFile)).isSymbolicLink())
      throw Error('Refusing to rewrite a linked dist or index.html; use an independent portable copy.');
    const next = html.slice(0, hook.index) + expected + html.slice(hook.index + hook[0].length);
    const temporary = path.join(dist, `.index.html.${crypto.randomBytes(8).toString('hex')}.tmp`);
    try {
      await fsp.writeFile(temporary, next, {flag:'wx', mode:(await fsp.stat(indexFile)).mode & 0o777});
      if (!(await fsp.readFile(indexFile)).equals(original)) throw Error('dist/index.html changed during startup; retry after stopping other operations.');
      await fsp.rename(temporary, indexFile);
    } finally { await fsp.rm(temporary, {force:true}); }
    console.log(`Portable Manager origin synchronized: ${origin(Number(match[1]))} -> ${origin(managementPort)}`);
  }
  return serveCli;
}
// Retain the standard launcher's Windows listener ownership check without
// invoking PowerShell. Shutdown still uses only the actual child handles.
function assertListenerOwned(port, child) {
  if (child.exitCode !== null || child.signalCode !== null) throw Error(`Service on ${port} exited`);
  if (process.platform !== 'win32') return;
  const output = execFileSync('netstat.exe', ['-ano', '-p', 'tcp'], {encoding:'utf8', windowsHide:true, timeout:5000});
  const listeners = output.split(/\r?\n/).map(line => line.trim().split(/\s+/)).filter(cols =>
    cols[0] === 'TCP' && cols[1] === `${host}:${port}` && cols[2] === '0.0.0.0:0');
  if (!listeners.length || listeners.some(cols => Number(cols.at(-1)) !== child.pid))
    throw Error(`Port ${port} listener is not owned by the launched process`);
}
async function managementReady(port) {
  let caps;
  try {
    const response = await fetch(`${origin(port)}/api/plugins/capabilities`, {signal:AbortSignal.timeout(650)});
    if (!response.ok) return false;
    caps = await response.json();
  } catch { return false; }
  if (caps.api_version !== 1 || caps.native_service !== 1 || caps.native_authorization !== 'interactive-v4')
    throw Error('Incompatible Manager capabilities; deploy the matching v1.13.3 runtime');
  let response;
  try {
    response = await fetch(`${origin(port)}/api/plugins/native/listeners`, {signal:AbortSignal.timeout(1500),cache:'no-store'});
  } catch { return false; }
  if (!response.ok) throw Error(`Listener inventory HTTP ${response.status}; deploy the matching v1.13.3 runtime`);
  let body;
  try { body = await response.json(); } catch { throw Error('Invalid Manager listener inventory JSON'); }
  if (!Array.isArray(body.services) || !Array.isArray(body.events))
    throw Error('Incompatible Manager listener inventory; deploy the matching v1.13.3 runtime');
  return true;
}
async function health(url) {
  try { return (await fetch(url, {signal:AbortSignal.timeout(650)})).ok; }
  catch { return false; }
}
// A child is not considered stopped merely because kill() was requested.
// The standard Architecture C Stop script waits for the owned process to exit.
async function terminateOwned(child, name) {
  if (!child) return;
  const cleanExit = (code, signal) => name === 'management backend'
    ? code === 0 : code === 0 || signal === 'SIGTERM' || signal === 'SIGINT';
  if (child.exitCode !== null || child.signalCode !== null) {
    if (!cleanExit(child.exitCode, child.signalCode))
      throw Error(`${name} exited with code ${child.exitCode}, signal ${child.signalCode}; shutdown verification failed`);
    return;
  }
  await new Promise((resolve, reject) => {
    let finished = false;
    const finish = error => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      child.removeListener('close', onClose);
      child.removeListener('error', onError);
      if (error) reject(error); else resolve();
    };
    const onClose = (code, signal) => finish(cleanExit(code,signal)?null:Error(`${name} exited with code ${code}, signal ${signal}; shutdown verification failed`));
    const onError = error => finish(error);
    const timer = setTimeout(() => {
      // Kill only the process we own; timeout is a shutdown FAILURE, never success.
      if (child.exitCode === null && child.signalCode === null) {
        try { child.kill('SIGKILL'); } catch { /* keep the original timeout error */ }
      }
      finish(Error(`Timed out stopping ${name} (PID ${child.pid}); graceful cleanup not verified`));
    }, 16000);
    child.once('close', onClose);
    child.once('error', onError);
    try {
      if (name === 'management backend') {
        if (!child.connected) throw Error('Manager shutdown IPC is unavailable; cannot verify native cleanup');
        child.send({type:'manager-shutdown'}, error => { if (error) finish(error); });
      } else child.kill();
    } catch (error) { finish(error); }
  });
}
async function awaitPortsFree(editorPort, managementPort) {
  for (let i = 0; i < 35; i++) {
    try {
      await available(editorPort);
      await available(managementPort);
      return;
    } catch { await wait(100); }
  }
  throw Error(`Shutdown incomplete: ports ${editorPort}/${managementPort} are not both free`);
}
function sessionName() {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/[.]/g, '') + '-' + crypto.randomBytes(3).toString('hex');
}
async function supervisorStatus(state) {
  const response = await fetch(`${origin(state.controlPort)}/status`, {
    headers: {Authorization: `Bearer ${state.token}`},
    signal: AbortSignal.timeout(1200)
  });
  if (!response.ok) throw Error('Supervisor identity check failed');
  const status = await response.json();
  if (status.root !== root || status.pid !== state.pid ||
      status.editorPort !== state.editorPort || status.managementPort !== state.managementPort)
    throw Error('Supervisor state mismatch; refusing to stop unrelated processes');
  return status;
}

// Session ownership is independent of listening ports. Windows uses CIM creation
// identities; Linux uses /proc start ticks and an inherited session marker.
const launcherPath = fileURLToPath(import.meta.url);
const marker = 'SUPERSPLAT_LAUNCH_SESSION';
const windows = process.platform === 'win32';
function ps(script) {
  return execFileSync('powershell.exe', ['-NoProfile','-NonInteractive','-Command',script],
    {encoding:'utf8',windowsHide:true,timeout:10000,maxBuffer:16*1024*1024}).trim();
}
function inventory() {
  if (windows) {
    const raw=ps("$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[Text.Encoding]::UTF8; ConvertTo-Json -Compress -InputObject @(Get-CimInstance Win32_Process | Where-Object {$_.ProcessId -ne $PID -and $null -ne $_.CreationDate} | ForEach-Object { [pscustomobject]@{pid=[int]$_.ProcessId;ppid=[int]$_.ParentProcessId;birth=$_.CreationDate.ToUniversalTime().Ticks.ToString();cmd=$_.CommandLine} })");
    const rows=JSON.parse(raw || '[]');
    return Array.isArray(rows)?rows:[rows];
  }
  if (process.platform !== 'linux') throw Error('Process identity verification requires Windows or Linux');
  const rows=[];
  for (const entry of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const p=`/proc/${entry}`, stat=fs.readFileSync(`${p}/stat`,'utf8');
      const fields=stat.slice(stat.lastIndexOf(')')+2).split(' ');
      if (fields[0]==='Z'||fields[0]==='X') continue;
      const argv=fs.readFileSync(`${p}/cmdline`,'utf8').split('\0').filter(Boolean);
      let session;
      try { session=fs.readFileSync(`${p}/environ`,'utf8').split('\0').find(v=>v.startsWith(`${marker}=`))?.slice(marker.length+1); } catch {}
      rows.push({pid:Number(entry),ppid:Number(fields[1]),birth:fields[19],argv,session});
    } catch (e) { if (!['ENOENT','ESRCH','EACCES','EPERM'].includes(e.code)) throw e; }
  }
  return rows;
}
const identity = r => ({pid:r.pid,birth:r.birth});
const same = (r,id) => !!r && !!id && r.pid===id.pid && r.birth===id.birth;
const alive = (rows,id) => rows.some(r=>same(r,id));
function processArgs(r) {
  return windows?((r.cmd||'').match(/"[^"]*"|[^\s]+/g)?.map(v=>v.replace(/^"|"$/g,''))||[]):(r.argv||[]);
}
const pathEquals=(a,b)=>typeof a==='string'&&(windows?a.toLowerCase()===b.toLowerCase():a===b);
function launcherRole(r) {
  const args=processArgs(r);
  return (pathEquals(args[1],launcherPath)||pathEquals(args[1],path.join(root,'editor_services_self.mjs')))?args[2]:null;
}
function knownDeploymentEntry(r) {
  const entry=processArgs(r)[1];
  if(!entry||!path.isAbsolute(entry))return false;
  const normalized=windows?path.normalize(entry).toLowerCase():path.normalize(entry);
  const base=windows?dist.toLowerCase():dist;
  return pathEquals(normalized,path.join(base,'runtime','management-server.cjs'))||
    (inside(path.join(base,'plugins'),normalized)&&/[/\\]native[/\\](?:service|processor)\.mjs$/i.test(normalized));
}
function collect(state,rows=inventory()) {
  const found=new Map();
  for (const r of rows) {
    if (same(r,state.supervisor)||state.owned?.some(id=>same(r,id))||
        (!windows && r.session===state.token)||(launcherRole(r)==='watch'&&pathEquals(processArgs(r)[1],launcherPath))) found.set(r.pid,r);
  }
  let changed=true;
  while (changed) {
    changed=false;
    for (const r of rows) {
      const parent=found.get(r.ppid);
      if (!found.has(r.pid)&&parent&&BigInt(r.birth)>=BigInt(parent.birth)) {found.set(r.pid,r);changed=true;}
    }
  }
  found.delete(process.pid);
  // The caller's identity must still be in the persisted session journal.
  return [...found.values()].map(identity);
}
function assertNoUnrecorded(rows=inventory()) {
  const residual=rows.filter(r=>r.pid!==process.pid&&(['supervise','watch'].includes(launcherRole(r))||knownDeploymentEntry(r)));
  if(residual.length) throw Error(`Unresolved launcher process(es) for this deployment: ${residual.map(r=>r.pid).join(', ')}. Inspect and stop verified residuals before retrying.`);
}
async function saveState(s) {
  const tmp=stateFile+'.'+crypto.randomBytes(6).toString('hex')+'.tmp';
  try { await fsp.writeFile(tmp,JSON.stringify(s,null,2),{flag:'wx',mode:0o600}); await fsp.rename(tmp,stateFile); }
  finally { await fsp.rm(tmp,{force:true}); }
}
function checkRecord(s) {
  if (s.profile !== profile || s.configurationFingerprint !== fingerprint) throw Error('Session profile differs, configuration changed or is legacy; restore the original launch configuration or use the original launcher to resolve it.');
  if(s.root!==root||s.schema!==2||s.lifecycle!==1||typeof s.token!=='string'||!/^[a-f0-9]{48}$/.test(s.token)||
      !Array.isArray(s.owned)||!s.owned.every(id=>Number.isSafeInteger(id.pid)&&id.pid>0&&/^\d+$/.test(id.birth))||
      !['starting','running','stopping','stopped','failed'].includes(s.phase)||
      !Number.isInteger(s.editorPort)||!Number.isInteger(s.managementPort)||!inside(logs,path.resolve(s.logs||'')))
    throw Error('Legacy, invalid or foreign launch record; inspect manually, do not delete while processes remain');
  if(s.project===true&&(!/^[a-f0-9]{48}$/.test(s.projectId||'')||s.projectId===s.token))throw Error('Invalid saved project staging identity');
  for(const id of [s.starter,s.supervisor].filter(Boolean)) if(!Number.isSafeInteger(id.pid)||id.pid<1||!/^\d+$/.test(id.birth)) throw Error('Invalid saved process identity');
  return s;
}
function killVerified(id) {
  if(id.pid===process.pid) throw Error('Refusing to terminate current command');
  if(windows) {
    // Open a process handle, then compare creation time before using that handle.
    // CIM timestamps have microsecond precision, FILETIME has 100 ns precision.
    ps(`$ErrorActionPreference='Stop'; $p=Get-Process -Id ${id.pid} -ErrorAction SilentlyContinue; if($null -ne $p){try{$null=$p.Handle; if([Math]::Abs([long]$p.StartTime.ToUniversalTime().Ticks-[long]'${id.birth}') -lt 10){$p.Kill(); $null=$p.WaitForExit(5000)}}finally{$p.Dispose()}}`);
  } else {
    if(alive(inventory(),id))try{process.kill(id.pid,'SIGKILL');}catch(e){if(e.code!=='ESRCH')throw e;}
  }
}
async function drainKnown(s,exclude=[],force=false) {
  // Give the normal IPC cancellation path time to finish first. Recheck the
  // current process inventory before any fallback termination.
  let pending=[];
  const deadline=Date.now()+2200;
  do {
    const rows=inventory();
    pending=collect(s,rows).filter(id=>!exclude.some(e=>same(id,e)));
    s.owned=[...s.owned.filter(id=>alive(rows,id)),...pending.filter(id=>!s.owned.some(x=>same(x,id)))];
    if(!pending.length)return [];
    await wait(150);
  }while(Date.now()<deadline);
  if(!force)return pending;
  // Descendants before parents, based on the current snapshot. Repeat to catch
  // descendants created during termination. Never target a port owner by port.
  for(let round=0;round<3&&pending.length;round++) {
    const rows=inventory();
    const depth=id=>{let n=0,r=rows.find(x=>same(x,id));const seen=new Set();while(r&&!seen.has(r.pid)){seen.add(r.pid);r=rows.find(x=>x.pid===r.ppid);n++;}return n;};
    pending.sort((a,b)=>depth(b)-depth(a));
    for(const id of pending)killVerified(id);
    await wait(200);
    pending=collect(s,inventory()).filter(id=>!exclude.some(e=>same(id,e)));
  }
  return pending;
}
async function finalize(s) {
  // Only the external caller removes a record, after the supervisor itself died.
  const rows=inventory();
  if(alive(rows,s.supervisor)||collect(s,rows).length)throw Error('Owned process(es) remain; session record retained');
  assertNoUnrecorded(rows);
  await awaitPortsFree(s.editorPort,s.managementPort);
  if(s.controlPort) await available(s.controlPort);
  const current=checkRecord(await readState());
  if(current.token!==s.token)throw Error('Launch identity changed; refusing to remove session record');
  if(current.project === true) { await cleanupProject(dist,current.projectId); console.log("[Project] Temporary resources removed after verified shutdown."); }
  await fsp.unlink(stateFile);
}

async function supervise(editorPort, managementPort, sessionDir) {
  const sessionLogs = path.resolve(root, sessionDir);
  if (!inside(logs, sessionLogs)) throw Error('Invalid per-run log directory');
  let state=checkRecord(await readState());
  if(state.phase!=='starting'||state.token!==process.env[marker]||state.logs!==sessionLogs||state.editorPort!==editorPort||state.managementPort!==managementPort||state.supervisor)
    throw Error('Supervisor reservation mismatch');
  state.supervisor=identity(inventory().find(r=>r.pid===process.pid));state.pid=process.pid;
  await saveState(state);
  let backend,staticChild,control,stopping=false,shutdownTask=null,timer,published=false,startupError=null;
  const token=state.token;
  const reports=state.project?projectReportHandler({state,editorOrigin:origin(editorPort),guiLog:path.join(logs,'launcher_gui.log'),sessionLog:path.join(sessionLogs,'project-restoration.log')}):null;
  const cancellation=path.join(sessionLogs,'cancel-start');
  async function refresh() {
    const rows=inventory();
    const captured=collect(state,rows);
    const next=[...state.owned.filter(id=>alive(rows,id)),...captured.filter(id=>!state.owned.some(x=>same(x,id)))];
    if(JSON.stringify(next)!==JSON.stringify(state.owned)){state.owned=next;await saveState(state);}
  }
  // Serialize census writes and shutdown writes within this supervisor.
  let census=Promise.resolve();
  function shutdown(code=0) {
    if(shutdownTask)return shutdownTask;
    stopping=true;clearInterval(timer);
    shutdownTask=(async()=>{
      const errors=[];
      try {await census;await refresh();}catch(e){errors.push(e.message);}
      state.phase='stopping';
      try {await saveState(state);}catch(e){errors.push(e.message);}
      try {
        const results=await Promise.allSettled([terminateOwned(backend,'management backend'),terminateOwned(staticChild,'Editor static server')]);
        for(const r of results)if(r.status==='rejected')errors.push(r.reason.message);
        const pending=await drainKnown(state,[],false);
        if(pending.length) {
          errors.push(`Graceful shutdown left owned processes: ${pending.map(p=>p.pid).join(', ')}`);
          const remaining=await drainKnown(state,[],true);
          if(remaining.length)errors.push(`Still active: ${remaining.map(p=>p.pid).join(', ')}`);
        }
        // Never interpret a free listening port as proof of process exit.
        await awaitPortsFree(editorPort, managementPort);
      }catch(e){errors.push(e.message);}
      finally {
        if(reports) await reports.finish().catch(e=>console.error("Project diagnostics finalization: "+e.message));
        if(control?.listening){control.closeAllConnections();await new Promise(resolve=>control.close(resolve));}
        state.phase=errors.length?'failed':'stopped';state.shutdownErrors=errors;state.exitCode=code;
        try{await saveState(state);}catch(e){errors.push(e.message);}
        if(errors.length)console.error(`Controlled shutdown incomplete: ${errors.join('; ')}`);
        else console.log('Owned child processes and core ports released; awaiting external supervisor verification.');
        // Ensure a failed child/IPC cannot keep a disconnected supervisor listening.
        // A failed record remains for external identity-based recovery.
        process.exitCode=errors.length?1:code;
        if(errors.length){for(const c of [backend,staticChild]){if(c?.connected)try{c.disconnect();}catch{}c?.stdout?.destroy();c?.stderr?.destroy();c?.unref();}}
      }
      return !errors.length;
    })();
    return shutdownTask;
  }
  const interrupt=()=>{if(published)void shutdown(1);else startupError=Error('Startup interrupted');};
  process.once('SIGTERM',interrupt);
  process.once('SIGINT',interrupt);
  try {
    const serveCli = await checkDist(managementPort);
    console.log(`Effective deployment: ${JSON.stringify(effective)}`);
    console.log(`${profile} static server: ${serveCli}; cwd=${source}; Node=${process.execPath}`);
    await available(editorPort); await available(managementPort);
    if(fs.existsSync(cancellation)||stopping||startupError)throw Error('Startup cancelled');
    backend = spawnLogged([paths.management_backend,
      '--dist', dist, '--port', String(managementPort), '--editor-origin',origin(editorPort)],'management',sessionLogs);
    staticChild = spawnLogged([serveCli, path.relative(source,dist), '-C', '-l', `tcp://${host}:${editorPort}`, '--no-port-switching'], 'editor', sessionLogs, source);
    for(const [name,c] of [['management',backend],['static',staticChild]]) {
      const failed=e=>{if(stopping)return;console.error(e.message);startupError=e;if(published)void shutdown(1);};
      c.on('error',e=>failed(Error(`${name} failed: ${e.message}`)));
      c.on('exit',(code,sig)=>failed(Error(`${name} exited (${code??sig})`)));
    }
    state.children={editor:staticChild.pid,management:backend.pid};
    census=refresh();await census;
    let ready=false;const deadline=Date.now()+15000;
    while(Date.now()<deadline){
      if(stopping||startupError||fs.existsSync(cancellation)||[backend,staticChild].some(c=>c.exitCode!==null||c.signalCode!==null))break;
      if(await health(`${origin(editorPort)}/`)&&await managementReady(managementPort)){ready=true;break;}
      await wait(150);
    }
    if(!ready||stopping||startupError||fs.existsSync(cancellation))throw Error('Editor or management capability not ready; inspect logs/run_logs/');
    assertListenerOwned(editorPort, staticChild);assertListenerOwned(managementPort, backend);
    control=http.createServer(async(req,res)=>{
      if(reports&&await reports.handle(req,res))return;
      if(req.headers.authorization!==`Bearer ${token}`){res.writeHead(403);return res.end();}
      if(req.method==='GET'&&req.url==='/status'){
        res.writeHead(200,{'Content-Type':'application/json'});
        return res.end(JSON.stringify({root,pid:process.pid,editorPort,managementPort,running:!stopping,stopping,children:state.children}));
      }
      if(req.method==='POST'&&/^\/watch\/[1-9]\d*$/.test(req.url)){
        if(stopping||state.phase!=='running'){res.writeHead(409);res.end();return;}
        const pid=Number(req.url.split('/').at(-1));
        census=census.then(async()=>{
          if(stopping)throw Error('Session stopping');
          const row=inventory().find(r=>r.pid===pid);
          const args=row&&processArgs(row);
          if(!row||args[2]!=='watch'||!pathEquals(path.basename(args[1]||''),path.basename(launcherPath)))throw Error('Monitor process identity not verified');
          if(!state.owned.some(id=>same(row,id)))state.owned.push(identity(row));
          await saveState(state);res.writeHead(200);res.end();
        }).catch(e=>{console.error(`Monitor registration failed: ${e.message}`);if(!res.headersSent)res.writeHead(409);res.end();});
        return;
      }
      if(req.method==='POST'&&req.url==='/stop'){res.writeHead(202);res.end('Controlled shutdown requested');setImmediate(()=>{void shutdown();});return;}
      res.writeHead(404);res.end();
    });
    await new Promise((resolve,reject)=>{control.once('error',reject);control.listen(0,host,resolve);});
    if(stopping||startupError||fs.existsSync(cancellation))throw Error('Startup cancelled');
    state.controlPort=control.address().port;state.phase='running';await saveState(state);published=true;
    if(startupError||fs.existsSync(cancellation)){await shutdown(1);return;}
    timer=setInterval(()=>{
      if(fs.existsSync(cancellation)){void shutdown(1);return;}
      census=census.then(()=>stopping?undefined:refresh()).catch(e=>{console.error(`Process inventory failed: ${e.message}`);void shutdown(1);});
    },3000);
  } catch(e){console.error(e.stack||e.message);await shutdown(1);}
}
async function start(editorPort, managementPort, projectFile) {
  if(fs.existsSync(stateFile)) {
    const prev=checkRecord(await readState());
    const rows=inventory();
    if(alive(rows,prev.supervisor)||collect(prev,rows).length|| (prev.phase==='starting'&&alive(rows,prev.starter)))
      throw Error('Editor services already running or unresolved; use Stop first');
    if(prev.phase!=='stopped')throw Error('Previous session interrupted; run Stop to verify recovery');
    await finalize(prev);
  }
  const rows=inventory();assertNoUnrecorded(rows);
  await available(editorPort);await available(managementPort);
  let project=null;
  try {project=await prepareProject(projectFile,dist);if(projectFile&&!project)console.log("[Project] Auto-restore disabled or no enabled models.");}
  catch(e){console.error("[Project] Preparation failed; starting Editor without restoration: "+e.message);}
  const sessionLogs=path.join(logs,sessionName());await fsp.mkdir(sessionLogs,{recursive:true});
  const reservation={schema:2,lifecycle:1,root,profile,configurationFingerprint:fingerprint,editorPort,managementPort,token:crypto.randomBytes(24).toString('hex'),
    phase:'starting',starter:identity(rows.find(r=>r.pid===process.pid)),owned:[],logs:sessionLogs,...(project?{project:true,projectId:crypto.randomBytes(24).toString('hex')}:{})};
  // Exclusive reservation BEFORE any portable HTML synchronization or spawn.
  await fsp.writeFile(stateFile,JSON.stringify(reservation,null,2),{flag:'wx',mode:0o600});
  let child,spawnError;
  try {
    await checkDist(managementPort,true);
    if(project){
      console.log(`[Project] ${project.name}; bundled version ${VERSION}`);
      try{await stageProject(dist,reservation.projectId,project);}
      catch(e){console.error('[Project] Staging failed; starting Editor without restoration: '+e.message);await cleanupProject(dist,reservation.projectId);delete reservation.project;delete reservation.projectId;await saveState(reservation);}
    }
    const out=fs.openSync(path.join(sessionLogs,'launcher.stdout.log'),'a');
    const err=fs.openSync(path.join(sessionLogs,'launcher.stderr.log'),'a');
    try {
      child=spawn(process.execPath,[launcherPath,'supervise',String(editorPort),String(managementPort),path.relative(root,sessionLogs)],
        {cwd:root,windowsHide:true,detached:true,stdio:['ignore',out,err],env:{...process.env,[marker]:reservation.token}});
      child.on('error',e=>{spawnError=e;});child.unref();
    }finally{fs.closeSync(out);fs.closeSync(err);}
    for(let i=0;i<170;i++){
      const saved=checkRecord(await readState());
      if(saved.token!==reservation.token)throw Error('Startup reservation changed');
      if(saved.phase==='running'&&saved.pid===child.pid&&await health(`${origin(editorPort)}/`)&&await managementReady(managementPort)){
        if(saved.project){
          try{const provider=await chooseProvider(dist,managementPort,editorPort);
            await configureProject(dist,saved.projectId,provider,`${origin(saved.controlPort)}/project-report/${saved.projectId}`);
          }catch(e){console.error('[Project] Provider configuration failed: '+e.message+'; bundled page remains available.');}
        }
        console.log(`Editor: ${saved.project?projectUrl(origin(editorPort),saved.projectId):origin(editorPort)+"/"}`);console.log(`Management: ${origin(managementPort)}/api/plugins/capabilities`);console.log(`Logs: ${saved.logs}`);
        console.log('Stop both: stop.bat (or invoke this launcher with stop)');return;
      }
      if(spawnError||child.exitCode!==null||child.signalCode!==null||['failed','stopped'].includes(saved.phase))break;
      await wait(150);
    }
    throw Error(`Startup failed. Inspect ${sessionLogs}/launcher.stderr.log`);
  }catch(error){
    if(!child||spawnError){const current=checkRecord(await readState());if(current.token===reservation.token&&!current.supervisor){if(current.project)await cleanupProject(dist,current.projectId);await fsp.unlink(stateFile);}}
    else {
      await fsp.writeFile(path.join(sessionLogs,'cancel-start'),'cancel\n');
      try{await finishSession(reservation.token,true);}catch(e){console.error(`Startup rollback incomplete: ${e.message}`);}
    }
    throw error;
  }
}
async function finishSession(token,rollback=false) {
  let s=checkRecord(await readState());if(s.token!==token)throw Error('Launch identity changed');
  const end=Date.now()+27000;
  // Wait for the supervisor's own exit, not merely an absent state file.
  while(Date.now()<end){
    s=checkRecord(await readState());if(s.token!==token)throw Error('Launch identity changed');
    if(s.supervisor&&!alive(inventory(),s.supervisor))break;
    if(!s.supervisor&&(!rollback&&!alive(inventory(),s.starter)))break;
    await wait(300);
  }
  const rows=inventory();
  // The supervisor may have published its final phase during process inventory.
  s=checkRecord(await readState());if(s.token!==token)throw Error('Launch identity changed');
  // Never kill an active startup owner, or an unauthenticated legacy process.
  if(!s.supervisor&&alive(rows,s.starter)&&!rollback)throw Error('Startup still active; retry Stop after startup completes');
  if(!s.supervisor&&rows.some(r=>launcherRole(r)==='supervise'))throw Error('Unregistered supervisor remains; inspect session before recovery');
  const supervisorAlive=alive(rows,s.supervisor);
  let pending=collect(s,rows);
  if(supervisorAlive||pending.length){
    s.owned=[...s.owned,...pending.filter(id=>!s.owned.some(x=>same(x,id)))];
    // Stop the controller before force recovery only if its identity is verified.
    // Its captured children remain in the journal, even after reparenting.
    if(supervisorAlive){killVerified(s.supervisor);await wait(200);if(alive(inventory(),s.supervisor))throw Error('Supervisor did not terminate; state retained');}
    s.phase='failed';s.shutdownErrors=[...(s.shutdownErrors||[]),'Forced recovery required'];await saveState(s);
    pending=await drainKnown(s,[],true);await saveState(s);
    if(pending.length)throw Error(`Owned processes still active: ${pending.map(p=>p.pid).join(', ')}`);
  }
  if(s.phase!=='stopped'&&s.phase!=='failed'){s.phase='failed';s.shutdownErrors=[...(s.shutdownErrors||[]),'Supervisor did not record a completed shutdown'];await saveState(s);}
  if(s.phase==='failed'&&!rollback){
    // Preserve diagnostic record on the first failed Stop. A subsequent Stop
    // can acknowledge recovered resources without claiming graceful cleanup.
    if(!s.recoveryReported){s.recoveryReported=true;await saveState(s);throw Error('Graceful shutdown not verified; tracked processes recovered. Run Stop again to clear the failed session.');}
  }
  await finalize(s);
  if(rollback&&s.phase==='failed')console.error('Startup rollback required abnormal/forced cleanup; tracked processes and core/control ports verified released.');
  if(!rollback)console.log(s.phase==='stopped'?'Shutdown verified: owned processes and listening ports released.':'Failed session cleared after process and port verification (not a graceful shutdown).');
}
async function stop() {
  if(!fs.existsSync(stateFile)){assertNoUnrecorded();console.log('No saved launch or matching supervisor/monitor processes.');return;}
  const s=checkRecord(await readState());
  if(s.phase==='starting'&&alive(inventory(),s.starter))throw Error('Startup in progress; retry Stop after startup completes');
  if(s.phase==='running'||s.phase==='stopping'){
    try{
      await supervisorStatus(s);
      const r=await fetch(`${origin(s.controlPort)}/stop`,{method:'POST',headers:{Authorization:`Bearer ${s.token}`},signal:AbortSignal.timeout(1200)});
      if(r.status!==202)throw Error('Stop request rejected');
    }catch(e){if(/identity|mismatch|rejected/.test(e.message))throw e;console.error(`Supervisor unreachable; verifying recorded identities: ${e.message}`);}
  }else if(s.phase==='starting')await fsp.writeFile(path.join(s.logs,'cancel-start'),'cancel\n');
  await finishSession(s.token);
}

// Read-only live native listener monitoring; never spawns, stops or authorizes a plugin.
async function watchNativeListeners() {
  if (!fs.existsSync(stateFile)) throw Error('Start Editor services before monitoring native listeners');
  const saved=checkRecord(await readState());
  if(saved.phase!=='running')throw Error('Editor session is not running');
  await supervisorStatus(saved);
  const registration=await fetch(`${origin(saved.controlPort)}/watch/${process.pid}`,{method:'POST',headers:{Authorization:`Bearer ${saved.token}`},signal:AbortSignal.timeout(6000)});
  if(!registration.ok)throw Error('Monitor registration rejected');
  console.log('[Native monitor] Watching Manager-owned native listener changes (Ctrl+C to stop monitoring).');
  const last=new Map();let failures=0,lastSequence=0;
  const projectNotifications=saved.project?projectNotificationReader(path.join(saved.logs,'project-restoration.log')):null;
  let projectReadWarning=false;
  while (fs.existsSync(stateFile)) {
    const current=await readState().catch(()=>null);
    if (!current || current.token!==saved.token || current.pid!==saved.pid || current.phase!=='running') break;
    if(projectNotifications)try{await projectNotifications();projectReadWarning=false;}catch(e){if(!projectReadWarning)console.error('[Project] Diagnostics monitor: '+e.message);projectReadWarning=true;}
    try {
      const response=await fetch(`${origin(saved.managementPort)}/api/plugins/native/listeners`,
        {signal:AbortSignal.timeout(1200),cache:'no-store'});
      if(response.status===404||response.status===405)throw Object.assign(Error(`Listener status HTTP ${response.status}; incompatible Manager runtime`),{incompatible:true});
      if(!response.ok)throw Error(`Listener status HTTP ${response.status}`);
      const body=await response.json();
      if(!Array.isArray(body.services)||!Array.isArray(body.events))throw Object.assign(Error('Manager listener status response incompatible'),{incompatible:true});
      // Event sequence prevents missing short-lived listeners between polls.
      if(Array.isArray(body.events))for(const event of body.events){
        if(!Number.isInteger(event.sequence)||event.sequence<=lastSequence)continue;
        console.log(`[Native event] ${event.id} port=${event.port} ${event.listener}`);
        lastSequence=event.sequence;
      }
      const active=new Set();
      for(const entry of body.services){
        if(!Number.isInteger(entry.port))continue;
        const key=`${entry.id}/${entry.folder}`,label=`${entry.id} port=${entry.port} ${entry.state} listener=${entry.listener}`;
        active.add(key);
        if(last.get(key)!==label){console.log(`[Native monitor] ${label}`);last.set(key,label);}
      }
      for(const key of [...last.keys()])if(!active.has(key)){
        console.log(`[Native monitor] ${key} approval removed`);last.delete(key);
      }
      failures=0;
    }catch(error){
      if(error.incompatible){console.error(`[Native monitor] ${error.message}; monitoring stopped.`);process.exitCode=1;break;}
      if(++failures===1)console.error(`[Native monitor] Status temporarily unavailable: ${error.message}`);
      if(failures>=10){console.error('[Native monitor] Listener status unavailable; stop monitoring without inferring listener release.');break;}
    }
    await wait(1000);
  }
  console.log('[Native monitor] Monitoring ended.');
}

const commandLock=path.join(root,'.editor-services.command.lock');
async function exclusiveCommand(fn) {
  const me=identity(inventory().find(r=>r.pid===process.pid));
  try {await fsp.writeFile(commandLock,JSON.stringify(me),{flag:'wx',mode:0o600});}
  catch(e){if(e.code==='EEXIST')throw Error('Another start/stop command holds the launch lock. If interrupted, verify its recorded process identity is gone before removing .editor-services.command.lock.');throw e;}
  try{return await fn();}finally{await fsp.unlink(commandLock);}
}

try {
  if (!(await fsp.stat(paths.node).catch(()=>null))?.isFile() || !pathEquals(await fsp.realpath(process.execPath),await fsp.realpath(paths.node)))
    throw Error(bundled?'Use the bundled runtime configured Node executable to run editor_services.mjs':'Use the configured Node executable to run editor_services.mjs');
  const [command, ...rest] = process.argv.slice(2);
  if (command === 'stop') await exclusiveCommand(stop);
  else if (command === 'watch') await watchNativeListeners();
  else if (['start','supervise'].includes(command)) {
    if (command==='supervise' ? rest.length!==3 : (rest.length>2 && (rest.length!==4||rest[2]!=='--project'||!rest[3]))) throw Error('Usage: start [editorPort] [managementPort] [--project project.json]');
    const ep=portNumber(rest[0] ?? defaults[0]), mp=portNumber(rest[1] ?? defaults[1]);
    if (ep===mp) throw Error('Editor and management ports must differ');
    if (command==='start') await exclusiveCommand(()=>start(ep,mp,rest[3]));
    else await supervise(ep,mp,rest[2]);
  } else throw Error('Usage: <profile Node> editor_services.mjs start [editorPort] [managementPort] [--project project.json] | watch | stop');
} catch(e) { console.error(`ERROR: ${e.message}`); process.exitCode=1; }
