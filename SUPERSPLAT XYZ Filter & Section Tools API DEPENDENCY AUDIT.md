# SUPERSPLAT XYZ Filter & Section Tools API DEPENDENCY AUDIT

**Purpose:** Summarize the extension's upstream dependencies, upgrade risks, and verification requirements. This is a compatibility reference, not a certification of every runtime behavior.

**Audited baseline:** [SuperSplat Editor](https://github.com/playcanvas/supersplat) v3.7.0, commit `4069712370df3425c386610f28a814403e835543`. This is a reference baseline, **not a mandatory version lock**.

**Verified build:** : A01–A18 static screening passed (16 `PASS_STATIC`, 2 `NOT_AUTOMATABLE`); 39 upstream tests and seven extension test suites passed; 21 native distribution files passed additive-only preservation checks. Browser/WebGPU and geometric acceptance were **not run** as part of this verification.

## Integration boundary

The extension runs as a separate `custom-editor.js` module loaded from `dist/index.html`. It does not modify upstream TypeScript or compile into SuperSplat's native `index.js`.

It uses `window.editor` for readiness and accesses `window.scene`, Gaussian data, rendering, and export services directly. These are **version-sensitive internal interfaces**, not a guaranteed stable plugin API. A successful build does not, by itself, prove runtime compatibility.

## Dependency impact priorities

**Priority** describes the consequences of a broken dependency. It is distinct from the build **gate severity** described below.

| Priority | Contracts | Primary risk |
|---|---|---|
| **CRITICAL (10)** | A01–A04, A07–A09, A11–A13 | Plugin initialization, snapshot matrices, Gaussian coordinates/flags, model transforms, and filtered subset export |
| **HIGH (6)** | A05–A06, A10, A15, A17–A18 | Render restoration, layer discovery, command sequencing, matrix/color APIs, file access, and codecs |
| **MEDIUM (2)** | A14, A16 | Timeline/display state and browser UI controls |

The most consequential individual contracts are:

- **A07–A09:** Correct source-row/instance mapping, world transformations, and exact restoration of pre-existing Gaussian flags.
- **A04, A11, A15:** Snapshot camera matrices and post-load transformation metadata must remain geometrically consistent.
- **A12–A13:** Filtered export must serialize only the selected Gaussian subset; silently exporting the full scene is unacceptable.
- **A17–A18:** Browser file access and WebP/WASM availability must be verified for workflows that use them.

Upstream packages also have different impact levels: `playcanvas` and `@playcanvas/splat-transform` are **CRITICAL** to the extension's geometric and export behavior; Rollup, TypeScript, and core build/integration dependencies are **HIGH**; supporting style, media, and serving packages are generally **MEDIUM**. These package priorities guide manual review; they are **not** separate automated gate rules.

## Build gates versus release acceptance

| Classification | Effect |
|---|---|
| `HARD_FAIL` | Blocks the operation, e.g., missing mandatory interface marker, failed test/build, or native artifact integrity mismatch |
| `REVIEW_REQUIRED` | Candidate build may continue, but a changed or unverified behavior needs review before acceptance |
| `WARNING` | Nonblocking diagnostic recorded in logs |
| `INFO` | Source version, commit, and other provenance |

A **CRITICAL** dependency change may require urgent verification without automatically blocking candidate compilation. Conversely, a missing mandatory static marker blocks the build regardless of the contract's impact priority.

The maintenance process checks **A01–A18** API continuity and **B01–B10** source, toolchain, build, deployment, and test contracts. It builds unmodified SuperSplat in release mode, then adds the external module and one HTML hook. Full native artifact hashes are compared before and after deployment; only the expected HTML hook may change. The existing distribution is backed up for recovery during a clean build.

The commands have distinct scopes: `clone` obtains/verifies the upstream checkout; `build` runs audit, compilation, tests, and deployment; `copy` verifies the existing build stamp and distribution, then updates only the external JavaScript without recompiling or rerunning all tests.

The primary outputs are `final-report.md`, `summary.json`, `gate-decision.json`, `api-audit.json`, `build-contracts.json`, and `native-before.json`/`native-after.json` under a timestamped `logs/` directory. An automated `PASS` is **not** upgrade approval.

## Metadata and runtime compatibility

The extension records post-load model adjustment as:

`U = M_current × inverse(M_initial)`

This excludes the original loading transform. Snapshot JSON contains camera/projection metadata and, when applicable, section/model mapping; filtered-export reports record bounds, counts, and transformation provenance. Native exported geometry already incorporates applicable editing transformations—**do not apply `U` again**.

Model transformations/rotation and axis/surface vertical calibration must not be performed while XYZ filtering is active.

Before accepting a new SuperSplat version, review changed upstream interfaces and verify, in the actual browser:

1. Editor startup, native editing, XYZ controls, camera navigation, and exact visibility restoration.
2. Orthographic PNG/JSON consistency, viewport restoration, and the correct axis/section metadata.
3. Actual filtered subset export and reimport for required formats, including sidecar report behavior.
4. A known nonidentity model adjustment and downstream reprojection where spatial metadata is consumed.

**Upgrade decision:** Review the new commit and affected contracts, pass mandatory build checks, complete relevant runtime/geometric tests, and explicitly accept the candidate. The maintenance scripts report pending acceptance; they do not automatically approve an upgrade.

For the detailed A01–A18 interface inventory, source ownership, metadata schemas, troubleshooting, and upgrade procedures, refer to the full technical audit maintained with the project.
