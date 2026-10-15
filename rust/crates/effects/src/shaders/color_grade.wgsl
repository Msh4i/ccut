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

// A parametric colour grade, the base of every colour filter.
// extra = [intensity (0..1, mix with the original), saturation (1 = unchanged)]
// scalars_a = [contrast (1 = unchanged), fade (0..1, lifted blacks),
//              temperature (-1 cool .. 1 warm), tint (-1 green .. 1 magenta)]
// scalars_b = [shadow tone hue (0..1), shadow tone amount,
//              highlight tone hue (0..1), highlight tone amount]
fn hue_to_rgb(hue: f32) -> vec3f {
    let k = abs(fract(vec3f(hue) + vec3f(0.0, 2.0 / 3.0, 1.0 / 3.0)) * 6.0 - 3.0) - 1.0;
    return clamp(k, vec3f(0.0), vec3f(1.0));
}

@fragment
fn fragment_main(input: VertexOutput) -> @location(0) vec4f {
    let source = textureSampleLevel(input_texture, input_sampler, input.tex_coord, 0.0);
    let intensity = uniforms.extra.x;
    let saturation = uniforms.extra.y;
    let contrast = uniforms.scalars_a.x;
    let fade = uniforms.scalars_a.y;
    let temperature = uniforms.scalars_a.z;
    let tint = uniforms.scalars_a.w;
    let luma_weights = vec3f(0.2126, 0.7152, 0.0722);

    var graded = source.rgb + vec3f(temperature, tint * 0.5, -temperature) * 0.1;
    graded = mix(vec3f(dot(graded, luma_weights)), graded, saturation);
    graded = (graded - 0.5) * contrast + 0.5;

    let luma = clamp(dot(graded, luma_weights), 0.0, 1.0);
    let shadow_weight = 1.0 - smoothstep(0.0, 0.55, luma);
    let highlight_weight = smoothstep(0.45, 1.0, luma);
    graded += (hue_to_rgb(uniforms.scalars_b.x) - 0.5) * uniforms.scalars_b.y * shadow_weight;
    graded += (hue_to_rgb(uniforms.scalars_b.z) - 0.5) * uniforms.scalars_b.w * highlight_weight;

    graded = mix(graded, graded * 0.85 + 0.12, fade);
    graded = clamp(graded, vec3f(0.0), vec3f(1.0));
    return vec4f(mix(source.rgb, graded, intensity), source.a);
}
