use crate::{
    CompiledPrompt, CoreError, FinishReason, OperationControl, ProviderCost, QualifiedModel,
    ReasoningEffort, TokenUsage,
};
use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GenerationAttempt {
    Initial,
    SchemaRepair,
}

/// The complete provider input after the core has compiled and checked it.
///
/// Adapters translate this type into a vendor request. They do not own prompt
/// wording, repair policy, schema validation, or model substitution.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderRequest {
    pub model: QualifiedModel,
    pub prompt: CompiledPrompt,
    pub output_schema: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reasoning_effort: Option<ReasoningEffort>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_output_tokens: Option<u32>,
    pub attempt: GenerationAttempt,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProviderResponse {
    pub output: Vec<u8>,
    /// Provider-reported token accounting. `None` means the provider omitted it.
    pub usage: Option<TokenUsage>,
    pub cost: Option<ProviderCost>,
    pub finish_reason: FinishReason,
    pub request_id: Option<String>,
}

/// The only vendor seam used by the generation core.
#[async_trait]
pub trait GenerationProvider: Send + Sync {
    fn provider_id(&self) -> &str;

    async fn generate(
        &self,
        request: ProviderRequest,
        control: &OperationControl,
    ) -> Result<ProviderResponse, CoreError>;
}
