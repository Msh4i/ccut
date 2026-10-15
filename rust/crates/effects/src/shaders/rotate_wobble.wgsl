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

// extra.x = this frame's rotation angle in radians, extra.y = a constant
// zoom (>= 1) sized by TypeScript for the effect's *maximum* angle, so the
// rotated frame always covers the corners instead of exposing them. Both
// pre-resolved from effect-local time.
@fragment
fn fragment_main(input: VertexOutput) -> @location(0) vec4f {
    let angle = uniforms.extra.x;
    let cover_scale = uniforms.extra.y;
    let aspect = uniforms.resolution.x / uniforms.resolution.y;
    let centered = (input.tex_coord - vec2f(0.5, 0.5)) * vec2f(aspect, 1.0) / cover_scale;
    let c = cos(angle);
    let s = sin(angle);
    let rotated = vec2f(centered.x * c - centered.y * s, centered.x * s + centered.y * c);
    let sample_uv = rotated / vec2f(aspect, 1.0) + vec2f(0.5, 0.5);
    // Outside the rotated picture (only reachable if the cover zoom is ever
    // too small) the pixel is transparent rather than a smeared edge.
    let sampled = textureSampleLevel(
        input_texture,
        input_sampler,
        clamp(sample_uv, vec2f(0.0), vec2f(1.0)),
        0.0,
    );
    let in_bounds = all(sample_uv >= vec2f(0.0)) && all(sample_uv <= vec2f(1.0));
    return select(vec4f(0.0), sampled, in_bounds);
}
