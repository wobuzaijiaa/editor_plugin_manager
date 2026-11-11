# SuperSplat Plugin Developer Guide

**Target:** SuperSplat Plugin Manager v1.11 — Architecture C  
**Reviewed Editor baseline:** PlayCanvas SuperSplat Editor v3.7.0 (`4069712370df3425c386610f28a814403e835543`); not a version lock  
**Audience:** Developers of independently installable browser plugins

## 1. Purpose and responsibility boundary

Plugin Manager provides a **standard package and lifecycle integration mechanism** for [PlayCanvas SuperSplat Editor](https://github.com/playcanvas/supersplat). It is not a SuperSplat feature API, compatibility layer, or official PlayCanvas plugin SDK.

| Responsibility | Owner |
|---|---|
| Rendering, editing, scene objects, and Editor APIs | **SuperSplat Editor** |
| Plugin installation/removal, registration, lifecycle invocation, status, Startup preferences, and settings persistence | **Plugin Manager** (browser module and management backend) |
| Plugin functionality, UI, SuperSplat API usage, dependency declarations, resource cleanup, and compatibility testing | **Plugin developer** |

**Plugin developers are responsible for compatibility with both the Plugin Manager's package/lifecycle contract and the targeted SuperSplat Editor version.** The Manager supplies the `editor` reference and lifecycle context, but does not make internal Editor APIs stable, implement plugin-specific features, or certify browser/WebGPU behavior. Installation-time API/import findings are **advisory**; package validation is mandatory.

Prefer published Editor APIs where sufficient. Any internal Scene/Splat interfaces used by a plugin remain the plugin developer's maintenance responsibility. Plugin-specific behaviors such as XYZ Filter's model selection, preview restoration, or Gaussian export are **not** generic Manager requirements.

## 2. How plugins run

Architecture C uses SuperSplat's original static `serve` process and an independent management HTTP backend. The browser loads the Editor, Manager, and installed plugin modules from the static server; the backend alone manages persistent package operations in `supersplat/dist/plugins/`. The two servers share that directory but **do not communicate directly**.

- **Install** registers and copies a plugin; it does not execute its JavaScript.
- **Activate** imports the plugin and invokes `activate(context)`; saved **Startup** invokes activation when the Editor page initializes, without automatically opening its UI.
- **Open** invokes the plugin's `open()` method from the Editor Plugins menu.
- **Deactivate** calls `deactivate()` to request plugin-owned cleanup.
- **Remove → Install** replaces a release; it resets saved settings and Startup preferences.

Install, Save, and Remove require the management backend. Already-installed plugins may activate, open, and deactivate without it when the Editor/static server is available. The Manager's **Refresh** rechecks management-backend capabilities; it does not refresh plugin-specific model data.

## 3. Plugin package

Create a folder containing `plugin.json` and a browser-compatible ES-module entry point:

~~~text
my-plugin/
├── plugin.json
└── index.js
~~~

Example `plugin.json`:

~~~json
{
  "id": "my-plugin",
  "name": "My Plugin",
  "classification": "Utility",
  "version": "0.1.0",
  "author": "Example Developer",
  "date": "2026-11-11",
  "description": "A minimal managed SuperSplat plugin.",
  "entry": "./index.js",
  "requires": {
    "editor_api": [],
    "internal_api": []
  }
}
~~~

The ID remains stable across releases; increment `version` when publishing changes. `entry` must point to a local `.js` or `.mjs` module. `requires` is optional but recommended: list public Editor methods relative to `editor` (for example, `inspect.scene`), and list internal dependencies separately. Do **not** declare methods merely to obtain a favorable compatibility classification.

Optional fields include `settings_schema` (Manager-editable `boolean`, `number`, or `string` settings) and `third_party` (bundled library identity/version/license). The Manager **does not** install npm dependencies or automatically bundle code. Include browser-loadable local modules and assets in the package.

The current installer accepts one folder with **2–100 files** and up to **50 MiB** of decoded content, subject to path and metadata validation. See the Manager's validator/source for exact constraints.

## 4. Lifecycle interface

A plugin **must** export `activate(context)` and return callable `open()` and `deactivate()` methods. A synchronous boolean `isRunning()` is optional.

The Manager provides:

| Context property | Meaning |
|---|---|
| `editor` | SuperSplat's current typed/public Editor API object; **not a Manager-defined feature adapter** |
| `uiHost` | DOM container for plugin UI |
| `plugin` | Validated plugin metadata |
| `settings` | Saved settings snapshot at activation |
| `advanced` | Currently empty; not a supported internal API adapter |

Minimal `index.js` (no SuperSplat feature dependency):

~~~javascript
export async function activate({ uiHost }) {
    let panel = null;

    return {
        open() {
            if (!panel) {
                panel = document.createElement('section');
                panel.textContent = 'My Plugin';
                const close = document.createElement('button');
                close.textContent = 'Close';
                close.onclick = () => { panel.hidden = true; };
                panel.append(close);
                uiHost.append(panel);
            }
            panel.hidden = false;
        },
        isRunning() {
            return Boolean(panel && !panel.hidden);
        },
        async deactivate() {
            panel?.remove();
            panel = null;
        }
    };
}
~~~

**Lifecycle obligations:** Import must have no activation side effects. `open()` should not duplicate UI or listeners. `deactivate()` must finish or explicitly refuse cleanup when work remains, release plugin-owned resources, and restore any temporary Editor state. Do not claim success if restoration failed. `isRunning()` should accurately reflect open UI, pending work, or incomplete cleanup.

For scene-dependent code, validate target objects again after asynchronous work and avoid accessing deleted GPU resources. The exact precautions and tests depend on the plugin; the Manager does not implement them on the plugin's behalf.

## 5. Compatibility and testing

The Manager performs mandatory package/path/metadata checks and may provide advisory findings such as `STATIC_COMPATIBLE`, `REVIEW_REQUIRED`, `INCOMPATIBLE`, or `NOT_ASSESSED`. **These are not guarantees or runtime approval gates.** Even a statically compatible plugin may fail against a particular SuperSplat version or browser.

The plugin developer must:

1. Verify the Manager v1.11 manifest and lifecycle contract.
2. Verify required SuperSplat public/internal APIs against the **actual target Editor checkout**, not only the reviewed v3.7.0 baseline.
3. Declare dependencies truthfully in `plugin.json`; bundle browser-ready third-party code when needed and respect licenses.
4. Test activation, opening, repeated use, deactivation, and cleanup in a real Editor session with representative scene data.
5. Test plugin-specific failure cases and repeat compatibility checks after SuperSplat upgrades.

The optional API inventory at `supersplat/dist/plugins/editor-api.json` may help identify published methods. It is a source-derived reference, **not proof of runtime behavior**.

## 6. Install, update, and troubleshoot

Start the prepared Editor and management backend using the release's normal launcher (example Windows development setup):

~~~powershell
.\run_supersplatEditor_p3013.bat
~~~

Open `http://127.0.0.1:3013/` (example port), then choose **Plugins → Manage Plugins → Install Plugin** and select the entire plugin folder. **Activate** the installed entry, then **Open** it from the Plugins menu. If desired, enable **Startup** and click **Save**; new settings take effect after deactivation/reactivation.

For updates: **Deactivate → Remove → Install → Activate**. Reapply Startup/settings after installation. If cleanup failed or an old module may remain active, reload the Editor browser page before activating the same plugin ID again. The Manager cannot forcibly unload JavaScript already imported into another open tab.

| Symptom | Check first |
|---|---|
| Install/Save/Remove unavailable | Independent management backend and Manager **Refresh** |
| Plugin cannot activate | Browser console, module imports, `activate()` return methods, and actual Editor APIs |
| `REVIEW_REQUIRED` or `INCOMPATIBLE` | Installed `audit.json`; resolve dependencies and test behavior yourself |
| Duplicate UI or leftover scene state | Plugin `open()` and `deactivate()` implementation |
| Source changes not visible | Remove → Install a new copied release; reload if old cleanup is uncertain |

## 7. Release checklist

- [ ] `plugin.json` identifies the correct ID, version, author, entry point, and dependencies.
- [ ] Entry module exports `activate()` returning `open()` and `deactivate()`; optional `isRunning()` is accurate.
- [ ] Installation and import have no unwanted side effects; browser modules and required assets are included.
- [ ] Plugin functions and cleanup work in the **target SuperSplat Editor version**, including relevant error/scene-change cases.
- [ ] Manager status, Startup/settings (if used), Remove → Install, and repeat activation are tested.
- [ ] Licenses and third-party notices are included where applicable.

**Further references:** `SuperSplat_Plugin_Manager_Final_Architecture_and_Implementation_Guide_v1.11.md`, `SuperSplat_Plugin_Manager_HTTP_Architecture_Practical_Reference_v1.1.md`, and the relevant plugin-specific technical reference (for example, XYZ Filter v1.0.10). These contain implementation details intentionally omitted from this public guide.
