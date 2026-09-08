#![forbid(unsafe_code)]

//! Provider-neutral structured generation for Scraply.
//!
//! Scraply supplies one trusted work order, untrusted evidence with stable
//! source IDs, and the JSON Schema it owns. This crate compiles the prompt,
//! calls the explicitly selected provider, validates output locally, and
//! returns normalized accounting metadata. It contains no tools, credentials,
//! provider transports, repository behavior, or fallback model routing.

mod atomic_output;
mod cancellation;
mod constants;
mod error;
mod generation;
mod model;
mod prompt;
mod providers;
mod request;
mod schema;

pub use atomic_output::write_output_atomically;
pub use cancellation::{CancellationToken, OperationControl};
pub use constants::{
    DEFAULT_TIMEOUT, MAX_ERROR_SUMMARY_CHARS, MAX_INPUT_BYTES, MAX_MODEL_ID_BYTES,
    MAX_OUTPUT_BYTES, MAX_OUTPUT_TOKENS, MAX_PROVIDER_REQUEST_ID_CHARS, MAX_SCHEMA_BYTES,
    MAX_SOURCE_ID_BYTES, MAX_TIMEOUT,
};
pub(crate) use error::sanitize_provider_request_id;
pub use error::{CoreError, Failure, FailureCode, FailureKind, FailureLogSummary};
pub use generation::{
    AttemptCost, AttemptOutcome, AttemptUsage, GenerationAttemptMetadata, GenerationFailure,
    GenerationMetadata, GenerationResult, ProviderCompletion, Runtime,
};
pub use model::{FinishReason, ProviderCost, QualifiedModel, ReasoningEffort, TokenUsage};
pub use prompt::{
    CompiledPrompt, CompiledRepair, PROMPT_ID, PromptCompiler, PromptIdentity, REPAIR_INSTRUCTION,
    SYSTEM_PROMPT,
};
pub use providers::{GenerationAttempt, GenerationProvider, ProviderRequest, ProviderResponse};
pub use request::{EvidenceSource, GenerationRequest, RepairPolicy, WorkOrder};
pub use schema::{CompiledSchema, compile_schema, parse_and_compile_schema, validate_model_output};
