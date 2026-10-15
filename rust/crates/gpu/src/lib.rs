mod context;
mod frame_pool;
mod gpu_errors;
mod upload_plan;

use thiserror::Error;

pub use context::GpuContext;
pub use frame_pool::{FramePool, MAX_IDLE_FRAMES, Release};
pub use gpu_errors::{GpuErrorLog, GpuErrorStats, errors_since};
pub use upload_plan::{
    ExternalCopy, ExternalCopyError, UploadPlan, plan_upload, validate_external_copy,
};
pub use wgpu;

pub const GPU_TEXTURE_FORMAT: wgpu::TextureFormat = wgpu::TextureFormat::Bgra8Unorm;
pub const FULLSCREEN_SHADER_SOURCE: &str = include_str!("shaders/fullscreen.wgsl");

#[derive(Debug, Error)]
pub enum GpuError {
    #[error("No WebGPU adapter is available")]
    AdapterUnavailable,
    #[error("Failed to request a WebGPU device: {0}")]
    RequestDevice(#[from] wgpu::RequestDeviceError),
    #[error("Failed to create a WebGPU surface: {0}")]
    CreateSurface(#[from] wgpu::CreateSurfaceError),
    #[error("The output surface does not support the required texture format")]
    UnsupportedSurfaceFormat,
}
