# Compositor blur on a software WebGPU adapter

Runs the real compositor wasm (`rust/wasm`) in headless Chromium on SwiftShader (a CPU WebGPU adapter) with the same
frame descriptors the editor builds for the Blur effect, in two shapes: `clip` (Blur on a clip, a layer with
`effectPassGroups`) and `scene` (Blur as an effect-track layer, a `sceneEffect` item). It counts wgpu validation
errors (`getGpuErrorStats`), catches thrown errors and the wasm panic. This is how the effect-track Blur failure
(`Invalid frame descriptor: missing field effect_pass_groups`) was reproduced before the fix.

```
wasm-pack build rust/wasm --target web --release --no-opt --out-dir script/webgpu-blur-harness/pkg --out-name opencut_wasm
bun script/webgpu-blur-harness/gen-scenes.ts          # sizes x intensities, passes from effects/definitions/blur.ts
CHROMIUM=<path to chrome> node script/webgpu-blur-harness/drive.mjs scene   # or: clip; optional 3rd arg: size prefix, e.g. 1920x
```

Needs `playwright-core` resolvable from this folder (`npm i playwright-core` here, not committed) and a Chromium.

## What it cannot do (sandbox facts, measured)

* **No pixels.** A WebGPU canvas reads back as transparent here, in plain JS too (`drawImage` and screenshots), so
  the harness proves "no error, no panic", not "the picture is right".
* **One scene per page.** After a frame is presented, `copyExternalImageToTexture` fails on this SwiftShader build,
  also in plain JS without Ccut code, so every scene gets a fresh page (upload, render once).
* SwiftShader is not an Iris Xe: a pass here says nothing about the owner's GPU driver.

Measured results: `results-round4.md`.
