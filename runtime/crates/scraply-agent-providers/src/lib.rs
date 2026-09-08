#![forbid(unsafe_code)]

//! Direct provider adapters for Scraply's single-turn structured generation.
//!
//! Provider credentials and upstream authentication types stay inside this
//! crate. Callers exchange only Scraply-owned request, result, model, account,
//! and error types.

mod error;
mod generation;
mod model;
mod models_dev;
mod openai_subscription;
mod openrouter;
mod pkce;

pub use error::{ProviderError, ProviderErrorCode};
pub use model::{ModelMetadata, ModelProvider, ProviderAccount};
pub use models_dev::{ModelsDevOverlay, OverlayFreshness};
pub use openai_subscription::{
    BrowserLogin, DeviceLogin, OPENAI_SUBSCRIPTION_PROVIDER_ID, OpenAiSessionCredential,
    OpenAiSubscription,
};
pub use openrouter::{OPENROUTER_PROVIDER_ID, OpenRouter, OpenRouterSession};
pub use pkce::{OpenRouterPkce, PendingPkce};
pub use scraply_agent_core::{QualifiedModel, ReasoningEffort};
