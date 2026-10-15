use std::cell::RefCell;
use std::collections::HashMap;

use bytemuck::{Pod, Zeroable};
use gpu::{FULLSCREEN_SHADER_SOURCE, GpuContext, Release};
use thiserror::Error;
use wgpu::util::DeviceExt;

use crate::pass_resources::PassResources;
use crate::{EffectPass, UniformValue};

const GAUSSIAN_BLUR_SHADER_ID: &str = "gaussian-blur";
const GAUSSIAN_BLUR_SHADER_SOURCE: &str = include_str!("shaders/gaussian_blur.wgsl");
const SHAKE_SHADER_ID: &str = "shake";
const SHAKE_SHADER_SOURCE: &str = include_str!("shaders/shake.wgsl");
const PUNCH_ZOOM_SHADER_ID: &str = "punch-zoom";
const PUNCH_ZOOM_SHADER_SOURCE: &str = include_str!("shaders/punch_zoom.wgsl");
const FLASH_SHADER_ID: &str = "flash";
const FLASH_SHADER_SOURCE: &str = include_str!("shaders/flash.wgsl");
const GLITCH_SHADER_ID: &str = "glitch";
const GLITCH_SHADER_SOURCE: &str = include_str!("shaders/glitch.wgsl");
const VIGNETTE_PULSE_SHADER_ID: &str = "vignette-pulse";
const VIGNETTE_PULSE_SHADER_SOURCE: &str = include_str!("shaders/vignette_pulse.wgsl");
const FILM_GRAIN_SHADER_ID: &str = "film-grain";
const FILM_GRAIN_SHADER_SOURCE: &str = include_str!("shaders/film_grain.wgsl");
const LIGHT_LEAK_SHADER_ID: &str = "light-leak";
const LIGHT_LEAK_SHADER_SOURCE: &str = include_str!("shaders/light_leak.wgsl");
const ROTATE_WOBBLE_SHADER_ID: &str = "rotate-wobble";
const ROTATE_WOBBLE_SHADER_SOURCE: &str = include_str!("shaders/rotate_wobble.wgsl");
const COLOR_GRADE_SHADER_ID: &str = "color-grade";
const COLOR_GRADE_SHADER_SOURCE: &str = include_str!("shaders/color_grade.wgsl");
const SKETCH_SHADER_ID: &str = "sketch";
const SKETCH_SHADER_SOURCE: &str = include_str!("shaders/sketch.wgsl");

type PackUniforms = fn(&EffectPass, [f32; 2]) -> Result<EffectUniformBuffer, EffectsError>;

/// One row per effect shader. Adding a shader means adding exactly one row
/// here (plus the `.wgsl` file and its `pack_*_uniforms` function) — pipeline
/// creation and uniform packing both read from this single table, so there
/// is nowhere else a new shader's id needs to be repeated.
struct EffectShader {
    id: &'static str,
    label: &'static str,
    source: &'static str,
    pack: PackUniforms,
}

const EFFECT_SHADERS: &[EffectShader] = &[
    EffectShader {
        id: GAUSSIAN_BLUR_SHADER_ID,
        label: "gaussian-blur",
        source: GAUSSIAN_BLUR_SHADER_SOURCE,
        pack: pack_gaussian_blur_uniforms,
    },
    EffectShader {
        id: SHAKE_SHADER_ID,
        label: "shake",
        source: SHAKE_SHADER_SOURCE,
        pack: pack_shake_uniforms,
    },
    EffectShader {
        id: PUNCH_ZOOM_SHADER_ID,
        label: "punch-zoom",
        source: PUNCH_ZOOM_SHADER_SOURCE,
        pack: pack_punch_zoom_uniforms,
    },
    EffectShader {
        id: FLASH_SHADER_ID,
        label: "flash",
        source: FLASH_SHADER_SOURCE,
        pack: pack_flash_uniforms,
    },
    EffectShader {
        id: GLITCH_SHADER_ID,
        label: "glitch",
        source: GLITCH_SHADER_SOURCE,
        pack: pack_glitch_uniforms,
    },
    EffectShader {
        id: VIGNETTE_PULSE_SHADER_ID,
        label: "vignette-pulse",
        source: VIGNETTE_PULSE_SHADER_SOURCE,
        pack: pack_vignette_pulse_uniforms,
    },
    EffectShader {
        id: FILM_GRAIN_SHADER_ID,
        label: "film-grain",
        source: FILM_GRAIN_SHADER_SOURCE,
        pack: pack_film_grain_uniforms,
    },
    EffectShader {
        id: LIGHT_LEAK_SHADER_ID,
        label: "light-leak",
        source: LIGHT_LEAK_SHADER_SOURCE,
        pack: pack_light_leak_uniforms,
    },
    EffectShader {
        id: ROTATE_WOBBLE_SHADER_ID,
        label: "rotate-wobble",
        source: ROTATE_WOBBLE_SHADER_SOURCE,
        pack: pack_rotate_wobble_uniforms,
    },
    EffectShader {
        id: COLOR_GRADE_SHADER_ID,
        label: "color-grade",
        source: COLOR_GRADE_SHADER_SOURCE,
        pack: pack_color_grade_uniforms,
    },
    EffectShader {
        id: SKETCH_SHADER_ID,
        label: "sketch",
        source: SKETCH_SHADER_SOURCE,
        pack: pack_sketch_uniforms,
    },
];

pub struct ApplyEffectsOptions<'a> {
    pub source: &'a wgpu::Texture,
    pub width: u32,
    pub height: u32,
    pub passes: &'a [EffectPass],
}

pub struct EffectPipeline {
    uniform_bind_group_layout: wgpu::BindGroupLayout,
    pipelines: HashMap<String, wgpu::RenderPipeline>,
    /// Output textures and uniform buffers of the passes (`pass_resources.rs`).
    ///
    /// Until the owner calls `recycle_frame` the first time, every pass creates
    /// its own, as before (callers that never signal frames, like the one-off
    /// effect preview, keep working). From then on they come from frame pools,
    /// so a blur no longer creates a frame-sized texture and a uniform buffer
    /// per pass and frame that only the JavaScript garbage collector would free
    /// (wgpu's WebGPU backend drops nothing). A texture returned by
    /// `apply_with_encoder` is valid until the next `recycle_frame`: whoever
    /// keeps a result longer must copy it.
    resources: RefCell<PassResources<wgpu::Texture, wgpu::Buffer>>,
}

/// What one run of the passes produced. `scratch_*` lists what it created
/// outside the pools (the output texture included), so a caller that has
/// submitted the commands can release it.
struct EncodedPasses {
    output: wgpu::Texture,
    scratch_textures: Vec<wgpu::Texture>,
    scratch_buffers: Vec<wgpu::Buffer>,
}

#[derive(Debug, Error)]
pub enum EffectsError {
    #[error("At least one effect pass is required")]
    MissingEffectPasses,
    #[error("Unknown effect shader '{shader}'")]
    UnknownEffectShader { shader: String },
    #[error("Missing uniform '{uniform}' for shader '{shader}'")]
    MissingUniform { shader: String, uniform: String },
    #[error("Uniform '{uniform}' for shader '{shader}' must be a number")]
    InvalidNumberUniform { shader: String, uniform: String },
    #[error(
        "Uniform '{uniform}' for shader '{shader}' must be a vector of length {expected_length}"
    )]
    InvalidVectorUniform {
        shader: String,
        uniform: String,
        expected_length: usize,
    },
    #[error("Shader '{shader}' does not support uniform '{uniform}'")]
    UnsupportedUniform { shader: String, uniform: String },
}

/// Generic per-pass uniform layout shared by every effect shader. `extra` and
/// the `scalars_*` fields have no fixed meaning — each shader's pack function
/// (below) defines what it writes there, documented next to that function.
#[repr(C)]
#[derive(Clone, Copy, Debug, Pod, Zeroable)]
struct EffectUniformBuffer {
    resolution: [f32; 2],
    extra: [f32; 2],
    scalars_a: [f32; 4],
    scalars_b: [f32; 4],
}

impl EffectPipeline {
    pub fn new(context: &GpuContext) -> Self {
        let uniform_bind_group_layout =
            context
                .device()
                .create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
                    label: Some("effects-uniform-bind-group-layout"),
                    entries: &[wgpu::BindGroupLayoutEntry {
                        binding: 0,
                        visibility: wgpu::ShaderStages::FRAGMENT,
                        ty: wgpu::BindingType::Buffer {
                            ty: wgpu::BufferBindingType::Uniform,
                            has_dynamic_offset: false,
                            min_binding_size: None,
                        },
                        count: None,
                    }],
                });
        let vertex_shader_module =
            context
                .device()
                .create_shader_module(wgpu::ShaderModuleDescriptor {
                    label: Some("effects-fullscreen-shader"),
                    source: wgpu::ShaderSource::Wgsl(FULLSCREEN_SHADER_SOURCE.into()),
                });
        let pipeline_layout =
            context
                .device()
                .create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
                    label: Some("effects-pipeline-layout"),
                    bind_group_layouts: &[
                        Some(context.texture_sampler_bind_group_layout()),
                        Some(&uniform_bind_group_layout),
                    ],
                    immediate_size: 0,
                });

        let pipelines = EFFECT_SHADERS
            .iter()
            .map(|shader| {
                let shader_module =
                    context
                        .device()
                        .create_shader_module(wgpu::ShaderModuleDescriptor {
                            label: Some(&format!("effects-{}-shader", shader.label)),
                            source: wgpu::ShaderSource::Wgsl(shader.source.into()),
                        });
                let pipeline =
                    context
                        .device()
                        .create_render_pipeline(&wgpu::RenderPipelineDescriptor {
                            label: Some(&format!("effects-{}-pipeline", shader.label)),
                            layout: Some(&pipeline_layout),
                            vertex: wgpu::VertexState {
                                module: &vertex_shader_module,
                                entry_point: Some("vertex_main"),
                                buffers: &[wgpu::VertexBufferLayout {
                                    array_stride: std::mem::size_of::<[f32; 2]>() as u64,
                                    step_mode: wgpu::VertexStepMode::Vertex,
                                    attributes: &[wgpu::VertexAttribute {
                                        format: wgpu::VertexFormat::Float32x2,
                                        offset: 0,
                                        shader_location: 0,
                                    }],
                                }],
                                compilation_options: wgpu::PipelineCompilationOptions::default(),
                            },
                            fragment: Some(wgpu::FragmentState {
                                module: &shader_module,
                                entry_point: Some("fragment_main"),
                                targets: &[Some(wgpu::ColorTargetState {
                                    format: context.texture_format(),
                                    blend: None,
                                    write_mask: wgpu::ColorWrites::ALL,
                                })],
                                compilation_options: wgpu::PipelineCompilationOptions::default(),
                            }),
                            primitive: wgpu::PrimitiveState::default(),
                            depth_stencil: None,
                            multisample: wgpu::MultisampleState::default(),
                            multiview_mask: None,
                            cache: None,
                        });
                (shader.id.to_string(), pipeline)
            })
            .collect();

        Self {
            uniform_bind_group_layout,
            pipelines,
            resources: RefCell::new(PassResources::default()),
        }
    }

    /// Starts a frame: the textures and buffers the previous frame's passes
    /// used are handed out again. Call it once per frame, before encoding any
    /// pass of the frame and after the previous frame's commands were submitted
    /// (or dropped). The first call switches the pipeline to pooled resources.
    pub fn recycle_frame(&self) {
        self.resources.borrow_mut().recycle_frame();
    }

    /// Textures and uniform buffers the pools created so far (0 before pooling).
    pub fn pooled_resource_counts(&self) -> (usize, usize) {
        self.resources.borrow().created()
    }

    pub fn apply(
        &self,
        context: &GpuContext,
        ApplyEffectsOptions {
            source,
            width,
            height,
            passes,
        }: ApplyEffectsOptions<'_>,
    ) -> Result<wgpu::Texture, EffectsError> {
        let mut encoder =
            context
                .device()
                .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                    label: Some("effects-command-encoder"),
                });
        let encoded = self.encode_passes(
            context,
            &mut encoder,
            ApplyEffectsOptions {
                source,
                width,
                height,
                passes,
            },
        )?;
        context.queue().submit([encoder.finish()]);
        // Submitted: the intermediate results can go (destroy waits for the GPU).
        for texture in &encoded.scratch_textures {
            if *texture != encoded.output {
                texture.release();
            }
        }
        for buffer in &encoded.scratch_buffers {
            buffer.release();
        }
        Ok(encoded.output)
    }

    pub fn apply_with_encoder(
        &self,
        context: &GpuContext,
        encoder: &mut wgpu::CommandEncoder,
        options: ApplyEffectsOptions<'_>,
    ) -> Result<wgpu::Texture, EffectsError> {
        // Not submitted yet: nothing created here may be released now.
        self.encode_passes(context, encoder, options)
            .map(|encoded| encoded.output)
    }

    fn encode_passes(
        &self,
        context: &GpuContext,
        encoder: &mut wgpu::CommandEncoder,
        ApplyEffectsOptions {
            source,
            width,
            height,
            passes,
        }: ApplyEffectsOptions<'_>,
    ) -> Result<EncodedPasses, EffectsError> {
        let mut current_texture: Option<wgpu::Texture> = None;
        let mut scratch_textures = Vec::new();
        let mut scratch_buffers = Vec::new();

        for pass in passes {
            let input_texture = current_texture.as_ref().unwrap_or(source);
            let output_texture = self.pass_texture(context, width, height, &mut scratch_textures);
            let input_view = input_texture.create_view(&wgpu::TextureViewDescriptor::default());
            let output_view = output_texture.create_view(&wgpu::TextureViewDescriptor::default());
            let texture_bind_group =
                context
                    .device()
                    .create_bind_group(&wgpu::BindGroupDescriptor {
                        label: Some("effects-texture-bind-group"),
                        layout: context.texture_sampler_bind_group_layout(),
                        entries: &[
                            wgpu::BindGroupEntry {
                                binding: 0,
                                resource: wgpu::BindingResource::TextureView(&input_view),
                            },
                            wgpu::BindGroupEntry {
                                binding: 1,
                                resource: wgpu::BindingResource::Sampler(context.linear_sampler()),
                            },
                        ],
                    });
            let uniforms = pack_effect_uniforms(pass, width, height)?;
            let uniform_buffer = self.pass_uniform_buffer(context, &uniforms, &mut scratch_buffers);
            let uniform_bind_group =
                context
                    .device()
                    .create_bind_group(&wgpu::BindGroupDescriptor {
                        label: Some("effects-uniform-bind-group"),
                        layout: &self.uniform_bind_group_layout,
                        entries: &[wgpu::BindGroupEntry {
                            binding: 0,
                            resource: uniform_buffer.as_entire_binding(),
                        }],
                    });
            let pipeline = self.pipelines.get(&pass.shader).ok_or_else(|| {
                EffectsError::UnknownEffectShader {
                    shader: pass.shader.clone(),
                }
            })?;

            {
                let mut render_pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                    label: Some("effects-render-pass"),
                    color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                        view: &output_view,
                        resolve_target: None,
                        depth_slice: None,
                        ops: wgpu::Operations {
                            load: wgpu::LoadOp::Clear(wgpu::Color::TRANSPARENT),
                            store: wgpu::StoreOp::Store,
                        },
                    })],
                    depth_stencil_attachment: None,
                    occlusion_query_set: None,
                    timestamp_writes: None,
                    multiview_mask: None,
                });
                render_pass.set_pipeline(pipeline);
                render_pass.set_vertex_buffer(0, context.fullscreen_quad().slice(..));
                render_pass.set_bind_group(0, &texture_bind_group, &[]);
                render_pass.set_bind_group(1, &uniform_bind_group, &[]);
                render_pass.draw(0..6, 0..1);
            }

            current_texture = Some(output_texture);
        }

        let output = current_texture.ok_or(EffectsError::MissingEffectPasses)?;
        Ok(EncodedPasses {
            output,
            scratch_textures,
            scratch_buffers,
        })
    }

    fn pass_texture(
        &self,
        context: &GpuContext,
        width: u32,
        height: u32,
        scratch: &mut Vec<wgpu::Texture>,
    ) -> wgpu::Texture {
        self.resources.borrow_mut().texture(
            (width, height),
            || context.create_render_texture(width, height, "effects-pass-output"),
            scratch,
        )
    }

    fn pass_uniform_buffer(
        &self,
        context: &GpuContext,
        uniforms: &EffectUniformBuffer,
        scratch: &mut Vec<wgpu::Buffer>,
    ) -> wgpu::Buffer {
        let uniform = self.resources.borrow_mut().uniform(
            || {
                context.device().create_buffer(&wgpu::BufferDescriptor {
                    label: Some("effects-uniform-buffer"),
                    size: std::mem::size_of::<EffectUniformBuffer>() as u64,
                    usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
                    mapped_at_creation: false,
                })
            },
            || {
                context
                    .device()
                    .create_buffer_init(&wgpu::util::BufferInitDescriptor {
                        label: Some("effects-uniform-buffer"),
                        contents: bytemuck::bytes_of(uniforms),
                        usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
                    })
            },
            scratch,
        );
        if uniform.pooled {
            // Queue order: this write runs after the submitted frames that read
            // the buffer and before this frame's commands; no other pass of
            // this frame has the same buffer.
            context
                .queue()
                .write_buffer(&uniform.buffer, 0, bytemuck::bytes_of(uniforms));
        }
        uniform.buffer
    }
}

fn pack_effect_uniforms(
    pass: &EffectPass,
    width: u32,
    height: u32,
) -> Result<EffectUniformBuffer, EffectsError> {
    let resolution = [width as f32, height as f32];
    let shader = EFFECT_SHADERS
        .iter()
        .find(|shader| shader.id == pass.shader)
        .ok_or_else(|| EffectsError::UnknownEffectShader {
            shader: pass.shader.clone(),
        })?;
    (shader.pack)(pass, resolution)
}

/// Blur: `extra` = blur direction (x, y); `scalars_a` = [sigma, step, _, _].
fn pack_gaussian_blur_uniforms(
    pass: &EffectPass,
    resolution: [f32; 2],
) -> Result<EffectUniformBuffer, EffectsError> {
    let sigma = read_number_uniform(pass, "u_sigma")?;
    let step = read_number_uniform(pass, "u_step")?;
    let direction = read_vec2_uniform(pass, "u_direction")?;
    reject_unsupported_uniforms(pass, &["u_sigma", "u_step", "u_direction"])?;

    Ok(EffectUniformBuffer {
        resolution,
        extra: direction,
        scalars_a: [sigma, step, 0.0, 0.0],
        scalars_b: [0.0; 4],
    })
}

/// Shake: `extra` = this frame's texture-sample offset in pixels (x, y),
/// already resolved from effect-local time by TypeScript. The shader samples
/// at `tex_coord + extra/resolution`, so the visible image moves by
/// `-extra`, not `extra` — irrelevant for this zero-mean symmetric jitter,
/// but worth knowing if `extra` is ever reused for a directional effect.
fn pack_shake_uniforms(
    pass: &EffectPass,
    resolution: [f32; 2],
) -> Result<EffectUniformBuffer, EffectsError> {
    let offset = read_vec2_uniform(pass, "u_offset")?;
    reject_unsupported_uniforms(pass, &["u_offset"])?;

    Ok(EffectUniformBuffer {
        resolution,
        extra: offset,
        scalars_a: [0.0; 4],
        scalars_b: [0.0; 4],
    })
}

/// Punch zoom: `extra.x` = this frame's zoom scale (>= 1.0).
fn pack_punch_zoom_uniforms(
    pass: &EffectPass,
    resolution: [f32; 2],
) -> Result<EffectUniformBuffer, EffectsError> {
    let scale = read_number_uniform(pass, "u_scale")?;
    reject_unsupported_uniforms(pass, &["u_scale"])?;

    Ok(EffectUniformBuffer {
        resolution,
        extra: [scale, 0.0],
        scalars_a: [0.0; 4],
        scalars_b: [0.0; 4],
    })
}

/// Flash/Strobe: `extra` = [blend amount (0..1), flash colour whiteness
/// (0 = black, 1 = white)].
fn pack_flash_uniforms(
    pass: &EffectPass,
    resolution: [f32; 2],
) -> Result<EffectUniformBuffer, EffectsError> {
    let amount = read_number_uniform(pass, "u_amount")?;
    let whiteness = read_number_uniform(pass, "u_whiteness")?;
    reject_unsupported_uniforms(pass, &["u_amount", "u_whiteness"])?;

    Ok(EffectUniformBuffer {
        resolution,
        extra: [amount, whiteness],
        scalars_a: [0.0; 4],
        scalars_b: [0.0; 4],
    })
}

/// Glitch (RGB split): `extra` = red-channel offset (x, y) in pixels,
/// `scalars_a` = [blue-channel offset x, y, _, _].
fn pack_glitch_uniforms(
    pass: &EffectPass,
    resolution: [f32; 2],
) -> Result<EffectUniformBuffer, EffectsError> {
    let red_offset = read_vec2_uniform(pass, "u_red_offset")?;
    let blue_offset = read_vec2_uniform(pass, "u_blue_offset")?;
    reject_unsupported_uniforms(pass, &["u_red_offset", "u_blue_offset"])?;

    Ok(EffectUniformBuffer {
        resolution,
        extra: red_offset,
        scalars_a: [blue_offset[0], blue_offset[1], 0.0, 0.0],
        scalars_b: [0.0; 4],
    })
}

/// Vignette pulse: `extra.x` = this frame's vignette strength (0..1).
fn pack_vignette_pulse_uniforms(
    pass: &EffectPass,
    resolution: [f32; 2],
) -> Result<EffectUniformBuffer, EffectsError> {
    let amount = read_number_uniform(pass, "u_amount")?;
    reject_unsupported_uniforms(pass, &["u_amount"])?;

    Ok(EffectUniformBuffer {
        resolution,
        extra: [amount, 0.0],
        scalars_a: [0.0; 4],
        scalars_b: [0.0; 4],
    })
}

/// Film grain: `extra` = [seed, grain amount (0..1)].
fn pack_film_grain_uniforms(
    pass: &EffectPass,
    resolution: [f32; 2],
) -> Result<EffectUniformBuffer, EffectsError> {
    let seed = read_number_uniform(pass, "u_seed")?;
    let amount = read_number_uniform(pass, "u_amount")?;
    reject_unsupported_uniforms(pass, &["u_seed", "u_amount"])?;

    Ok(EffectUniformBuffer {
        resolution,
        extra: [seed, amount],
        scalars_a: [0.0; 4],
        scalars_b: [0.0; 4],
    })
}

/// Light leak: `extra` = leak centre in UV space (x, y), `scalars_a` =
/// [intensity (0..1), _, _, _].
fn pack_light_leak_uniforms(
    pass: &EffectPass,
    resolution: [f32; 2],
) -> Result<EffectUniformBuffer, EffectsError> {
    let center = read_vec2_uniform(pass, "u_center")?;
    let intensity = read_number_uniform(pass, "u_intensity")?;
    reject_unsupported_uniforms(pass, &["u_center", "u_intensity"])?;

    Ok(EffectUniformBuffer {
        resolution,
        extra: center,
        scalars_a: [intensity, 0.0, 0.0, 0.0],
        scalars_b: [0.0; 4],
    })
}

/// Rotate wobble: `extra` = [rotation angle in radians, constant cover zoom
/// (>= 1) sized for the effect's maximum angle].
fn pack_rotate_wobble_uniforms(
    pass: &EffectPass,
    resolution: [f32; 2],
) -> Result<EffectUniformBuffer, EffectsError> {
    let angle = read_number_uniform(pass, "u_angle")?;
    let cover_scale = read_number_uniform(pass, "u_cover_scale")?;
    reject_unsupported_uniforms(pass, &["u_angle", "u_cover_scale"])?;

    Ok(EffectUniformBuffer {
        resolution,
        extra: [angle, cover_scale],
        scalars_a: [0.0; 4],
        scalars_b: [0.0; 4],
    })
}

/// Colour grade (filters): `extra` = [intensity, saturation], `scalars_a` =
/// [contrast, fade, temperature, tint], `scalars_b` = [shadow hue, shadow
/// amount, highlight hue, highlight amount].
fn pack_color_grade_uniforms(
    pass: &EffectPass,
    resolution: [f32; 2],
) -> Result<EffectUniformBuffer, EffectsError> {
    let intensity = read_number_uniform(pass, "u_intensity")?;
    let saturation = read_number_uniform(pass, "u_saturation")?;
    let contrast = read_number_uniform(pass, "u_contrast")?;
    let fade = read_number_uniform(pass, "u_fade")?;
    let temperature = read_number_uniform(pass, "u_temperature")?;
    let tint = read_number_uniform(pass, "u_tint")?;
    let shadow = read_vec2_uniform(pass, "u_shadow_tone")?;
    let highlight = read_vec2_uniform(pass, "u_highlight_tone")?;
    reject_unsupported_uniforms(
        pass,
        &[
            "u_intensity",
            "u_saturation",
            "u_contrast",
            "u_fade",
            "u_temperature",
            "u_tint",
            "u_shadow_tone",
            "u_highlight_tone",
        ],
    )?;

    Ok(EffectUniformBuffer {
        resolution,
        extra: [intensity, saturation],
        scalars_a: [contrast, fade, temperature, tint],
        scalars_b: [shadow[0], shadow[1], highlight[0], highlight[1]],
    })
}

/// Sketch (Paper / Pencil filters): `extra` = [intensity, edge strength],
/// `scalars_a` = [colour kept, paper warmth, paper grain, _].
fn pack_sketch_uniforms(
    pass: &EffectPass,
    resolution: [f32; 2],
) -> Result<EffectUniformBuffer, EffectsError> {
    let intensity = read_number_uniform(pass, "u_intensity")?;
    let edge = read_number_uniform(pass, "u_edge")?;
    let colour_kept = read_number_uniform(pass, "u_color_kept")?;
    let paper_warmth = read_number_uniform(pass, "u_paper_warmth")?;
    let paper_grain = read_number_uniform(pass, "u_paper_grain")?;
    reject_unsupported_uniforms(
        pass,
        &[
            "u_intensity",
            "u_edge",
            "u_color_kept",
            "u_paper_warmth",
            "u_paper_grain",
        ],
    )?;

    Ok(EffectUniformBuffer {
        resolution,
        extra: [intensity, edge],
        scalars_a: [colour_kept, paper_warmth, paper_grain, 0.0],
        scalars_b: [0.0; 4],
    })
}

fn reject_unsupported_uniforms(
    pass: &EffectPass,
    known_uniforms: &[&str],
) -> Result<(), EffectsError> {
    for uniform in pass.uniforms.keys() {
        if known_uniforms.contains(&uniform.as_str()) {
            continue;
        }
        return Err(EffectsError::UnsupportedUniform {
            shader: pass.shader.clone(),
            uniform: uniform.clone(),
        });
    }
    Ok(())
}

fn read_number_uniform(pass: &EffectPass, uniform: &str) -> Result<f32, EffectsError> {
    let Some(value) = pass.uniforms.get(uniform) else {
        return Err(EffectsError::MissingUniform {
            shader: pass.shader.clone(),
            uniform: uniform.to_string(),
        });
    };
    match value {
        UniformValue::Number(value) => Ok(*value),
        UniformValue::Vector(_) => Err(EffectsError::InvalidNumberUniform {
            shader: pass.shader.clone(),
            uniform: uniform.to_string(),
        }),
    }
}

fn read_vec2_uniform(pass: &EffectPass, uniform: &str) -> Result<[f32; 2], EffectsError> {
    let Some(value) = pass.uniforms.get(uniform) else {
        return Err(EffectsError::MissingUniform {
            shader: pass.shader.clone(),
            uniform: uniform.to_string(),
        });
    };
    let UniformValue::Vector(values) = value else {
        return Err(EffectsError::InvalidVectorUniform {
            shader: pass.shader.clone(),
            uniform: uniform.to_string(),
            expected_length: 2,
        });
    };
    if values.len() != 2 {
        return Err(EffectsError::InvalidVectorUniform {
            shader: pass.shader.clone(),
            uniform: uniform.to_string(),
            expected_length: 2,
        });
    }
    Ok([values[0], values[1]])
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pass_with(shader: &str, uniforms: &[(&str, UniformValue)]) -> EffectPass {
        EffectPass {
            shader: shader.to_string(),
            uniforms: uniforms
                .iter()
                .map(|(name, value)| (name.to_string(), value.clone()))
                .collect(),
        }
    }

    #[test]
    fn packs_gaussian_blur_uniforms_into_extra_and_scalars_a() {
        let pass = pass_with(
            GAUSSIAN_BLUR_SHADER_ID,
            &[
                ("u_sigma", UniformValue::Number(3.5)),
                ("u_step", UniformValue::Number(2.0)),
                ("u_direction", UniformValue::Vector(vec![1.0, 0.0])),
            ],
        );

        let buffer = pack_effect_uniforms(&pass, 1920, 1080).expect("blur uniforms pack");

        assert_eq!(buffer.resolution, [1920.0, 1080.0]);
        assert_eq!(buffer.extra, [1.0, 0.0]);
        assert_eq!(buffer.scalars_a, [3.5, 2.0, 0.0, 0.0]);
        assert_eq!(buffer.scalars_b, [0.0; 4]);
    }

    #[test]
    fn packs_shake_uniforms_into_extra_only() {
        let pass = pass_with(
            SHAKE_SHADER_ID,
            &[("u_offset", UniformValue::Vector(vec![4.0, -2.5]))],
        );

        let buffer = pack_effect_uniforms(&pass, 1280, 720).expect("shake uniforms pack");

        assert_eq!(buffer.resolution, [1280.0, 720.0]);
        assert_eq!(buffer.extra, [4.0, -2.5]);
        assert_eq!(buffer.scalars_a, [0.0; 4]);
        assert_eq!(buffer.scalars_b, [0.0; 4]);
    }

    #[test]
    fn packs_punch_zoom_uniforms_into_extra_x() {
        let pass = pass_with(
            PUNCH_ZOOM_SHADER_ID,
            &[("u_scale", UniformValue::Number(1.3))],
        );

        let buffer = pack_effect_uniforms(&pass, 100, 100).expect("punch zoom uniforms pack");

        assert_eq!(buffer.extra, [1.3, 0.0]);
    }

    #[test]
    fn packs_flash_uniforms_into_extra() {
        let pass = pass_with(
            FLASH_SHADER_ID,
            &[
                ("u_amount", UniformValue::Number(0.6)),
                ("u_whiteness", UniformValue::Number(1.0)),
            ],
        );

        let buffer = pack_effect_uniforms(&pass, 100, 100).expect("flash uniforms pack");

        assert_eq!(buffer.extra, [0.6, 1.0]);
    }

    #[test]
    fn packs_glitch_uniforms_into_extra_and_scalars_a() {
        let pass = pass_with(
            GLITCH_SHADER_ID,
            &[
                ("u_red_offset", UniformValue::Vector(vec![3.0, 0.0])),
                ("u_blue_offset", UniformValue::Vector(vec![-3.0, 1.0])),
            ],
        );

        let buffer = pack_effect_uniforms(&pass, 100, 100).expect("glitch uniforms pack");

        assert_eq!(buffer.extra, [3.0, 0.0]);
        assert_eq!(buffer.scalars_a, [-3.0, 1.0, 0.0, 0.0]);
    }

    #[test]
    fn packs_vignette_pulse_uniforms_into_extra_x() {
        let pass = pass_with(
            VIGNETTE_PULSE_SHADER_ID,
            &[("u_amount", UniformValue::Number(0.4))],
        );

        let buffer = pack_effect_uniforms(&pass, 100, 100).expect("vignette pulse uniforms pack");

        assert_eq!(buffer.extra, [0.4, 0.0]);
    }

    #[test]
    fn packs_film_grain_uniforms_into_extra() {
        let pass = pass_with(
            FILM_GRAIN_SHADER_ID,
            &[
                ("u_seed", UniformValue::Number(7.0)),
                ("u_amount", UniformValue::Number(0.2)),
            ],
        );

        let buffer = pack_effect_uniforms(&pass, 100, 100).expect("film grain uniforms pack");

        assert_eq!(buffer.extra, [7.0, 0.2]);
    }

    #[test]
    fn packs_light_leak_uniforms_into_extra_and_scalars_a() {
        let pass = pass_with(
            LIGHT_LEAK_SHADER_ID,
            &[
                ("u_center", UniformValue::Vector(vec![0.3, 0.7])),
                ("u_intensity", UniformValue::Number(0.9)),
            ],
        );

        let buffer = pack_effect_uniforms(&pass, 100, 100).expect("light leak uniforms pack");

        assert_eq!(buffer.extra, [0.3, 0.7]);
        assert_eq!(buffer.scalars_a, [0.9, 0.0, 0.0, 0.0]);
    }

    #[test]
    fn packs_rotate_wobble_uniforms_into_extra_x() {
        let pass = pass_with(
            ROTATE_WOBBLE_SHADER_ID,
            &[
                ("u_angle", UniformValue::Number(0.05)),
                ("u_cover_scale", UniformValue::Number(1.1)),
            ],
        );

        let buffer = pack_effect_uniforms(&pass, 100, 100).expect("rotate wobble uniforms pack");

        assert_eq!(buffer.extra, [0.05, 1.1]);
    }

    #[test]
    fn unknown_shader_id_is_rejected() {
        let pass = pass_with("totally-not-a-shader", &[]);

        let error = pack_effect_uniforms(&pass, 100, 100).unwrap_err();

        assert!(matches!(error, EffectsError::UnknownEffectShader { .. }));
    }

    #[test]
    fn missing_required_uniform_is_rejected() {
        let pass = pass_with(SHAKE_SHADER_ID, &[]);

        let error = pack_effect_uniforms(&pass, 100, 100).unwrap_err();

        assert!(matches!(error, EffectsError::MissingUniform { .. }));
    }

    #[test]
    fn uniform_name_from_a_different_shader_is_rejected() {
        // u_sigma is a real blur uniform, but shake doesn't take it — the
        // per-shader allowlist must reject it, not silently accept it.
        let pass = pass_with(
            SHAKE_SHADER_ID,
            &[
                ("u_offset", UniformValue::Vector(vec![1.0, 1.0])),
                ("u_sigma", UniformValue::Number(1.0)),
            ],
        );

        let error = pack_effect_uniforms(&pass, 100, 100).unwrap_err();

        assert!(matches!(error, EffectsError::UnsupportedUniform { .. }));
    }

    /// Neither `cargo test` nor `cargo check` ever asks wgpu to compile these
    /// shaders — that only happens at runtime, inside `EffectPipeline::new`,
    /// where a bad shader panics (wgpu's default uncaptured-error handler)
    /// and takes down the whole GPU compositor, not just the broken effect.
    /// This test closes most of that gap offline: it parses and validates
    /// every registered shader with naga (the same WGSL front end wgpu uses
    /// internally) and checks the `EffectUniforms` struct each one declares
    /// against the actual Rust `EffectUniformBuffer` layout byte for byte.
    /// Not all of it: on the WebGPU backend the browser compiles the WGSL
    /// itself (Chrome: Tint), which is stricter than naga about uniform
    /// control flow — see the next test.
    #[test]
    fn every_registered_shader_parses_and_matches_the_uniform_buffer_layout() {
        let expected_size = std::mem::size_of::<EffectUniformBuffer>() as u32;
        let expected_offsets: Vec<u32> = vec![0, 8, 16, 32];

        for shader in EFFECT_SHADERS {
            let module = naga::front::wgsl::parse_str(shader.source)
                .unwrap_or_else(|error| panic!("{} failed to parse: {error}", shader.label));

            naga::valid::Validator::new(
                naga::valid::ValidationFlags::all(),
                naga::valid::Capabilities::empty(),
            )
            .validate(&module)
            .unwrap_or_else(|error| panic!("{} failed validation: {error}", shader.label));

            let uniforms_type = module
                .types
                .iter()
                .map(|(_, ty)| ty)
                .find(|ty| ty.name.as_deref() == Some("EffectUniforms"))
                .unwrap_or_else(|| panic!("{}: no EffectUniforms struct declared", shader.label));

            let naga::TypeInner::Struct { members, span } = &uniforms_type.inner else {
                panic!("{}: EffectUniforms is not a struct", shader.label);
            };

            assert_eq!(
                *span, expected_size,
                "{}: EffectUniforms size does not match EffectUniformBuffer",
                shader.label,
            );
            let offsets: Vec<u32> = members.iter().map(|member| member.offset).collect();
            assert_eq!(
                offsets, expected_offsets,
                "{}: EffectUniforms member offsets do not match EffectUniformBuffer",
                shader.label,
            );
        }
    }

    /// The WGSL spec only allows implicit-derivative operations
    /// (`textureSample`, `dpdx`, ...) in uniform control flow, and Chrome's
    /// compiler (Tint, which builds these shaders on the WebGPU backend)
    /// enforces it — after a per-pixel `return`, in an `else`, after a `break`
    /// in a sampling loop, inside a `switch` case. naga 29.0.1 accepted the
    /// early-return case when checked by hand, so the naga test above is no
    /// guard against this; and every effect pipeline is built at
    /// startup, so one rejected shader breaks all effects. Effect textures
    /// have a single mip level, so `textureSampleLevel(..., 0.0)` is the same
    /// sample with no uniformity requirement at all; this forbids the rest.
    #[test]
    fn no_registered_shader_needs_implicit_derivatives() {
        fn without_comments(source: &str) -> String {
            let mut code = String::new();
            let mut rest = source;
            while let Some(start) = rest.find("/*") {
                code.push_str(&rest[..start]);
                rest = rest[start + 2..]
                    .split_once("*/")
                    .map_or("", |(_, after)| after);
            }
            code.push_str(rest);
            code.lines()
                .map(|line| line.split("//").next().unwrap_or(""))
                .collect::<Vec<_>>()
                .join("\n")
        }

        for shader in EFFECT_SHADERS {
            let code = without_comments(shader.source);
            for forbidden in [
                "textureSample(",
                "textureSampleBias(",
                "textureSampleCompare(",
                "dpdx",
                "dpdy",
                "fwidth",
            ] {
                assert!(
                    !code.contains(forbidden),
                    "{}: uses `{forbidden}`, which needs uniform control flow — use \
                     textureSampleLevel(..., 0.0) instead",
                    shader.label,
                );
            }
        }
    }
}
