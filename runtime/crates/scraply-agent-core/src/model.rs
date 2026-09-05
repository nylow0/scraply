use serde::{Deserialize, Serialize};
use serde_json::Number;

/// A model plus the provider that bills and serves it.
///
/// The two parts are never collapsed into one string so callers cannot silently
/// substitute the same model name from another provider.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QualifiedModel {
    pub provider_id: String,
    pub model_id: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ReasoningEffort {
    Low,
    Medium,
    High,
    Xhigh,
    Max,
    Ultra,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenUsage {
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub total_tokens: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cached_input_tokens: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reasoning_tokens: Option<u64>,
}

impl TokenUsage {
    pub(crate) fn checked_add(self, other: Self) -> Option<Self> {
        Some(Self {
            input_tokens: self.input_tokens.checked_add(other.input_tokens)?,
            output_tokens: self.output_tokens.checked_add(other.output_tokens)?,
            total_tokens: self.total_tokens.checked_add(other.total_tokens)?,
            cached_input_tokens: add_optional(self.cached_input_tokens, other.cached_input_tokens)?,
            reasoning_tokens: add_optional(self.reasoning_tokens, other.reasoning_tokens)?,
        })
    }
}

fn add_optional(left: Option<u64>, right: Option<u64>) -> Option<Option<u64>> {
    match (left, right) {
        (None, None) => Some(None),
        (Some(value), None) | (None, Some(value)) => Some(Some(value)),
        (Some(left), Some(right)) => left.checked_add(right).map(Some),
    }
}

/// Exact cost value reported by a provider.
///
/// The runtime preserves the JSON number instead of converting it through a
/// float or fixed precision. A missing currency represents provider credits or
/// another provider-defined unit.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderCost {
    pub amount: Number,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub currency: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FinishReason {
    Stop,
    Length,
    ContentFilter,
    Other(String),
}
