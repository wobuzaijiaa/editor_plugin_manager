# Editor Plugin Manager v1.13.3 — Plugin Developer Guide

**Target:** Plugin Manager v1.13.3 — Architecture C  
**Editor reference runtime:** SuperSplat v3.7.0–v3.9.2  
**Reference plugins:** XYZ Filter v1.0.10 · Splat Cleaner v0.3.37  
**Revision:** 2026-11-24

## 1. Development Overview

Editor Plugin Manager provides reusable infrastructure for developing independent plugins for [PlayCanvas SuperSplat Editor](https://github.com/playcanvas/supersplat), without modifying upstream TypeScript or rebuilding the Editor for plugin updates.

Plugins can operate entirely within the browser or integrate existing local software through optional plugin-owned native services.

~~~mermaid
flowchart TD
    E["SuperSplat Editor"]
    M["Plugin Manager"]
    P["Independent Plugin"]
    N["Optional Native Service"]
    T["System CLI / Libraries / Scripts"]

    M -->|"Integration and lifecycle"| P
    P -->|"Editor APIs"| E
    M -->|"Authorization, ports and lifecycle"| N
    P -->|"Plugin-specific requests"| N
    N --> T
~~~

### Responsibility boundaries

| Component | Responsibility |
|---|---|
| SuperSplat Editor | Rendering, scene management and native editing capabilities |
| Plugin Manager | Plugin installation, configuration, activation, native authorization, port assignment and lifecycle management |
| Plugin | Functionality, UI, Editor compatibility, dependencies, data contracts and resource cleanup |
| Plugin-owned native service | Local processing, external software integration and computational subprocess lifecycle |

Plugin Manager does not implement plugin-specific computation or proxy computational data.

Standard and portable deployments use the same plugin integration contracts.

This framework is not an official PlayCanvas plugin SDK.

## 2. Plugin Package

### 2.1 Package structure

~~~text
my-plugin/
├── plugin.json
├── index.js
├── lib/                  # optional
├── assets/               # optional
└── native/               # optional
    └── service.mjs
~~~

Only `plugin.json` and the declared browser entry are mandatory for browser-only plugins.

Include all required runtime modules and assets. Manager does not compile plugins, install npm dependencies or resolve missing runtime files.

Maintain development source separately from installed releases.

### 2.2 Plugin metadata

Minimal example:

~~~json
{
  "id": "hello-plugin",
  "name": "Hello Plugin",
  "classification": "Utility",
  "version": "0.1.0",
  "author": "Example Developer",
  "date": "2026-11-20",
  "description": "Minimal browser plugin.",
  "entry": "./index.js"
}
~~~

These eight fields are required.

Optional declarations:

| Field | Purpose |
|---|---|
| `requires` | Public and internal Editor API dependencies |
| `third_party` | Third-party software and licenses |
| `settings_schema` | Editable plugin settings |
| `native_service` | Optional native-service configuration |

### 2.3 Package constraints

| Constraint | Requirement |
|---|---|
| Plugin ID | Lowercase alphanumeric segments separated by hyphens |
| Installed releases | One per plugin ID |
| Version | MAJOR.MINOR.PATCH, with supported optional prerelease suffix |
| Entry | Local `.js` or `.mjs` path beginning `./` |
| Package size | Maximum 50 MiB decoded content |
| File count | 2–100 |
| Client-validator path depth | Maximum eight subdirectories |
| Descriptive fields | Maximum 500 characters each |
| Settings | Maximum 30 unique keys |

Do not include generated manifests, approval registries, credentials or private data.

## 3. Browser Integration

### 3.1 Lifecycle contract

Every plugin exports `activate(context)` and returns its lifecycle methods.

~~~javascript
export async function activate(context) {
    return {
        open() {
            // Show or focus plugin UI.
        },

        isRunning() {
            return false;
        },

        async deactivate() {
            // Release plugin-owned resources.
        }
    };
}
~~~

`open()` and `deactivate()` are required. `isRunning()` is optional and must return a synchronous boolean.

| Operation | Requirement |
|---|---|
| Import | Avoid functional side effects |
| Activate | Initialize and validate dependencies |
| Open | Show or focus existing UI without duplication |
| isRunning | Report active UI, processing, preview or incomplete restoration |
| Deactivate | Await cleanup and report failures |

Installation does not execute plugin code.

`open()` must not remain pending for the entire UI lifetime.

### 3.2 Activation context

| Property | Description |
|---|---|
| `editor` | Current SuperSplat Editor API object |
| `plugin` | Validated plugin metadata |
| `settings` | Saved settings snapshot |
| `uiHost` | Host element for plugin UI |
| `advanced` | Optional native lifecycle interface |

### 3.3 Minimal working example

Save as `index.js` alongside the preceding metadata example.

~~~javascript
export async function activate({ uiHost }) {
    let panel = null;

    return {
        open() {
            if (!panel) {
                panel = document.createElement('div');

                panel.style.cssText =
                    'position:fixed;right:24px;top:90px;' +
                    'padding:12px;background:#292f38;' +
                    'color:white;z-index:1300;';

                const message = document.createElement('span');
                message.textContent = 'Hello from Plugin Manager';

                const close = document.createElement('button');
                close.textContent = 'Close';
                close.onclick = () => {
                    panel.hidden = true;
                };

                panel.append(message, close);
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

This example demonstrates activation, reusable UI, running-state reporting and cleanup without depending on a specific Editor scene API.

## 4. Settings and Dependencies

### 4.1 Plugin settings

Declare editable settings in `plugin.json`:

~~~json
"settings_schema": [
  {
    "key": "threshold",
    "type": "number",
    "label": "Processing threshold"
  }
]
~~~

Supported types are `boolean`, `number` and `string`.

Read and validate settings during activation:

~~~javascript
const value = settings?.threshold;

const threshold = Number.isFinite(value)
    ? value
    : 1;
~~~

Plugins own their defaults and functional validation.

Apply changed settings using:

~~~text
Settings → Save → Deactivate → Activate
~~~

Startup preference automatically activates the plugin when the Editor initializes. It does not automatically open the UI or authorize native execution.

### 4.2 Editor APIs

Prefer published Editor APIs and declare dependencies:

~~~json
"requires": {
  "editor_api": ["inspect.scene"],
  "internal_api": []
}
~~~

Declare internal interfaces separately when required.

The example API path must be verified against the target Editor checkout before use. Internal interfaces are version-sensitive.

### 4.3 Third-party dependencies

Use browser-compatible relative imports and include all required files:

~~~javascript
import { calculate } from './lib/math.js';
~~~

Declare third-party software and licenses:

~~~json
"third_party": [
  {
    "name": "example-library",
    "version": "1.2.3",
    "license": "MIT"
  }
]
~~~

Node-only APIs belong in the optional native service.

External development tools and bundlers may be used, but the installed package must be complete and deployable.

## 5. Optional Native-Service Integration

Native services allow plugins to reuse system-installed CLI tools, native libraries and local processing scripts.

Native implementation details, computational protocols and external software execution remain plugin-specific.

### 5.1 Declaration

For a service requiring a managed TCP listener, add:

~~~json
"native_service": {
  "entry": "./native/service.mjs",
  "port": {
    "required": true,
    "preferred": 3015
  }
}
~~~

Requirements:

- The native entry must be `./native/service.mjs`.
- One managed loopback TCP listener is supported per plugin.
- Preferred ports must be integers between 1024 and 65535.
- The preferred port is not the actual authorized assignment.

For services without a managed listener, omit the `port` object.

### 5.2 Browser lifecycle interface

Managed-port plugins require the v1.13.x integration contract:

~~~json
{
  "native_service": 1,
  "native_authorization": "interactive-v4"
}
~~~

The eligible browser plugin receives `advanced.native`.

~~~javascript
const native = advanced?.native;

if (!native) {
    throw new Error('Native service unavailable.');
}

const started = await native.start();

const status = await native.status();

await native.stop();
~~~

| Method | Purpose |
|---|---|
| `start(options?)` | Start or reuse the authorized service |
| `status()` | Retrieve current service state |
| `stop()` | Cancel pending startup or stop the service |

Pending startup supports `start({ signal })` with an AbortSignal.

Computational cancellation after startup remains the plugin's responsibility.

The existence of `advanced.native` alone does not establish managed-port compatibility.

### 5.3 Endpoint discovery

Always obtain the actual assigned port from Manager.

Example startup result:

~~~json
{
  "id": "my-native-plugin",
  "folder": "my-native-plugin_<timestamp>",
  "state": "running",
  "port": 3016,
  "listener": "listening"
}
~~~

Before connecting, verify the installed plugin ID, exact release folder, running state, listener state and valid assigned port.

Connect to:

~~~text
http://127.0.0.1:<assigned-port>
~~~

Never assume the preferred port is the actual endpoint.

Validate the plugin-specific service protocol and capabilities before submitting requests.

Additional exact-release checks using the derived approval projection are described in the Architecture Reference and demonstrated by Splat Cleaner.

### 5.4 Native-service contract

Manager starts the installed native entry using Node.js with IPC and supplies:

~~~text
--editor-origin <configured-editor-origin>
--port <authorized-port>
~~~

The port argument applies to managed listeners.

Bind to the exact assigned loopback port. After successful binding, report readiness:

~~~javascript
process.send({
    type: 'native-ready',
    port: server.address().port
});
~~~

For an occupied port:

~~~javascript
process.send({
    type: 'native-start-error',
    code: 'PORT_IN_USE',
    port
});
~~~

Deliver the error before cleaning up and exiting. Do not select another port independently.

Portless services report `native-ready` without a port.

The documented readiness timeout is 12 seconds after fork. The graceful-stop interval is approximately five seconds before direct-child escalation.

Handle both shutdown events:

~~~javascript
process.on('message', message => {
    if (message?.type === 'native-stop') {
        void shutdown();
    }
});

process.on('disconnect', () => {
    void shutdown();
});
~~~

`shutdown()` is implemented by the plugin and must perform safe, idempotent cleanup.

Native settings are not automatically supplied through the browser activation context. Where necessary, read the matching saved catalog record without modifying it directly.

### 5.5 Authorization and security

Installing or activating a plugin does not authorize native execution.

First-use Windows authorization is bound to the installed release and, where applicable, its assigned port. Reinstallation requires fresh approval.

Use Manager for port reassignment. Do not modify approval registries or introduce alternative authorization mechanisms.

Browser plugins execute with Editor-page privileges. Approved native services execute with local-user privileges; neither is sandboxed by Manager.

Native services must validate the permitted Editor origin, processing requests and data sizes, and expose only intended plugin-specific operations.

Manager verifies its owned service lifecycle and managed listener release. Plugins remain responsible for external dependencies, computational correctness, subprocess termination and temporary-resource cleanup.

Detailed authorization, monitoring and shutdown contracts are specified in the Architecture Reference.

## 6. Installation, Testing and Release

### 6.1 Development workflow

Start an existing compatible Editor deployment:

~~~bash
node editor_services.mjs start
~~~

Open the Editor URL displayed by the launcher.

1. Prepare the complete plugin package.
2. Open **Plugins → Manage Plugins → Install Plugin**.
3. Select the plugin folder.
4. Review compatibility findings.
5. Activate and test the plugin.
6. Verify Close, Deactivate and reactivation.

Build and deployment procedures are covered in the Maintenance How-To.

### 6.2 Compatibility assessment

Manager distinguishes mandatory package validation from advisory compatibility assessment.

| Classification | Meaning |
|---|---|
| `STATIC_COMPATIBLE` | Static evidence supports declared compatibility |
| `REVIEW_REQUIRED` | Additional review is necessary |
| `INCOMPATIBLE` | Missing declared API or unresolved dependency |
| `NOT_ASSESSED` | Insufficient evidence |

Advisory results do not guarantee runtime correctness or block activation of structurally valid packages.

Native authorization remains independent of compatibility assessment.

### 6.3 Release checklist

Before releasing a plugin, verify:

- [ ] Package metadata, dependencies and runtime files.
- [ ] Activation, reusable UI, settings and Startup.
- [ ] Functional correctness against the intended Editor version.
- [ ] Cancellation, restoration and resource cleanup.
- [ ] Removal, replacement and reactivation.

For native-enabled plugins, additionally verify:

- [ ] Authorization, startup and actual endpoint discovery.
- [ ] External dependency availability and computational results.
- [ ] Failure handling, cancellation and owned-process termination.
- [ ] Managed-port conflicts, reassignment and release.
- [ ] Complete cleanup during plugin and Editor shutdown.

Plugin-specific tests are the developer's responsibility and are not automatically executed by Manager.

### 6.4 Updates

Maintain a stable plugin ID and increment its version when releasing changes.

~~~text
Implement → Test → Package → Deactivate → Remove
    → Install → Activate
~~~

Removal resets saved settings, Startup preferences, native approval and associated port assignment.

Keep known-good release packages for rollback.

Routine plugin updates require neither an Editor rebuild nor Manager redeployment.

## 7. Reference Implementations

| Reference | Demonstrated integration |
|---|---|
| XYZ Filter v1.0.10 | Browser-only scene interaction, reversible preview, snapshots and export |
| Splat Cleaner v0.3.37 | Combined browser/native processing and independent system CLI integration |

Splat Cleaner demonstrates how existing external software can be reused through plugin-owned native services without extending the Manager contract.

Minimal Manager examples:

~~~text
plugin-manager/examples/hello/
plugin-manager/examples/scene-info/
~~~

## Documentation

- **XYZ Filter documentation** — Browser-based plugin implementation.
- **Splat Cleaner documentation** — Browser/native processing and external software integration.

---

**Development principle:** Plugin Manager provides reusable integration infrastructure. Individual plugins remain responsible for their functionality, dependencies, resource lifecycle and correctness. Extend the framework only when an established requirement cannot be satisfied through its existing contracts.
