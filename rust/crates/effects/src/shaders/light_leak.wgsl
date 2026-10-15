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

const LEAK_COLOR: vec3f = vec3f(1.0, 0.7, 0.35);
const LEAK_RADIUS: f32 = 0.6;

// extra = this frame's leak centre in UV space (0..1), already swept over
// effect-local time by TypeScript; scalars_a.x = leak intensity (0..1).
@fragment
fn fragment_main(input: VertexOutput) -> @location(0) vec4f {
    let source = textureSampleLevel(input_texture, input_sampler, input.tex_coord, 0.0);
    let dist = length(input.tex_coord - uniforms.extra);
    let falloff = clamp(1.0 - dist / LEAK_RADIUS, 0.0, 1.0);
    let strength = falloff * falloff * uniforms.scalars_a.x;
    return vec4f(source.rgb + LEAK_COLOR * strength, source.a);
}
