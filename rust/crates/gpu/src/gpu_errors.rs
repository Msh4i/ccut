//! Uncaptured GPU errors (`wgpu::Device::on_uncaptured_error`), counted and
//! logged once per message.
//!
//! wgpu's core backend (the WebGL2 fallback on the web, and native) panics on
//! an uncaptured error unless a handler is installed (`default_error_handler`,
//! wgpu 29 `backend/wgpu_core.rs`). On wasm32 a panic is a trap, which leaves
//! the compositor unusable until the page reloads. With the handler a bad
//! frame stays a bad frame: the error is recorded here, logged once, and the
//! render that saw it returns an error (`errors_since`).

use std::collections::VecDeque;

/// Longest message kept (validation errors can quote whole descriptors).
pub const MAX_GPU_ERROR_MESSAGE_CHARS: usize = 500;
/// Distinct messages remembered for "log once"; the oldest is forgotten first.
pub const MAX_REMEMBERED_GPU_ERRORS: usize = 32;

/// What the uncaptured-error handler saw since the device was created.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct GpuErrorStats {
    pub count: u64,
    pub last_message: Option<String>,
}

#[derive(Debug, Default)]
pub struct GpuErrorLog {
    stats: GpuErrorStats,
    /// Messages already logged, oldest first.
    logged: VecDeque<String>,
}

impl GpuErrorLog {
    /// Records one error. Returns the (shortened) message when it has not been
    /// logged recently, i.e. when the caller should log it; None otherwise.
    pub fn record(&mut self, message: &str) -> Option<String> {
        let message = shorten(message);
        self.stats.count += 1;
        self.stats.last_message = Some(message.clone());
        if self.logged.contains(&message) {
            return None;
        }
        if self.logged.len() >= MAX_REMEMBERED_GPU_ERRORS {
            self.logged.pop_front();
        }
        self.logged.push_back(message.clone());
        Some(message)
    }

    pub fn stats(&self) -> GpuErrorStats {
        self.stats.clone()
    }

    pub fn count(&self) -> u64 {
        self.stats.count
    }

    pub fn remembered(&self) -> usize {
        self.logged.len()
    }
}

/// The error a call should return when GPU errors were recorded while it ran
/// (`before` taken at its start); None when there were none.
pub fn errors_since(before: &GpuErrorStats, after: &GpuErrorStats) -> Option<String> {
    let new_errors = after.count.saturating_sub(before.count);
    if new_errors == 0 {
        return None;
    }
    let message = after.last_message.as_deref().unwrap_or("unknown");
    Some(if new_errors == 1 {
        format!("GPU error: {message}")
    } else {
        format!("GPU error: {message} (and {} more)", new_errors - 1)
    })
}

fn shorten(message: &str) -> String {
    if message.chars().count() <= MAX_GPU_ERROR_MESSAGE_CHARS {
        return message.to_string();
    }
    let mut short: String = message
        .chars()
        .take(MAX_GPU_ERROR_MESSAGE_CHARS - 3)
        .collect();
    short.push_str("...");
    short
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_error_is_counted_and_the_last_message_kept() {
        let mut log = GpuErrorLog::default();
        assert_eq!(log.stats(), GpuErrorStats::default());
        log.record("Validation Error: texture usage");
        log.record("Validation Error: texture usage");
        log.record("Out of memory");
        assert_eq!(
            log.stats(),
            GpuErrorStats {
                count: 3,
                last_message: Some("Out of memory".to_string()),
            }
        );
    }

    #[test]
    fn a_message_is_logged_once_however_often_it_comes() {
        let mut log = GpuErrorLog::default();
        assert_eq!(log.record("a"), Some("a".to_string()));
        for _ in 0..100 {
            assert_eq!(log.record("a"), None);
        }
        assert_eq!(log.record("b"), Some("b".to_string()));
        assert_eq!(log.record("a"), None);
        assert_eq!(log.stats().count, 103);
    }

    #[test]
    fn it_remembers_a_bounded_number_of_messages_and_forgets_the_oldest() {
        let mut log = GpuErrorLog::default();
        for index in 0..MAX_REMEMBERED_GPU_ERRORS + 8 {
            assert!(log.record(&format!("error {index}")).is_some());
        }
        assert_eq!(log.remembered(), MAX_REMEMBERED_GPU_ERRORS);
        // the oldest were forgotten, so they are logged again; the newest are not
        assert!(log.record("error 0").is_some());
        assert!(
            log.record(&format!("error {}", MAX_REMEMBERED_GPU_ERRORS + 7))
                .is_none()
        );
    }

    #[test]
    fn a_long_message_is_cut() {
        let mut log = GpuErrorLog::default();
        let long = "é".repeat(MAX_GPU_ERROR_MESSAGE_CHARS * 3);
        let logged = log.record(&long).expect("new message");
        assert_eq!(logged.chars().count(), MAX_GPU_ERROR_MESSAGE_CHARS);
        assert!(logged.ends_with("..."));
        assert_eq!(log.stats().last_message, Some(logged.clone()));
        // the cut text is what is remembered: the same long message is not logged twice
        assert_eq!(log.record(&long), None);
    }

    #[test]
    fn errors_during_a_call_are_the_new_ones_since_its_start() {
        let before = GpuErrorStats {
            count: 2,
            last_message: Some("old".to_string()),
        };
        assert_eq!(errors_since(&before, &before), None);
        let after = GpuErrorStats {
            count: 3,
            last_message: Some("Validation Error: bad bind group".to_string()),
        };
        assert_eq!(
            errors_since(&before, &after),
            Some("GPU error: Validation Error: bad bind group".to_string())
        );
        let several = GpuErrorStats {
            count: 6,
            last_message: Some("x".to_string()),
        };
        assert_eq!(
            errors_since(&before, &several),
            Some("GPU error: x (and 3 more)".to_string())
        );
    }
}
