# Plugin Region-Aware Splat Cleaner v0.3.37

An independently managed plugin for [PlayCanvas SuperSplat Editor](https://github.com/playcanvas/supersplat), providing **interactive 3D Gaussian Splatting (3DGS) cleanup through complementary detection methods, spatial selection and reversible visual inspection**.

**Plugin:** v0.3.37  
**Plugin Manager:** v1.13.3  
**Evaluated Editor:** SuperSplat v3.9.1 / PlayCanvas Engine v2.24.1

## Motivation

3DGS reconstructions may contain isolated Gaussians, floating artifacts, oversized splats and unwanted geometry.

Splat Cleaner combines geometry-aware and contribution-based detection with visual inspection, helping users identify potential artifacts and selectively clean models rather than relying on manual removal alone.

## Features

| Method | Detection principle |
|---|---|
| SNS | Insufficient scale-normalized geometric support |
| GPU Floaters | SplatTransform voxel-based contribution filtering |
| Size | Unusually large Gaussians |
| Opacity | Low decoded opacity |
| Floater Components | Detached spatial groups |

- **Region-aware selection:** Restrict removal using XYZ bounds and density classes.
- **Combined cleaning:** Combine independent methods using OR, with optional opacity restriction of SNS candidates.
- **Reusable analysis:** Independent cached results and automatic method refresh.
- **Visual inspection:** Compare Original, Candidates and Cleaned views.
- **Method Tint:** Highlight individual cleaning methods with adjustable color and opacity.
- **Selective export:** PLY, compressed PLY, SPLAT, SOG or SPZ, with a JSON cleaning report.

Preview is reversible and does not permanently delete source Gaussians.

## Scale-Normalized Spacing (SNS)

SNS identifies Gaussians with insufficient geometric support relative to their scales and orientations.

It evaluates support in both directions: whether a Gaussian's neighborhood contains other Gaussian centers, and whether its own center is covered by neighboring Gaussians.

| Parameter | Default |
|---|---:|
| Extent k | 3 |
| Minimum neighbors m | 1 |

SNS uses hybrid CPU/GPU processing within the browser. No external runtime is required.

Optional opacity restriction helps refine SNS selection without repeating geometric analysis.

SNS detects insufficient geometric support, not excessive overlap or poor rendering quality.

## GPU Floaters

GPU Floaters complements SNS through SplatTransform's voxel-based Gaussian contribution filtering.

It uses the system-installed SplatTransform CLI through a plugin-owned native service.

On Windows, computation runs automatically in a separate PowerShell window using Vulkan by default.

SplatTransform is required only for GPU Floaters.

## Workflow

1. **Analyze** — Select a model and establish base geometry and density information.
2. **Detect** — Run Analyze SNS, Analyze GPU Floaters or Find Components as required.
3. **Configure** — Enable cleaning methods, adjust thresholds and define spatial scope.
4. **Apply / Preview** — Establish the candidate selection.
5. **Inspect** — Compare Original, Candidates and Cleaned views using Method Tint.
6. **Export or Restore** — Export a separate cleaned model or restore the preview.

After the initial Apply / Preview, compatible method-enable changes automatically refresh the selection. Scope and threshold changes require manual Apply / Preview.

## Installation

Requires Editor Plugin Manager v1.13.3.

1. Extract the complete plugin package.
2. Open **Plugins → Manage Plugins → Install Plugin**.
3. Select the extracted plugin folder and activate it.
4. Open **Region-Aware Splat Cleaner** from the Plugins menu.

For updates:

~~~text
Deactivate → Remove → Install → Activate
~~~

No Editor rebuild is required. The same plugin package supports standard and portable deployments.

### Optional GPU Floaters Runtime

Install the evaluated SplatTransform version:

~~~powershell
npm install -g @playcanvas/splat-transform@3.11.2
splat-transform --version
~~~

Windows PowerShell is required for the evaluated native workflow.

On first execution, authorize the native service and select an available port. The service starts on demand and stops automatically after analysis by default.

## Limitations

- Cleaning operates on one selected model at a time.
- Candidates are potential artifacts, not confirmed reconstruction errors.
- Large-model processing depends on memory, GPU resources and temporary disk space.
- GPU Floaters requires compatible geometry and transformations.
- Restore preview before external model edits or other visibility-filtering operations.

**Inspect the cleaned result before export.**

## Compatibility

Successfully operated in standard and portable Windows deployments with SuperSplat versions from v3.7.0 to v3.9.1 and system SplatTransform version v3.11.2, v3.11.1.

SNS and GPU Floaters processing have been demonstrated on a model containing approximately 10.44 million Gaussians.

Other Editor versions, platforms and GPU environments require separate verification.

## Documentation

- **SNS Introduction** — Motivation, detection principle and expected benefits.
- **SNS User Guide** — Parameters, cleaning and inspection.
- **GPU Floaters User Guide** — Native runtime and cleaning workflow.
