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

// extra.x = this frame's vignette strength (0..1), pre-resolved by
// TypeScript from effect-local time (a pulsing oscillation).
@fragment
fn fragment_main(input: VertexOutput) -> @location(0) vec4f {
    let source = textureSampleLevel(input_texture, input_sampler, input.tex_coord, 0.0);
    let amount = uniforms.extra.x;
    // Pixel-space distance from centre, normalised so 1.0 lands on the
    // corners — circular, not stretched to the frame's aspect, and only the
    // corners reach full strength (normalising by the short side blacked out
    // whole side edges of a 16:9 frame at intensity 100).
    let centered_px = (input.tex_coord - vec2f(0.5, 0.5)) * uniforms.resolution;
    let dist = length(centered_px) / (0.5 * length(uniforms.resolution));
    let darken = smoothstep(0.4, 1.0, dist) * amount * 0.85;
    return vec4f(source.rgb * (1.0 - darken), source.a);
}
