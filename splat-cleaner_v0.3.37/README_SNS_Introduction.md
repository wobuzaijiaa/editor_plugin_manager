# Scale-Normalized Spacing (SNS) — Geometry-Aware Cleaning for 3DGS

**Related tool:** Region-Aware Splat Cleaner for SuperSplat Editor

## Why SNS?

Unlike conventional point clouds, 3D Gaussian Splatting (3DGS) represents scenes using spatially extended Gaussians with different scales and orientations.

Although these Gaussians are optimized for image reconstruction, they do not necessarily exhibit strong local geometric support. Conventional distance-based outlier detection may therefore be insufficient because the same spatial distance can have different meanings for small and large Gaussians.

## What is SNS?

Scale-Normalized Spacing (SNS) identifies Gaussians with insufficient neighboring-center support relative to their spatial extent and orientation.

SNS evaluates support in both directions: whether a Gaussian's neighborhood contains other Gaussian centers, and whether its own center is covered by neighboring Gaussians.

This bidirectional approach accounts for differences in Gaussian scale and helps preserve smaller Gaussians supported by larger neighbors.

## Expected Benefits

- **Scale-aware detection:** Evaluates relative geometric support rather than fixed spatial distances.
- **Candidate identification:** Helps locate isolated Gaussians and potentially unwanted geometry.
- **Flexible cleaning:** Combines neighborhood parameters with spatial scope and optional opacity restriction.
- **Visual verification:** Supports reversible inspection before selective removal and export.

## Interpretation and Limitations

SNS detects insufficient geometric support, not excessive overlap or poor rendering quality.

Legitimate thin or sparse structures may be selected, while internally supported floating clusters may remain undetected.

SNS is therefore intended as an interactive cleaning aid rather than an automatic quality-assessment method. Its effectiveness depends on model characteristics, parameter selection and visual verification.

## Background Reference

[3D Gaussian Splatting for Real-Time Radiance Field Rendering](https://doi.org/10.1145/3592433), 2023.
