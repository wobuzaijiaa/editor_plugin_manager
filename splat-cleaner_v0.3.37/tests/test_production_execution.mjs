import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fixture} from './fixtures/native-cli-fixture.mjs';
import {detect,runProcessor} from '../native/service.mjs';
import {encodeGeometry} from '../native-floaters.mjs';

test('production calculation ignores diagnostic capture override, preserves mask and launch mode',async t=>{
 const f=await fixture(t),captureRoot=path.join(f.root,'must-not-exist');
 const saved=process.env.SCF_DEBUG_CAPTURE_DIR;
 process.env.SCF_DEBUG_CAPTURE_DIR=captureRoot;
 t.after(()=>{if(saved===undefined)delete process.env.SCF_DEBUG_CAPTURE_DIR;else process.env.SCF_DEBUG_CAPTURE_DIR=saved;});
 const info=await detect(f.pkg);const bytes=Buffer.from(await (await encodeGeometry(f.columns)).arrayBuffer());
 for(const mode of ['ok','loss']){
  const dir=await fs.mkdtemp(path.join(f.root,'production-'));const input=path.join(dir,'geometry.bin'),output=path.join(dir,'mask.bin');
  await fs.writeFile(input,bytes);await f.mode(mode);
  const run=runProcessor(['--run',info.cli,input,output,info.version,info.commit],{timeout:30000});
  if(mode==='ok'){
   const log=await run;assert.match(log,new RegExp('Launch mode: '+(process.platform==='win32'?'powershell-window':'direct-node')));
   assert.deepEqual([...await fs.readFile(output)],Array.from({length:28},(_,i)=>i===1?1:0));
  }else{await assert.rejects(run,/GPU error true/);await assert.rejects(fs.stat(output),{code:'ENOENT'});}
  await assert.rejects(fs.stat(captureRoot),{code:'ENOENT'});
  await assert.rejects(fs.stat(input),{code:'ENOENT'});
 }
});
