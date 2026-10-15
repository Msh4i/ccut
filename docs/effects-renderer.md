# Effects & GPU Renderer

## How to add a new effect

1. Create a new file in `apps/web/src/effects/definitions/` (e.g. `brightness.ts`)
2. Export an `EffectDefinition` — see `blur.ts` or `shake.ts` as a reference
3. Register it in `apps/web/src/effects/definitions/index.ts`
4. Add the matching `.wgsl` shader under `rust/crates/effects/src/shaders/`, a `pack_*_uniforms` function, and one row in the `EFFECT_SHADERS` table in `rust/crates/effects/src/pipeline.rs`

An effect definition has:
- `type` — unique string identifier
- `name` — display name
- `keywords` — for search
- `params` — user-facing controls (sliders, toggles, etc.)
- `renderer` — GPU pass templates resolved into shader identifiers + uniforms

All effects use the shared GPU renderer. TypeScript decides which shader identifiers to run and which uniforms to pass, including `localTimeSeconds`/`durationSeconds` for time-based effects (seconds since this effect instance started, and its total duration — see `shake.ts` for a worked example, including how to keep a periodic effect's frequency from aliasing at low export frame rates). Rust/wgpu owns device creation, textures, and pass execution.

## Single-pass vs multi-pass

The renderer supports a `passes` array. Single-pass effects (e.g. color grading) just have one entry. Multi-pass is needed when an effect has to process its own output — blur (H then V), bloom (extract → blur → composite), glow, etc.

```typescript
renderer: {
  passes: [
    { shader: "my-effect-shader", uniforms: ({ effectParams }) => ({ ... }) },
  ],
}
```

### Dynamic pass counts with `buildPasses`

Some effects need a variable number of passes depending on their parameters (e.g. blur needs more iterations at high intensity to keep quality). For these, add a `buildPasses` function to the renderer:

```typescript
renderer: {
  passes: [ /* static fallback — used if buildPasses is absent */ ],
  buildPasses: ({ effectParams, width, height }) => {
    // return EffectPass[] with pre-computed uniforms
  },
}
```

When `buildPasses` is present, all rendering paths use it instead of the static `passes` array. The static array is kept as a structural reference and fallback for effects that don't need dynamic pass counts.

### Resolving passes — always use `resolveEffectPasses`

All code that consumes effect passes should go through the helper, never access `definition.renderer.passes` directly:

```typescript
import { resolveEffectPasses } from "@/lib/effects";

const passes = resolveEffectPasses({ definition, effectParams, width, height });
```

This handles the `buildPasses` vs static `passes` dispatch automatically.

### Pipeline

Linear effect chains go through `gpuRenderer.applyEffect()` in `apps/web/src/services/renderer/gpu-renderer.ts`.

TypeScript resolves `EffectPass[]` from effect definitions. Each pass contains:
- `shader` — a stable identifier such as `"gaussian-blur"`
- `uniforms` — resolved numeric values for that pass

Rust maps the shader identifier to a precompiled WGSL pipeline via the `EFFECT_SHADERS` table in `rust/crates/effects/src/pipeline.rs`. Non-linear GPU work such as signed-distance-field generation and mask feathering lives in dedicated Rust pipeline modules, not in TypeScript orchestration.

## Writing shaders

Effect-specific WGSL shaders live in `rust/crates/effects/src/shaders/`. Add the shader file there, add a `pack_*_uniforms` function next to the others in `pipeline.rs`, and add one row for it to `EFFECT_SHADERS` — that one table is what both builds the wgpu pipeline and looks up the right uniform-packing function, so a new shader never needs registering twice. `cargo test -p effects` parses and validates every row in that table with `naga` and checks its `EffectUniforms` struct against the Rust-side buffer layout, so a struct typo or a bad WGSL file fails offline instead of panicking the GPU compositor at startup.

Every pass shares the same `EffectUniforms` WGSL struct and bind group layout (see `rust/crates/effects/src/pipeline.rs`'s `EffectUniformBuffer` for the Rust side, kept byte-for-byte identical and checked by the `cargo test` above):
- `@group(0) @binding(0/1)` — `input_texture: texture_2d<f32>` and `input_sampler: sampler`, injected automatically
- `@group(1) @binding(0) uniforms: EffectUniforms { resolution: vec2f, extra: vec2f, scalars_a: vec4f, scalars_b: vec4f }` — `resolution` is filled in automatically; `extra`/`scalars_a`/`scalars_b` are 10 generic floats with no fixed meaning. Each shader's own `pack_*_uniforms` function in `pipeline.rs` decides what it writes there (and under what `u_*` names it expects from TypeScript) — see `pack_gaussian_blur_uniforms` and `pack_shake_uniforms` for two different layouts of the same struct.

**Sampling density and step scaling**

A fixed kernel (e.g. ±30 samples) can only cover ±30 texels at step=1. When the target sigma grows beyond ~10, the kernel can't cover enough of the Gaussian curve and the result degrades into a box filter.

The fix is a `u_step` uniform that spaces samples further apart. With step=4 the same 61-sample kernel covers ±120 texels. Bilinear texture filtering smooths the gaps between samples. For very large sigma, combine step scaling with **multi-iteration stacking** (multiple H+V pass pairs via `buildPasses`) — each iteration compounds the blur, and the effective sigma = per-pass sigma × √iterations.

Keep the step size moderate (≤4) to avoid visible banding. If you need more blur than step=4 allows in a single iteration, add iterations instead of increasing the step further.

```wgsl
// gaussian_blur.wgsl: sigma/step live in scalars_a, direction lives in extra
let sigma = uniforms.scalars_a.x;
let step_size = uniforms.scalars_a.y;
let position = f32(sample_index) * step_size;
let weight = exp(-(position * position) / (2.0 * sigma * sigma));
color += textureSample(input_texture, input_sampler, uv + texel_size * uniforms.extra * position) * weight;
```

Do **not** use large step sizes (>6) in a single pass — it creates visible banding regardless of bilinear interpolation. Use multiple iterations instead.

## Coordinate systems

Source canvases are imported through `copy_external_image_to_texture()`, which is the boundary where browser canvas data enters the GPU pipeline. If a shader or import path changes, validate orientation explicitly — the renderer assumes a consistent top-left canvas origin by the time results come back to TypeScript.
