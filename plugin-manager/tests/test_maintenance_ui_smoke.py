"""Synthetic Chromium lifecycle/UI test for simplified Manager; no live SuperSplat/HTTP."""
from pathlib import Path
import os
from playwright.sync_api import sync_playwright

src = Path(__file__).resolve().parents[1].joinpath('custom-editor.js').read_text()
src = src.replace("new URL('./plugins/', import.meta.url)", "new URL('https://fixture.invalid/plugins/')")
src = src.replace("new URL('./api/plugins/', import.meta.url)", "new URL('https://fixture.invalid/api/plugins/')")
with sync_playwright() as p:
    browser = p.chromium.launch(executable_path=os.environ.get('CHROMIUM_EXECUTABLE','/usr/bin/chromium'),
        headless=True, args=['--no-sandbox','--disable-dev-shm-usage'])
    page = browser.new_page()
    errors = []
    dialogs = []
    page.on('pageerror', lambda e: errors.append(str(e)))
    def accept_dialog(dialog):
        dialogs.append(dialog.message)
        dialog.accept()
    page.on('dialog', accept_dialog)
    page.set_content('<!DOCTYPE html><html><head></head><body><div>Editor fixture</div></body></html>')
    page.evaluate('''() => {
      const folder='scene-info_20261105T174600000Z',commit='4069712370df3425c386610f28a814403e835543';
      window.editor={viewport:{},inspect:{scene:()=>({})}};
      window.__catalog={schema_version:1,plugins:[{id:'scene-info',folder,enabled:false,settings:{}}]};
      window.__backendOnline=true;
      window.fetch=async (url,options={}) => {
        const u=String(url);let data;
        if(options.method==='DELETE' && u.endsWith('/scene-info')) {
          const payload=JSON.parse(options.body);
          if(JSON.stringify(payload.expected_catalog)!==JSON.stringify(window.__catalog))
            return {ok:false,status:409,json:async()=>({error:'stale catalog'})};
          window.__catalog={schema_version:1,plugins:[]};
          data={status:'Removed'};
        } else if(u.endsWith('/capabilities')) {
          if(!window.__backendOnline) return {ok:false,status:503};
          data={api_version:1,install:true,save:true,remove:true,local_only:true};
        }
        else if(u.endsWith('/manifest.json'))data=window.__catalog;
        else if(u.endsWith('/editor-api.json'))data={schema_version:1,commit,available_methods:['inspect.scene']};
        else if(u.endsWith('/plugin.json'))data={id:'scene-info',name:'Scene Information',classification:'Utility',version:'0.1.0',
          author:'Tester',date:'2026-11-05',description:'Test plugin',entry:'./index.js'};
        else if(u.endsWith('/audit.json'))data={status:'NOT_ASSESSED',editor_commit:commit,notices:['No usable API declaration']};
        else throw Error('Unexpected URL: '+u);
        return {ok:true,status:200,headers:{get:()=> 'application/json'},json:async()=>data};
      };
    }''')
    page.evaluate('''async code => await import('data:text/javascript;base64,'+btoa(unescape(encodeURIComponent(code))))''', src)
    page.wait_for_function("window.__superSplatPluginManager?.entries?.has('scene-info')")
    page.evaluate('''() => {
        const manager=window.__superSplatPluginManager;
        let working=false;
        manager.importer=async()=>({activate:async()=>({
            open(){working=true;},isRunning(){return working;},async deactivate(){working=false;}
        })});
    }''')
    page.get_by_role('button',name='Plugins ▲').click()
    page.get_by_role('button',name='Manage Plugins…').click()
    assert page.get_by_text('Not assessed').count() >= 1
    checkbox=page.locator('tbody input[type="checkbox"]').first
    checkbox.check()
    assert page.locator('tbody input[type="checkbox"]').last.is_disabled()
    expected=['Install Plugin','Refresh','Activate','Deactivate','Remove','Settings','Save']
    for name in expected:
        assert page.get_by_role('button',name=name,exact=True).count()==1, name
    # Refresh must re-probe backend availability without an Editor/browser reload.
    page.evaluate('window.__backendOnline=false')
    page.get_by_role('button',name='Refresh',exact=True).click()
    page.wait_for_function('window.__superSplatPluginManager.capabilities === null')
    assert page.get_by_role('button',name='Remove',exact=True).is_disabled()
    assert page.get_by_role('button',name='Install Plugin',exact=True).is_disabled()
    page.evaluate('window.__backendOnline=true')
    page.get_by_role('button',name='Refresh',exact=True).click()
    page.wait_for_function('window.__superSplatPluginManager.capabilities?.remove === true')
    assert page.get_by_role('button',name='Remove',exact=True).is_enabled()
    assert page.get_by_role('button',name='Install Plugin',exact=True).is_enabled()
    for name in ['Force Deactivate','Reassess','Reinstall']:
        assert page.get_by_role('button',name=name,exact=True).count()==0, name
    page.get_by_role('button',name='Activate',exact=True).click()
    page.get_by_text('Active · Closed',exact=True).wait_for(timeout=5000)
    assert page.locator('tbody input[type="checkbox"]').last.is_enabled()
    page.evaluate("window.__superSplatPluginManager.open('scene-info')")
    page.get_by_text('Active · Running',exact=True).wait_for(timeout=5000)
    page.get_by_role('button',name='Deactivate',exact=True).click()
    page.get_by_text('Inactive',exact=True).wait_for(timeout=5000)
    assert any('Cleanup may interrupt work' in d for d in dialogs), dialogs
    page.get_by_role('button',name='Activate',exact=True).click()
    page.get_by_text('Active · Closed',exact=True).wait_for(timeout=5000)
    page.evaluate("window.__superSplatPluginManager.open('scene-info')")
    page.get_by_text('Active · Running',exact=True).wait_for(timeout=5000)
    assert page.get_by_role('button',name='Remove',exact=True).is_enabled()
    page.get_by_role('button',name='Remove',exact=True).click()
    page.wait_for_function("window.__superSplatPluginManager.catalog.plugins.length===0")
    assert any('Manager will attempt cleanup' in d for d in dialogs), dialogs
    assert page.evaluate("window.__superSplatPluginManager.reloadRequiredIds.size")==0
    assert not errors, errors
    browser.close()
    print('SYNTHETIC_LIFECYCLE_UI_PASS: seven controls, conditional Deactivate warning, running Remove, diagnostics')
