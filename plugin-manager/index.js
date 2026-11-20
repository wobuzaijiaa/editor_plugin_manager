/** Minimal independent plugin with visible Close and isRunning status. */
export async function activate({ uiHost }) {
    let panel = null;
    return {
        open() {
            if (!panel) {
                panel = document.createElement('section');
                panel.setAttribute('aria-label', 'Hello Plugin');
                panel.style.cssText = 'position:fixed;top:55px;right:24px;z-index:1300;background:#303844;color:white;padding:12px;border:1px solid #aaa;border-radius:6px;font:13px system-ui,sans-serif';
                const message = document.createElement('p');
                message.textContent = 'Hello from an independent SuperSplat plugin.';
                const close = document.createElement('button');
                close.type = 'button';
                close.textContent = 'Close';
                close.onclick = () => { panel.hidden = true; };
                panel.append(message, close);
                uiHost.append(panel);
            }
            panel.hidden = false;
        },
        isRunning() { return !!(panel && !panel.hidden); },
        async deactivate() { panel?.remove(); panel = null; }
    };
}
