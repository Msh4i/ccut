use gpu::{FramePool, GpuContext, Release, wgpu};

type TextureKey = (u32, u32);

/// Frame-sized scratch textures of the compositor, reused from frame to frame
/// (`gpu::FramePool`). A size no frame asked for during a few frames (after a
/// canvas resize) is destroyed instead of being kept forever.
#[derive(Default)]
pub struct TexturePool {
    pool: FramePool<TextureKey, wgpu::Texture>,
}

impl TexturePool {
    pub fn recycle_frame(&mut self) {
        self.pool.recycle(|texture| texture.release());
    }

    pub fn acquire(
        &mut self,
        context: &GpuContext,
        width: u32,
        height: u32,
        label: &'static str,
    ) -> wgpu::Texture {
        self.pool.acquire((width, height), || {
            context.create_render_texture(width, height, label)
        })
    }
}
