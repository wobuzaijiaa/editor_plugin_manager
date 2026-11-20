/** Scene Information — public-API reference plugin (no import-time side effects). */
export async function activate({ editor, uiHost, settings }) {
    if (!editor?.inspect) throw new Error('SuperSplat Editor inspect API is unavailable.');
    let panel = null;
    let closed = false;
    let updating = false;
    const open = async () => {
        if (closed) throw new Error('Plugin is inactive.');
        if (!panel) {
            panel = document.createElement('section');
            panel.className = 'blocks-shortcuts';
            panel.style.cssText = 'position:fixed;right:24px;top:90px;z-index:1300;max-width:340px;background:#292f38;color:#fff;border:1px solid #aaa;border-radius:8px;padding:12px;font:13px system-ui,sans-serif;box-shadow:0 6px 20px #0008';
            const title = document.createElement('strong');
            title.textContent = 'Scene Information';
            const header = document.createElement('div');
            header.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:12px';
            const close = document.createElement('button');
            close.type = 'button';
            close.textContent = 'Close';
            close.onclick = () => { panel.hidden = true; };
            header.append(title, close);
            const content = document.createElement('pre');
            content.style.cssText = 'white-space:pre-wrap;max-height:40vh;overflow:auto';
            content.textContent = 'Reading Editor scene…';
            const refresh = document.createElement('button');
            refresh.textContent = 'Refresh scene info';
            const update = async () => {
                if (!panel || closed) return;
                updating = true;
                try {
                    const info = typeof editor.inspect.scene === 'function'
                        ? await editor.inspect.scene() : { inspect: 'Scene inspector method unavailable' };
                    if (!closed && panel) {
                        content.textContent = settings?.['show-details'] === true
                            ? JSON.stringify(info, null, 2).slice(0, 12000)
                            : `Scene inspection available. ${Object.keys(info || {}).length} top-level fields returned.`;
                    }
                } catch (err) {
                    if (!closed && panel) content.textContent = `Inspection unavailable: ${err.message || err}`;
                } finally { updating = false; }
            };
            refresh.onclick = update;
            panel.append(header, document.createElement('hr'), content, refresh);
            uiHost.append(panel);
            await update();
        }
        panel.hidden = false;
    };
    return {
        open,
        isRunning() { return updating || !!(panel && !panel.hidden); },
        async deactivate() {
            closed = true;
            panel?.remove();
            panel = null;
        }
    };
}
