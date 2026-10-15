//! Pure decisions of the texture upload that reuses a layer's texture
//! (docs/ccut/playback-p5-design.md section 3). No GPU types here, so they run
//! under a native `cargo test`.

use thiserror::Error;

/// What an upload does with the texture already stored under its id.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UploadPlan {
    /// Copy into the stored texture (same size): no allocation, nothing released.
    Reuse,
    /// Make a new texture; the store releases the one it replaces.
    Create,
}

/// `existing` is the size of the texture stored under the id, if any. Only an
/// exactly equal size is reused: a copy into a larger texture would leave old
/// pixels around the new ones, a smaller one would not fit.
pub fn plan_upload(existing: Option<(u32, u32)>, width: u32, height: u32) -> UploadPlan {
    match existing {
        Some((stored_width, stored_height)) if stored_width == width && stored_height == height => {
            UploadPlan::Reuse
        }
        _ => UploadPlan::Create,
    }
}

/// An external image copy: `src_*` is the size the source reports now, `width`
/// by `height` the part that is copied (from the origin).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ExternalCopy {
    pub src_width: u32,
    pub src_height: u32,
    pub width: u32,
    pub height: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Error)]
pub enum ExternalCopyError {
    /// A zero size: an empty copy, or a closed ImageBitmap (it reports 0x0).
    #[error(
        "the external image copy has a zero size (source {src_width}x{src_height}, copy {width}x{height}); a closed ImageBitmap reports 0x0"
    )]
    ZeroSize {
        src_width: u32,
        src_height: u32,
        width: u32,
        height: u32,
    },
    /// The copy is larger than its source: wgpu's WebGPU backend would panic in
    /// an `unwrap` and the compositor would stay dead until the page reloads.
    #[error(
        "the external image copy ({width}x{height}) is larger than its source ({src_width}x{src_height})"
    )]
    LargerThanSource {
        src_width: u32,
        src_height: u32,
        width: u32,
        height: u32,
    },
}

/// Every external image copy goes through this before it reaches wgpu.
pub fn validate_external_copy(copy: ExternalCopy) -> Result<(), ExternalCopyError> {
    let ExternalCopy {
        src_width,
        src_height,
        width,
        height,
    } = copy;
    if src_width == 0 || src_height == 0 || width == 0 || height == 0 {
        return Err(ExternalCopyError::ZeroSize {
            src_width,
            src_height,
            width,
            height,
        });
    }
    if width > src_width || height > src_height {
        return Err(ExternalCopyError::LargerThanSource {
            src_width,
            src_height,
            width,
            height,
        });
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn copy(src_width: u32, src_height: u32, width: u32, height: u32) -> ExternalCopy {
        ExternalCopy {
            src_width,
            src_height,
            width,
            height,
        }
    }

    #[test]
    fn plan_table() {
        let cases = [
            (None, 4, 3, UploadPlan::Create),
            (Some((4, 3)), 4, 3, UploadPlan::Reuse),
            (Some((4, 3)), 5, 3, UploadPlan::Create),
            (Some((4, 3)), 4, 4, UploadPlan::Create),
            (Some((4, 3)), 3, 4, UploadPlan::Create),
            (Some((8, 8)), 4, 4, UploadPlan::Create),
            (Some((3, 4)), 4, 3, UploadPlan::Create),
        ];
        for (existing, width, height, expected) in cases {
            assert_eq!(
                plan_upload(existing, width, height),
                expected,
                "existing {existing:?} for {width}x{height}"
            );
        }
    }

    #[test]
    fn a_copy_of_the_whole_source_or_a_part_of_it_is_valid() {
        assert_eq!(validate_external_copy(copy(4, 3, 4, 3)), Ok(()));
        assert_eq!(validate_external_copy(copy(4, 3, 2, 3)), Ok(()));
        assert_eq!(validate_external_copy(copy(4, 3, 4, 1)), Ok(()));
    }

    #[test]
    fn a_copy_larger_than_its_source_is_an_error_by_one_pixel_on_either_axis() {
        for bad in [copy(4, 3, 5, 3), copy(4, 3, 4, 4), copy(4, 3, 5, 4)] {
            assert!(
                matches!(
                    validate_external_copy(bad),
                    Err(ExternalCopyError::LargerThanSource { .. })
                ),
                "{bad:?}"
            );
        }
    }

    #[test]
    fn zero_sizes_are_errors_and_a_closed_bitmap_reports_zero() {
        for bad in [
            copy(0, 0, 4, 3),
            copy(4, 0, 4, 3),
            copy(0, 3, 4, 3),
            copy(4, 3, 0, 3),
            copy(4, 3, 4, 0),
            copy(0, 0, 0, 0),
        ] {
            assert!(
                matches!(
                    validate_external_copy(bad),
                    Err(ExternalCopyError::ZeroSize { .. })
                ),
                "{bad:?}"
            );
        }
    }

    #[test]
    fn the_error_names_both_sizes() {
        let message = validate_external_copy(copy(4, 3, 5, 3))
            .unwrap_err()
            .to_string();
        assert!(
            message.contains("5x3") && message.contains("4x3"),
            "{message}"
        );
    }
}
