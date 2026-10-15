use bytemuck::{Pod, Zeroable};
use effects::{ApplyEffectsOptions, EffectPass, EffectPipeline, UniformValue};
use gpu::{FULLSCREEN_SHADER_SOURCE, GpuContext, wgpu};
use masks::{ApplyMaskFeatherOptions, MaskFeatherPipeline};
use thiserror::Error;
use wgpu::util::DeviceExt;

use crate::{
    BlendMode,
    frame::{
        EffectPassDescriptor, EffectUniformValueDescriptor, FrameDescriptor, FrameItemDescriptor,
        LayerDescriptor,
    },
    texture_pool::TexturePool,
    texture_store::TextureStore,
};

const LAYER_SHADER_SOURCE: &str = include_str!("shaders/layer.wgsl");
const BLEND_SHADER_SOURCE: &str = include_str!("shaders/blend.wgsl");
const MASK_SHADER_SOURCE: &str = include_str!("shaders/mask.wgsl");

pub struct RenderFrameOptions<'a, 'surface> {
    pub frame: &'a FrameDescriptor,
    pub surface: &'a wgpu::Surface<'surface>,
}

pub struct Compositor {
    textures: TextureStore,
    texture_pool: TexturePool,
    effects: EffectPipeline,
    masks: MaskFeatherPipeline,
    layer_uniform_bind_group_layout: wgpu::BindGroupLayout,
    layer_pipeline: wgpu::RenderPipeline,
    blend_uniform_bind_group_layout: wgpu::BindGroupLayout,
    blend_pipeline: wgpu::RenderPipeline,
    mask_uniform_bind_group_layout: wgpu::BindGroupLayout,
    mask_pipeline: wgpu::RenderPipeline,
}

#[derive(Debug, Error)]
pub enum CompositorError {
    #[error("Texture '{texture_id}' is not available")]
    MissingTexture { texture_id: String },
    #[error("Failed to apply effects: {0}")]
    Effects(#[from] effects::EffectsError),
    #[error("Failed to present frame: {0}")]
    Gpu(#[from] gpu::GpuError),
}

/// Mirrors `LayerUniforms` in `shaders/layer.wgsl`. WebGL requires uniform
/// buffer sizes to be multiples of 16 bytes; the three inverse-homography rows
/// are vec4s that start on a 16-byte boundary (offset 48), 96 bytes in all.
#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq, Pod, Zeroable)]
struct LayerUniformBuffer {
    resolution: [f32; 2],
    center: [f32; 2],
    size: [f32; 2],
    rotation_radians: f32,
    opacity: f32,
    flip_x: f32,
    flip_y: f32,
    /// 1.0 when the layer is placed by `inverse_homography` (a 3D layer).
    homography_enabled: f32,
    _padding: f32,
    /// Rows of the inverse homography (canvas pixels -> layer UV), w unused.
    inverse_homography: [[f32; 4]; 3],
}

/// The inverse of a layer homography (UV -> canvas pixels, row-major),
/// computed in f64 and scaled by a positive factor so that its largest entry
/// is 1 (the sign is kept: `q.z > 0` still means "in front of the camera").
/// `None` when the homography is singular or not finite.
fn layer_homography_inverse(homography: &[f32; 9]) -> Option<[f64; 9]> {
    let [a, b, c, d, e, f, g, h, i] = homography.map(f64::from);
    // Adjugate (transposed cofactors), row-major.
    let adjugate = [
        e * i - f * h,
        c * h - b * i,
        b * f - c * e,
        f * g - d * i,
        a * i - c * g,
        c * d - a * f,
        d * h - e * g,
        b * g - a * h,
        a * e - b * d,
    ];
    let determinant = a * adjugate[0] + b * adjugate[3] + c * adjugate[6];
    if !determinant.is_finite() || determinant == 0.0 {
        return None;
    }
    let inverse = adjugate.map(|value| value / determinant);
    let largest = inverse.iter().fold(0.0_f64, |m, value| m.max(value.abs()));
    if !largest.is_finite() || largest == 0.0 {
        return None;
    }
    Some(inverse.map(|value| value / largest))
}

fn layer_uniforms(layer: &LayerDescriptor, width: u32, height: u32) -> LayerUniformBuffer {
    let (homography_enabled, inverse_homography) = match &layer.transform.homography {
        None => (0.0, [[0.0; 4]; 3]),
        // A singular map keeps the flag with zero rows: q = 0, q.z <= 0, nothing is drawn.
        Some(homography) => match layer_homography_inverse(homography) {
            None => (1.0, [[0.0; 4]; 3]),
            Some(m) => (
                1.0,
                [
                    [m[0] as f32, m[1] as f32, m[2] as f32, 0.0],
                    [m[3] as f32, m[4] as f32, m[5] as f32, 0.0],
                    [m[6] as f32, m[7] as f32, m[8] as f32, 0.0],
                ],
            ),
        },
    };
    LayerUniformBuffer {
        resolution: [width as f32, height as f32],
        center: [layer.transform.center_x, layer.transform.center_y],
        size: [layer.transform.width, layer.transform.height],
        rotation_radians: layer.transform.rotation_degrees.to_radians(),
        opacity: layer.opacity,
        flip_x: if layer.transform.flip_x { 1.0 } else { 0.0 },
        flip_y: if layer.transform.flip_y { 1.0 } else { 0.0 },
        homography_enabled,
        _padding: 0.0,
        inverse_homography,
    }
}

#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
struct BlendUniformBuffer {
    blend_mode: u32,
    _padding: [u32; 3],
}

#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
struct MaskUniformBuffer {
    inverted: f32,
    _padding: [f32; 3],
}

impl Compositor {
    pub fn new(context: &GpuContext) -> Self {
        let device = context.device();
        let fullscreen_shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("compositor-fullscreen-shader"),
            source: wgpu::ShaderSource::Wgsl(FULLSCREEN_SHADER_SOURCE.into()),
        });
        let layer_shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("compositor-layer-shader"),
            source: wgpu::ShaderSource::Wgsl(LAYER_SHADER_SOURCE.into()),
        });
        let blend_shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("compositor-blend-shader"),
            source: wgpu::ShaderSource::Wgsl(BLEND_SHADER_SOURCE.into()),
        });
        let mask_shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("compositor-mask-shader"),
            source: wgpu::ShaderSource::Wgsl(MASK_SHADER_SOURCE.into()),
        });

        let layer_uniform_bind_group_layout =
            device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
                label: Some("compositor-layer-uniform-layout"),
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
        let blend_uniform_bind_group_layout =
            device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
                label: Some("compositor-blend-uniform-layout"),
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
        let mask_uniform_bind_group_layout =
            device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
                label: Some("compositor-mask-uniform-layout"),
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

        let layer_pipeline_layout =
            device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
                label: Some("compositor-layer-pipeline-layout"),
                bind_group_layouts: &[
                    Some(context.texture_sampler_bind_group_layout()),
                    Some(&layer_uniform_bind_group_layout),
                ],
                immediate_size: 0,
            });
        let blend_pipeline_layout =
            device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
                label: Some("compositor-blend-pipeline-layout"),
                bind_group_layouts: &[
                    Some(context.texture_sampler_bind_group_layout()),
                    Some(context.texture_sampler_bind_group_layout()),
                    Some(&blend_uniform_bind_group_layout),
                ],
                immediate_size: 0,
            });
        let mask_pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("compositor-mask-pipeline-layout"),
            bind_group_layouts: &[
                Some(context.texture_sampler_bind_group_layout()),
                Some(context.texture_sampler_bind_group_layout()),
                Some(&mask_uniform_bind_group_layout),
            ],
            immediate_size: 0,
        });

        let layer_pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("compositor-layer-pipeline"),
            layout: Some(&layer_pipeline_layout),
            vertex: wgpu::VertexState {
                module: &fullscreen_shader,
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
                module: &layer_shader,
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
        let blend_pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("compositor-blend-pipeline"),
            layout: Some(&blend_pipeline_layout),
            vertex: wgpu::VertexState {
                module: &fullscreen_shader,
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
                module: &blend_shader,
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
        let mask_pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("compositor-mask-pipeline"),
            layout: Some(&mask_pipeline_layout),
            vertex: wgpu::VertexState {
                module: &fullscreen_shader,
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
                module: &mask_shader,
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

        Self {
            textures: TextureStore::default(),
            texture_pool: TexturePool::default(),
            effects: EffectPipeline::new(context),
            masks: MaskFeatherPipeline::new(context),
            layer_uniform_bind_group_layout,
            layer_pipeline,
            blend_uniform_bind_group_layout,
            blend_pipeline,
            mask_uniform_bind_group_layout,
            mask_pipeline,
        }
    }

    pub fn upsert_texture(&mut self, id: String, texture: wgpu::Texture) {
        self.textures.upsert(id, texture);
    }

    pub fn release_texture(&mut self, id: &str) {
        self.textures.remove(id);
    }

    /// Size of the texture stored under `id` (the input of `plan_upload`).
    pub fn texture_extent(&self, id: &str) -> Option<(u32, u32)> {
        self.textures.extent(id)
    }

    /// A handle to the texture stored under `id`, to copy pixels into it.
    pub fn stored_texture(&self, id: &str) -> Option<wgpu::Texture> {
        self.textures.get(id).map(|stored| stored.texture().clone())
    }

    /// Pixels were copied into the texture of `id`: a new generation.
    pub fn mark_texture_updated(&mut self, id: &str) -> bool {
        self.textures.mark_updated(id)
    }

    /// The generation of the texture of `id` (changes at every write to it).
    pub fn texture_generation(&self, id: &str) -> Option<u64> {
        self.textures.get(id).map(|stored| stored.generation())
    }

    /// Composites all frame items into a texture and returns it.
    /// Used on backends that cannot surface-render to an arbitrary canvas (e.g. WebGL).
    pub fn render_frame_to_texture(
        &mut self,
        context: &GpuContext,
        frame: &FrameDescriptor,
    ) -> Result<wgpu::Texture, CompositorError> {
        self.texture_pool.recycle_frame();
        self.effects.recycle_frame();
        let mut encoder =
            context
                .device()
                .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                    label: Some("compositor-frame-encoder"),
                });
        let mut scene = self.create_cleared_texture(
            context,
            &mut encoder,
            frame.width,
            frame.height,
            frame.clear.color,
        );

        for item in &frame.items {
            match item {
                FrameItemDescriptor::Layer(layer) => {
                    let layer_texture = self.render_layer(context, &mut encoder, frame, layer)?;
                    scene = self.blend_texture(
                        context,
                        &mut encoder,
                        &scene,
                        &layer_texture,
                        layer.blend_mode,
                        frame.width,
                        frame.height,
                    )?;
                }
                FrameItemDescriptor::SceneEffect { effect_pass_groups } => {
                    scene = self.apply_effect_groups(
                        context,
                        &mut encoder,
                        &scene,
                        frame.width,
                        frame.height,
                        effect_pass_groups,
                    )?;
                }
            }
        }

        context.queue().submit([encoder.finish()]);
        Ok(scene)
    }

    pub fn render_frame(
        &mut self,
        context: &GpuContext,
        options: RenderFrameOptions<'_, '_>,
    ) -> Result<(), CompositorError> {
        let frame = options.frame;
        self.texture_pool.recycle_frame();
        self.effects.recycle_frame();
        let surface_texture = context.acquire_surface_texture(options.surface)?;
        let surface_view = surface_texture
            .texture
            .create_view(&wgpu::TextureViewDescriptor::default());
        let mut encoder =
            context
                .device()
                .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                    label: Some("compositor-frame-encoder"),
                });
        let mut scene = self.create_cleared_texture(
            context,
            &mut encoder,
            frame.width,
            frame.height,
            frame.clear.color,
        );

        for item in &frame.items {
            match item {
                FrameItemDescriptor::Layer(layer) => {
                    let layer_texture = self.render_layer(context, &mut encoder, frame, layer)?;
                    scene = self.blend_texture(
                        context,
                        &mut encoder,
                        &scene,
                        &layer_texture,
                        layer.blend_mode,
                        frame.width,
                        frame.height,
                    )?;
                }
                FrameItemDescriptor::SceneEffect { effect_pass_groups } => {
                    scene = self.apply_effect_groups(
                        context,
                        &mut encoder,
                        &scene,
                        frame.width,
                        frame.height,
                        effect_pass_groups,
                    )?;
                }
            }
        }

        context.encode_texture_blit_to_view(
            &mut encoder,
            &scene,
            &surface_view,
            "compositor-present-pass",
        );
        context.queue().submit([encoder.finish()]);
        surface_texture.present();
        Ok(())
    }

    fn render_layer(
        &mut self,
        context: &GpuContext,
        encoder: &mut wgpu::CommandEncoder,
        frame: &FrameDescriptor,
        layer: &LayerDescriptor,
    ) -> Result<wgpu::Texture, CompositorError> {
        let source = self.textures.get(&layer.texture_id).ok_or_else(|| {
            CompositorError::MissingTexture {
                texture_id: layer.texture_id.clone(),
            }
        })?;

        let mut current =
            self.texture_pool
                .acquire(context, frame.width, frame.height, "compositor-layer");
        self.render_source_to_texture(
            context,
            encoder,
            source.texture(),
            &current,
            frame.width,
            frame.height,
            layer,
        );

        if usable_effect_groups(&layer.effect_pass_groups)
            .next()
            .is_some()
        {
            current = self.apply_effect_groups(
                context,
                encoder,
                &current,
                frame.width,
                frame.height,
                &layer.effect_pass_groups,
            )?;
        }

        if let Some(mask) = &layer.mask {
            let mask_source = self.textures.get(&mask.texture_id).ok_or_else(|| {
                CompositorError::MissingTexture {
                    texture_id: mask.texture_id.clone(),
                }
            })?;
            let mask_source_texture = mask_source.texture().clone();
            let mask_texture = if mask.feather > 0.0 {
                self.masks.apply_mask_feather_with_encoder(
                    context,
                    encoder,
                    ApplyMaskFeatherOptions {
                        mask: &mask_source_texture,
                        width: frame.width,
                        height: frame.height,
                        feather: mask.feather,
                    },
                )
            } else {
                self.copy_texture(
                    context,
                    encoder,
                    &mask_source_texture,
                    frame.width,
                    frame.height,
                )
            };
            current = self.apply_mask(
                context,
                encoder,
                &current,
                &mask_texture,
                mask.inverted,
                frame.width,
                frame.height,
            );
        }

        Ok(current)
    }

    fn apply_effect_groups(
        &mut self,
        context: &GpuContext,
        encoder: &mut wgpu::CommandEncoder,
        source: &wgpu::Texture,
        width: u32,
        height: u32,
        effect_pass_groups: &[Vec<EffectPassDescriptor>],
    ) -> Result<wgpu::Texture, CompositorError> {
        let mut groups = usable_effect_groups(effect_pass_groups).peekable();
        if groups.peek().is_none() {
            return Ok(source.clone());
        }
        let mut current = self.copy_texture(context, encoder, source, width, height);
        for group in groups {
            let passes = map_effect_passes(group);
            current = self.effects.apply_with_encoder(
                context,
                encoder,
                ApplyEffectsOptions {
                    source: &current,
                    width,
                    height,
                    passes: &passes,
                },
            )?;
        }
        Ok(current)
    }

    fn create_cleared_texture(
        &mut self,
        context: &GpuContext,
        encoder: &mut wgpu::CommandEncoder,
        width: u32,
        height: u32,
        clear_color: [f32; 4],
    ) -> wgpu::Texture {
        let texture =
            self.texture_pool
                .acquire(context, width, height, "compositor-cleared-texture");
        let view = texture.create_view(&wgpu::TextureViewDescriptor::default());
        {
            let _pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("compositor-clear-pass"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: &view,
                    resolve_target: None,
                    depth_slice: None,
                    ops: wgpu::Operations {
                        load: wgpu::LoadOp::Clear(wgpu::Color {
                            r: clear_color[0] as f64,
                            g: clear_color[1] as f64,
                            b: clear_color[2] as f64,
                            a: clear_color[3] as f64,
                        }),
                        store: wgpu::StoreOp::Store,
                    },
                })],
                depth_stencil_attachment: None,
                occlusion_query_set: None,
                timestamp_writes: None,
                multiview_mask: None,
            });
        }
        texture
    }

    fn copy_texture(
        &mut self,
        context: &GpuContext,
        encoder: &mut wgpu::CommandEncoder,
        source: &wgpu::Texture,
        width: u32,
        height: u32,
    ) -> wgpu::Texture {
        let texture = self
            .texture_pool
            .acquire(context, width, height, "compositor-copy-texture");
        self.blit_texture(context, encoder, source, &texture);
        texture
    }

    fn render_source_to_texture(
        &self,
        context: &GpuContext,
        encoder: &mut wgpu::CommandEncoder,
        source: &wgpu::Texture,
        target: &wgpu::Texture,
        width: u32,
        height: u32,
        layer: &LayerDescriptor,
    ) {
        let source_view = source.create_view(&wgpu::TextureViewDescriptor::default());
        let target_view = target.create_view(&wgpu::TextureViewDescriptor::default());
        let source_bind_group = context
            .device()
            .create_bind_group(&wgpu::BindGroupDescriptor {
                label: Some("compositor-layer-source-bind-group"),
                layout: context.texture_sampler_bind_group_layout(),
                entries: &[
                    wgpu::BindGroupEntry {
                        binding: 0,
                        resource: wgpu::BindingResource::TextureView(&source_view),
                    },
                    wgpu::BindGroupEntry {
                        binding: 1,
                        resource: wgpu::BindingResource::Sampler(context.linear_sampler()),
                    },
                ],
            });
        let uniform_buffer =
            context
                .device()
                .create_buffer_init(&wgpu::util::BufferInitDescriptor {
                    label: Some("compositor-layer-uniform-buffer"),
                    contents: bytemuck::bytes_of(&layer_uniforms(layer, width, height)),
                    usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
                });
        let uniform_bind_group = context
            .device()
            .create_bind_group(&wgpu::BindGroupDescriptor {
                label: Some("compositor-layer-uniform-bind-group"),
                layout: &self.layer_uniform_bind_group_layout,
                entries: &[wgpu::BindGroupEntry {
                    binding: 0,
                    resource: uniform_buffer.as_entire_binding(),
                }],
            });

        {
            let mut render_pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("compositor-layer-pass"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: &target_view,
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
            render_pass.set_pipeline(&self.layer_pipeline);
            render_pass.set_vertex_buffer(0, context.fullscreen_quad().slice(..));
            render_pass.set_bind_group(0, &source_bind_group, &[]);
            render_pass.set_bind_group(1, &uniform_bind_group, &[]);
            render_pass.draw(0..6, 0..1);
        }
    }

    fn apply_mask(
        &mut self,
        context: &GpuContext,
        encoder: &mut wgpu::CommandEncoder,
        layer_texture: &wgpu::Texture,
        mask_texture: &wgpu::Texture,
        inverted: bool,
        width: u32,
        height: u32,
    ) -> wgpu::Texture {
        let target = self
            .texture_pool
            .acquire(context, width, height, "compositor-masked-texture");
        let layer_view = layer_texture.create_view(&wgpu::TextureViewDescriptor::default());
        let mask_view = mask_texture.create_view(&wgpu::TextureViewDescriptor::default());
        let target_view = target.create_view(&wgpu::TextureViewDescriptor::default());

        let layer_bind_group = context
            .device()
            .create_bind_group(&wgpu::BindGroupDescriptor {
                label: Some("compositor-mask-layer-bind-group"),
                layout: context.texture_sampler_bind_group_layout(),
                entries: &[
                    wgpu::BindGroupEntry {
                        binding: 0,
                        resource: wgpu::BindingResource::TextureView(&layer_view),
                    },
                    wgpu::BindGroupEntry {
                        binding: 1,
                        resource: wgpu::BindingResource::Sampler(context.linear_sampler()),
                    },
                ],
            });
        let mask_bind_group = context
            .device()
            .create_bind_group(&wgpu::BindGroupDescriptor {
                label: Some("compositor-mask-mask-bind-group"),
                layout: context.texture_sampler_bind_group_layout(),
                entries: &[
                    wgpu::BindGroupEntry {
                        binding: 0,
                        resource: wgpu::BindingResource::TextureView(&mask_view),
                    },
                    wgpu::BindGroupEntry {
                        binding: 1,
                        resource: wgpu::BindingResource::Sampler(context.linear_sampler()),
                    },
                ],
            });
        let uniform_buffer =
            context
                .device()
                .create_buffer_init(&wgpu::util::BufferInitDescriptor {
                    label: Some("compositor-mask-uniform-buffer"),
                    contents: bytemuck::bytes_of(&MaskUniformBuffer {
                        inverted: if inverted { 1.0 } else { 0.0 },
                        _padding: [0.0; 3],
                    }),
                    usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
                });
        let uniform_bind_group = context
            .device()
            .create_bind_group(&wgpu::BindGroupDescriptor {
                label: Some("compositor-mask-uniform-bind-group"),
                layout: &self.mask_uniform_bind_group_layout,
                entries: &[wgpu::BindGroupEntry {
                    binding: 0,
                    resource: uniform_buffer.as_entire_binding(),
                }],
            });

        {
            let mut render_pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("compositor-mask-pass"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: &target_view,
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
            render_pass.set_pipeline(&self.mask_pipeline);
            render_pass.set_vertex_buffer(0, context.fullscreen_quad().slice(..));
            render_pass.set_bind_group(0, &layer_bind_group, &[]);
            render_pass.set_bind_group(1, &mask_bind_group, &[]);
            render_pass.set_bind_group(2, &uniform_bind_group, &[]);
            render_pass.draw(0..6, 0..1);
        }
        target
    }

    fn blend_texture(
        &mut self,
        context: &GpuContext,
        encoder: &mut wgpu::CommandEncoder,
        base: &wgpu::Texture,
        layer: &wgpu::Texture,
        blend_mode: BlendMode,
        width: u32,
        height: u32,
    ) -> Result<wgpu::Texture, CompositorError> {
        let target =
            self.texture_pool
                .acquire(context, width, height, "compositor-blended-texture");
        let base_view = base.create_view(&wgpu::TextureViewDescriptor::default());
        let layer_view = layer.create_view(&wgpu::TextureViewDescriptor::default());
        let target_view = target.create_view(&wgpu::TextureViewDescriptor::default());
        let base_bind_group = context
            .device()
            .create_bind_group(&wgpu::BindGroupDescriptor {
                label: Some("compositor-base-bind-group"),
                layout: context.texture_sampler_bind_group_layout(),
                entries: &[
                    wgpu::BindGroupEntry {
                        binding: 0,
                        resource: wgpu::BindingResource::TextureView(&base_view),
                    },
                    wgpu::BindGroupEntry {
                        binding: 1,
                        resource: wgpu::BindingResource::Sampler(context.linear_sampler()),
                    },
                ],
            });
        let layer_bind_group = context
            .device()
            .create_bind_group(&wgpu::BindGroupDescriptor {
                label: Some("compositor-layer-bind-group"),
                layout: context.texture_sampler_bind_group_layout(),
                entries: &[
                    wgpu::BindGroupEntry {
                        binding: 0,
                        resource: wgpu::BindingResource::TextureView(&layer_view),
                    },
                    wgpu::BindGroupEntry {
                        binding: 1,
                        resource: wgpu::BindingResource::Sampler(context.linear_sampler()),
                    },
                ],
            });
        let uniform_buffer =
            context
                .device()
                .create_buffer_init(&wgpu::util::BufferInitDescriptor {
                    label: Some("compositor-blend-uniform-buffer"),
                    contents: bytemuck::bytes_of(&BlendUniformBuffer {
                        blend_mode: blend_mode.shader_code(),
                        _padding: [0; 3],
                    }),
                    usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
                });
        let uniform_bind_group = context
            .device()
            .create_bind_group(&wgpu::BindGroupDescriptor {
                label: Some("compositor-blend-uniform-bind-group"),
                layout: &self.blend_uniform_bind_group_layout,
                entries: &[wgpu::BindGroupEntry {
                    binding: 0,
                    resource: uniform_buffer.as_entire_binding(),
                }],
            });

        {
            let mut render_pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("compositor-blend-pass"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: &target_view,
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
            render_pass.set_pipeline(&self.blend_pipeline);
            render_pass.set_vertex_buffer(0, context.fullscreen_quad().slice(..));
            render_pass.set_bind_group(0, &base_bind_group, &[]);
            render_pass.set_bind_group(1, &layer_bind_group, &[]);
            render_pass.set_bind_group(2, &uniform_bind_group, &[]);
            render_pass.draw(0..6, 0..1);
        }
        Ok(target)
    }

    fn blit_texture(
        &self,
        context: &GpuContext,
        encoder: &mut wgpu::CommandEncoder,
        source: &wgpu::Texture,
        target: &wgpu::Texture,
    ) {
        let target_view = target.create_view(&wgpu::TextureViewDescriptor::default());
        context.encode_texture_blit_to_view(encoder, source, &target_view, "compositor-blit-pass");
    }
}

/// The effect pass groups that are applied: an empty group (an effect with
/// nothing to do, e.g. a blur of 0 px) is skipped as identity. Handed to the
/// effect pipeline it is `MissingEffectPasses`, which failed the whole frame.
fn usable_effect_groups(
    effect_pass_groups: &[Vec<EffectPassDescriptor>],
) -> impl Iterator<Item = &Vec<EffectPassDescriptor>> {
    effect_pass_groups.iter().filter(|group| !group.is_empty())
}

fn map_effect_passes(passes: &[EffectPassDescriptor]) -> Vec<EffectPass> {
    passes
        .iter()
        .map(|pass| EffectPass {
            shader: pass.shader.clone(),
            uniforms: pass
                .uniforms
                .iter()
                .map(|(name, value)| {
                    let uniform_value = match value {
                        EffectUniformValueDescriptor::Number(n) => UniformValue::Number(*n),
                        EffectUniformValueDescriptor::Vector(v) => UniformValue::Vector(v.clone()),
                    };
                    (name.clone(), uniform_value)
                })
                .collect(),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use super::{
        LayerUniformBuffer, layer_homography_inverse, layer_uniforms, usable_effect_groups,
    };
    use crate::{
        BlendMode,
        frame::{EffectPassDescriptor, LayerDescriptor, QuadTransformDescriptor},
    };

    /// A perspective map of the UV square: w = 0.4 u + 0.3 v + 1 > 0 on it.
    const PERSPECTIVE: [f32; 9] = [700.0, 150.0, 200.0, -80.0, 500.0, 150.0, 0.4, 0.3, 1.0];

    fn apply(m: &[f64; 9], p: [f64; 3]) -> [f64; 3] {
        [
            m[0] * p[0] + m[1] * p[1] + m[2] * p[2],
            m[3] * p[0] + m[4] * p[1] + m[5] * p[2],
            m[6] * p[0] + m[7] * p[1] + m[8] * p[2],
        ]
    }

    fn widen(m: &[f32; 9]) -> [f64; 9] {
        m.map(f64::from)
    }

    fn uv_samples() -> Vec<[f64; 2]> {
        let mut samples = Vec::new();
        for i in 0..=4 {
            for j in 0..=4 {
                samples.push([i as f64 / 4.0, j as f64 / 4.0]);
            }
        }
        samples.push([0.123, 0.987]);
        samples.push([0.5, 0.25]);
        samples
    }

    /// Canvas pixel of a UV point through `h`, and its w.
    fn forward(h: &[f32; 9], uv: [f64; 2]) -> ([f64; 2], f64) {
        let p = apply(&widen(h), [uv[0], uv[1], 1.0]);
        ([p[0] / p[2], p[1] / p[2]], p[2])
    }

    fn layer(homography: Option<[f32; 9]>) -> LayerDescriptor {
        LayerDescriptor {
            texture_id: "layer".to_string(),
            transform: QuadTransformDescriptor {
                center_x: 412.5,
                center_y: 233.25,
                width: 301.0,
                height: 177.5,
                rotation_degrees: 33.0,
                flip_x: true,
                flip_y: false,
                homography,
            },
            opacity: 0.75,
            blend_mode: BlendMode::Normal,
            effect_pass_groups: Vec::new(),
            mask: None,
        }
    }

    #[test]
    fn uniform_layout_keeps_16_byte_rows() {
        assert_eq!(std::mem::size_of::<LayerUniformBuffer>(), 96);
        assert_eq!(std::mem::size_of::<LayerUniformBuffer>() % 16, 0);
        assert_eq!(
            std::mem::offset_of!(LayerUniformBuffer, homography_enabled),
            40
        );
        assert_eq!(
            std::mem::offset_of!(LayerUniformBuffer, inverse_homography),
            48
        );
    }

    #[test]
    fn a_2d_layer_fills_the_first_40_bytes_exactly_as_before() {
        let uniforms = layer_uniforms(&layer(None), 1920, 1080);
        // The 2D fields of the old 48-byte buffer, in order.
        let old: [f32; 10] = [
            1920.0,
            1080.0,
            412.5,
            233.25,
            301.0,
            177.5,
            33.0_f32.to_radians(),
            0.75,
            1.0,
            0.0,
        ];
        let bytes = bytemuck::bytes_of(&uniforms);
        assert_eq!(&bytes[..40], bytemuck::bytes_of(&old));
        assert_eq!(uniforms.homography_enabled, 0.0);
        assert_eq!(uniforms.inverse_homography, [[0.0; 4]; 3]);
        assert!(bytes[40..].iter().all(|byte| *byte == 0));
    }

    #[test]
    fn a_homography_layer_carries_the_normalised_inverse() {
        let uniforms = layer_uniforms(&layer(Some(PERSPECTIVE)), 1920, 1080);
        let inverse = layer_homography_inverse(&PERSPECTIVE).expect("invertible");
        assert_eq!(uniforms.homography_enabled, 1.0);
        for row in 0..3 {
            for column in 0..3 {
                assert_eq!(
                    uniforms.inverse_homography[row][column],
                    inverse[row * 3 + column] as f32
                );
            }
            assert_eq!(uniforms.inverse_homography[row][3], 0.0);
        }
        assert_eq!(uniforms.opacity, 0.75);
    }

    #[test]
    fn a_singular_homography_layer_draws_nothing() {
        let uniforms = layer_uniforms(&layer(Some([0.0; 9])), 1920, 1080);
        assert_eq!(uniforms.homography_enabled, 1.0);
        // q = 0 for every pixel: q.z <= 0 is transparent in the shader.
        assert_eq!(uniforms.inverse_homography, [[0.0; 4]; 3]);
    }

    #[test]
    fn the_inverse_maps_canvas_pixels_back_to_uv() {
        let affine: [f32; 9] = [640.0, 0.0, 100.0, 0.0, 360.0, 50.0, 0.0, 0.0, 1.0];
        for h in [affine, PERSPECTIVE] {
            let inverse = layer_homography_inverse(&h).expect("invertible");
            for uv in uv_samples() {
                let (pixel, w) = forward(&h, uv);
                assert!(w > 0.0);
                let q = apply(&inverse, [pixel[0], pixel[1], 1.0]);
                assert!(q[2] > 0.0, "in front of the camera: q.z > 0");
                assert!((q[0] / q[2] - uv[0]).abs() < 1e-9, "u of {uv:?}");
                assert!((q[1] / q[2] - uv[1]).abs() < 1e-9, "v of {uv:?}");
            }
        }
    }

    #[test]
    fn the_inverse_is_normalised_to_a_largest_entry_of_one() {
        let inverse = layer_homography_inverse(&PERSPECTIVE).expect("invertible");
        let largest = inverse.iter().fold(0.0_f64, |m, v| m.max(v.abs()));
        assert_eq!(largest, 1.0);
    }

    #[test]
    fn a_positive_rescaling_of_h_gives_the_same_inverse() {
        let base = layer_homography_inverse(&PERSPECTIVE).expect("invertible");
        for factor in [1e-3_f32, 7.5, 1e4] {
            let scaled = PERSPECTIVE.map(|v| v * factor);
            let inverse = layer_homography_inverse(&scaled).expect("invertible");
            for (a, b) in base.iter().zip(inverse.iter()) {
                assert!((a - b).abs() < 1e-6, "factor {factor}: {a} vs {b}");
            }
        }
    }

    #[test]
    fn pixels_whose_layer_point_is_behind_the_camera_get_a_negative_q_z() {
        // w = u - 0.5: the half u < 0.5 of the layer is behind the camera.
        let h: [f32; 9] = [1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 1.0, 0.0, -0.5];
        let inverse = layer_homography_inverse(&h).expect("invertible");
        for (uv, in_front) in [
            ([0.25, 0.5], false),
            ([0.75, 0.5], true),
            ([0.1, 0.9], false),
        ] {
            let (pixel, w) = forward(&h, uv);
            assert_eq!(w > 0.0, in_front);
            let q = apply(&inverse, [pixel[0], pixel[1], 1.0]);
            assert_eq!(q[2] > 0.0, in_front, "uv {uv:?}");
            assert!((q[0] / q[2] - uv[0]).abs() < 1e-9);
        }
    }

    /// The WGSL uniform struct must match `LayerUniformBuffer` byte for byte,
    /// and the shader must still compile for the WebGL2 fallback (GLSL ES 3.00).
    #[cfg(not(target_arch = "wasm32"))]
    #[test]
    fn layer_shader_validates_matches_the_uniform_layout_and_compiles_for_webgl2() {
        use gpu::wgpu::naga;

        let module =
            naga::front::wgsl::parse_str(super::LAYER_SHADER_SOURCE).expect("layer.wgsl parses");
        let info = naga::valid::Validator::new(
            naga::valid::ValidationFlags::all(),
            naga::valid::Capabilities::default(),
        )
        .validate(&module)
        .expect("layer.wgsl validates");

        let (members, span) = module
            .types
            .iter()
            .find_map(|(_, ty)| match (&ty.name, &ty.inner) {
                (Some(name), naga::TypeInner::Struct { members, span })
                    if name == "LayerUniforms" =>
                {
                    Some((members.clone(), *span))
                }
                _ => None,
            })
            .expect("LayerUniforms struct");
        assert_eq!(span as usize, std::mem::size_of::<LayerUniformBuffer>());
        let offset = |name: &str| {
            members
                .iter()
                .find(|member| member.name.as_deref() == Some(name))
                .map(|member| member.offset as usize)
                .unwrap_or_else(|| panic!("member {name}"))
        };
        assert_eq!(
            offset("resolution"),
            std::mem::offset_of!(LayerUniformBuffer, resolution)
        );
        assert_eq!(
            offset("center"),
            std::mem::offset_of!(LayerUniformBuffer, center)
        );
        assert_eq!(
            offset("size"),
            std::mem::offset_of!(LayerUniformBuffer, size)
        );
        assert_eq!(
            offset("rotation_radians"),
            std::mem::offset_of!(LayerUniformBuffer, rotation_radians)
        );
        assert_eq!(
            offset("opacity"),
            std::mem::offset_of!(LayerUniformBuffer, opacity)
        );
        assert_eq!(
            offset("flip_x"),
            std::mem::offset_of!(LayerUniformBuffer, flip_x)
        );
        assert_eq!(
            offset("flip_y"),
            std::mem::offset_of!(LayerUniformBuffer, flip_y)
        );
        assert_eq!(
            offset("homography_enabled"),
            std::mem::offset_of!(LayerUniformBuffer, homography_enabled)
        );
        let rows = std::mem::offset_of!(LayerUniformBuffer, inverse_homography);
        assert_eq!(offset("inverse_homography_row0"), rows);
        assert_eq!(offset("inverse_homography_row1"), rows + 16);
        assert_eq!(offset("inverse_homography_row2"), rows + 32);

        let options = naga::back::glsl::Options {
            version: naga::back::glsl::Version::Embedded {
                version: 300,
                is_webgl: true,
            },
            ..naga::back::glsl::Options::default()
        };
        let pipeline_options = naga::back::glsl::PipelineOptions {
            shader_stage: naga::ShaderStage::Fragment,
            entry_point: "fragment_main".to_string(),
            multiview: None,
        };
        let mut glsl = String::new();
        naga::back::glsl::Writer::new(
            &mut glsl,
            &module,
            &info,
            &options,
            &pipeline_options,
            naga::proc::BoundsCheckPolicies::default(),
        )
        .expect("GLSL ES 3.00 writer")
        .write()
        .expect("GLSL ES 3.00 output");
        assert!(glsl.contains("inverse_homography_row2"));
    }

    fn blur_pass() -> EffectPassDescriptor {
        EffectPassDescriptor {
            shader: "gaussian-blur".to_string(),
            uniforms: HashMap::new(),
        }
    }

    /// An empty group used to reach `EffectPipeline::apply_with_encoder`, which
    /// returns `MissingEffectPasses`, and the whole frame failed with it.
    #[test]
    fn empty_effect_pass_groups_are_skipped_not_applied() {
        let groups = vec![
            vec![],
            vec![blur_pass(), blur_pass()],
            vec![],
            vec![blur_pass()],
        ];
        let applied: Vec<usize> = usable_effect_groups(&groups).map(Vec::len).collect();
        assert_eq!(applied, vec![2, 1]);

        let only_empty: Vec<Vec<EffectPassDescriptor>> = vec![vec![], vec![]];
        assert_eq!(usable_effect_groups(&only_empty).count(), 0);
        assert_eq!(usable_effect_groups(&[]).count(), 0);
    }

    #[test]
    fn singular_or_non_finite_homographies_have_no_inverse() {
        assert_eq!(layer_homography_inverse(&[0.0; 9]), None);
        // Rank 2: the third row is the sum of the first two (an edge-on layer).
        let rank_two: [f32; 9] = [1.0, 2.0, 3.0, 4.0, 5.0, 6.0, 5.0, 7.0, 9.0];
        assert_eq!(layer_homography_inverse(&rank_two), None);
        let mut not_finite = PERSPECTIVE;
        not_finite[4] = f32::NAN;
        assert_eq!(layer_homography_inverse(&not_finite), None);
        not_finite[4] = f32::INFINITY;
        assert_eq!(layer_homography_inverse(&not_finite), None);
    }
}
