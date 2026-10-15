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

// extra = this frame's red-channel sample offset in pixels, scalars_a.xy =
// the blue-channel offset; green is sampled unshifted (the classic
// chromatic-aberration glitch look). Both pre-resolved by TypeScript.
@fragment
fn fragment_main(input: VertexOutput) -> @location(0) vec4f {
    let texel_size = vec2f(1.0, 1.0) / uniforms.resolution;
    let red_uv = clamp(
        input.tex_coord + uniforms.extra * texel_size,
        vec2f(0.0),
        vec2f(1.0),
    );
    let blue_uv = clamp(
        input.tex_coord + uniforms.scalars_a.xy * texel_size,
        vec2f(0.0),
        vec2f(1.0),
    );
    let red = textureSampleLevel(input_texture, input_sampler, red_uv, 0.0).r;
    let center = textureSampleLevel(input_texture, input_sampler, input.tex_coord, 0.0);
    let blue = textureSampleLevel(input_texture, input_sampler, blue_uv, 0.0).b;
    return vec4f(red, center.g, blue, center.a);
}
