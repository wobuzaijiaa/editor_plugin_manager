"""Isolated Chromium UI test. Browser HTTP to loopback is blocked in this test environment;
this verifies visible controls against mocked service responses, not a live SuperSplat Editor.
"""
from pathlib import Path
import os
from playwright.sync_api import sync_playwright
src=Path(__file__).resolve().parents[1].joinpath('custom-editor.js').read_text()
src=src.replace("new URL('./plugins/', import.meta.url)", "new URL('https://fixture.invalid/plugins/')")
src=src.replace("new URL('./api/plugins/', import.meta.url)", "new URL('https://fixture.invalid/api/plugins/')")
with sync_playwright() as p:
    browser=p.chromium.launch(executable_path=os.environ.get('CHROMIUM_EXECUTABLE','/usr/bin/chromium'),
        headless=True,args=['--no-sandbox','--disable-dev-shm-usage'])
    page=browser.new_page()
    errors=[];page.on('pageerror',lambda error: errors.append(str(error)))
    page.set_content('<!DOCTYPE html><html><head></head><body><main>Mock Editor</main></body></html>')
    page.evaluate('''() => {
        window.editor={viewport:{},inspect:{scene:async()=>({layers:2})}};
        window.fetch=async url => {
          const u=String(url);
          if(u.endsWith('/capabilities'))return {ok:true,headers:{get:()=> 'application/json'},json:async()=>({api_version:1,install:true,save:true,remove:true,local_only:true})};
          if(u.endsWith('/manifest.json'))return {ok:true,headers:{get:()=> 'application/json'},json:async()=>({schema_version:1,plugins:[]})};
          if(u.endsWith('/editor-api.json'))return {ok:true,headers:{get:()=> 'application/json'},json:async()=>({schema_version:1,commit:'4069712370df3425c386610f28a814403e835543',available_methods:['inspect.scene']})};
          throw new Error('Unexpected request: '+u);
        };
    }''')
    page.evaluate('''async code => {
      await import('data:text/javascript;base64,'+btoa(unescape(encodeURIComponent(code))));
    }''',src)
    page.locator('#spm-toolbar').wait_for(timeout=5000)
    page.get_by_role('button',name='Plugins ▲').click()
    page.get_by_role('button',name='Manage Plugins…').click()
    assert page.get_by_role('button',name='Install Plugin').is_enabled()
    assert page.get_by_role('button',name='Authorize installation folder').count()==0
    assert page.get_by_role('button',name='Connect plugin directory').count()==0
    assert page.get_by_role('button',name='Load from Computer').count()==0
    # Verify that the manager allows using one source folder without asking where to install.
    page.evaluate('''() => {
        const m=window.__superSplatPluginManager;
        m.installFiles=async () => {
          const id='scene-info',folder='scene-info_20261105T174600000Z';
          const meta={id,name:'Scene Information',version:'0.1.0',classification:'Utility',
            author:'Tester',date:'2026-11-05',description:'Public API reference',entry:'./index.js',settings_schema:[]};
          m.catalog.plugins.push({id,folder,enabled:false,settings:{}});
          const entry={id,folder,meta,state:'Installed',module:null,handle:null,error:null};
          m.entries.set(id,entry);m.emit();return entry;
        };
    }''')
    with page.expect_file_chooser() as filechooser:
        page.get_by_role('button',name='Install Plugin').click()
    filechooser.value.set_files(str(Path(__file__).resolve().parents[1]/'examples'/'scene-info'))
    page.get_by_text('Scene Information',exact=True).wait_for(timeout=7000)
    assert page.get_by_text('Inactive',exact=True).count()>=1
    assert not errors,errors
    browser.close()
    print('SYNTHETIC_BROWSER_UI_PASS: single Install action, folder source selection, registered row; no destination picker')
