'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const path=require('node:path');
const {pathToFileURL}=require('node:url');
test('SC-W01 cleaner window minimization preserves resize and never touches selection masks',async()=>{
 const {__testing}=await import(pathToFileURL(path.join(__dirname,'../index.js')).href);
 const make=()=>({style:{height:'580px',width:'430px',minHeight:'320px',resize:'both',display:'flex'},attrs:{},listeners:new Map(),
   addEventListener(k,f){this.listeners.set(k,f)},removeEventListener(k){this.listeners.delete(k)},
   setAttribute(k,v){this.attrs[k]=v},getBoundingClientRect(){return {width:420,height:550}}});
 const panel=make(),body=make(),button=make(),masks=Uint8Array.from([0,2,1,3]);
 global.window={};
 const ctrl=__testing.attachPluginWindow(panel,body,button);
 button.listeners.get('click')();assert.equal(body.style.display,'none');assert.equal(panel.style.resize,'none');
 button.listeners.get('click')();assert.equal(body.style.display,'flex');assert.equal(panel.style.resize,'both');
 assert.equal(panel.style.width,'420px');assert.equal(panel.style.height,'550px');
 assert.deepEqual(Array.from(masks),[0,2,1,3]);
 ctrl.dispose();delete global.window;
});
