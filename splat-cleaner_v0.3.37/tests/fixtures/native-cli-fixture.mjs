import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {smokeColumns} from '../../native/processor.mjs';
export async function fixture(t,existingRoot){
 const root=existingRoot??await fs.mkdtemp(path.join(os.tmpdir(),'scf-cli-'));if(!existingRoot)t.after(()=>fs.rm(root,{recursive:true,force:true,maxRetries:4,retryDelay:100}));
 const pkg=path.join(root,'node_modules','@playcanvas','splat-transform');await fs.mkdir(pkg,{recursive:true});
 await fs.writeFile(path.join(pkg,'package.json'),JSON.stringify({name:'@playcanvas/splat-transform',version:'3.11.2',bin:{'splat-transform':'cli.mjs'}}));
 const behavior=path.join(root,'behavior.json');await fs.writeFile(behavior,JSON.stringify({mode:'ok'}));
 await fs.writeFile(path.join(pkg,'cli.mjs'),`import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';import {pathToFileURL} from 'node:url';
 const cfg=JSON.parse(fs.readFileSync(${JSON.stringify(behavior)},'utf8'));const args=process.argv.slice(2);
 if(args[0]==='--version'){console.log(cfg.mode==='bad-version'?'splat-transform v9.9.9 (changed)':'splat-transform v3.11.2 (6f64293)');process.exit(0);}
 assert.deepEqual(args,['-g','0','--no-tty','--verbose','--memory','--gpu-backend',cfg.gpuBackend??'vulkan','input.ply','--filter-floaters=0.05,0.1,0.00392156862745098','retained.ply']);
 assert.equal(fs.existsSync('geometry.bin'),false,'SCF2 must be deleted before CLI execution');
 const buf=fs.readFileSync('input.ply'),end=buf.indexOf('end_header\\n')+11;
 const header=buf.subarray(0,end).toString();const count=Number(header.match(/element vertex (\\d+)/)[1]);
 const names=[...header.matchAll(/property (float|uint) (\\w+)/g)].map(m=>m[2]);assert.equal(names.length,18);assert.equal(buf.length,end+count*72);
 const rows=Array.from({length:count},(_,i)=>Object.fromEntries(names.map((k,j)=>[k,k==='_cleaner_instance_id'?buf.readUInt32LE(end+i*72+j*4):buf.readFloatLE(end+i*72+j*4)])));
 if(cfg.mode==='slow'){fs.writeFileSync(${JSON.stringify(path.join(root,'active.json'))},JSON.stringify({pid:process.pid,input:path.resolve('geometry.bin')}));await new Promise(r=>setTimeout(r,30000));}
 const selected=cfg.mode==='duplicate'?[rows[0],rows[0]]:cfg.mode==='range'?[{...rows[0],_cleaner_instance_id:count}]:cfg.mode==='empty'?[]:rows.filter((r,i)=>i!==(cfg.mode==='smoke'?27:1)).reverse();
 if(cfg.mode==='position')selected[0].x+=10;if(cfg.mode==='opacity')selected[0].opacity=-3;
 if(cfg.mode==='rotation')selected[0].rot_0+=.25;
 if(cfg.mode==='sign')for(const r of selected)for(let i=0;i<4;i++)r['rot_'+i]*=-1;
 const props=(cfg.mode==='ids-only'?['_cleaner_instance_id']:cfg.mode==='missing'?names.filter(k=>k!=='_cleaner_instance_id'):names).reverse();
 const outHeader=Buffer.from(['ply','format binary_little_endian 1.0','element vertex '+selected.length,...props.map(k=>'property '+(k==='_cleaner_instance_id'?'uint':'float')+' '+k),'end_header',''].join('\\n'));
 const out=Buffer.alloc(selected.length*props.length*4);for(let i=0;i<selected.length;i++)for(let j=0;j<props.length;j++){const k=props[j],o=(i*props.length+j)*4;if(k==='_cleaner_instance_id')out.writeUInt32LE(selected[i][k],o);else out.writeFloatLE(selected[i][k],o);}
 if(cfg.mode!=='no-output')fs.writeFileSync('retained.ply',Buffer.concat([outHeader,cfg.mode==='truncated'?out.subarray(0,-1):out]));
 if(cfg.mode==='loss')console.error('WebGPU device lost: reason=unknown, message=mock');
 if(cfg.mode==='error'){process.stderr.write('WebGPU out-of-');await new Promise(r=>setTimeout(r,20));process.stderr.write('memory: mock\\n');}
 if(cfg.mode==='nonzero')process.exitCode=1;
 `);
 const columns=smokeColumns();columns.x[0]=-1.25;columns.y[0]=3.5;columns.rot_0[0]=.5;columns.rot_1[0]=.5;columns.rot_2[0]=.5;columns.rot_3[0]=.5;
 return {root,pkg,columns,behavior,mode:(mode,gpuBackend)=>fs.writeFile(behavior,JSON.stringify({mode,gpuBackend}))};
}
