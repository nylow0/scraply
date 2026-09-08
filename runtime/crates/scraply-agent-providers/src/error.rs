use scraply_agent_core::{CoreError, FailureCode};
use serde::{Deserialize, Serialize};
use std::fmt;

const MAX_DIAGNOSTIC_BYTES: usize = 128;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProviderErrorCode {
    Authentication,
    ReconnectRequired,
    InvalidRequest,
    UnavailableModel,
    RateLimited,
    Timeout,
    Cancelled,
    OutputLimit,
    InvalidResponse,
    Transport,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProviderError {
    pub code: ProviderErrorCode,
    pub provider_id: String,
    pub retryable: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub request_id: Option<String>,
    pub detail: String,
}

impl ProviderError {
    pub(crate) fn new(
        provider_id: &str,
        code: ProviderErrorCode,
        retryable: bool,
        detail: impl Into<String>,
    ) -> Self {
        Self {
            code,
            provider_id: provider_id.to_owned(),
            retryable,
            status: None,
            request_id: None,
            detail: detail.into(),
        }
    }

    pub(crate) fn http(
        provider_id: &str,
        status: reqwest::StatusCode,
        headers: &reqwest::header::HeaderMap,
    ) -> Self {
        let code = match status.as_u16() {
            401 | 403 => ProviderErrorCode::Authentication,
            404 => ProviderErrorCode::UnavailableModel,
            408 | 504 => ProviderErrorCode::Timeout,
            429 => ProviderErrorCode::RateLimited,
            400..=499 => ProviderErrorCode::InvalidRequest,
            _ => ProviderErrorCode::Transport,
        };
        let retryable = matches!(status.as_u16(), 408 | 429 | 500..=599);
        let request_id = ["x-request-id", "x-oai-request-id"]
            .into_iter()
            .find_map(|name| headers.get(name)?.to_str().ok())
            .and_then(safe_diagnostic);
        let mut error = Self::new(
            provider_id,
            code,
            retryable,
            format!("provider request failed with HTTP {}", status.as_u16()),
        );
        error.status = Some(status.as_u16());
        error.request_id = request_id;
        error
    }

    pub(crate) fn transport(provider_id: &str, error: &reqwest::Error) -> Self {
        let (code, retryable, detail) = if error.is_timeout() {
            (
                ProviderErrorCode::Timeout,
                true,
                "provider request timed out",
            )
        } else {
            (
                ProviderErrorCode::Transport,
                true,
                "provider request could not be completed",
            )
        };
        Self::new(provider_id, code, retryable, detail)
    }
}

impl fmt::Display for ProviderError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.detail)
    }
}

impl std::error::Error for ProviderError {}

impl From<ProviderError> for CoreError {
    fn from(error: ProviderError) -> Self {
        let code = match error.code {
            ProviderErrorCode::Authentication => FailureCode::Authentication,
            ProviderErrorCode::ReconnectRequired => FailureCode::Authentication,
            ProviderErrorCode::InvalidRequest => FailureCode::InvalidRequest,
            ProviderErrorCode::UnavailableModel => FailureCode::UnavailableModel,
            ProviderErrorCode::RateLimited => FailureCode::RateLimit,
            ProviderErrorCode::Timeout => FailureCode::Timeout,
            ProviderErrorCode::Cancelled => FailureCode::Cancellation,
            ProviderErrorCode::OutputLimit => FailureCode::OutputLimit,
            ProviderErrorCode::InvalidResponse => FailureCode::InvalidOutput,
            ProviderErrorCode::Transport => FailureCode::Transport,
        };
        CoreError::provider(
            code,
            error.retryable,
            error.request_id.as_deref(),
            error.detail,
        )
    }
}

fn safe_diagnostic(value: &str) -> Option<String> {
    if value.is_empty()
        || value.len() > MAX_DIAGNOSTIC_BYTES
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
    {
        return None;
    }
    Some(value.to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;
    use reqwest::header::{HeaderMap, HeaderValue};

    #[test]
    fn http_errors_keep_only_safe_diagnostics() {
        let mut headers = HeaderMap::new();
        headers.insert("x-request-id", HeaderValue::from_static("req_safe-123"));
        let error = ProviderError::http(
            "openrouter",
            reqwest::StatusCode::TOO_MANY_REQUESTS,
            &headers,
        );
        assert_eq!(error.request_id.as_deref(), Some("req_safe-123"));
        assert!(error.retryable);
        assert_eq!(error.status, Some(429));

        headers.insert("x-request-id", HeaderValue::from_static("unsafe value"));
        let error = ProviderError::http("openrouter", reqwest::StatusCode::BAD_REQUEST, &headers);
        assert!(error.request_id.is_none());
    }

    #[test]
    fn core_errors_keep_sanitized_provider_diagnostics() {
        let error = ProviderError {
            code: ProviderErrorCode::RateLimited,
            provider_id: "openrouter".to_owned(),
            retryable: true,
            status: Some(429),
            request_id: Some("req-1".to_owned()),
            detail: "provider request failed with HTTP 429".to_owned(),
        };
        let core = CoreError::from(error);
        assert_eq!(core.code(), FailureCode::RateLimit);
        assert!(core.retryable());
        assert_eq!(core.provider_request_id(), Some("req-1"));
    }
}
