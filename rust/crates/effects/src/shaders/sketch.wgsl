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

// Drawn-on-paper look: washed-out colour on a paper tone, dark strokes where
// the picture has edges (Sobel on luminance), and a fixed paper grain.
// extra = [intensity (0..1, mix with the original), edge strength]
// scalars_a = [colour kept (0 = pencil grey .. 1 = full colour),
//              paper warmth (0 white .. 1 cream), paper grain amount, _]
fn pcg(v: u32) -> u32 {
    let state = v * 747796405u + 2891336453u;
    let word = ((state >> ((state >> 28u) + 4u)) ^ state) * 277803737u;
    return (word >> 22u) ^ word;
}

fn luma_at(uv: vec2f) -> f32 {
    let sample = textureSampleLevel(input_texture, input_sampler, uv, 0.0).rgb;
    return dot(sample, vec3f(0.2126, 0.7152, 0.0722));
}

@fragment
fn fragment_main(input: VertexOutput) -> @location(0) vec4f {
    let source = textureSampleLevel(input_texture, input_sampler, input.tex_coord, 0.0);
    let intensity = uniforms.extra.x;
    let edge_strength = uniforms.extra.y;
    let colour_kept = uniforms.scalars_a.x;
    let paper_warmth = uniforms.scalars_a.y;
    let paper_grain = uniforms.scalars_a.z;

    let t = vec2f(1.0) / uniforms.resolution;
    let uv = input.tex_coord;
    let tl = luma_at(uv + vec2f(-t.x, -t.y));
    let tc = luma_at(uv + vec2f(0.0, -t.y));
    let tr = luma_at(uv + vec2f(t.x, -t.y));
    let ml = luma_at(uv + vec2f(-t.x, 0.0));
    let mr = luma_at(uv + vec2f(t.x, 0.0));
    let bl = luma_at(uv + vec2f(-t.x, t.y));
    let bc = luma_at(uv + vec2f(0.0, t.y));
    let br = luma_at(uv + vec2f(t.x, t.y));
    let gx = (tr + 2.0 * mr + br) - (tl + 2.0 * ml + bl);
    let gy = (bl + 2.0 * bc + br) - (tl + 2.0 * tc + tr);
    let edge = clamp(length(vec2f(gx, gy)) * edge_strength, 0.0, 1.0);

    let luma = dot(source.rgb, vec3f(0.2126, 0.7152, 0.0722));
    let paper = mix(vec3f(0.97, 0.97, 0.96), vec3f(0.96, 0.91, 0.82), paper_warmth);
    let tone = mix(vec3f(luma), source.rgb, colour_kept);
    let washed = mix(tone, paper, 0.45) * mix(vec3f(1.0), paper, 0.3);

    let pixel = vec2u(input.position.xy);
    let grain = f32(pcg(pixel.x + pcg(pixel.y))) / 4294967295.0 - 0.5;
    let drawn = washed * (1.0 - edge * 0.85) + grain * paper_grain;

    let result = clamp(drawn, vec3f(0.0), vec3f(1.0));
    return vec4f(mix(source.rgb, result, intensity), source.a);
}
