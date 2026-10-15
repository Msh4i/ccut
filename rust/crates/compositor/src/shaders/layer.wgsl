struct VertexOutput {
    @builtin(position) position: vec4f,
    @location(0) tex_coord: vec2f,
}

struct LayerUniforms {
    resolution: vec2f,
    center: vec2f,
    size: vec2f,
    rotation_radians: f32,
    opacity: f32,
    flip_x: f32,
    flip_y: f32,
    // 1.0 when the layer is placed by the inverse homography below (a 3D layer);
    // the 2D fields above are then ignored.
    homography_enabled: f32,
    _padding: f32,
    // Rows of the inverse homography: canvas pixels -> layer UV (xyz used).
    inverse_homography_row0: vec4f,
    inverse_homography_row1: vec4f,
    inverse_homography_row2: vec4f,
}

@group(0) @binding(0) var source_texture: texture_2d<f32>;
@group(0) @binding(1) var source_sampler: sampler;
@group(1) @binding(0) var<uniform> uniforms: LayerUniforms;

fn rotate_inverse(point: vec2f, angle: f32) -> vec2f {
    let c = cos(angle);
    let s = sin(angle);
    return vec2f(
        point.x * c + point.y * s,
        -point.x * s + point.y * c,
    );
}

// A 3D layer: the canvas pixel goes back through the inverse homography.
// Transparent where the layer point is behind the camera (q.z <= 0) or
// outside the layer's UV square.
fn sample_homography(pixel: vec2f) -> vec4f {
    let p = vec3f(pixel, 1.0);
    let q = vec3f(
        dot(uniforms.inverse_homography_row0.xyz, p),
        dot(uniforms.inverse_homography_row1.xyz, p),
        dot(uniforms.inverse_homography_row2.xyz, p),
    );
    if (q.z <= 0.0) {
        return vec4f(0.0, 0.0, 0.0, 0.0);
    }

    let uv = q.xy / q.z;
    if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) {
        return vec4f(0.0, 0.0, 0.0, 0.0);
    }

    let color = textureSampleLevel(source_texture, source_sampler, uv, 0.0);
    return vec4f(color.rgb, color.a * uniforms.opacity);
}

@fragment
fn fragment_main(input: VertexOutput) -> @location(0) vec4f {
    let pixel = input.tex_coord * uniforms.resolution;
    if (uniforms.homography_enabled > 0.5) {
        return sample_homography(pixel);
    }

    let local = rotate_inverse(pixel - uniforms.center, uniforms.rotation_radians);

    let uv = vec2f(
        local.x / uniforms.size.x + 0.5,
        local.y / uniforms.size.y + 0.5,
    );

    if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) {
        return vec4f(0.0, 0.0, 0.0, 0.0);
    }

    let sample_uv = vec2f(
        select(uv.x, 1.0 - uv.x, uniforms.flip_x > 0.5),
        select(uv.y, 1.0 - uv.y, uniforms.flip_y > 0.5),
    );
    let color = textureSampleLevel(source_texture, source_sampler, sample_uv, 0.0);
    return vec4f(color.rgb, color.a * uniforms.opacity);
}
