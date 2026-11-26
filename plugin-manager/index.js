/** Minimal browser example: lifecycle, public viewport API and saved settings. */
// Optional UI metadata: the public Editor API does not expose component versions.
// Read the existing About panel without opening it or changing Editor state.
function componentVersions() {
    const app = document.querySelector('#about-app-version')?.textContent?.trim()
        || document.querySelector('#app-label span')?.textContent?.trim();
    const versions = new Map();
    for (const row of document.querySelectorAll('#about-deps .about-dep-row')) {
        const name = row.querySelector('.about-dep-name')?.textContent?.trim();
        const version = row.querySelector('.about-dep-version')?.textContent?.trim();
        if (name && version) versions.set(name, version);
    }
    return [
        `SuperSplat: ${app || 'Unavailable'}`,
        `PlayCanvas Engine: ${versions.get('Engine') || 'Unavailable'}`,
        `SplatTransform (Editor bundle): ${versions.get('Splat Transform') || 'Unavailable'}`,
        `PCUI: ${versions.get('PCUI') || 'Unavailable'}`
    ].join('\n');
}

export async function activate({ editor, uiHost, settings }) {
    if (typeof editor?.viewport?.info !== 'function') {
        throw new Error('SuperSplat Editor viewport.info API is unavailable.');
    }
    let panel = null;
    let output;
    let inactive = false;

    function refresh() {
        try {
            // Public read-only API: no scene modification or rendering command.
            const info = editor.viewport.info();
            const size = info.renderSize;
            const viewport = size ? `${size.width} × ${size.height} px` : 'Unavailable';
            const details = settings?.['show-details'] === true
                ? `\n\nViewport details:\n${JSON.stringify(info, null, 2)}` : '';
            output.textContent = `${componentVersions()}\n\nRender size: ${viewport}${details}`;
        } catch (error) {
            output.textContent = `Inspection failed: ${error.message || error}`;
        }
    }

    return {
        open() {
            if (inactive) throw new Error('Plugin is inactive.');
            if (!panel) {
                panel = document.createElement('section');
                panel.className = 'blocks-shortcuts';
                panel.setAttribute('aria-label', 'Hello Plugin');
                panel.style.cssText = 'position:fixed;top:55px;right:24px;z-index:1300;width:340px;max-width:85vw;background:#303844;color:white;padding:12px;border:1px solid #aaa;border-radius:6px;font:13px system-ui,sans-serif';
                const title = document.createElement('strong');
                title.textContent = 'Hello Plugin — Editor Information';
                output = document.createElement('pre');
                output.style.cssText = 'white-space:pre-wrap;overflow:auto;max-height:45vh;overflow-wrap:anywhere';
                const update = document.createElement('button');
                update.type = 'button';
                update.textContent = 'Refresh editor info';
                update.onclick = refresh;
                const close = document.createElement('button');
                close.type = 'button';
                close.textContent = 'Close';
                close.onclick = () => { panel.hidden = true; };
                panel.append(title, output, update, close);
                uiHost.append(panel);
            }
            panel.hidden = false;
            refresh();
        },
        isRunning() { return !!(panel && !panel.hidden); },
        async deactivate() {
            inactive = true;
            panel?.remove();
            panel = null;
        }
    };
}
