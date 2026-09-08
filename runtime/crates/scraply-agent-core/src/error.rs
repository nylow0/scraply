use crate::{MAX_ERROR_SUMMARY_CHARS, MAX_PROVIDER_REQUEST_ID_CHARS};
use serde::Serialize;
use std::fmt;

/// Stable failure codes exposed across the core boundary.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum FailureCode {
    Authentication,
    RateLimit,
    Timeout,
    Cancellation,
    InvalidRequest,
    Schema,
    InvalidOutput,
    UnavailableModel,
    Transport,
    InputLimit,
    SchemaLimit,
    OutputLimit,
    Io,
    Unknown,
}

impl FailureCode {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Authentication => "authentication",
            Self::RateLimit => "rate_limit",
            Self::Timeout => "timeout",
            Self::Cancellation => "cancellation",
            Self::InvalidRequest => "invalid_request",
            Self::Schema => "schema",
            Self::InvalidOutput => "invalid_output",
            Self::UnavailableModel => "unavailable_model",
            Self::Transport => "transport",
            Self::InputLimit => "input_limit",
            Self::SchemaLimit => "schema_limit",
            Self::OutputLimit => "output_limit",
            Self::Io => "io",
            Self::Unknown => "unknown",
        }
    }

    pub const fn retryable(self) -> bool {
        matches!(self, Self::RateLimit | Self::Timeout | Self::Transport)
    }
}

/// Compatibility name for callers migrating from the prototype core.
pub type FailureKind = FailureCode;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Failure {
    pub code: FailureCode,
    pub retryable: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider_request_id: Option<String>,
    pub detail: String,
}

pub type FailureLogSummary = Failure;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CoreError {
    failure: Failure,
}

impl CoreError {
    /// Creates an error from a caller-provided safe summary.
    ///
    /// Control characters and excess length are removed, but callers must not
    /// pass prompts, schemas, credentials, model output, or raw response bodies.
    pub fn new(code: FailureCode, safe_detail: impl AsRef<str>) -> Self {
        Self {
            failure: Failure {
                code,
                retryable: code.retryable(),
                provider_request_id: None,
                detail: sanitize(safe_detail.as_ref(), MAX_ERROR_SUMMARY_CHARS),
            },
        }
    }

    pub fn provider(
        code: FailureCode,
        retryable: bool,
        provider_request_id: Option<&str>,
        safe_detail: impl AsRef<str>,
    ) -> Self {
        let mut error = Self::new(code, safe_detail);
        error.failure.retryable = retryable;
        error.failure.provider_request_id = provider_request_id.map(sanitize_provider_request_id);
        error
    }

    pub const fn code(&self) -> FailureCode {
        self.failure.code
    }

    pub const fn kind(&self) -> FailureCode {
        self.code()
    }

    pub const fn retryable(&self) -> bool {
        self.failure.retryable
    }

    pub fn provider_request_id(&self) -> Option<&str> {
        self.failure.provider_request_id.as_deref()
    }

    pub fn failure(&self) -> Failure {
        self.failure.clone()
    }

    pub fn log_summary(&self) -> FailureLogSummary {
        self.failure()
    }

    pub fn with_provider_request_id(mut self, request_id: Option<&str>) -> Self {
        self.failure.provider_request_id = request_id.map(sanitize_provider_request_id);
        self
    }

    pub fn from_http_status(status: u16, provider_request_id: Option<&str>) -> Self {
        let (code, retryable, detail) = match status {
            401 | 403 => (
                FailureCode::Authentication,
                false,
                "authentication rejected",
            ),
            429 => (
                FailureCode::RateLimit,
                true,
                "model service rate limited the request",
            ),
            408 | 504 => (FailureCode::Timeout, true, "model request timed out"),
            400..=499 => (
                FailureCode::Transport,
                false,
                "model service rejected the request",
            ),
            500..=599 => (FailureCode::Transport, true, "model service is unavailable"),
            _ => (
                FailureCode::Unknown,
                false,
                "unexpected model service response",
            ),
        };
        Self::provider(code, retryable, provider_request_id, detail)
    }

    pub(crate) fn io() -> Self {
        Self::new(FailureCode::Io, "filesystem operation failed")
    }
}

impl fmt::Display for CoreError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {}", self.failure.code.as_str(), self.failure.detail)
    }
}

impl std::error::Error for CoreError {}

pub(crate) fn sanitize_provider_request_id(raw: &str) -> String {
    sanitize(raw, MAX_PROVIDER_REQUEST_ID_CHARS)
}

fn sanitize(raw: &str, max_chars: usize) -> String {
    let mut result = String::with_capacity(raw.len().min(max_chars));
    for ch in raw.chars().take(max_chars) {
        if ch.is_control() {
            if !result.ends_with(' ') {
                result.push(' ');
            }
        } else {
            result.push(ch);
        }
    }
    result.trim().to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn failure_is_single_line_bounded_and_stable() {
        let raw = format!("safe\n{}", "x".repeat(MAX_ERROR_SUMMARY_CHARS * 2));
        let failure =
            CoreError::provider(FailureCode::Transport, true, Some("request\rsecret"), raw)
                .failure();
        assert_eq!(failure.code, FailureCode::Transport);
        assert!(failure.retryable);
        assert!(!failure.detail.contains('\n'));
        assert!(failure.detail.chars().count() <= MAX_ERROR_SUMMARY_CHARS);
        assert_eq!(
            failure.provider_request_id.as_deref(),
            Some("request secret")
        );
    }

    #[test]
    fn http_classification_never_accepts_a_response_body() {
        let error = CoreError::from_http_status(401, Some("req-1"));
        assert_eq!(error.code(), FailureCode::Authentication);
        assert!(!error.retryable());
        assert_eq!(error.provider_request_id(), Some("req-1"));
    }
}
