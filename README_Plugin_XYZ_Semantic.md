# Plugin XYZ Semantic

A semantic spatial modeling and inspection plugin for [PlayCanvas SuperSplat Editor](https://github.com/playcanvas/supersplat), enabling **building, floor, and room-level management of 3D Gaussian Splatting (3DGS) models**.

XYZ Semantic introduces persistent spatial semantics into 3DGS scenes through interactive, human-guided modeling, without retraining or automatic segmentation.

**Version:** v0.2.0  
**Compatibility:** SuperSplat Editor v3.9.2 · Plugin Manager v1.13.3  
**License:** MPL-2.0

## Modeling Concept

XYZ Semantic uses a simplified 2.5D spatial representation based on the hierarchy:

**Building → Floor → Room/Area**

- **Floors** are defined by vertical ranges, including ceiling-free viewing heights.
- **Rooms and areas** are defined by convex polygons in the horizontal plane, inheriting their floor's vertical range.

This approach accommodates noisy and incomplete real-world reconstructions without requiring precise architectural geometry.

Semantic definitions are stored independently of the Gaussian model, preserving the original reconstruction while providing reusable spatial information.

## Key Features

- **Semantic Modeling** — Create and manage persistent building, floor, and room definitions.
- **Spatial Filtering** — Interactive XYZ filtering, reversible region isolation, ceiling-free views, and wall slices.
- **Spatial Navigation** — Navigate and inspect buildings, floors, and rooms through a semantic tree.
- **Snapshots and Export** — Generate annotated snapshots and selective 3DGS exports in PLY, SPLAT, SOG, and SPZ formats with spatial metadata.
- **Live Camera Tracking** — Automatically identify the virtual camera's current building, floor, and room during navigation.
- **Semantic Data Persistence** — Save and reload model-associated semantic definitions in JSON format.

## Applications

- Indoor spatial modeling and building inspection.
- Floor- and room-level documentation.
- Interactive virtual walkthroughs and location-aware navigation.
- Spatial data organization and digital twin integration.
- Foundations for asset management and facility management applications.

## Installation

Install the `xyz-semantic` plugin using **SuperSplat Plugin Manager** and restart the Editor.

No modification to SuperSplat Editor is required.

## Basic Workflow

1. **Bind Model** — Associate a building model with a new or existing semantic document.
2. **Define Floors** — Establish vertical boundaries using interactive XYZ filtering.
3. **Define Rooms** — Draw and name room polygons in orthographic top view.
4. **Navigate and Inspect** — Select and optionally isolate semantic regions.
5. **Snapshot and Export** — Generate regional snapshots and model subsets.
6. **Live Tracking** — Enable position-based semantic location identification.

## Notes

- XYZ Semantic focuses on manual spatial semantic modeling and position-based queries rather than automatic semantic segmentation.
- Room isolation and model export use XYZ bounding boxes rather than exact polygon clipping.
- Semantic definitions are associated with a specific model and coordinate system.

## License

Licensed under the **Mozilla Public License, Version 2.0 (MPL-2.0)**.

Copyright (c) 2026 repo@gjt.

See [LICENSE](LICENSE) for the complete license terms.
