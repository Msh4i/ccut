struct VertexOutput {
    @builtin(position) position: vec4f,
    @location(0) tex_coord: vec2f,
}

struct EffectUniforms {
    resolution: vec2f,
    extra: vec2f,
    scalars_a: vec4f,
    scalars_b: vec4f,
}

@group(0) @binding(0) var input_texture: texture_2d<f32>;
@group(0) @binding(1) var input_sampler: sampler;
@group(1) @binding(0) var<uniform> uniforms: EffectUniforms;

// `extra` carries this frame's texture-sample offset, already resolved to
// pixels by TypeScript (a deterministic function of effect-local time, so
// preview and export always agree). The shader only has to convert it to UV
// space and resample — it never needs to know about time itself. Sampling at
// `tex_coord + extra/resolution` moves the visible image by `-extra`; for
// this zero-mean symmetric jitter that distinction doesn't matter.
@fragment
fn fragment_main(input: VertexOutput) -> @location(0) vec4f {
    let offset_uv = uniforms.extra / uniforms.resolution;
    let sample_uv = clamp(input.tex_coord + offset_uv, vec2f(0.0), vec2f(1.0));
    return textureSampleLevel(input_texture, input_sampler, sample_uv, 0.0);
}
