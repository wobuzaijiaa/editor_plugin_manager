'use strict';
/** Narrow plugin compatibility screen; NOT a sandbox, security scan, or runtime guarantee. */
const path = require('node:path').posix;
const crypto = require('node:crypto');
/** Stable package identity across builds; generated audit.json is excluded. */
function packageDigest(files) {
    const hash=crypto.createHash('sha256');
    for (const file of [...files].filter(f=>f.name!=='audit.json').sort((a,b)=>a.name.localeCompare(b.name,'en'))) {
        const name=Buffer.from(file.name,'utf8');
        const length=Buffer.alloc(8);length.writeBigUInt64BE(BigInt(file.data.length));
        hash.update(name);hash.update(Buffer.from([0]));hash.update(length);hash.update(file.data);
    }
    return hash.digest('hex');
}

function requirements(meta) {
    const r = meta?.requires || {};
    const editor_api = Array.isArray(r.editor_api) ? r.editor_api : [];
    const internal_api = Array.isArray(r.internal_api) ? r.internal_api : [];
    const third_party = Array.isArray(meta?.third_party) ? meta.third_party : [];
    return { editor_api, internal_api, third_party };
}
function runtimeMethods(editor, paths) {
    return paths.filter(p => {
        let value = editor;
        for (const part of p.split('.')) { if (value == null) return true; value = value[part]; }
        return typeof value !== 'function';
    });
}
function declaredAudit(meta, inventory, editor = null) {
    const {editor_api, internal_api, third_party} = requirements(meta);
    const supported = new Set(inventory?.available_methods || []);
    const missing = inventory ? editor_api.filter(s => !supported.has(s)) : [];
    const absent_runtime = editor ? runtimeMethods(editor, editor_api) : [];
    const notices = [];
    if (!inventory) notices.push('Editor API inventory unavailable; plugin compatibility not assessed.');
    if (meta?.requires_declared === false) notices.push('No usable Editor API dependency declaration; compatibility not assessed.');
    if (missing.length) notices.push(`Required Editor API unavailable: ${missing.join(', ')}`);
    if (absent_runtime.length) notices.push(`Required runtime API missing: ${absent_runtime.join(', ')}`);
    if (internal_api.length) notices.push(`Internal SuperSplat APIs require manual review: ${internal_api.join(', ')}`);
    if (third_party.length) notices.push('Declared third-party libraries require license/security and runtime review; installation does not certify them.');
    return { status: missing.length || absent_runtime.length ? 'INCOMPATIBLE' :
        !inventory || meta?.requires_declared === false ? 'NOT_ASSESSED' :
        internal_api.length || third_party.length ? 'REVIEW_REQUIRED' : 'STATIC_COMPATIBLE',
        missing, absent_runtime, notices };
}
/** Internal requirements are checked against recorded source declarations, NOT certified as stable.
 * Unknown external/indirect types must not be mislabeled as absent.
 */
function auditInternalRequirements(meta, inventory) {
    const required=requirements(meta).internal_api;
    const internal=inventory?.internal_inventory;
    const index=new Map((internal?.interfaces||[]).map(x=>[x.path,x]));
    const roots=new Set(Object.keys(internal?.entry_roots||{}));
    const evidence=[];
    for(const raw of required){
        const name=raw.startsWith('window.scene.')?'scene.'+raw.slice('window.scene.'.length):
            raw==='window.scene'?'scene':raw;
        if(!internal||!['scene','splat'].some(root=>name===root||name.startsWith(root+'.'))){
            evidence.push({path:raw,status:'UNRESOLVED',reason:!internal?'No internal inventory generated for this Editor build':'Outside inventoried roots'});continue;
        }
        const node=index.get(name);
        if(node){evidence.push({path:raw,status:'FOUND_STATIC',kind:node.kind,signature:node.signature,
            source:node.source,line:node.line});continue;}
        const parts=name.split('.');
        let ancestor=null;
        for(let i=parts.length-1;i>1;i--){const a=index.get(parts.slice(0,i).join('.'));if(a){ancestor=a;break;}}
        const root=parts[0];
        if(name===root&&roots.has(root)){evidence.push({path:raw,status:'FOUND_STATIC',source:'src/main.ts'});continue;}
        if(!roots.has(root))evidence.push({path:raw,status:'UNRESOLVED',reason:'Unrecognized root'});
        else if(ancestor?.expansion==='local_class'&&parts.length<=4)
            evidence.push({path:raw,status:'MISSING_STATIC',reason:'Absent from locally declared class members',nearest:ancestor.path});
        else if(!ancestor&&parts.length===2)
            evidence.push({path:raw,status:'MISSING_STATIC',reason:'Absent from root class declaration'});
        else evidence.push({path:raw,status:'UNRESOLVED',reason:'Nested type is external, inferred, ambiguous or beyond inventory depth',nearest:ancestor?.path||root});
    }
    return {inventory_available:!!internal, evidence, found:evidence.filter(x=>x.status==='FOUND_STATIC').map(x=>x.path),
        missing:evidence.filter(x=>x.status==='MISSING_STATIC').map(x=>x.path),
        unresolved:evidence.filter(x=>x.status==='UNRESOLVED').map(x=>x.path)};
}
/** Files are {name, data:Buffer}, as produced by local-server upload validation. */
function packageAudit(files, meta, inventory, ts) {
    const result = declaredAudit(meta, inventory);
    const internal = auditInternalRequirements(meta, inventory);
    const notes = [...result.notices];
    const missingImports = [];
    const unknownImports = [];
    const undeclared = new Set();
    if (!ts) notes.push('TypeScript parser unavailable; JS syntax/import audit not assessed.');
    const filesByName = new Set(files.map(f => f.name));
    for (const file of files) {
        if (/(?:^|\/)(?:node_modules|vendor|third_party)\//i.test(file.name))
            unknownImports.push(`${file.name}: bundled external/library code requires review`);
        if (!/\.(?:js|mjs)$/.test(file.name)) continue;
        if (!ts) continue;
        if (file.data.length > 5 * 1024 * 1024) { unknownImports.push(`${file.name}: too large to inspect`); continue; }
        const sf = ts.createSourceFile(file.name, file.data.toString('utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);
        if (sf.parseDiagnostics.length) { missingImports.push(`${file.name}: JavaScript parse error`); continue; }
        const inspectSpecifier = spec => {
            if (typeof spec !== 'string') { unknownImports.push(`${file.name}: nonliteral import`); return; }
            if (spec.startsWith('./') || spec.startsWith('../')) {
                const target = path.normalize(path.join(path.dirname(file.name),spec));
                if (target === '..' || target.startsWith('../') || !filesByName.has(target)) missingImports.push(`${file.name}: missing local import ${spec}`);
            } else if (spec.startsWith('/') || !/^https?:\/\//.test(spec)) {
                // Import-map/bundler handling is unknown at this stage; record review,
                // not proof of an absent dependency or unsafe installation.
                unknownImports.push(`${file.name}: nonrelative module requires import-map/bundle review: ${spec}`);
            } else unknownImports.push(`${file.name}: remote module ${spec}`);
        };
        const pathOfCall = expr => {
            const parts=[];
            let x=expr;
            while (ts.isPropertyAccessExpression(x)) {parts.unshift(x.name.text);x=x.expression;}
            if (ts.isIdentifier(x)) parts.unshift(x.text);
            return parts;
        };
        function visit(n) {
            if ((ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) && n.moduleSpecifier)
                inspectSpecifier(ts.isStringLiteral(n.moduleSpecifier) ? n.moduleSpecifier.text : null);
            if (ts.isCallExpression(n) && n.expression.kind === ts.SyntaxKind.ImportKeyword)
                inspectSpecifier(n.arguments.length===1 && ts.isStringLiteral(n.arguments[0]) ? n.arguments[0].text : null);
            if (ts.isPropertyAccessExpression(n)) {
                const chain=pathOfCall(n);
                if ((chain[0]==='window' || chain[0]==='globalThis') && chain[1]==='scene' || chain[0]==='scene' && chain[1]==='commandQueue')
                    unknownImports.push(`${file.name}: internal Scene API access`);
                if (chain[0]==='editor' && chain.length >= 3 && ts.isCallExpression(n.parent) && n.parent.expression===n) {
                    const call=chain.slice(1).join('.');
                    if (!result.missing.includes(call) && !requirements(meta).editor_api.includes(call)) undeclared.add(call);
                }
            }
            ts.forEachChild(n,visit);
        }
        visit(sf);
    }
    if (missingImports.length) notes.push(...missingImports);
    if (internal.missing.length) notes.push(`Internal interfaces absent in source: ${internal.missing.join(', ')}`);
    if (internal.unresolved.length) notes.push(`Internal interfaces unresolved by static discovery: ${internal.unresolved.join(', ')}`);
    if (unknownImports.length) notes.push(...new Set(unknownImports));
    if (undeclared.size) notes.push(`Recognized Editor calls not declared in requires.editor_api: ${[...undeclared].sort().join(', ')}`);
    const status = result.status==='INCOMPATIBLE' || missingImports.length || internal.missing.length ? 'INCOMPATIBLE' :
        !ts || result.status==='NOT_ASSESSED' ? 'NOT_ASSESSED' :
        result.status==='REVIEW_REQUIRED' || unknownImports.length || undeclared.size ? 'REVIEW_REQUIRED' : 'STATIC_COMPATIBLE';
    return { schema_version:1, status, editor_commit:inventory?.commit || null,
        package_sha256:packageDigest(files),
        evaluation: {declared_requirements:meta.requires_declared !== false,
            public_api:!inventory?'NOT_ASSESSED':result.missing.length?'MISSING_REQUIRED':'CHECKED_STATIC',
            local_imports:!ts?'NOT_ASSESSED':missingImports.length?'UNRESOLVED':'CHECKED_STATIC',
            internal_interfaces:internal.missing.length?'MISSING_REQUIRED':
                internal.unresolved.length?'REVIEW_UNRESOLVED':
                requirements(meta).internal_api.length?'FOUND_STATIC_REVIEW_REQUIRED':'NONE_DECLARED',
            third_party:requirements(meta).third_party.length?'DECLARED_NOT_VERIFIED':'NONE_DECLARED',
            code_execution:'NOT_RUN', security:'NOT_ASSESSED'},
        declared_editor_api:requirements(meta).editor_api, missing_editor_api:result.missing,
        internal_dependencies:internal,
        missing_imports:missingImports, unresolved_imports:[...new Set(unknownImports)],
        undeclared_editor_calls:[...undeclared].sort(), notices:notes,
        assurance:'STATIC_SCREEN_NOT_A_SECURITY_OR_RUNTIME_CERTIFICATE' };
}
module.exports={requirements,runtimeMethods,declaredAudit,auditInternalRequirements,packageAudit,packageDigest};
