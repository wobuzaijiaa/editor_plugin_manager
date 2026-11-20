import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {buildPowerShellLaunch,invokePowerShellCli} from '../native/powershell-cli.mjs';
const args=['-g','0','--no-tty','--verbose','--memory','--gpu-backend','vulkan','input.ply','--filter-floaters=0.05,0.1,0.00392156862745098','retained.ply'];
const decode=s=>Buffer.from(s,'base64').toString('utf16le');
const mockChild=()=>Object.assign(new EventEmitter(),{pid:12000,stdout:new PassThrough(),stderr:new PassThrough()});
async function setup(t,mode){
 const cwd=await fs.mkdtemp(path.join(os.tmpdir(),'pslaunch-'));t.after(()=>fs.rm(cwd,{recursive:true,force:true}));
 const calls=[],controller=new AbortController(),logs=[];const record={write:(c,i)=>logs.push([c.toString(),i])};let waiter;
 const spawnImpl=(file,argv,opts)=>{calls.push({file,argv,opts});const child=mockChild();if(file.endsWith('taskkill.exe')){setImmediate(()=>{child.emit('close',0,null);waiter.emit('close',1,null);});return child;}waiter=child;
 if(mode==='cancel'){setImmediate(()=>controller.abort());return child;}
 setImmediate(async()=>{if(mode!=='missing'){await fs.writeFile(path.join(cwd,'powershell-cli.log'),mode==='loss'?'WebGPU device lost: test\n'+'x'.repeat(70000):'normal CLI output\n');await fs.writeFile(path.join(cwd,'powershell-cli.exit'),mode==='nonzero'?'1':'0');}child.emit('close',mode==='nonzero'?1:0,null);});return child;};
 const execute=()=>invokePowerShellCli('C:\\CLI folder\\cli.mjs',args,{cwd,signal:controller.signal,record,spawnImpl});return {execute,calls,record,logs,cwd,controller};
}
test('PowerShell waiter starts visible console, safely quotes apostrophes and preserves comma parameter',()=>{
 const launch=buildPowerShellLaunch({shell:'C:\\Windows\\powershell.exe',node:'C:\\A B\\node.exe',cli:"C:\\O'Brien\\cli.mjs",args,cwd:'C:\\Work folder'});
 assert.equal(decode(launch.args.at(-1)),launch.waiter);assert.match(launch.waiter,/-WindowStyle Normal -PassThru -Wait/);assert.match(launch.command,/O''Brien/);assert.ok(launch.command.includes("'--filter-floaters=0.05,0.1,0.00392156862745098'"));assert.match(launch.command,/& \$node @cliArgs 2>&1/);assert.match(launch.command,/exit \$code/);
});
test('successful PowerShell run imports merged CLI log and verifies exit marker',async t=>{const a=await setup(t,'ok');await a.execute();assert.equal(a.record.result.code,0);assert.equal(a.record.result.launchMode,'powershell-window');assert.equal(a.record.result.gpuError,false);assert.equal(a.calls.length,1);assert.match(a.logs[0][0],/normal CLI output/);});
test('device loss is rejected even with exit zero and error outside retained tail',async t=>{const a=await setup(t,'loss');await assert.rejects(a.execute(),/GPU error true/);assert.equal(a.record.result.gpuError,true);});
test('nonzero CLI exit and missing marker fail closed',async t=>{for(const mode of ['nonzero','missing']){const a=await setup(t,mode);await assert.rejects(a.execute(),/Original SplatTransform CLI failed/);}});
test('cancellation targets only owned waiter tree and waits for close',async t=>{const a=await setup(t,'cancel');await assert.rejects(a.execute(),/cancelled/);assert.deepEqual(a.calls[1].argv,['/PID','12000','/T','/F']);assert.equal(a.calls.length,2);});
test('Windows actual PowerShell console and native argument round trip (mock CLI, no GPU)',{skip:process.platform!=='win32'},async t=>{
 const cwd=await fs.mkdtemp(path.join(os.tmpdir(),'scf ps test '));t.after(()=>fs.rm(cwd,{recursive:true,force:true}));const cli=path.join(cwd,"test's cli.mjs");await fs.writeFile(cli,`import fs from 'node:fs';fs.writeFileSync('argv.json',JSON.stringify(process.argv.slice(2)));console.error('CLI stderr progress');console.log('CLI stdout');`);const record={write(){}};await invokePowerShellCli(cli,args,{cwd,record});assert.deepEqual(JSON.parse(await fs.readFile(path.join(cwd,'argv.json'),'utf8')),args);assert.equal(record.result.code,0);assert.match(await fs.readFile(path.join(cwd,'powershell-cli.log'),'utf8'),/CLI stderr progress/);
});

// Real Windows cancellation acceptance: no GPU required. Wait for the mock
// CLI to announce readiness before cancelling, then check that it is gone.
test('Windows actual PowerShell cancellation stops active owned mock CLI',{skip:process.platform!=='win32',timeout:45000},async t=>{
 const cwd=await fs.mkdtemp(path.join(os.tmpdir(),'scf ps cancel '));const controller=new AbortController();
 const cli=path.join(cwd,'slow.mjs');await fs.writeFile(cli,`import fs from 'node:fs';fs.writeFileSync('active.json',JSON.stringify({pid:process.pid}));await new Promise(r=>setTimeout(r,30000));`);
 const pending=invokePowerShellCli(cli,args,{cwd,signal:controller.signal}).then(()=>null,e=>e);
 t.after(async()=>{controller.abort();await pending;await fs.rm(cwd,{recursive:true,force:true,maxRetries:4,retryDelay:200});});
 let active;
 for(let i=0;i<200;i++){try{active=JSON.parse(await fs.readFile(path.join(cwd,'active.json'),'utf8'));break;}catch{}await new Promise(r=>setTimeout(r,50));}
 assert.ok(active?.pid,'Mock CLI must start before cancellation');controller.abort();
 const error=await pending;assert.match(error?.message??'',/Native Floaters cancelled/);
 assert.throws(()=>process.kill(active.pid,0),{code:'ESRCH'});
});
