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

// extra.x = blend amount toward the flash colour this frame (0..1),
// extra.y = that colour's whiteness (1 = white flash, 0 = black flash).
// Both are pre-resolved by TypeScript from effect-local time. Shared by two
// effect definitions, Flash (one-shot decay) and Strobe (repeating pulse) —
// they only differ in how they compute extra.x over time, not in this
// shader.
@fragment
fn fragment_main(input: VertexOutput) -> @location(0) vec4f {
    let source = textureSampleLevel(input_texture, input_sampler, input.tex_coord, 0.0);
    let amount = uniforms.extra.x;
    let flash_color = vec3f(uniforms.extra.y);
    let blended = mix(source.rgb, flash_color, amount);
    return vec4f(blended, source.a);
}
