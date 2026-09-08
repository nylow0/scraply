use std::time::Duration;

/// Maximum combined serialized bytes of the trusted work order and evidence.
pub const MAX_INPUT_BYTES: usize = 2 * 1024 * 1024;
/// Maximum supplied JSON Schema size.
pub const MAX_SCHEMA_BYTES: usize = 256 * 1024;
/// Maximum raw model response and atomically written output size.
pub const MAX_OUTPUT_BYTES: usize = 2 * 1024 * 1024;
/// Maximum UTF-8 bytes in either part of a qualified model identifier.
pub const MAX_MODEL_ID_BYTES: usize = 256;
/// Maximum UTF-8 bytes in an evidence source identifier.
pub const MAX_SOURCE_ID_BYTES: usize = 256;
/// Largest output-token ceiling accepted from Scraply.
pub const MAX_OUTPUT_TOKENS: u32 = 1_000_000;
/// Maximum characters exposed by a sanitized diagnostic summary.
pub const MAX_ERROR_SUMMARY_CHARS: usize = 256;
/// Maximum characters retained from a provider request identifier.
pub const MAX_PROVIDER_REQUEST_ID_CHARS: usize = 128;
/// Default one-shot generation timeout.
pub const DEFAULT_TIMEOUT: Duration = Duration::from_secs(120);
/// Largest timeout accepted by the core.
pub const MAX_TIMEOUT: Duration = Duration::from_secs(15 * 60);
