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

// PCG hash ("pcg_hash", Jarzynski & Olano 2020, "Hash Functions for GPU
// Rendering"): integer-only, so unlike the common fract(sin(dot(...)))
// hash it has no float-precision cliff at large pixel coordinates (that
// one visibly bands at 4K) and gives the same bits on every GPU.
fn pcg(v: u32) -> u32 {
    let state = v * 747796405u + 2891336453u;
    let word = ((state >> ((state >> 28u) + 4u)) ^ state) * 277803737u;
    return (word >> 22u) ^ word;
}

// extra.x = a small non-negative integer seed that TypeScript advances in
// discrete steps over effect-local time (so a grain pattern holds for a
// moment and then jumps, like real film grain, instead of smoothly
// drifting); extra.y = grain amount (0..1).
@fragment
fn fragment_main(input: VertexOutput) -> @location(0) vec4f {
    let source = textureSampleLevel(input_texture, input_sampler, input.tex_coord, 0.0);
    let pixel = vec2u(input.position.xy);
    let seed = u32(uniforms.extra.x);
    let hashed = pcg(pixel.x + pcg(pixel.y + pcg(seed)));
    let noise = f32(hashed) / 4294967295.0 * 2.0 - 1.0;
    let amount = uniforms.extra.y;
    return vec4f(source.rgb + noise * amount, source.a);
}
