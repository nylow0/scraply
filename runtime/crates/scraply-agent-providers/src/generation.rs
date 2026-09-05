use crate::{ProviderError, ProviderErrorCode};
use scraply_agent_core::{CoreError, FailureCode, FinishReason, OperationControl, ProviderRequest};
use std::future::Future;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum PromptRole {
    System,
    Developer,
    User,
}

pub(crate) struct PromptMessage<'a> {
    pub role: PromptRole,
    pub content: &'a str,
}

pub(crate) fn prompt_messages(request: &ProviderRequest) -> Vec<PromptMessage<'_>> {
    let mut messages = vec![
        PromptMessage {
            role: PromptRole::System,
            content: &request.prompt.system,
        },
        PromptMessage {
            role: PromptRole::Developer,
            content: &request.prompt.trusted_work_order_json,
        },
        PromptMessage {
            role: PromptRole::User,
            content: &request.prompt.untrusted_evidence_json,
        },
    ];
    if let Some(repair) = &request.prompt.repair {
        messages.push(PromptMessage {
            role: PromptRole::Developer,
            content: &repair.instruction,
        });
        messages.push(PromptMessage {
            role: PromptRole::User,
            content: &repair.untrusted_previous_candidate,
        });
    }
    messages
}

pub(crate) fn validate_model(
    request: &ProviderRequest,
    provider_id: &str,
) -> Result<(), ProviderError> {
    if request.model.provider_id != provider_id || request.model.model_id.is_empty() {
        return Err(ProviderError::new(
            provider_id,
            ProviderErrorCode::UnavailableModel,
            false,
            "generation model does not belong to this provider",
        ));
    }
    Ok(())
}

pub(crate) async fn controlled<F, T>(future: F, control: &OperationControl) -> Result<T, CoreError>
where
    F: Future<Output = T>,
{
    tokio::select! {
        _ = control.cancellation().cancelled() => Err(CoreError::new(
            FailureCode::Cancellation,
            "provider request was cancelled",
        )),
        _ = tokio::time::sleep(control.remaining()) => Err(CoreError::new(
            FailureCode::Timeout,
            "provider request timed out",
        )),
        result = future => Ok(result),
    }
}

pub(crate) fn finish_reason(value: Option<&str>) -> FinishReason {
    match value {
        Some("stop" | "completed") | None => FinishReason::Stop,
        Some("length" | "max_tokens") => FinishReason::Length,
        Some("content_filter") => FinishReason::ContentFilter,
        Some(other) => FinishReason::Other(other.to_owned()),
    }
}
