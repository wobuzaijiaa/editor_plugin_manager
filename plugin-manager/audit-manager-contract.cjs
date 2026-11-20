'use strict';
/** Mandatory Manager bootstrap audit, independent of advisory Editor API inventories.
 * Source-level continuity check only; browser tests assess the runtime contract.
 */
const fs = require('node:fs');
const path = require('node:path');
const {typeScriptFrom} = require('./typescript-loader.cjs'); // independent of optional auditors

function auditManagerContract(source, managerPath, ts=typeScriptFrom(source)) {
    const readTs = file => {
        const code = fs.readFileSync(path.join(source,'src',file),'utf8');
        const sf = ts.createSourceFile(file,code,ts.ScriptTarget.Latest,true,ts.ScriptKind.TS);
        if (sf.parseDiagnostics.length) throw Error(`Cannot parse src/${file}`);
        return sf;
    };
    const main = readTs('main.ts');
    const api = readTs('editor-api.ts');
    const strip = expression => {
        while (expression && (ts.isParenthesizedExpression(expression) || ts.isAsExpression(expression) ||
            ts.isNonNullExpression(expression) || (ts.isSatisfiesExpression && ts.isSatisfiesExpression(expression)))) {
            expression=expression.expression;
        }
        return expression;
    };
    let publishesEditor=false;
    const factoryVariables=new Set(), assignedValues=[];
    const invokesEditorFactory = expr => ts.isCallExpression(strip(expr)) &&
        ts.isIdentifier(strip(expr).expression) && strip(expr).expression.text==='createEditorAPI';
    function findPublish(node) {
        if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) &&
            node.initializer && invokesEditorFactory(node.initializer)) factoryVariables.add(node.name.text);
        if (ts.isBinaryExpression(node) && node.operatorToken.kind===ts.SyntaxKind.EqualsToken) {
            const left=strip(node.left);
            if (ts.isPropertyAccessExpression(left) && left.name.text==='editor' &&
                ts.isIdentifier(strip(left.expression)) && strip(left.expression).text==='window') {
                publishesEditor=true;
                assignedValues.push(strip(node.right));
            }
        }
        ts.forEachChild(node,findPublish);
    }
    findPublish(main);
    const publishesFactory = assignedValues.some(expr=>invokesEditorFactory(expr) ||
        (ts.isIdentifier(expr) && factoryVariables.has(expr.text)));
    // Only inspect the top-level factory return used by window.editor. Full method inventory
    // is optional and must never become a dependency of this mandatory bootstrap gate.
    const factory = api.statements.filter(ts.isVariableStatement)
        .flatMap(statement=>[...statement.declarationList.declarations])
        .find(decl=>ts.isIdentifier(decl.name) && decl.name.text==='createEditorAPI');
    let root=null;
    if (factory?.initializer && ts.isArrowFunction(factory.initializer) &&
        ts.isBlock(factory.initializer.body)) {
        const returns=factory.initializer.body.statements.filter(ts.isReturnStatement)
            .map(statement=>strip(statement.expression)).filter(ts.isObjectLiteralExpression);
        if (returns.length===1) root=returns[0];
    }
    const propertyNames=new Set((root?.properties||[]).map(p=>{
        const name=p.name;
        return name && (ts.isIdentifier(name)||ts.isStringLiteral(name)) ? name.text : null;
    }).filter(Boolean));
    const manager=fs.readFileSync(managerPath,'utf8');
    const checks={
        native_editor_global_declared:publishesEditor,
        native_editor_uses_typed_factory:publishesFactory,
        typed_editor_factory_declared:!!root,
        typed_inspection_root_available:propertyNames.has('inspect'),
        typed_viewport_root_available:propertyNames.has('viewport'),
        plugin_manager_consumes_editor_global:/\bwindow\.editor\b/.test(manager),
        plugin_manager_waits_for_inspection:/\bwindow\.editor\?\.inspect\b/.test(manager),
        plugin_manager_waits_for_viewport:/\bwindow\.editor\?\.viewport\b/.test(manager),
        manager_no_direct_scene_global:!/\bwindow\.scene\b/.test(manager)
    };
    const missing=Object.keys(checks).filter(k=>!checks[k]);
    return {schema_version:2,status:missing.length?'FAIL':'PASS_STATIC',checks,missing,
        manager_dependency_scope:'window.editor and top-level inspect/viewport readiness',
        inventory_dependency:'NONE',assurance:'STATIC_SOURCE_CONTINUITY_ONLY_NOT_RUNTIME_CERTIFICATION'};
}
if(require.main===module){
    try{
        const args=process.argv.slice(2);const opt=name=>{
            const i=args.indexOf(name);return i<0?null:args[i+1];
        };
        const source=opt('--source'),manager=opt('--manager'),output=opt('--output');
        if(!source||!manager||!output) throw Error('Usage: audit-manager-contract.cjs --source <supersplat> --manager <custom-editor.js> --output <report>');
        const result=auditManagerContract(source,manager);
        fs.writeFileSync(output,JSON.stringify(result,null,2)+'\n');
        console.log(`Manager bootstrap contract: ${result.status}; missing=${result.missing.join(',')||'none'}`);
        if(result.status!=='PASS_STATIC')process.exitCode=1;
    }catch(e){console.error('Manager bootstrap audit failed: '+(e.stack||e));process.exitCode=1;}
}
module.exports={auditManagerContract};
