#![cfg(target_arch = "wasm32")]

use compositor::{Compositor, FrameDescriptor, RenderFrameOptions};
use gpu::{ExternalCopy, UploadPlan, errors_since, plan_upload, validate_external_copy, wgpu};
use js_sys::Object;
use wasm_bindgen::{JsCast, JsValue, prelude::wasm_bindgen};

use crate::gpu::{
    import_canvas_texture, read_offscreen_canvas_property, read_property, read_serde_property,
    read_u32_property, with_gpu_runtime,
};
use crate::perf;
use crate::runtime_slot::{RuntimeSlot, SlotError};

struct CompositorRuntime {
    canvas: web_sys::HtmlCanvasElement,
    compositor: Compositor,
    surface: wgpu::Surface<'static>,
    surface_size: (u32, u32),
}

thread_local! {
    // Not a RefCell borrowed across the call: see runtime_slot.rs.
    static COMPOSITOR_RUNTIME: RuntimeSlot<CompositorRuntime> = const { RuntimeSlot::new() };
}

/// Runs `action` on the compositor runtime. No borrow is held while it runs:
/// after a call that trapped, later calls get an error instead of panicking
/// with "already borrowed" (and `window.__wasmPanic` keeps the first panic).
///
/// The GPU runtime (`with_gpu_runtime`) is still a shared `RefCell` borrow
/// around the call. A trap leaves that shared borrow counted, which is
/// harmless: every later use only borrows it shared, and the one mutable
/// borrow (`initializeGpu`) runs only while it is still empty.
fn with_compositor<T>(
    action: impl FnOnce(&mut CompositorRuntime) -> Result<T, JsValue>,
) -> Result<T, JsValue> {
    COMPOSITOR_RUNTIME
        .with(|slot| slot.with(action))
        .unwrap_or_else(|error| {
            Err(JsValue::from_str(match error {
                SlotError::Empty => "Compositor is not initialized. Call initCompositor() first.",
                SlotError::InUse => {
                    "The compositor stopped: an earlier call did not return (a wasm panic, see window.__wasmPanic). Reload the editor."
                }
            }))
        })
}

#[wasm_bindgen(js_name = initCompositor)]
pub fn init_compositor(width: u32, height: u32) -> Result<(), JsValue> {
    with_gpu_runtime(|gpu_runtime| {
        // On WebGL, wgpu is bound to a specific canvas; reuse it so the UI
        // can mount the output directly instead of copying pixels through
        // an intermediate 2D canvas every frame. On WebGPU, surface rendering
        // works against any canvas so we create a fresh one.
        let canvas = if let Some(gl_canvas) = gpu_runtime.context.gl_canvas() {
            gl_canvas.clone()
        } else {
            let document = web_sys::window()
                .and_then(|window| window.document())
                .ok_or_else(|| JsValue::from_str("Document is not available"))?;
            document
                .create_element("canvas")?
                .dyn_into::<web_sys::HtmlCanvasElement>()
                .map_err(|_| JsValue::from_str("Failed to create compositor canvas"))?
        };
        canvas.set_width(width);
        canvas.set_height(height);

        let compositor = Compositor::new(&gpu_runtime.context);
        let surface = gpu_runtime
            .context
            .instance()
            .create_surface(wgpu::SurfaceTarget::Canvas(canvas.clone()))
            .map_err(|error| JsValue::from_str(&error.to_string()))?;
        gpu_runtime
            .context
            .configure_surface(&surface, width, height)
            .map_err(|error| JsValue::from_str(&error.to_string()))?;

        COMPOSITOR_RUNTIME.with(|slot| {
            slot.set(CompositorRuntime {
                canvas,
                compositor,
                surface,
                surface_size: (width, height),
            });
        });

        Ok(())
    })
}

#[wasm_bindgen(js_name = resizeCompositor)]
pub fn resize_compositor(width: u32, height: u32) -> Result<(), JsValue> {
    with_gpu_runtime(|gpu_runtime| {
        with_compositor(|runtime| {
            runtime.canvas.set_width(width);
            runtime.canvas.set_height(height);
            if runtime.surface_size != (width, height) {
                gpu_runtime
                    .context
                    .configure_surface(&runtime.surface, width, height)
                    .map_err(|error| JsValue::from_str(&error.to_string()))?;
                runtime.surface_size = (width, height);
            }
            Ok(())
        })
    })
}

#[wasm_bindgen(js_name = getCompositorCanvas)]
pub fn get_compositor_canvas() -> Result<web_sys::HtmlCanvasElement, JsValue> {
    with_compositor(|runtime| Ok(runtime.canvas.clone()))
}

#[wasm_bindgen(js_name = uploadTexture)]
pub fn upload_texture(options: JsValue) -> Result<(), JsValue> {
    let UploadTextureOptions {
        id,
        source,
        width,
        height,
    } = parse_upload_texture_options(options)?;

    with_gpu_runtime(|gpu_runtime| {
        with_compositor(|runtime| {
            let texture = import_canvas_texture(
                &gpu_runtime.context,
                &source,
                width,
                height,
                "compositor-upload-texture",
            );
            runtime.compositor.upsert_texture(id, texture);
            Ok(())
        })
    })
}

/// `uploadTexture`'s sibling for the playing preview (lever b): the source is an
/// OffscreenCanvas or an ImageBitmap, and a layer whose texture already has the
/// size gets the pixels copied into it instead of a new texture. Returns true
/// when it reused the texture, false when it created one. `uploadTexture` stays
/// as it was: the flag off means exactly its GPU commands.
///
/// The copy is checked before it reaches wgpu (a copy larger than its source,
/// or a closed bitmap that reports 0x0, would panic inside wgpu and leave the
/// compositor dead): such a call returns an error and changes nothing.
#[wasm_bindgen(js_name = uploadTextureReuse)]
pub fn upload_texture_reuse(options: JsValue) -> Result<bool, JsValue> {
    let UploadTextureReuseOptions {
        id,
        source,
        width,
        height,
    } = parse_upload_texture_reuse_options(options)?;

    let (src_width, src_height) = source.size();
    validate_external_copy(ExternalCopy {
        src_width,
        src_height,
        width,
        height,
    })
    .map_err(|error| JsValue::from_str(&error.to_string()))?;

    with_gpu_runtime(|gpu_runtime| {
        with_compositor(|runtime| {
            let context = &gpu_runtime.context;
            let existing = runtime.compositor.texture_extent(&id);
            match (
                plan_upload(existing, width, height),
                runtime.compositor.stored_texture(&id),
            ) {
                (UploadPlan::Reuse, Some(texture)) => {
                    match &source {
                        UploadSource::Canvas(canvas) => context
                            .copy_offscreen_canvas_to_texture(canvas, &texture, width, height),
                        UploadSource::Bitmap(bitmap) => {
                            context.copy_image_bitmap_to_texture(bitmap, &texture, width, height)
                        }
                    }
                    runtime.compositor.mark_texture_updated(&id);
                    Ok(true)
                }
                _ => {
                    let texture = match &source {
                        UploadSource::Canvas(canvas) => import_canvas_texture(
                            context,
                            canvas,
                            width,
                            height,
                            "compositor-upload-texture",
                        ),
                        UploadSource::Bitmap(bitmap) => context.import_image_bitmap_texture(
                            bitmap,
                            width,
                            height,
                            "compositor-upload-texture",
                        ),
                    };
                    runtime.compositor.upsert_texture(id, texture);
                    Ok(false)
                }
            }
        })
    })
}

#[wasm_bindgen(js_name = releaseTexture)]
pub fn release_texture(id: String) -> Result<(), JsValue> {
    with_compositor(|runtime| {
        runtime.compositor.release_texture(&id);
        Ok(())
    })
}

#[wasm_bindgen(js_name = renderFrame)]
pub fn render_frame(options: JsValue) -> Result<(), JsValue> {
    perf::reset();

    let t_deserialize = perf::now_ms();
    let frame: FrameDescriptor = serde_wasm_bindgen::from_value(options)
        .map_err(|error| JsValue::from_str(&format!("Invalid frame descriptor: {error}")))?;
    perf::record("wasm.deserialize", perf::now_ms() - t_deserialize);

    with_gpu_runtime(|gpu_runtime| {
        // The WebGL2 backend reports GPU validation errors during the calls
        // (to the uncaptured-error handler, GpuContext); a frame that had one
        // is not what was asked for, so it fails with it and the preview can
        // draw the frame again without effects. WebGPU reports them later, as
        // a browser event: they are counted (getGpuErrorStats), not tied to a frame.
        let errors_before = gpu_runtime.context.gpu_error_stats();
        let rendered = with_compositor(|runtime| {
            // On the WebGL fallback this canvas is also the one wgpu presents the
            // effect thumbnails through, which resizes it
            // (GpuContext::render_texture_to_gl_canvas_surface): put the frame's
            // size back, else only a thumbnail-sized corner of the frame shows.
            let frame_size = (frame.width, frame.height);
            let canvas_size = (runtime.canvas.width(), runtime.canvas.height());
            if runtime.surface_size != frame_size || canvas_size != frame_size {
                runtime.canvas.set_width(frame.width);
                runtime.canvas.set_height(frame.height);
                let t_surface = perf::now_ms();
                gpu_runtime
                    .context
                    .configure_surface(&runtime.surface, frame.width, frame.height)
                    .map_err(|error| JsValue::from_str(&error.to_string()))?;
                perf::record("wasm.surfaceConfigure", perf::now_ms() - t_surface);
                runtime.surface_size = (frame.width, frame.height);
            }

            if gpu_runtime.context.supports_surface_rendering() {
                let t_render = perf::now_ms();
                let result = runtime
                    .compositor
                    .render_frame(
                        &gpu_runtime.context,
                        RenderFrameOptions {
                            frame: &frame,
                            surface: &runtime.surface,
                        },
                    )
                    .map_err(|error| JsValue::from_str(&error.to_string()));
                perf::record("wasm.renderFrameToSurface", perf::now_ms() - t_render);
                result
            } else {
                // WebGL still needs a separate composition pass, but the output
                // surface is now persistent just like the WebGPU path.
                let t_composite = perf::now_ms();
                let texture = runtime
                    .compositor
                    .render_frame_to_texture(&gpu_runtime.context, &frame)
                    .map_err(|error| JsValue::from_str(&error.to_string()))?;
                perf::record("wasm.compositeToTexture", perf::now_ms() - t_composite);

                let t_present = perf::now_ms();
                gpu_runtime
                    .context
                    .present_texture_to_surface(&texture, &runtime.surface)
                    .map_err(|error| JsValue::from_str(&error.to_string()))?;
                perf::record("wasm.presentToSurface", perf::now_ms() - t_present);

                Ok(())
            }
        });
        let errors_after = gpu_runtime.context.gpu_error_stats();
        match errors_since(&errors_before, &errors_after) {
            Some(message) if rendered.is_ok() => Err(JsValue::from_str(&message)),
            _ => rendered,
        }
    })
}

enum UploadSource {
    Canvas(wgpu::web_sys::OffscreenCanvas),
    Bitmap(wgpu::web_sys::ImageBitmap),
}

impl UploadSource {
    /// The size the source reports now (a closed ImageBitmap: 0x0).
    fn size(&self) -> (u32, u32) {
        match self {
            UploadSource::Canvas(canvas) => (canvas.width(), canvas.height()),
            UploadSource::Bitmap(bitmap) => (bitmap.width(), bitmap.height()),
        }
    }
}

struct UploadTextureReuseOptions {
    id: String,
    source: UploadSource,
    width: u32,
    height: u32,
}

fn parse_upload_texture_reuse_options(
    value: JsValue,
) -> Result<UploadTextureReuseOptions, JsValue> {
    let object: Object = value
        .dyn_into()
        .map_err(|_| JsValue::from_str("uploadTextureReuse expects an options object"))?;
    let source = read_property(&object, "source")?;
    let source = if source.is_instance_of::<wgpu::web_sys::ImageBitmap>() {
        UploadSource::Bitmap(source.unchecked_into())
    } else {
        UploadSource::Canvas(source.dyn_into().map_err(|_| {
            JsValue::from_str("Property 'source' must be an OffscreenCanvas or an ImageBitmap")
        })?)
    };

    Ok(UploadTextureReuseOptions {
        id: read_serde_property(&object, "id")?,
        source,
        width: read_u32_property(&object, "width")?,
        height: read_u32_property(&object, "height")?,
    })
}

#[derive(Debug)]
struct UploadTextureOptions {
    id: String,
    source: wgpu::web_sys::OffscreenCanvas,
    width: u32,
    height: u32,
}

fn parse_upload_texture_options(value: JsValue) -> Result<UploadTextureOptions, JsValue> {
    let object: Object = value
        .dyn_into()
        .map_err(|_| JsValue::from_str("uploadTexture expects an options object"))?;

    Ok(UploadTextureOptions {
        id: read_serde_property(&object, "id")?,
        source: read_offscreen_canvas_property(&object, "source")?,
        width: read_u32_property(&object, "width")?,
        height: read_u32_property(&object, "height")?,
    })
}
