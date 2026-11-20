'use strict';
/** Inventory the *typed, published* SuperSplat Editor API at a specific checkout.
 * Uses the same TypeScript compiler as the upstream build; never executes Editor code.
 * MIT: original Plugin Manager tooling, copyright (c) 2026 repo@gjt.
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {typeScriptFrom} = require('./typescript-loader.cjs');
function inventory(source, commit, ts = typeScriptFrom(source)) {
    const root = path.resolve(source);
    const owners = ['editor-api.ts', 'editor-session.ts', 'editor-timeline.ts'];
    const parsed = new Map();
    const hashes = {};
    for (const name of owners) {
        const abs = path.join(root, 'src', name);
        const bytes = fs.readFileSync(abs);
        hashes[`src/${name}`] = crypto.createHash('sha256').update(bytes).digest('hex');
        const sf = ts.createSourceFile(name, bytes.toString('utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
        if (sf.parseDiagnostics.length) throw new Error(`Cannot parse src/${name}: ${sf.parseDiagnostics[0].messageText}`);
        parsed.set(name, sf);
    }
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    if (pkg.name !== 'supersplat') throw new Error('Expected upstream SuperSplat package.json');
    const factoryNames = {
        'editor-api.ts': 'createEditorAPI',
        'editor-session.ts': 'createEditorSession'
    };
    function rootReturn(file) {
        const sf = parsed.get(file);
        const name = factoryNames[file];
        const declaration = sf.statements.filter(ts.isVariableStatement)
            .flatMap(s => [...s.declarationList.declarations])
            .find(d => d.name.getText(sf) === name);
        if (!declaration || !declaration.initializer || !declaration.initializer.body ||
            !ts.isBlock(declaration.initializer.body)) throw new Error(`Factory ${name} not found in ${file}`);
        const returns = declaration.initializer.body.statements
            .filter(ts.isReturnStatement).map(s => s.expression).filter(ts.isObjectLiteralExpression);
        if (returns.length !== 1) throw new Error(`Ambiguous public API return in ${file}`);
        return returns[0];
    }
    const apiRoot = rootReturn('editor-api.ts');
    const sessionRoot = rootReturn('editor-session.ts');
    const results = new Map();
    const key = node => node.name && (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name))
        ? node.name.text : null;
    const compact = value => value.replace(/\s+/g, ' ').trim();
    const describe = (expr, owner) => {
        if (ts.isArrowFunction(expr) || ts.isFunctionExpression(expr)) {
            const ps = expr.parameters.map(p => compact(p.getText(parsed.get(owner))));
            return `${expr.modifiers?.some(m => m.kind === ts.SyntaxKind.AsyncKeyword) ? 'async ' : ''}(${ps.join(', ')})`;
        }
        return `delegated:${compact(expr.getText(parsed.get(owner)))}`;
    };
    function propertyOf(rootObj, name) {
        return rootObj.properties.find(p => ts.isPropertyAssignment(p) && key(p) === name)?.initializer;
    }
    function walk(obj, prefix, owner) {
        for (const prop of obj.properties) {
            if (ts.isSpreadAssignment(prop)) {
                const ref = compact(prop.expression.getText(parsed.get(owner)));
                if (owner === 'editor-api.ts' && ref === 'session.viewport') {
                    const vp = propertyOf(sessionRoot, 'viewport');
                    if (!vp || !ts.isObjectLiteralExpression(vp)) throw new Error('Cannot resolve session.viewport spread');
                    walk(vp, prefix, 'editor-session.ts');
                } else throw new Error(`Unresolved Editor API spread: ${ref}`);
                continue;
            }
            const name = key(prop);
            if (!name) throw new Error(`Unknown public API property at ${owner}`);
            const pathname = prefix ? `${prefix}.${name}` : name;
            if (ts.isMethodDeclaration(prop)) {
                results.set(pathname, {path: pathname, signature: `(${prop.parameters.map(p => compact(p.getText(parsed.get(owner)))).join(', ')})`, source: `src/${owner}`});
            } else if (ts.isShorthandPropertyAssignment(prop)) {
                results.set(pathname, {path: pathname, signature: `delegated:${name}`, source: `src/${owner}`});
            } else if (ts.isPropertyAssignment(prop)) {
                const init = prop.initializer;
                if (ts.isObjectLiteralExpression(init)) walk(init, pathname, owner);
                else if (owner === 'editor-api.ts' && compact(init.getText(parsed.get(owner))) === 'session.files') {
                    const files = propertyOf(sessionRoot, 'files');
                    if (!files || !ts.isObjectLiteralExpression(files)) throw new Error('Cannot resolve session.files');
                    walk(files, pathname, 'editor-session.ts');
                } else results.set(pathname, {path: pathname, signature: describe(init, owner), source: `src/${owner}`});
            } else throw new Error(`Unsupported API member ${name}`);
        }
    }
    walk(apiRoot, '', 'editor-api.ts');
    const methods = [...results.values()].sort((a, b) => a.path.localeCompare(b.path));
    if (methods.length < 25 || !['inspect.scene', 'layers.list', 'viewport.captureFrame', 'files.export', 'on']
        .every(p => results.has(p))) throw new Error('EditorAPI inventory incomplete; inspect upstream API shape');
    return { schema_version: 1, inventory_kind: 'typed_editor_api_static',
        supersplat_version: pkg.version, commit, generated_utc: new Date().toISOString(),
        source_sha256: hashes, method_count: methods.length, available_methods: methods.map(m => m.path), methods,
        assurance: 'SOURCE_INVENTORY_ONLY_NOT_RUNTIME_CERTIFICATION' };
}
function diffInventory(oldInv, newInv) {
    if (!oldInv) return {status:'NO_PREVIOUS_INVENTORY', added:[],removed:[],signature_changed:[]};
    const old = new Map((oldInv.methods || []).map(m => [m.path, m.signature]));
    const current = new Map((newInv.methods || []).map(m => [m.path, m.signature]));
    const added = [...current.keys()].filter(k => !old.has(k)).sort();
    const removed = [...old.keys()].filter(k => !current.has(k)).sort();
    const signature_changed = [...current.keys()].filter(k => old.has(k) && old.get(k) !== current.get(k)).sort();
    return {status: added.length || removed.length || signature_changed.length ? 'REVIEW_REQUIRED' : 'UNCHANGED',
        previous_commit: oldInv.commit, current_commit: newInv.commit, added, removed, signature_changed};
}
if (require.main === module) {
    try {
        const args = process.argv.slice(2);
        const opt = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
        const source = opt('--source'), output = opt('--output'), commit = opt('--commit');
        if (!source || !output || !/^[0-9a-f]{40}$/i.test(commit || '')) {
            throw new Error('Usage: node audit-editor-api.cjs --source <supersplat> --commit <40-hex> --output <json> [--previous <json>] [--diff <json>]');
        }
        const result = inventory(source, commit);
        fs.writeFileSync(output, JSON.stringify(result,null,2)+'\n');
        const old = opt('--previous');
        const previous = old && fs.existsSync(old) ? JSON.parse(fs.readFileSync(old,'utf8')) : null;
        const difference = diffInventory(previous, result);
        if (opt('--diff')) fs.writeFileSync(opt('--diff'), JSON.stringify(difference,null,2)+'\n');
        process.stdout.write(`Editor API: ${result.method_count} typed method paths; change review: ${difference.status}\n`);
    } catch (e) { process.stderr.write(`Editor API inventory failed: ${e.stack||e}\n`); process.exitCode=1; }
}
module.exports = { inventory, diffInventory, typeScriptFrom };
