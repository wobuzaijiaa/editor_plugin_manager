# Plugin XYZ Filter, Snapshot & Export v1.0.10

An independently managed plugin for [PlayCanvas SuperSplat Editor](https://github.com/playcanvas/supersplat), providing **interactive 3DGS spatial filtering, orthographic snapshots, selective export and transformation-aware metadata**.

**Plugin:** v1.0.10  
**Plugin Manager:** v1.13.3  
**Editor reference runtime:** SuperSplat v3.7.0–v3.9.1 / PlayCanvas Engine v2.24.1

## Motivation

Large 3D Gaussian Splatting (3DGS) scenes may contain unwanted geometry or regions that are difficult to inspect using conventional selection tools.

XYZ Filter provides coordinate-based spatial filtering for scene cleanup, sectional inspection and spatial documentation.

## Features

- **XYZ filtering:** Interactive X/Y/Z ranges in Editor-world coordinates, using sliders and numeric inputs.
- **Reversible preview:** Temporarily hide Gaussians outside the selected region without deleting source geometry.
- **Selective export:** PLY, compressed PLY, SPLAT, SOG or SPZ, accompanied by a JSON report.
- **Orthographic snapshots:** Paired PNG/JSON export with camera, projection and applicable section metadata.
- **Transformation-aware metadata:** Record spatial bounds, Gaussian counts and supported model transformations.

## Workflow

1. **Prepare** — Import and align the model in SuperSplat. Activate XYZ Filter before model import when transformation tracking is required.
2. **Filter** — Open XYZ Filter, select the target model and adjust the XYZ ranges.
3. **Inspect and export** — Capture orthographic snapshots or export the filtered Gaussian subset.
4. **Restore** — Use **Clear filter** to reset ranges and visibility without ending preview, or **Restore and close** to end preview.

Main-panel snapshots are unfiltered. Snapshots captured through the filtering preview can include the active XYZ selection.

## Spatial Metadata

Snapshots include camera and projection information for interpreting images in Editor-world coordinates.

Model export reports contain selection bounds, Gaussian counts and applicable transformation information.

**Exported model geometry already incorporates applicable transformations. Do not apply the recorded adjustment matrix again.**

Metadata supports coordinate traceability but does not independently verify spatial alignment or metric accuracy.

## Installation

Requires Editor Plugin Manager v1.13.3.

1. Open **Plugins → Manage Plugins → Install Plugin**.
2. Select the complete `xyz-filter/` folder.
3. Activate the plugin and save the configuration.
4. Open **XYZ Filter** from the Plugins menu.

For updates:

~~~text
Deactivate → Remove → Install → Activate
~~~

No Editor rebuild is required. The same plugin package supports standard and portable deployments.

## Limitations

- Filtering operates on one selected static 3DGS model at a time.
- XYZ bounds evaluate Gaussian centers, not complete ellipsoid intersections.
- Restore and close preview before switching targets or editing model geometry.
- Paired PNG/JSON snapshots require compatible browser directory-access support.
- External spatial alignment and other Editor versions require separate verification.

## Documentation

- **XYZ Filter User Guide** — Filtering, snapshots and export.
