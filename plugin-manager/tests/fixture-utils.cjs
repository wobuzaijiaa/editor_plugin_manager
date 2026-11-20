'use strict';
const fs=require('node:fs/promises');
const net=require('node:net');
// For test-owned directories only. Exhausted retries are hard failures.
const removeFixture=root=>fs.rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:100});
function fixtureScope(t,root){
 const releases=[];
 t.after(async()=>{
  const errors=[];
  for(const release of releases.reverse())try{await release();}catch(e){errors.push(e);}
  if(!errors.length)try{await removeFixture(root);}catch(e){errors.push(e);}
  if(errors.length){console.error(`[Fixture cleanup failed] retained: ${root}`);throw new AggregateError(errors,`Fixture cleanup failed: ${root}: ${errors.map(e=>e.message).join('; ')}`);}
 });
 return {defer:fn=>releases.push(fn)};
}
function listen(server,port=0){return new Promise((resolve,reject)=>{
 const error=e=>{server.off('listening',ready);reject(e);};
 const ready=()=>{server.off('error',error);resolve(server.address().port);};
 server.once('error',error);server.once('listening',ready);server.listen(port,'127.0.0.1');
});}
async function closeServer(server){
 if(!server?.listening)return;
 await new Promise((resolve,reject)=>{
  const timer=setTimeout(()=>{reject(Error('Fixture server close timed out'));server.closeAllConnections?.();},10000);
  server.close(e=>{clearTimeout(timer);e?reject(e):resolve();});server.closeIdleConnections?.();
 });
}
async function closeBackend(server,closeNative){try{await closeNative();}finally{await closeServer(server);}}
async function freePort(){const s=net.createServer();const port=await listen(s);await closeServer(s);return port;}
module.exports={removeFixture,fixtureScope,listen,closeServer,closeBackend,freePort};
