'use strict';
/** Source-derived SuperSplat internal interface discovery. NOT an endorsed API or runtime proof.
 * Audits the actual cloned Editor checkout. No upstream code executed or modified.
 */
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const {typeScriptFrom}=require('./audit-editor-api.cjs');
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const compact=s=>s.replace(/\s+/g,' ').trim();
function filesIn(directory, root, list=[]) {
    for (const ent of fs.readdirSync(directory,{withFileTypes:true})) {
        if (ent.name==='node_modules'||ent.name==='dist'||ent.name==='tests'||ent.name.startsWith('.'))continue;
        const abs=path.join(directory,ent.name);
        if(ent.isDirectory()) filesIn(abs,root,list);
        else if(ent.isFile()&&/\.tsx?$/.test(ent.name)&&!ent.name.endsWith('.d.ts'))list.push({abs,relative:path.relative(root,abs).split(path.sep).join('/')});
    }
    return list.sort((a,b)=>a.relative.localeCompare(b.relative));
}
function inventoryInternals(source,commit,ts=typeScriptFrom(source)) {
    const root=path.resolve(source);const pkg=JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8'));
    if(pkg.name!=='supersplat'||!/^[0-9a-f]{40}$/i.test(commit))throw Error('Expected SuperSplat source and commit');
    const input=filesIn(path.join(root,'src'),root);
    if(!input.length)throw Error('No TypeScript source in cloned SuperSplat checkout');
    const classes=new Map();const declarations=[];const source_sha256={};const registered=[];
    for(const {abs,relative} of input){
        const bytes=fs.readFileSync(abs);source_sha256[relative]=sha(bytes);
        const sf=ts.createSourceFile(relative,bytes.toString('utf8'),ts.ScriptTarget.Latest,true,abs.endsWith('.tsx')?ts.ScriptKind.TSX:ts.ScriptKind.TS);
        if(sf.parseDiagnostics.length)throw Error(`Cannot parse ${relative}: ${sf.parseDiagnostics[0].messageText}`);
        function visit(node){
            if((ts.isClassDeclaration(node)||ts.isInterfaceDeclaration(node))&&node.name){
                const cls={name:node.name.text,source:relative,node,sf,base:ts.isClassDeclaration(node)?node.heritageClauses?.flatMap(h=>h.types.map(t=>t.expression.getText(sf))).find(Boolean):undefined};
                if(!classes.has(cls.name))classes.set(cls.name,[]);
                classes.get(cls.name).push(cls);declarations.push(cls);
            }
            if(ts.isCallExpression(node)&&ts.isPropertyAccessExpression(node.expression)&&
               node.arguments.length>0&&ts.isStringLiteral(node.arguments[0])&&['function','on','fire','invoke'].includes(node.expression.name.text)) {
                // Observable event strings, without claiming they are all callable services.
                const n=node.arguments[0].text;
                registered.push({name:n,operation:node.expression.name.text,source:relative,line:sf.getLineAndCharacterOfPosition(node.getStart(sf)).line+1});
            }
            ts.forEachChild(node,visit);
        }visit(sf);
    }
    function cls(name){const xs=classes.get(name);return xs?.length===1?xs[0]:null;}
    const memberMap=new Map();
    function members(c,visited=new Set()){
        if(!c||visited.has(c.name))return new Map();visited.add(c.name);
        if(memberMap.has(c.name))return new Map(memberMap.get(c.name));
        const out=members(cls(c.base),visited);
        for(const m of c.node.members||[]){
            if(!m.name||!ts.isIdentifier(m.name)&&!ts.isStringLiteral(m.name))continue;
            if(m.modifiers?.some(mod=>mod.kind===ts.SyntaxKind.PrivateKeyword||mod.kind===ts.SyntaxKind.ProtectedKeyword))continue;
            const name=m.name.text;
            const method=ts.isMethodDeclaration(m)||ts.isMethodSignature(m);
            const getter=ts.isGetAccessorDeclaration(m)||ts.isSetAccessorDeclaration(m);
            const signature=method||getter?`(${(m.parameters||[]).map(p=>compact(p.getText(c.sf))).join(', ')})${m.type?' => '+compact(m.type.getText(c.sf)):''}`:null;
            let type=m.type?compact(m.type.getText(c.sf)):null;
            if(!type&&m.initializer&&ts.isNewExpression(m.initializer))type=m.initializer.expression.getText(c.sf);
            if(!type&&getter&&m.body) {
                const r=m.body.statements.find(ts.isReturnStatement);
                if(r&&ts.isPropertyAccessExpression(r.expression))type=null; // possible external; avoid invented type
            }
            const typeName=type?.match(/^(?:readonly\s+)?([A-Za-z_$][\w$]*)\b/)?.[1]||null;
            out.set(name,{name,kind:method?'method':getter?'accessor':'property',signature,type,typeName,
                source:c.source,line:c.sf.getLineAndCharacterOfPosition(m.getStart(c.sf)).line+1,declaring_class:c.name});
        }
        memberMap.set(c.name,new Map(out));return out;
    }
    const paths=[];const seen=new Set();
    function explore(prefix,c,depth){
        if(!c||depth>=4)return;
        for(const mem of [...members(c).values()].sort((a,b)=>a.name.localeCompare(b.name))){
            const pathname=prefix+'.'+mem.name;if(seen.has(pathname))continue;seen.add(pathname);
            const target=cls(mem.typeName);
            paths.push({path:pathname,kind:mem.kind,signature:mem.signature,type:mem.type,
                source:mem.source,line:mem.line,declaring_class:mem.declaring_class,
                expansion:target?'local_class':'unknown_or_external'});
            if(target&&mem.kind!=='method')explore(pathname,target,depth+1);
        }
    }
    for(const [prefix,name] of [['scene','Scene'],['splat','Splat']]){
        const rootClass=cls(name);
        if(!rootClass)throw Error(`Missing internal root class ${name} in cloned source`);
        explore(prefix,rootClass,0);
    }
    const mainPath=path.join(root,'src','main.ts');
    const main=fs.existsSync(mainPath)?fs.readFileSync(mainPath,'utf8'):'';
    const mainSF=ts.createSourceFile('main.ts',main,ts.ScriptTarget.Latest,true,ts.ScriptKind.TS);
    let exposesScene=false;
    function visitMain(node){
        if(ts.isBinaryExpression(node)&&node.operatorToken.kind===ts.SyntaxKind.EqualsToken&&
           ts.isPropertyAccessExpression(node.left)&&node.left.name.text==='scene'&&
           ts.isIdentifier(node.left.expression)&&node.left.expression.text==='window')exposesScene=true;
        ts.forEachChild(node,visitMain);
    }visitMain(mainSF);
    if(!exposesScene)throw Error('Internal Scene root not published as window.scene in src/main.ts');
    const class_catalog=declarations.map(c=>({name:c.name,source:c.source,member_count:members(c).size,
        members:[...members(c).values()].map(m=>({name:m.name,kind:m.kind,signature:m.signature,
            type:m.type,source:m.source,line:m.line})).sort((a,b)=>a.name.localeCompare(b.name))}));
    const events=[...new Map(registered.map(e=>[`${e.operation}:${e.name}:${e.source}:${e.line}`,e])).values()]
        .sort((a,b)=>a.name.localeCompare(b.name)||a.source.localeCompare(b.source));
    return {schema_version:1,inventory_kind:'supersplat_internal_source_static',supersplat_version:pkg.version,commit,
        generated_utc:new Date().toISOString(),assurance:'DECLARED_SOURCE_SURFACE_NOT_STABILITY_ACCESSIBILITY_OR_RUNTIME_PROOF',
        entry_roots:{scene:'window.scene (observed in src/main.ts)',splat:'Splat objects reachable via scene elements (type-dependent)'},
        source_files:input.length,source_sha256, class_count:class_catalog.length,class_catalog,
        interface_count:paths.length,interfaces:paths,events, event_occurrence_count:events.length};
}
function diffInternals(oldInv,newInv){
    if(!oldInv)return {status:'NO_PREVIOUS_INVENTORY',added:[],removed:[],changed:[]};
    const values=inv=>new Map((inv.interfaces||[]).map(x=>[x.path,JSON.stringify([x.kind,x.signature,x.type])]));
    const a=values(oldInv),b=values(newInv);
    const added=[...b.keys()].filter(p=>!a.has(p)).sort(),removed=[...a.keys()].filter(p=>!b.has(p)).sort();
    const changed=[...b.keys()].filter(p=>a.has(p)&&a.get(p)!==b.get(p)).sort();
    const flatten=inv=>new Map((inv.class_catalog||[]).flatMap(c=>(c.members||[]).map(m=>
        [`${c.source}#${c.name}.${m.name}`,JSON.stringify([m.kind,m.signature,m.type])])));
    const ac=flatten(oldInv),bc=flatten(newInv);
    const class_members_added=[...bc.keys()].filter(k=>!ac.has(k)).sort();
    const class_members_removed=[...ac.keys()].filter(k=>!bc.has(k)).sort();
    const class_members_changed=[...bc.keys()].filter(k=>ac.has(k)&&ac.get(k)!==bc.get(k)).sort();
    const eventNames=inv=>new Set((inv.events||[]).map(e=>`${e.operation}:${e.name}`));
    const ae=eventNames(oldInv),be=eventNames(newInv);
    const events_added=[...be].filter(x=>!ae.has(x)).sort(),events_removed=[...ae].filter(x=>!be.has(x)).sort();
    return {status:added.length||removed.length||changed.length||class_members_added.length||
        class_members_removed.length||class_members_changed.length||events_added.length||events_removed.length?'REVIEW_REQUIRED':'UNCHANGED',
        previous_commit:oldInv.commit,current_commit:newInv.commit,added,removed,changed,
        class_members_added,class_members_removed,class_members_changed,events_added,events_removed};
}
if(require.main===module){
    try{
        const a=process.argv.slice(2),opt=k=>a.includes(k)?a[a.indexOf(k)+1]:null;
        if(!opt('--source')||!opt('--commit')||!opt('--output')||!opt('--combined'))throw Error('Usage: audit-editor-internals.cjs --source <supersplat> --commit <40hex> --output <report> --combined <public-inventory> [--previous <inventory>] [--diff <report>]');
        const result=inventoryInternals(opt('--source'),opt('--commit'));
        const previous=opt('--previous')&&fs.existsSync(opt('--previous'))?JSON.parse(fs.readFileSync(opt('--previous'),'utf8')):null;
        const diff=diffInternals(previous?.internal_inventory||null,result);
        fs.writeFileSync(opt('--output'),JSON.stringify(result,null,2)+'\n');
        if(opt('--diff'))fs.writeFileSync(opt('--diff'),JSON.stringify(diff,null,2)+'\n');
        const combined=JSON.parse(fs.readFileSync(opt('--combined'),'utf8'));
        if(combined.commit!==result.commit||combined.schema_version!==1)throw Error('Public inventory revision differs from internal inventory');
        combined.internal_inventory=result;
        fs.writeFileSync(opt('--combined'),JSON.stringify(combined,null,2)+'\n');
        console.log(`Internal discovery: ${result.interface_count} reachable paths, ${result.class_count} class/interface declarations, ${result.event_occurrence_count} event references; diff ${diff.status}`);
    }catch(e){console.error('Internal interface inventory failed:',e.stack||e);process.exitCode=1;}
}
module.exports={inventoryInternals,diffInternals};
