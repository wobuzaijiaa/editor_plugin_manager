# SuperSplat Plugin Manager

A lightweight plugin framework for [PlayCanvas SuperSplat Editor](https://github.com/playcanvas/supersplat). It enables independently developed extensions **without modifying upstream TypeScript source files or rebuilding the Editor for each plugin update**.

SuperSplat remains the host application; Plugin Manager handles plugin installation, lifecycle, settings, and Editor integration. Two independent plugins demonstrate the framework:

- **XYZ Filter, Snapshot & Export** — Interactive 3DGS filtering, spatial inspection, snapshots, and model export with transformation-aware metadata.
- **Splat Cleaner** — Region-aware 3DGS cleanup.

**Versions:** Plugin Manager v1.11 · XYZ Filter v1.0.10 · Splat Cleaner v0.2.6  
**Reviewed Editor baseline:** SuperSplat v3.7.0 (`4069712370df3425c386610f28a814403e835543`); not a mandatory version lock.

## Architecture

The framework retains SuperSplat's **original static HTTP server** and adds an **independent Node.js management backend** for persistent plugin operations. The browser-side Manager handles activation and UI lifecycle.

| Component | Responsibility | Location |
|---|---|---|
| Original SuperSplat `serve` | Serve Editor and installed plugin files | `supersplat/dist/` |
| Browser Plugin Manager | Plugin lifecycle management | `plugin-manager/custom-editor.js` → `dist/custom-editor.js` |
| Management backend | As backend Server for packages Install/remove, manifest, settings, and Startup preferences | `supersplat/dist/runtime/management-server.cjs` |
| Plugin store | Installed packages and catalog | `supersplat/dist/plugins/` |

The two servers **share the plugin directory but do not communicate directly**: the browser loads static files from SuperSplat and sends management requests to the backend. No duplicate Editor installation or upstream TypeScript modification is required.

## Plugin Manager

- **Independent updates:** Install a complete local plugin folder; update with **Remove → Install**, without rebuilding the Editor.
- **Managed lifecycle:** Activate, open, deactivate, and remove plugins, with runtime status and error reporting.
- **Persistent settings:** Save plugin configuration and optional **Startup** activation.
- **Backend recovery:** **Refresh** rechecks management capabilities after a backend restart, without an Editor reload solely for that purpose.
- **Compatibility guidance:** Advisory dependency checks; plugin-specific runtime compatibility remains the developer's responsibility.

## XYZ Filter — Reference Plugin

**XYZ Filter, Snapshot & Export v1.0.10** provides reversible, coordinate-based filtering of **one selected 3DGS model** for cleanup and spatial inspection.

### Features

- **Live XYZ filtering:** Combined Editor-world X/Y/Z ranges with sliders and numeric inputs; only the selected model is affected.
- **Automatic, reversible preview:** Opening XYZ starts the preview for a valid target and temporarily isolates other models. **Restore and close** ends the preview and restores its scene-visibility changes.
- **Clear filter:** Disable filtering, restore original Gaussian visibility, and reset **all X/Y/Z ranges** to full model bounds without closing preview.
- **Native filtered export:** PLY, compressed PLY, SPLAT, SOG, or SPZ, with an `.export.json` report.
- **Orthographic snapshots:** Paired PNG/JSON with camera, projection, and applicable filter/section metadata; the main-panel snapshot is unfiltered.
- **Transformation-aware metadata:** Source model, Gaussian counts, spatial bounds, and post-load adjustments where reliably determinable.
- **Scene-change handling:** Unrelated model additions/removals do not automatically invalidate preview; removing the selected model ends its preview safely.

The main XYZ popup appears at **bottom-left** and the preview at **bottom-right**. Multiple loaded models require explicit target selection; switch models only after **Restore and close**. XYZ does not provide model transformation controls or image registration.

**Workflow:** Activate XYZ before model import when transformation provenance matters → import/align the model → open XYZ and confirm the target → filter/inspect → capture a snapshot or export a subset → **Clear filter** to reset, or **Restore and close** to finish.

## Splat Cleaner — Plugin

**Splat Cleaner v0.2.6** provides region-aware 3DGS cleaning through the same Plugin Manager. Unlike XYZ Filter's reversible visibility preview, it focuses on cleaning operations.

It is **independently installed, versioned, and updated**; neither plugin requires the other. See Splat Cleaner's own technical reference for its cleaning rules and workflow.

## Installation and startup

**Prerequisite:** Install **Node.js (including npm)** on the host system and ensure `node` and `npm` are available in the system `PATH`. Git is needed for the supplied initial checkout workflow.

~~~powershell
node --version
npm --version
~~~

### 1. Arrange the release folder

Download the release files into **one project root** (for example, `release_plugin_manager_v1.11/`). **Extract all three ZIP packages** (`plugin-manager_v1.11.zip`, `xyz-filter_v1.0.10.zip`, and `splat-cleaner_v0.2.6.zip`) before building or starting the Editor. Keep their extracted source directories as siblings in the project root, with no extra nested ZIP wrapper directory. In particular, retain the script-expected `plugin-manager/` directory name.

Keep the supplied `.bat` and `.ps1` scripts directly in the **same root folder**. The original SuperSplat Editor checkout must also be a sibling directory named **`supersplat/`**, created by the `clone` command in the next step or supplied as an existing checkout.

~~~text
release_plugin_manager_v1.11/           # project root
├── plugin-manager/                       # extracted Manager package
├── xyz-filter/                           # extracted XYZ package
├── splat-cleaner/                        # extracted Cleaner package
├── supersplat/                           # original Editor checkout (after clone)
├── maintain_editor.bat
├── maintain_editor.ps1
├── deploy_runtime.ps1
├── start_architecture_c.ps1
├── run_supersplatEditor_p3013.bat
└── stop_supersplatEditor_p3013.bat
~~~

The ZIP archives may remain in the root, but the scripts and Plugin Manager use the **extracted directories**. Do not put `supersplat/` inside `plugin-manager/`, or vice versa. Install plugin packages later through the Manager UI; do not manually copy their source directories into `supersplat/dist/plugins/`.

### 2. Prepare the Editor

From the **project root** in the supplied Windows development setup:

~~~powershell
.\maintain_editor.bat clone   # Initial checkout, when needed
.\maintain_editor.bat build   # Build Editor and deploy Manager
~~~

A successful build already deploys the Manager; **plugin-only updates do not require rebuilding**.

### 3. Start the Editor and management backend

Run the two services separately, or use the supplied Windows wrapper. **Ports 3013/3014 are examples, not fixed requirements.**

| Service | Working directory | Example command |
|---|---|---|
| Original SuperSplat server | `supersplat/` | `npm run serve -- -l tcp://127.0.0.1:3013 --no-port-switching` |
| Management backend | Project root | `node ./supersplat/dist/runtime/management-server.cjs --dist ./supersplat/dist --port 3014 --editor-origin http://127.0.0.1:3013` |

~~~powershell
.\run_supersplatEditor_p3013.bat    # Start both services
.\stop_supersplatEditor_p3013.bat   # Stop both services
~~~

Open `http://127.0.0.1:3013` in the browser. For custom ports, ensure backend `--editor-origin` and the Editor HTML hook's `data-management-origin` match the actual service URLs. Starting the services does not build the Editor or activate plugins in the browser.

### 4. Install a plugin

1. Select **Plugins → Manage Plugins → Install Plugin** and choose the complete plugin folder.
2. Select **Activate**; optionally enable **Startup** and **Save**.
3. Open the plugin from the Editor's **Plugins** menu.

**Startup** activates saved plugins when the Editor browser page initializes, but does not open their panels. Activate XYZ before importing/editing models if post-load transformation tracking is needed.

## Maintenance

| Task | Procedure |
|---|---|
| Editor build / Manager deployment | `maintain_editor.bat build` |
| Manager-only update | `maintain_editor.bat copy` |
| Plugin-only update | **Deactivate → Remove → Install → Activate** |
| Backend recovery | Restart backend → **Refresh** in Plugin Manager |

Removal clears saved plugin settings and Startup preferences. If browser cleanup is uncertain, reload the Editor before activating a replacement with the same plugin ID. Manager **Refresh** concerns backend availability; it is not an XYZ model-refresh control.

## Limitations

- Install/Save/Remove require the management backend; already installed plugins can run with the original static server when the backend is unavailable.
- Plugins share the Editor browser environment: install only trusted packages. Internal Editor APIs can change across releases.
- XYZ processes one model at a time; avoid changing its geometry during preview. Snapshot saving requires a compatible browser, and external spatial alignment needs separate validation.

**Project focus:** Reusable SuperSplat extension infrastructure, demonstrated by independently maintained XYZ Filter and Splat Cleaner plugins.
