'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const code=fs.readFileSync(path.join(__dirname,'../index.js'),'utf8');
test('XYZ-W01 minimize/restore preserves panel state and click-to-front is bounded',()=>{
 const begin=code.indexOf('function attachPluginWindow(');
 const end=code.indexOf('\n}\n',begin);
 const ctx=vm.createContext({window:{}});
 const create=vm.runInContext(`(()=>{${code.slice(begin,end+3)};return attachPluginWindow})()`,ctx);
 const make=()=>({style:{height:'450px',width:'410px',resize:'both',display:'block'},listeners:new Map(),attrs:{},
   addEventListener(n,f){this.listeners.set(n,f)},removeEventListener(n){this.listeners.delete(n)},
   setAttribute(k,v){this.attrs[k]=v},getBoundingClientRect(){return {width:400,height:440}}});
 const panel=make(),body=make(),btn=make(),other=make(),otherBody=make(),otherBtn=make();
 const a=create(panel,body,btn),b=create(other,otherBody,otherBtn);
 assert.equal(other.style.zIndex,'1151');
 panel.listeners.get('pointerdown')();assert.equal(panel.style.zIndex,'1151');
 btn.listeners.get('click')();assert.equal(body.style.display,'none');assert.equal(a.isMinimized(),true);
 assert.equal(panel.style.height,'auto');
 btn.listeners.get('click')();assert.equal(body.style.display,'block');assert.equal(panel.style.height,'440px');
 a.dispose();b.dispose();assert.equal(ctx.window.__supersplatPluginFloatingStackV1.panels.length,0);
});
