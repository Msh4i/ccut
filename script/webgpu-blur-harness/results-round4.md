# Results, 2026-10-06 (cloud, SwiftShader WebGPU, headless Chromium from /opt/pw-browsers)

Command: `node drive.mjs <mode>` over the 42 scenes of `gen-scenes.ts` (sizes 1920x1080, 1080x1920, 777x433, 1x1, 3x5,
4096x2304, 4096x4096 x intensities 0, 1, 15, 50, 100, 250). A scene fails when it throws, panics or counts a GPU
validation error (`getGpuErrorStats`). No pixels are compared (see README).

| wasm | mode | failed scenes |
|---|---|---|
| before the fix (source of `f794f91`, `wasm-pack --no-opt`) | `clip` (Blur on a clip) | 0 of 42 |
| before the fix | `scene` (Blur as an effect-track layer) | 33 of 42 (every scene that has a blur pass; the 9 without one draw no scene-effect item): `Invalid frame descriptor: Error: missing field effect_pass_groups` |
| after the fix (this branch, `wasm-pack --no-opt`) | `clip` | 0 of 42 |
| after the fix | `scene` | 0 of 42 |

The harness wasm is a separate `--target web --no-opt` build of the same Rust source, not the vendored
`packages/opencut-wasm` artifact (that one was built by `script/build-wasm-vendor.sh` and checked only for the renamed
key). SwiftShader is not the owner's Iris Xe.
