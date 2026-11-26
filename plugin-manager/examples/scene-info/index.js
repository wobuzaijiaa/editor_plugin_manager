/** Public Editor inspection + optional Manager-authorized native HTTP service. */
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

// Explicitly select the documented layer fields rather than dump engine objects.
function sceneSummary(info, detailed) {
    const layers = info.layers || [];
    const lines = [
        componentVersions(), '',
        `Loaded layers: ${layers.length}`,
        `Total Gaussian instances: ${layers.reduce((sum, layer) => sum + layer.total, 0).toLocaleString('en-US')}`,
        `Active layer: ${layers.find(layer => layer.id === info.activeLayer)?.name ?? 'None'}`
    ];
    if (info.viewport?.renderSize) {
        const { width, height } = info.viewport.renderSize;
        lines.push(`Render size: ${width} × ${height} px`);
    }
    if (!layers.length) lines.push('No models loaded.');
    const xyz = v => v ? [v.x, v.y, v.z] : null;
    for (const layer of layers) {
        lines.push('', `${layer.name} (ID ${layer.id}, ${layer.visible ? 'visible' : 'hidden'})`,
            `  Instances: ${layer.total.toLocaleString('en-US')}`,
            `  Selected: ${layer.selected} | Hidden: ${layer.hidden} | Deleted: ${layer.deleted}`);
        if (detailed) {
            lines.push(JSON.stringify({
                position: xyz(layer.position),
                rotationQuaternion: layer.rotation ? [...xyz(layer.rotation), layer.rotation.w] : null,
                scale: xyz(layer.scale),
                worldBounds: layer.bounds ? { center: xyz(layer.bounds.center), halfExtents: xyz(layer.bounds.halfExtents) } : null,
                shBands: layer.shBands
            }, null, 2));
        }
    }
    return lines.join('\n');
}

export async function activate({ editor, uiHost, settings, advanced }) {
    if (typeof editor?.inspect?.scene !== 'function') {
        throw new Error('SuperSplat Editor inspect.scene API is unavailable.');
    }
    const native = advanced?.native;
    let panel, sceneText, nativeText, refresh, read, close;
    let inactive = false;
    let inspection = null;
    let operation = null;
    let controller = null;
    let cleanup = null;
    let nativeRequested = false;

    // Editor inspection stays entirely in the browser.
    function inspect() {
        if (inspection || cleanup || inactive) return;
        refresh.disabled = true;
        inspection = (async () => {
            try {
                const info = await editor.inspect.scene();
                if (inactive) return;
                sceneText.textContent = sceneSummary(info, settings?.['show-details'] === true);
            } catch (err) {
                if (!inactive) sceneText.textContent = `Inspection failed: ${err.message || err}`;
            } finally {
                refresh.disabled = !!cleanup || inactive;
            }
        })();
        // Prevent overlapping inspections; a pending read does not block cleanup.
        inspection.finally(() => { inspection = null; });
    }

    // A deliberate user action requests native execution. No start on activation/open.
    function readNative() {
        if (!native || operation || cleanup || inactive) return;
        read.disabled = true;
        nativeText.textContent = 'Requesting native service…';
        controller = new AbortController();
        const signal = controller.signal;
        nativeRequested = true;
        operation = (async () => {
            try {
                const service = await native.start({ signal });
                if (signal.aborted) return;
                if (service?.state !== 'running' || !Number.isInteger(service.port) ||
                    service.port < 1024 || service.port > 65535) {
                    throw new Error('Manager did not return a running service with an assigned port.');
                }
                // Always use the actual authorized port, never the preferred port.
                const response = await fetch(`http://127.0.0.1:${service.port}/info`, {
                    signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]), cache: 'no-store'
                });
                if (!response.ok) throw new Error(`Native HTTP ${response.status}`);
                const info = await response.json();
                if (!signal.aborted) nativeText.textContent = JSON.stringify({ port: service.port, ...info }, null, 2);
            } catch (err) {
                if (!signal.aborted) nativeText.textContent = `Native request failed: ${err.message || err}`;
            } finally {
                read.disabled = !!cleanup || inactive;
            }
        })();
        operation.finally(() => { operation = null; controller = null; });
    }

    // Abort a pending request, then use Manager Stop (not direct process control).
    function closePanel() {
        if (cleanup) return cleanup;
        if (!panel) return Promise.resolve();
        close.disabled = refresh.disabled = read.disabled = true;
        controller?.abort();
        cleanup = (async () => {
            // Issue Stop even if Start was cancelled; Manager owns pending startup.
            const pending = operation;
            let stopError;
            if (nativeRequested) {
                try {
                    await native.stop();
                } catch (err) { stopError = err; }
            }
            await pending;
            if (stopError) throw stopError;
            nativeRequested = false;
            nativeText.textContent = native ? 'Native service stopped.' : 'Native capability unavailable.';
            panel.hidden = true;
        })().finally(() => {
            cleanup = null;
            close.disabled = false;
            refresh.disabled = !!inspection;
            read.disabled = !native;
        });
        return cleanup;
    }

    function button(label, action) {
        const element = document.createElement('button');
        element.type = 'button';
        element.textContent = label;
        element.onclick = action;
        return element;
    }

    return {
        open() {
            if (inactive) throw new Error('Plugin is inactive.');
            if (cleanup) return;
            if (!panel) {
                panel = document.createElement('section');
                panel.className = 'blocks-shortcuts';
                panel.setAttribute('aria-label', 'Scene Information');
                panel.style.cssText = 'position:fixed;right:24px;top:90px;z-index:1300;width:320px;max-width:85vw;background:#292f38;color:#fff;border:1px solid #aaa;border-radius:8px;padding:12px;font:13px system-ui,sans-serif';
                const title = document.createElement('strong');
                title.textContent = 'Scene Information';
                sceneText = document.createElement('pre');
                nativeText = document.createElement('pre');
                for (const text of [sceneText, nativeText]) text.style.cssText = 'white-space:pre-wrap;overflow:auto;max-height:30vh;overflow-wrap:anywhere';
                nativeText.textContent = native ? 'Native service not requested.' : 'Native capability unavailable. Reactivate after backend recovery.';
                refresh = button('Refresh scene info', inspect);
                read = button('Read native info', readNative);
                read.disabled = !native;
                close = button('Close', () => {
                    closePanel().catch(err => { nativeText.textContent = `Cleanup failed; retry Close: ${err.message || err}`; });
                });
                panel.append(title, sceneText, refresh, document.createElement('hr'), nativeText, read, close);
                uiHost.append(panel);
            }
            panel.hidden = false;
            inspect();
        },
        isRunning() { return !inactive && (nativeRequested || !!operation || !!inspection || !!cleanup || !!(panel && !panel.hidden)); },
        async deactivate() {
            // Failure propagates to Manager; do not discard a handle with uncertain cleanup.
            await closePanel();
            inactive = true;
            panel?.remove();
            panel = null;
        }
    };
}
