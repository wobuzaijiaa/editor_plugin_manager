'use strict';
/** Recheck every installed plugin against current static Editor API inventory.
 * This produces evidence, never executes imported plugin JS and never edits manifest.json.
 */
const fs=require('node:fs/promises');
const path=require('node:path');
const {pathToFileURL}=require('node:url');
const {packageAudit}=require('./plugin-compat.cjs');
const {typeScriptFrom}=require('./audit-editor-api.cjs');
async function auditStore(dist, ts=typeScriptFrom(path.dirname(path.resolve(dist)))) {
    const pluginRoot=path.join(path.resolve(dist),'plugins');
    const {validateCatalog, validateMetadata}=await import(pathToFileURL(path.join(__dirname,'custom-editor.js')).href);
    const catalog=validateCatalog(JSON.parse(await fs.readFile(path.join(pluginRoot,'manifest.json'),'utf8')));
    const inventory=JSON.parse(await fs.readFile(path.join(pluginRoot,'editor-api.json'),'utf8'));
    if (inventory.schema_version!==1 || !Array.isArray(inventory.available_methods) ||
        !/^[0-9a-f]{40}$/i.test(inventory.commit||'')) throw Error('Missing/invalid Editor API inventory: run full build');
    const summary={schema_version:1,editor_commit:inventory.commit,
        installed_count:catalog.plugins.length, plugins:[]};
    for (const p of catalog.plugins) {
        const folder=path.join(pluginRoot,p.folder);
        const stats=await fs.lstat(folder);
        if (!stats.isDirectory()||stats.isSymbolicLink()) throw Error('Unsafe plugin folder: '+p.folder);
        const meta=validateMetadata(JSON.parse(await fs.readFile(path.join(folder,'plugin.json'),'utf8')),p.id);
        const files=[];
        async function walk(directory,prefix='',depth=0) {
            if (depth>8) throw Error('Plugin directory nesting too deep');
            for (const item of await fs.readdir(directory,{withFileTypes:true})) {
                if (item.isSymbolicLink()) throw Error('Symlink in installed plugin: '+p.id);
                const rel=prefix ? prefix+'/'+item.name : item.name;
                if (item.isDirectory()) await walk(path.join(directory,item.name),rel,depth+1);
                else if (item.isFile() && rel!=='audit.json')
                    files.push({name:rel,data:await fs.readFile(path.join(directory,item.name))});
            }
        }
        await walk(folder);
        const audit=packageAudit(files,meta,inventory,ts);
        await fs.writeFile(path.join(folder,'audit.json'),JSON.stringify(audit,null,2)+'\n');
        summary.plugins.push({id:p.id,folder:p.folder,status:audit.status,notices:audit.notices});
    }
    summary.counts={};
    for (const status of ['STATIC_COMPATIBLE','REVIEW_REQUIRED','INCOMPATIBLE','NOT_ASSESSED'])
        summary.counts[status]=summary.plugins.filter(x=>x.status===status).length;
    return summary;
}
if(require.main===module){
    (async()=>{
        const args=process.argv.slice(2); const get=k=>args[args.indexOf(k)+1];
        if(!args.includes('--dist')||!args.includes('--output'))throw Error('Usage: node audit-plugin-store.cjs --dist <dist> --output <json>');
        const result=await auditStore(get('--dist'));
        await fs.writeFile(get('--output'),JSON.stringify(result,null,2)+'\n');
        process.stdout.write(`Plugin compatibility: ${result.installed_count} installed, ${result.counts.INCOMPATIBLE} incompatible, ${result.counts.REVIEW_REQUIRED} review required\n`);
    })().catch(e=>{process.stderr.write('Plugin compatibility screening failed: '+(e.stack||e)+'\n');process.exitCode=1;});
}
module.exports={auditStore};
