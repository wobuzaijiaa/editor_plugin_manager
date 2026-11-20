"""Chromium end-to-end smoke with a synthetic Editor, real local HTTP plugin server,
real package-folder upload and persistent manifest (not actual SuperSplat/WebGPU)."""
from pathlib import Path
import json, os, socket, subprocess, tempfile, time
from playwright.sync_api import sync_playwright

HERE = Path(__file__).resolve().parents[1]
with tempfile.TemporaryDirectory(prefix='spm-http-browser-') as td:
    dist = Path(td) / 'dist'
    (dist / 'plugins').mkdir(parents=True)
    (dist / 'plugins' / 'manifest.json').write_text('{"schema_version":1,"plugins":[]}',encoding='utf-8')
    (dist / 'plugins' / 'editor-api.json').write_text(json.dumps({'schema_version':1,
        'commit':'4069712370df3425c386610f28a814403e835543',
        'available_methods':['inspect.scene']}),encoding='utf-8')
    (dist / 'custom-editor.js').write_bytes((HERE/'custom-editor.js').read_bytes())
    (dist / 'index.html').write_text('''<!doctype html><html><head></head><body>
    <main>Mock SuperSplat Editor</main>
    <script>window.editor={viewport:{},inspect:{scene:async()=>({layers:2})}};</script>
    <script type="module" src="./custom-editor.js"></script>
    </body></html>''',encoding='utf-8')
    with socket.socket() as sock:
        sock.bind(('127.0.0.1',0));port=sock.getsockname()[1]
    proc=subprocess.Popen(['node',str(HERE/'local-server.cjs'),'--dist',str(dist),'--port',str(port)],
        stdout=subprocess.PIPE,stderr=subprocess.PIPE, text=True)
    try:
        time.sleep(.6)
        if proc.poll() is not None:
            raise RuntimeError('Local server failed to start: '+proc.communicate(timeout=2)[1])
        with sync_playwright() as p:
            browser=p.chromium.launch(executable_path=os.environ.get('CHROMIUM_EXECUTABLE','/usr/bin/chromium'),
                headless=True,args=['--no-sandbox','--disable-dev-shm-usage'])
            page=browser.new_page(accept_downloads=True)
            errors=[]
            page.on('pageerror',lambda e: errors.append(str(e)))
            page.on('dialog',lambda dialog: dialog.accept())
            last_error = None
            for _ in range(6):
                try:
                    page.goto(f'http://127.0.0.1:{port}/',wait_until='domcontentloaded',timeout=1800)
                    break
                except Exception as e:
                    last_error = e
                    time.sleep(.2)
            else:
                raise RuntimeError(f'Browser cannot navigate to loopback Editor: {last_error}')
            page.get_by_role('button',name='Plugins ▲').click(timeout=5000)
            page.get_by_role('button',name='Manage Plugins…').click()
            assert page.get_by_role('button',name='Install Plugin').is_enabled()
            assert page.get_by_role('button',name='Authorize installation folder').count()==0
            with page.expect_file_chooser() as chooser_info:
                page.get_by_role('button',name='Install Plugin').click()
            chooser_info.value.set_files(str(HERE/'examples'/'scene-info'))
            page.get_by_text('Scene Information',exact=True).wait_for(timeout=10000)
            assert page.get_by_text('Inactive',exact=True).count()>=1
            manifest=json.loads((dist/'plugins'/'manifest.json').read_text(encoding='utf-8'))
            assert len(manifest['plugins'])==1
            print('BROWSER_HTTP_INSTALL_PASS',manifest['plugins'][0]['folder'])
            page.get_by_role('checkbox').first.check()
            page.get_by_role('button',name='Activate',exact=True).click()
            page.get_by_text('Active · Closed',exact=True).wait_for(timeout=5000)
            page.get_by_role('button',name='Close',exact=True).click()
            page.get_by_role('button',name='Plugins ▲').click()
            page.get_by_role('button',name='Scene Information · Active · Closed').click()
            page.get_by_role('button',name='Refresh scene info').wait_for(timeout=3000)
            page.get_by_role('button',name='Plugins ▲').click()
            page.get_by_role('button',name='Manage Plugins…').click()
            page.get_by_text('Active · Running',exact=True).wait_for(timeout=3000)
            page.get_by_role('button',name='Deactivate',exact=True).click()
            page.get_by_text('Inactive',exact=True).wait_for(timeout=5000)
            print('BROWSER_HTTP_ACTIVE_DEACTIVATE_PASS')
            page.get_by_role('button',name='Activate',exact=True).click()
            page.get_by_text('Active · Closed',exact=True).wait_for(timeout=5000)
            page.evaluate("window.__superSplatPluginManager.open('scene-info')")
            page.get_by_text('Active · Running',exact=True).wait_for(timeout=5000)
            page.get_by_role('button',name='Remove',exact=True).click()
            page.wait_for_function('window.__superSplatPluginManager.catalog.plugins.length === 0',timeout=4000)
            assert json.loads((dist/'plugins'/'manifest.json').read_text(encoding='utf-8'))['plugins']==[]
            assert not errors,errors
            print('BROWSER_HTTP_REMOVE_PASS; CLIENT_PAGEERRORS=0')
            browser.close()
    finally:
        proc.terminate()
        try: proc.communicate(timeout=4)
        except subprocess.TimeoutExpired: proc.kill();proc.communicate()
