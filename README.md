# SuperSplat XYZ Filter & Section Tools

A lightweight external extension for [PlayCanvas SuperSplat Editor](https://github.com/playcanvas/supersplat), providing **interactive XYZ filtering for 3DGS cleanup and spatial inspection**, selective model export, and transformation-aware metadata.

Developed for **SuperSplat Editor v3.7.0**, without modifying upstream TypeScript source files.

## Motivation

**1. Simpler, more intuitive cleanup**

Large 3DGS scenes often contain unwanted geometry, reconstruction artifacts, or irrelevant regions. Reversible XYZ filtering provides a coordinate-based alternative to manually brushing large numbers of Gaussians.

**2. Inspection beyond physical viewing constraints**

Physical photography is limited by camera placement, field of view, and occlusions. Live XYZ filtering exposes selected scene sections and enables virtual inspection of large objects, rooms, and structures from otherwise inaccessible perspectives.

## Features

- **Live XYZ filtering** — Combined X/Y/Z ranges in Editor-world coordinates, with sliders, numeric inputs, and axis resets.
- **Reversible preview** — Hide unwanted regions without permanently modifying the original model.
- **Selective export** — Export filtered Gaussian subsets as PLY, compressed PLY, SPLAT, SOG, or SPZ.
- **Orthographic snapshots** — Export PNG/JSON pairs with camera, projection, and optional section metadata.
- **Spatial metadata and reports** — Record Gaussian counts, spatial bounds, export settings, and post-load model transformations.

Standard SuperSplat editing and export functions remain available.

## Applications

Section-level inspection of buildings and equipment, spatial documentation, selective model delivery, and external 2D AI analysis of virtual RGB views.

AI-based detection, counting, and world-space localization are not built-in extension features.

## Workflow

1. **Load and align** a 3DGS model using native SuperSplat tools.
2. **Filter and inspect** the scene using XYZ controls.
3. **Export** a filtered model and/or capture an orthographic snapshot.
4. **Close the preview** to restore the original visibility state.

## Installation & Build

The extension, maintenance scripts, and regression tests are maintained outside the upstream SuperSplat source.

**Initial setup:**

```powershell
.\maintain_editor.bat clone
.\maintain_editor.bat build
```

**JavaScript-only updates:**

```powershell
.\maintain_editor.bat copy
```

The maintenance script supports three operations:

- `clone` — Obtain or verify the upstream SuperSplat checkout.
- `build` — Audit dependencies, perform a clean release build, run regression tests, and deploy the extension.
- `copy` — Redeploy the extension to a verified existing build without recompilation.

The customization loads through a separate `custom-editor.js` browser module and an HTML hook. Native SuperSplat distribution artifacts are verified using SHA-256 hashes to ensure additive-only deployment.

### Verification & Logs

The maintenance process includes **A01–A18 API dependency screening**, **B01–B10 build checks**, automated regression tests, and native artifact preservation verification.

Build failures, warnings, and items requiring manual review are classified separately. A successful automated build does not establish full runtime compatibility.

Each operation generates timestamped logs under `logs/`, including:

- `final-report.md` — Verification summary and outstanding reviews.
- `summary.json` — Operation results and build provenance.
- `gate-decision.json` — Severity-classified findings.
- Additional audit, build, test, and artifact-integrity records.

Serve `supersplat/dist/` over HTTP or HTTPS.

## Spatial Metadata

Orthographic snapshots are exported as matching PNG/JSON files under `topdown_[section_id]_[UTC-timestamp]/`. An empty section identifier uses `unlabeled` in filenames.

Post-load model adjustment is defined as:

`U = M_current × inverse(M_initial)`

This excludes the initial SuperSplat load transformation. An unchanged model yields Identity when a valid uniform mapping exists; otherwise the adjustment may be `null`.

- **Snapshot JSON:** Camera/projection matrices, section bounds, and `portviewer_floor.model_to_snapshot` for XYZ section snapshots.
- **Filtered-export report:** Gaussian counts, spatial bounds, export settings, and `model_to_snapshot` transformation provenance.

Native exported geometry already incorporates applicable editing transformations. **Do not apply `U` again.**

Metadata provides coordinate traceability, not independent proof of metric accuracy or external registration.

## Limitations

- Axis-aligned filtering does not replace all manual cleanup operations.
- Filtering cannot reconstruct missing geometry or increase camera field of view.
- **Model transformations (including rotation) and axis/surface vertical calibration must not be performed while XYZ filtering is active.**
- Snapshot folder export requires compatible browser directory access, such as Chrome/Edge on localhost or HTTPS.
- Production reprojection and transformed-model export/reimport require workflow-level validation.

## Maintenance

Developed and verified against SuperSplat Editor **v3.7.0**, commit `4069712370df3425c386610f28a814403e835543`.

This is the compatibility baseline, **not a mandatory version lock**. Other revisions can be built subject to dependency screening, integrity checks, and subsequent functional verification.

See `SUPERSPLAT_API_DEPENDENCY_AUDIT.md` and the technical reference for upgrade procedures and detailed implementation contracts.

**Version:** v1.0 — Live XYZ filtering, spatial inspection, selective export, and transformation-aware documentation.
