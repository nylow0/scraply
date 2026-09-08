use crate::{
    ModelMetadata, ModelProvider, ProviderError, ProviderErrorCode,
    generation::{PromptRole, controlled, finish_reason, prompt_messages, validate_model},
};
use async_trait::async_trait;
use reqwest::{Url, header};
use scraply_agent_core::{
    CoreError, GenerationProvider, OperationControl, ProviderCost, ProviderRequest,
    ProviderResponse, QualifiedModel, TokenUsage,
};
use serde::Deserialize;
use serde_json::{Number, Value, json};
use std::{collections::BTreeMap, sync::Arc};

pub const OPENROUTER_PROVIDER_ID: &str = "openrouter";
const BASE_URL: &str = "https://openrouter.ai/api/v1/";
const MAX_KEY_BYTES: usize = 4 * 1024;

#[derive(Clone)]
pub struct OpenRouterSession {
    key: Arc<str>,
}

impl OpenRouterSession {
    pub fn manual(key: impl Into<String>) -> Result<Self, ProviderError> {
        let key = key.into();
        if key.is_empty() || key.len() > MAX_KEY_BYTES || key.chars().any(char::is_whitespace) {
            return Err(ProviderError::new(
                OPENROUTER_PROVIDER_ID,
                ProviderErrorCode::Authentication,
                false,
                "OpenRouter API key is invalid",
            ));
        }
        Ok(Self { key: key.into() })
    }

    /// Consumes this handle and returns the credential for one host-owned,
    /// encrypted persistence handoff after PKCE exchange.
    pub fn into_host_credential(self) -> String {
        self.key.to_string()
    }

    fn bearer(&self) -> Result<header::HeaderValue, ProviderError> {
        let mut value =
            header::HeaderValue::from_str(&format!("Bearer {}", self.key)).map_err(|_| {
                ProviderError::new(
                    OPENROUTER_PROVIDER_ID,
                    ProviderErrorCode::Authentication,
                    false,
                    "OpenRouter API key is invalid",
                )
            })?;
        value.set_sensitive(true);
        Ok(value)
    }
}

impl std::fmt::Debug for OpenRouterSession {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("OpenRouterSession")
            .field("key", &"[REDACTED]")
            .finish()
    }
}

#[derive(Clone)]
pub struct OpenRouter {
    session: OpenRouterSession,
    client: reqwest::Client,
    base_url: Url,
}

impl std::fmt::Debug for OpenRouter {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("OpenRouter")
            .field("base_url", &self.base_url)
            .finish_non_exhaustive()
    }
}

impl OpenRouter {
    pub fn new(session: OpenRouterSession) -> Self {
        Self {
            session,
            client: reqwest::Client::new(),
            base_url: Url::parse(BASE_URL).expect("OpenRouter base URL must be valid"),
        }
    }

    #[cfg(test)]
    fn with_base_url(session: OpenRouterSession, base_url: Url) -> Self {
        Self {
            session,
            client: reqwest::Client::builder()
                .no_proxy()
                .build()
                .expect("test client should build"),
            base_url,
        }
    }

    fn endpoint(&self, path: &str) -> Result<Url, ProviderError> {
        self.base_url.join(path).map_err(|_| {
            ProviderError::new(
                OPENROUTER_PROVIDER_ID,
                ProviderErrorCode::Transport,
                false,
                "OpenRouter endpoint is invalid",
            )
        })
    }

    fn authenticated(
        &self,
        request: reqwest::RequestBuilder,
    ) -> Result<reqwest::RequestBuilder, ProviderError> {
        Ok(request.header(header::AUTHORIZATION, self.session.bearer()?))
    }

    async fn generate_request(
        &self,
        request: &ProviderRequest,
    ) -> Result<ProviderResponse, ProviderError> {
        validate_model(request, OPENROUTER_PROVIDER_ID)?;
        let body = generation_body(request);
        let http_request = self.authenticated(
            self.client
                .post(self.endpoint("chat/completions")?)
                .json(&body),
        )?;
        let response = http_request
            .send()
            .await
            .map_err(|error| ProviderError::transport(OPENROUTER_PROVIDER_ID, &error))?;
        if !response.status().is_success() {
            return Err(ProviderError::http(
                OPENROUTER_PROVIDER_ID,
                response.status(),
                response.headers(),
            ));
        }
        let response = response.json::<ChatResponse>().await.map_err(|_| {
            ProviderError::new(
                OPENROUTER_PROVIDER_ID,
                ProviderErrorCode::InvalidResponse,
                false,
                "OpenRouter returned an invalid generation response",
            )
        })?;
        response.into_response(&request.model)
    }
}

#[async_trait]
impl ModelProvider for OpenRouter {
    async fn list_models(&self) -> Result<Vec<ModelMetadata>, ProviderError> {
        let endpoint = self.endpoint("models")?;
        let request = self.authenticated(self.client.get(endpoint).query(&[
            ("output_modalities", "text"),
            ("supported_parameters", "structured_outputs"),
        ]))?;
        let response = request
            .send()
            .await
            .map_err(|error| ProviderError::transport(OPENROUTER_PROVIDER_ID, &error))?;
        if !response.status().is_success() {
            return Err(ProviderError::http(
                OPENROUTER_PROVIDER_ID,
                response.status(),
                response.headers(),
            ));
        }
        let catalog = response.json::<ModelsResponse>().await.map_err(|_| {
            ProviderError::new(
                OPENROUTER_PROVIDER_ID,
                ProviderErrorCode::InvalidResponse,
                false,
                "OpenRouter returned an invalid model catalog",
            )
        })?;
        let models: Vec<_> = catalog
            .data
            .into_iter()
            .filter(RemoteModel::supports_required_output)
            .map(RemoteModel::into_metadata)
            .collect();
        if models.is_empty() {
            return Err(ProviderError::new(
                OPENROUTER_PROVIDER_ID,
                ProviderErrorCode::InvalidResponse,
                false,
                "OpenRouter returned no structured-output text models",
            ));
        }
        Ok(models)
    }
}

#[async_trait]
impl GenerationProvider for OpenRouter {
    fn provider_id(&self) -> &str {
        OPENROUTER_PROVIDER_ID
    }

    async fn generate(
        &self,
        request: ProviderRequest,
        control: &OperationControl,
    ) -> Result<ProviderResponse, CoreError> {
        control.check()?;
        Ok(controlled(self.generate_request(&request), control).await??)
    }
}

fn generation_body(request: &ProviderRequest) -> Value {
    let messages: Vec<_> = prompt_messages(request)
        .into_iter()
        .map(|message| {
            let role = match message.role {
                PromptRole::System => "system",
                PromptRole::Developer => "developer",
                PromptRole::User => "user",
            };
            json!({ "role": role, "content": message.content })
        })
        .collect();
    let mut body = json!({
        "model": request.model.model_id,
        "messages": messages,
        "stream": false,
        "response_format": {
            "type": "json_schema",
            "json_schema": {
                "name": "scraply_result",
                "strict": true,
                "schema": request.output_schema
            }
        },
        "provider": {
            "require_parameters": true
        }
    });
    if let Some(max_tokens) = request.max_output_tokens {
        body["max_tokens"] = json!(max_tokens);
    }
    if let Some(effort) = request.reasoning_effort {
        body["reasoning"] = json!({ "effort": effort });
    }
    body
}

#[derive(Deserialize)]
struct ModelsResponse {
    #[serde(default)]
    data: Vec<RemoteModel>,
}

#[derive(Deserialize)]
struct RemoteModel {
    id: String,
    #[serde(default)]
    name: String,
    #[serde(default)]
    description: String,
    context_length: Option<u64>,
    #[serde(default)]
    supported_parameters: Vec<String>,
    #[serde(default)]
    architecture: RemoteArchitecture,
    #[serde(default)]
    pricing: BTreeMap<String, String>,
}

impl RemoteModel {
    fn supports_required_output(&self) -> bool {
        self.architecture
            .output_modalities
            .iter()
            .any(|modality| modality == "text")
            && self
                .supported_parameters
                .iter()
                .any(|parameter| parameter == "structured_outputs")
    }

    fn into_metadata(self) -> ModelMetadata {
        ModelMetadata {
            identity: QualifiedModel {
                provider_id: OPENROUTER_PROVIDER_ID.to_owned(),
                model_id: self.id.clone(),
            },
            display_name: if self.name.is_empty() {
                self.id
            } else {
                self.name
            },
            description: self.description,
            context_length: self.context_length,
            supports_structured_output: true,
            supported_reasoning_efforts: Vec::new(),
            reasoning_effort_descriptions: BTreeMap::new(),
            default_reasoning_effort: None,
            pricing: self.pricing,
        }
    }
}

#[derive(Default, Deserialize)]
struct RemoteArchitecture {
    #[serde(default)]
    output_modalities: Vec<String>,
}

#[derive(Deserialize)]
struct ChatResponse {
    id: String,
    model: String,
    #[serde(default)]
    choices: Vec<ChatChoice>,
    usage: Option<RemoteUsage>,
}

impl ChatResponse {
    fn into_response(self, requested: &QualifiedModel) -> Result<ProviderResponse, ProviderError> {
        if self.model != requested.model_id {
            return Err(ProviderError::new(
                OPENROUTER_PROVIDER_ID,
                ProviderErrorCode::InvalidResponse,
                false,
                "OpenRouter returned a different model than requested",
            ));
        }
        let choice = self.choices.into_iter().next().ok_or_else(|| {
            ProviderError::new(
                OPENROUTER_PROVIDER_ID,
                ProviderErrorCode::InvalidResponse,
                false,
                "OpenRouter response contained no completion",
            )
        })?;
        let output = serde_json::from_str::<Value>(&choice.message.content).map_err(|_| {
            ProviderError::new(
                OPENROUTER_PROVIDER_ID,
                ProviderErrorCode::InvalidResponse,
                false,
                "OpenRouter returned invalid structured output",
            )
        })?;
        let output = serde_json::to_vec(&output).map_err(|_| {
            ProviderError::new(
                OPENROUTER_PROVIDER_ID,
                ProviderErrorCode::InvalidResponse,
                false,
                "OpenRouter returned invalid structured output",
            )
        })?;
        let (usage, cost) = self
            .usage
            .map(RemoteUsage::into_accounting)
            .unwrap_or((None, None));
        Ok(ProviderResponse {
            output,
            usage,
            cost,
            finish_reason: finish_reason(choice.finish_reason.as_deref()),
            request_id: Some(self.id),
        })
    }
}

#[derive(Deserialize)]
struct ChatChoice {
    message: ChatMessage,
    finish_reason: Option<String>,
}

#[derive(Deserialize)]
struct ChatMessage {
    content: String,
}

#[derive(Deserialize)]
struct RemoteUsage {
    prompt_tokens: Option<u64>,
    completion_tokens: Option<u64>,
    total_tokens: Option<u64>,
    cost: Option<Number>,
    #[serde(default)]
    prompt_tokens_details: PromptTokenDetails,
    #[serde(default)]
    completion_tokens_details: CompletionTokenDetails,
}

impl RemoteUsage {
    fn into_accounting(self) -> (Option<TokenUsage>, Option<ProviderCost>) {
        let usage = match (
            self.prompt_tokens,
            self.completion_tokens,
            self.total_tokens,
        ) {
            (Some(input_tokens), Some(output_tokens), Some(total_tokens)) => Some(TokenUsage {
                input_tokens,
                output_tokens,
                total_tokens,
                cached_input_tokens: self.prompt_tokens_details.cached_tokens,
                reasoning_tokens: self.completion_tokens_details.reasoning_tokens,
            }),
            _ => None,
        };
        let cost = self.cost.map(|amount| ProviderCost {
            amount,
            currency: Some("USD".to_owned()),
        });
        (usage, cost)
    }
}

#[derive(Default, Deserialize)]
struct PromptTokenDetails {
    cached_tokens: Option<u64>,
}

#[derive(Default, Deserialize)]
struct CompletionTokenDetails {
    reasoning_tokens: Option<u64>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use scraply_agent_core::{
        CompiledPrompt, GenerationAttempt, PromptIdentity, ProviderRequest, QualifiedModel,
    };
    use std::{
        io::{Read, Write},
        net::TcpListener,
        sync::mpsc,
        thread,
        time::Duration,
    };

    fn generation_request(model_id: &str) -> ProviderRequest {
        ProviderRequest {
            model: QualifiedModel {
                provider_id: OPENROUTER_PROVIDER_ID.to_owned(),
                model_id: model_id.to_owned(),
            },
            prompt: CompiledPrompt {
                identity: PromptIdentity {
                    id: "test".to_owned(),
                    sha256: "test".to_owned(),
                },
                system: "system".to_owned(),
                trusted_work_order_json: "work order".to_owned(),
                untrusted_evidence_json: "answer".to_owned(),
                repair: None,
            },
            output_schema: json!({"type":"object"}),
            reasoning_effort: None,
            max_output_tokens: None,
            attempt: GenerationAttempt::Initial,
        }
    }

    #[test]
    fn session_debug_cannot_expose_key() {
        let key = "sk-or-secret-value";
        let session = OpenRouterSession::manual(key).unwrap();
        assert!(!format!("{session:?}").contains(key));
    }

    #[test]
    fn generation_request_is_single_turn_strict_and_parameter_required() {
        let mut request = generation_request("openai/gpt-test");
        request.max_output_tokens = Some(500);
        let body = generation_body(&request);
        assert_eq!(body["stream"], false);
        assert_eq!(body["response_format"]["type"], "json_schema");
        assert_eq!(body["response_format"]["json_schema"]["strict"], true);
        assert_eq!(body["provider"]["require_parameters"], true);
        assert!(body.get("tools").is_none());
        assert!(body.get("plugins").is_none());
    }

    #[test]
    fn catalog_filters_response_even_when_server_filter_is_ignored() {
        let response: ModelsResponse = serde_json::from_value(json!({
            "data": [
                {
                    "id": "good/model",
                    "architecture": {"output_modalities": ["text"]},
                    "supported_parameters": ["structured_outputs"]
                },
                {
                    "id": "image/model",
                    "architecture": {"output_modalities": ["image"]},
                    "supported_parameters": ["structured_outputs"]
                },
                {
                    "id": "loose/model",
                    "architecture": {"output_modalities": ["text"]},
                    "supported_parameters": []
                }
            ]
        }))
        .unwrap();
        let models: Vec<_> = response
            .data
            .into_iter()
            .filter(RemoteModel::supports_required_output)
            .collect();
        assert_eq!(models.len(), 1);
        assert_eq!(models[0].id, "good/model");
    }

    #[test]
    fn generation_rejects_silent_model_substitution() {
        let response: ChatResponse = serde_json::from_value(json!({
            "id": "gen-1",
            "model": "other/model",
            "choices": [{"message":{"content":"{}"},"finish_reason":"stop"}],
            "usage": {}
        }))
        .unwrap();
        let error = response
            .into_response(&QualifiedModel {
                provider_id: OPENROUTER_PROVIDER_ID.to_owned(),
                model_id: "wanted/model".to_owned(),
            })
            .unwrap_err();
        assert_eq!(error.code, ProviderErrorCode::InvalidResponse);
    }

    #[test]
    fn missing_or_partial_provider_usage_remains_unknown() {
        for usage in [None, Some(json!({"prompt_tokens": 12}))] {
            let mut value = json!({
                "id": "gen-1",
                "model": "openai/gpt-test",
                "choices": [{
                    "message": {"content": "{\"answer\":\"yes\"}"},
                    "finish_reason": "stop"
                }]
            });
            if let Some(usage) = usage {
                value["usage"] = usage;
            }
            let response: ChatResponse = serde_json::from_value(value).unwrap();
            let result = response
                .into_response(&QualifiedModel {
                    provider_id: OPENROUTER_PROVIDER_ID.to_owned(),
                    model_id: "openai/gpt-test".to_owned(),
                })
                .unwrap();
            assert_eq!(result.usage, None);
        }
    }

    #[tokio::test]
    async fn live_catalog_request_authenticates_and_filters_at_the_endpoint() {
        let response = json!({
            "data": [{
                "id": "openai/gpt-test",
                "name": "GPT Test",
                "architecture": {"output_modalities": ["text"]},
                "supported_parameters": ["structured_outputs"]
            }]
        });
        let (base_url, captured, server) = fake_server(response.to_string());
        let key = "sk-or-test-secret";
        let provider = OpenRouter::with_base_url(
            OpenRouterSession::manual(key).unwrap(),
            Url::parse(&base_url).unwrap(),
        );
        let models = provider.list_models().await.unwrap();
        assert_eq!(models.len(), 1);
        let request = captured.recv_timeout(Duration::from_secs(2)).unwrap();
        server.join().unwrap();
        let (headers, body) = request.split_once("\r\n\r\n").unwrap();
        assert!(headers.starts_with(
            "GET /models?output_modalities=text&supported_parameters=structured_outputs HTTP/1.1"
        ));
        assert!(
            headers
                .to_ascii_lowercase()
                .contains("authorization: bearer sk-or-test-secret")
        );
        assert!(!body.contains(key));
    }

    #[tokio::test]
    async fn structured_generation_is_one_http_turn_and_keeps_usage_cost() {
        let response = json!({
            "id": "gen-1",
            "model": "openai/gpt-test",
            "choices": [{
                "message": {"content": "{\"answer\":\"yes\"}"},
                "finish_reason": "stop"
            }],
            "usage": {
                "prompt_tokens": 12,
                "completion_tokens": 3,
                "total_tokens": 15,
                "cost": 0.0000012,
                "cost_details": {"upstream_inference_cost": 0.000001}
            }
        });
        let expected_cost = response["usage"]["cost"].as_number().cloned();
        let (base_url, captured, server) = fake_server(response.to_string());
        let provider = OpenRouter::with_base_url(
            OpenRouterSession::manual("sk-or-test-secret").unwrap(),
            Url::parse(&base_url).unwrap(),
        );
        let request = generation_request("openai/gpt-test");
        let result = provider.generate_request(&request).await.unwrap();
        assert_eq!(
            serde_json::from_slice::<Value>(&result.output).unwrap(),
            json!({"answer":"yes"})
        );
        assert_eq!(result.usage.unwrap().total_tokens, 15);
        assert_eq!(result.cost.map(|cost| cost.amount), expected_cost);
        let raw = captured.recv_timeout(Duration::from_secs(2)).unwrap();
        server.join().unwrap();
        let (_, body) = raw.split_once("\r\n\r\n").unwrap();
        let body: Value = serde_json::from_str(body).unwrap();
        assert_eq!(body["provider"]["require_parameters"], true);
        assert!(body.get("tools").is_none());
        assert!(body.get("plugins").is_none());
    }

    fn fake_server(
        response_body: String,
    ) -> (String, mpsc::Receiver<String>, thread::JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let (sender, receiver) = mpsc::channel();
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(2)))
                .unwrap();
            let mut request = Vec::new();
            let mut buffer = [0_u8; 4096];
            loop {
                match stream.read(&mut buffer) {
                    Ok(0) => break,
                    Ok(read) => {
                        request.extend_from_slice(&buffer[..read]);
                        if complete_http_request(&request) {
                            break;
                        }
                    }
                    Err(error)
                        if matches!(
                            error.kind(),
                            std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                        ) =>
                    {
                        break;
                    }
                    Err(error) => panic!("fake server read failed: {error}"),
                }
            }
            sender.send(String::from_utf8(request).unwrap()).unwrap();
            let response = format!(
                "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{}",
                response_body.len(),
                response_body
            );
            stream.write_all(response.as_bytes()).unwrap();
        });
        (format!("http://{address}/"), receiver, server)
    }

    fn complete_http_request(request: &[u8]) -> bool {
        let Some(headers_end) = request.windows(4).position(|window| window == b"\r\n\r\n") else {
            return false;
        };
        let headers_end = headers_end + 4;
        let headers = String::from_utf8_lossy(&request[..headers_end]);
        let content_length = headers.lines().find_map(|line| {
            let (name, value) = line.split_once(':')?;
            name.eq_ignore_ascii_case("content-length")
                .then(|| value.trim().parse::<usize>().ok())
                .flatten()
        });
        content_length.is_none_or(|length| request.len() >= headers_end + length)
    }
}
