use crate::{QualifiedModel, ReasoningEffort};
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Trusted instructions and completion criteria owned by Scraply.
///
/// Research material does not belong here. It must travel through
/// [`EvidenceSource`] so the prompt compiler can keep the trust boundary intact.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkOrder {
    pub stage: String,
    pub instruction: String,
    pub goal: String,
    #[serde(default)]
    pub inputs: Value,
    #[serde(default)]
    pub required_decisions: Vec<String>,
    pub definition_of_done: Vec<String>,
    #[serde(default)]
    pub constraints: Vec<String>,
}

/// Untrusted research material with a stable ID assigned by Scraply.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EvidenceSource {
    pub source_id: String,
    pub content: Value,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RepairPolicy {
    #[default]
    Disabled,
    OneRetry,
}

/// One provider-neutral structured generation requested by Scraply.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GenerationRequest {
    pub model: QualifiedModel,
    /// Prompt release expected by the caller. Requests fail closed if the
    /// runtime does not own this exact revision.
    pub prompt_revision: String,
    pub work_order: WorkOrder,
    #[serde(default)]
    pub evidence: Vec<EvidenceSource>,
    pub output_schema: Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reasoning_effort: Option<ReasoningEffort>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_output_tokens: Option<u32>,
    #[serde(default)]
    pub repair_policy: RepairPolicy,
}
