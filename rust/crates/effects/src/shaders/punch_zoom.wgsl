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

// extra.x carries this frame's zoom scale (>= 1.0), already resolved from
// effect-local time by TypeScript (a punch that decays back to 1.0).
@fragment
fn fragment_main(input: VertexOutput) -> @location(0) vec4f {
    let scale = uniforms.extra.x;
    let center = vec2f(0.5, 0.5);
    let sample_uv = clamp(
        center + (input.tex_coord - center) / scale,
        vec2f(0.0),
        vec2f(1.0),
    );
    return textureSampleLevel(input_texture, input_sampler, sample_uv, 0.0);
}
