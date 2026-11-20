'use strict';
/** Resolve the upstream checkout's TypeScript parser without invoking optional API inventories. */
const path=require('node:path');
function typeScriptFrom(source) {
    for (const location of [source,path.resolve(__dirname,'..','supersplat')]) {
        try { return require(require.resolve('typescript',{paths:[location]})); }
        catch(e) { if(e.code!=='MODULE_NOT_FOUND') throw e; }
    }
    return require('typescript');
}
module.exports={typeScriptFrom};
