use crate::{
    ModelMetadata, ModelProvider, ProviderAccount, ProviderError, ProviderErrorCode,
    generation::{PromptRole, controlled, prompt_messages, validate_model},
};
use async_trait::async_trait;
use codex_api::{
    ApiError, AuthProvider, Compression, Provider, ReqwestTransport, ResponseEvent,
    ResponsesClient, RetryConfig, TransportError,
};
use codex_http_client::{HttpClientFactory, OutboundProxyPolicy};
use codex_login::{
    AuthCredentialsStoreMode, AuthDotJson, AuthKeyringBackendKind, AuthManager, CodexAuth,
    DeviceCode, LoginServer, RefreshTokenError, ServerOptions, complete_device_code_login,
    load_auth_dot_json, oauth_client_id, request_device_code, run_login_server, save_auth,
};
use codex_websocket_client::{WebSocketConnection, WebSocketConnector};
use futures_util::{SinkExt, StreamExt};
use http::{HeaderMap, HeaderValue, header::AUTHORIZATION};
use scraply_agent_core::{
    CoreError, FinishReason, GenerationProvider, MAX_OUTPUT_BYTES, OperationControl,
    ProviderRequest, ProviderResponse, QualifiedModel, TokenUsage,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::sync::atomic::{AtomicU64, Ordering};
use std::{
    collections::BTreeMap,
    path::PathBuf,
    sync::Arc,
    time::{Duration, Instant},
};
use tokio_tungstenite::tungstenite::{
    Error as WebSocketError, Message,
    client::IntoClientRequest,
    error::ProtocolError,
    protocol::{CloseFrame, WebSocketConfig},
};

pub const OPENAI_SUBSCRIPTION_PROVIDER_ID: &str = "openai-subscription";
const CHATGPT_CODEX_BASE_URL: &str = "https://chatgpt.com/backend-api/codex";
const ACCOUNT_ID_HEADER: &str = "chatgpt-account-id";
const RESPONSES_WEBSOCKET_BETA: &str = "responses_websockets=2026-02-06";
// Subscription catalog visibility is version-gated; use a client version that
// includes the September 2026 GPT-6 Sol and Luna release.
const MODEL_CATALOG_CLIENT_VERSION: &str = "0.156.1";
const MAX_SESSION_CREDENTIAL_BYTES: usize = 64 * 1024;
static EPHEMERAL_AUTH_SEQUENCE: AtomicU64 = AtomicU64::new(0);

#[derive(Clone, PartialEq, Eq)]
pub struct OpenAiSessionCredential(Box<str>);

impl OpenAiSessionCredential {
    fn from_auth(auth: &AuthDotJson) -> Result<Self, ProviderError> {
        let serialized = serde_json::to_string(auth).map_err(|_| invalid_session_credential())?;
        Self::try_from(serialized)
    }

    fn deserialize_auth(&self) -> Result<AuthDotJson, ProviderError> {
        serde_json::from_str(&self.0).map_err(|_| invalid_session_credential())
    }

    pub fn into_host_credential(self) -> String {
        self.0.into()
    }
}

impl TryFrom<String> for OpenAiSessionCredential {
    type Error = ProviderError;

    fn try_from(serialized: String) -> Result<Self, Self::Error> {
        if serialized.len() > MAX_SESSION_CREDENTIAL_BYTES {
            return Err(invalid_session_credential());
        }
        let auth: AuthDotJson =
            serde_json::from_str(&serialized).map_err(|_| invalid_session_credential())?;
        if auth.tokens.is_none() {
            return Err(invalid_session_credential());
        }
        Ok(Self(serialized.into_boxed_str()))
    }
}

impl std::fmt::Debug for OpenAiSessionCredential {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("OpenAiSessionCredential([REDACTED])")
    }
}

#[cfg(debug_assertions)]
#[derive(Clone, Deserialize)]
struct FixtureData {
    account: FixtureAccount,
    models: Vec<FixtureModel>,
    output: Value,
    #[serde(default)]
    repair_output: Option<Value>,
    #[serde(default)]
    repair_failure: bool,
    #[serde(default)]
    refresh_credential: Option<String>,
    #[serde(default)]
    delay_ms: u64,
}

#[cfg(debug_assertions)]
#[derive(Clone, Deserialize)]
struct FixtureAccount {
    email: Option<String>,
    account_id: Option<String>,
    plan: Option<String>,
}

#[cfg(debug_assertions)]
impl FixtureAccount {
    fn metadata(&self) -> ProviderAccount {
        ProviderAccount {
            provider_id: OPENAI_SUBSCRIPTION_PROVIDER_ID.into(),
            email: self.email.clone(),
            account_id: self.account_id.clone(),
            plan: self.plan.clone(),
        }
    }
}

#[cfg(debug_assertions)]
#[derive(Clone, Deserialize)]
struct FixtureModel {
    id: String,
    display_name: String,
    #[serde(default)]
    description: String,
    #[serde(default)]
    supported_reasoning_efforts: Vec<String>,
    #[serde(default)]
    reasoning_effort_descriptions: BTreeMap<String, String>,
    default_reasoning_effort: Option<String>,
}

#[cfg(debug_assertions)]
impl FixtureModel {
    fn metadata(&self) -> ModelMetadata {
        ModelMetadata {
            identity: QualifiedModel {
                provider_id: OPENAI_SUBSCRIPTION_PROVIDER_ID.to_owned(),
                model_id: self.id.clone(),
            },
            display_name: self.display_name.clone(),
            description: self.description.clone(),
            context_length: None,
            supports_structured_output: true,
            supported_reasoning_efforts: self.supported_reasoning_efforts.clone(),
            reasoning_effort_descriptions: self.reasoning_effort_descriptions.clone(),
            default_reasoning_effort: self.default_reasoning_effort.clone(),
            pricing: BTreeMap::new(),
        }
    }
}

#[cfg(debug_assertions)]
fn load_fixture() -> Result<Option<FixtureData>, ProviderError> {
    let Some(raw) = std::env::var_os("SCRAPLY_AGENT_TEST_FIXTURE") else {
        return Ok(None);
    };
    let fixture = serde_json::from_str(raw.to_str().unwrap_or_default()).map_err(|_| {
        ProviderError::new(
            OPENAI_SUBSCRIPTION_PROVIDER_ID,
            ProviderErrorCode::InvalidRequest,
            false,
            "debug provider fixture is invalid",
        )
    })?;
    Ok(Some(fixture))
}

#[derive(Clone)]
pub struct OpenAiSubscription {
    auth: Arc<AuthManager>,
    auth_home: PathBuf,
    base_url: String,
    client: reqwest::Client,
    #[cfg(debug_assertions)]
    fixture: Option<FixtureData>,
}

impl OpenAiSubscription {
    pub async fn ephemeral() -> Result<Self, ProviderError> {
        // Check before AuthManager: upstream accepts environment tokens even in
        // ephemeral mode and permits overrides of credential-bearing endpoints.
        const AUTH_ENVIRONMENT: &[&str] = &[
            "CODEX_ACCESS_TOKEN",
            "CODEX_AUTHAPI_BASE_URL",
            "CODEX_REFRESH_TOKEN_URL_OVERRIDE",
            "CODEX_REVOKE_TOKEN_URL_OVERRIDE",
            "CODEX_APP_SERVER_LOGIN_CLIENT_ID",
            "CODEX_API_KEY",
            "OPENAI_API_KEY",
        ];
        if std::env::vars_os().any(|(name, _)| {
            AUTH_ENVIRONMENT.contains(&name.to_string_lossy().to_ascii_uppercase().as_str())
        }) {
            return Err(ProviderError::new(
                OPENAI_SUBSCRIPTION_PROVIDER_ID,
                ProviderErrorCode::InvalidRequest,
                false,
                "OpenAI credentials and authentication settings must be supplied through Scraply",
            ));
        }
        let auth_home = ephemeral_auth_home();
        let auth = Arc::new(
            AuthManager::new(
                auth_home.clone(),
                false,
                AuthCredentialsStoreMode::Ephemeral,
                None,
                None,
                AuthKeyringBackendKind::default(),
                None,
            )
            .await,
        );
        let client = codex_login::default_client::try_build_reqwest_client().map_err(|_| {
            ProviderError::new(
                OPENAI_SUBSCRIPTION_PROVIDER_ID,
                ProviderErrorCode::Transport,
                false,
                "could not initialize OpenAI subscription transport",
            )
        })?;
        Ok(Self {
            auth,
            auth_home,
            base_url: CHATGPT_CODEX_BASE_URL.to_owned(),
            client,
            #[cfg(debug_assertions)]
            fixture: load_fixture()?,
        })
    }

    pub fn auth_home(&self) -> &std::path::Path {
        &self.auth_home
    }

    pub async fn account(&self) -> Result<Option<ProviderAccount>, ProviderError> {
        #[cfg(debug_assertions)]
        if let Some(fixture) = &self.fixture {
            return Ok(Some(fixture.account.metadata()));
        }
        let Some(auth) = self.current_auth().await else {
            return Ok(None);
        };
        validate_subscription_auth(&auth)?;
        Ok(Some(account_from_auth(&auth)))
    }

    pub async fn refresh(
        &self,
    ) -> Result<(ProviderAccount, OpenAiSessionCredential), ProviderError> {
        #[cfg(debug_assertions)]
        if let Some(fixture) = &self.fixture {
            let credential = fixture
                .refresh_credential
                .clone()
                .ok_or_else(reconnect_required)
                .and_then(OpenAiSessionCredential::try_from)?;
            return Ok((fixture.account.metadata(), credential));
        }
        let Some(auth) = self.current_auth().await else {
            return Err(not_logged_in());
        };
        validate_subscription_auth(&auth)?;
        self.auth
            .refresh_token_from_authority()
            .await
            .map_err(refresh_error)?;
        let account = self.account().await?.ok_or_else(not_logged_in)?;
        let credential = self.session_credential()?;
        Ok((account, credential))
    }

    pub fn begin_browser_login(&self, open_browser: bool) -> Result<BrowserLogin, ProviderError> {
        let mut options = self.login_options();
        options.open_browser = open_browser;
        let server = run_login_server(options).map_err(|_| {
            ProviderError::new(
                OPENAI_SUBSCRIPTION_PROVIDER_ID,
                ProviderErrorCode::Authentication,
                false,
                "could not start the OpenAI account login callback",
            )
        })?;
        Ok(BrowserLogin {
            authorization_url: server.auth_url.clone(),
            callback_port: server.actual_port,
            server,
            auth: Arc::clone(&self.auth),
        })
    }

    pub async fn begin_device_login(&self) -> Result<DeviceLogin, ProviderError> {
        let options = self.login_options();
        let device = request_device_code(&options).await.map_err(|_| {
            ProviderError::new(
                OPENAI_SUBSCRIPTION_PROVIDER_ID,
                ProviderErrorCode::Authentication,
                false,
                "could not start OpenAI device login",
            )
        })?;
        Ok(DeviceLogin {
            verification_url: device.verification_url.clone(),
            user_code: device.user_code.clone(),
            options,
            device,
            auth: Arc::clone(&self.auth),
        })
    }

    pub fn session_credential(&self) -> Result<OpenAiSessionCredential, ProviderError> {
        let auth = load_auth_dot_json(
            &self.auth_home,
            AuthCredentialsStoreMode::Ephemeral,
            AuthKeyringBackendKind::default(),
        )
        .map_err(|_| session_credential_storage_error())?
        .ok_or_else(not_logged_in)?;
        OpenAiSessionCredential::from_auth(&auth)
    }

    pub async fn set_session_credential(
        &self,
        credential: OpenAiSessionCredential,
    ) -> Result<ProviderAccount, ProviderError> {
        let auth = credential.deserialize_auth()?;
        save_auth(
            &self.auth_home,
            &auth,
            AuthCredentialsStoreMode::Ephemeral,
            AuthKeyringBackendKind::default(),
        )
        .map_err(|_| session_credential_storage_error())?;
        self.auth.reload().await;
        account_from_manager(&self.auth)
    }

    pub async fn logout(&self) -> Result<bool, ProviderError> {
        #[cfg(debug_assertions)]
        if self.fixture.is_some() {
            return Ok(true);
        }
        self.auth.logout_with_revoke().await.map_err(|_| {
            ProviderError::new(
                OPENAI_SUBSCRIPTION_PROVIDER_ID,
                ProviderErrorCode::Transport,
                false,
                "could not remove the stored OpenAI account session",
            )
        })
    }

    fn login_options(&self) -> ServerOptions {
        ServerOptions::new(
            self.auth_home.clone(),
            oauth_client_id(),
            None,
            AuthCredentialsStoreMode::Ephemeral,
            AuthKeyringBackendKind::default(),
            None,
        )
    }

    async fn auth_snapshot(&self) -> Result<CodexAuth, ProviderError> {
        let Some(auth) = self.current_auth().await else {
            return Err(not_logged_in());
        };
        validate_subscription_auth(&auth)?;
        Ok(auth)
    }

    async fn current_auth(&self) -> Option<CodexAuth> {
        self.auth.auth_cached()
    }

    async fn request_models(&self, auth: &CodexAuth) -> Result<reqwest::Response, ProviderError> {
        self.client
            .get(format!("{}/models", self.base_url.trim_end_matches('/')))
            .query(&[("client_version", MODEL_CATALOG_CLIENT_VERSION)])
            .headers(auth_headers(auth)?)
            .timeout(Duration::from_secs(30))
            .send()
            .await
            .map_err(|error| ProviderError::transport(OPENAI_SUBSCRIPTION_PROVIDER_ID, &error))
    }
}

#[async_trait]
impl ModelProvider for OpenAiSubscription {
    async fn list_models(&self) -> Result<Vec<ModelMetadata>, ProviderError> {
        #[cfg(debug_assertions)]
        if let Some(fixture) = &self.fixture {
            return Ok(fixture.models.iter().map(FixtureModel::metadata).collect());
        }
        let auth = self.auth_snapshot().await?;
        let response = self.request_models(&auth).await?;
        if !response.status().is_success() {
            return Err(ProviderError::http(
                OPENAI_SUBSCRIPTION_PROVIDER_ID,
                response.status(),
                response.headers(),
            ));
        }
        let catalog = response.json::<ModelsResponse>().await.map_err(|_| {
            ProviderError::new(
                OPENAI_SUBSCRIPTION_PROVIDER_ID,
                ProviderErrorCode::InvalidResponse,
                false,
                "OpenAI returned an invalid model catalog",
            )
        })?;
        resolve_models(catalog)
    }
}

impl OpenAiSubscription {
    async fn generate_request(
        &self,
        request: &ProviderRequest,
    ) -> Result<ProviderResponse, ProviderError> {
        validate_model(request, OPENAI_SUBSCRIPTION_PROVIDER_ID)?;
        if request.max_output_tokens.is_some() {
            return Err(ProviderError::new(
                OPENAI_SUBSCRIPTION_PROVIDER_ID,
                ProviderErrorCode::InvalidRequest,
                false,
                "OpenAI subscription does not support an output-token ceiling; omit maxOutputTokens",
            ));
        }
        #[cfg(debug_assertions)]
        if let Some(fixture) = &self.fixture {
            if !fixture
                .models
                .iter()
                .any(|model| model.id == request.model.model_id)
            {
                return Err(ProviderError::new(
                    OPENAI_SUBSCRIPTION_PROVIDER_ID,
                    ProviderErrorCode::UnavailableModel,
                    false,
                    "selected model is not available from the OpenAI account",
                ));
            }
            if fixture.delay_ms > 0 {
                tokio::time::sleep(Duration::from_millis(fixture.delay_ms)).await;
            }
            if request.attempt == scraply_agent_core::GenerationAttempt::SchemaRepair
                && fixture.repair_failure
            {
                return Err(ProviderError::new(
                    OPENAI_SUBSCRIPTION_PROVIDER_ID,
                    ProviderErrorCode::InvalidResponse,
                    false,
                    "OpenAI fixture repair failed",
                ));
            }
            let output = if request.attempt == scraply_agent_core::GenerationAttempt::SchemaRepair {
                fixture.repair_output.as_ref().unwrap_or(&fixture.output)
            } else {
                &fixture.output
            };
            return Ok(ProviderResponse {
                output: serde_json::to_vec(output).map_err(|_| {
                    ProviderError::new(
                        OPENAI_SUBSCRIPTION_PROVIDER_ID,
                        ProviderErrorCode::InvalidResponse,
                        false,
                        "OpenAI fixture returned invalid structured output",
                    )
                })?,
                usage: Some(TokenUsage {
                    input_tokens: 10,
                    output_tokens: 5,
                    total_tokens: 15,
                    cached_input_tokens: Some(2),
                    reasoning_tokens: Some(1),
                }),
                cost: None,
                finish_reason: FinishReason::Stop,
                request_id: Some(
                    match request.attempt {
                        scraply_agent_core::GenerationAttempt::Initial => "fixture-initial",
                        scraply_agent_core::GenerationAttempt::SchemaRepair => "fixture-repair",
                    }
                    .into(),
                ),
            });
        }
        let auth = self.auth_snapshot().await?;
        let provider = Provider {
            name: "OpenAI subscription".to_owned(),
            base_url: self.base_url.clone(),
            query_params: None,
            headers: HeaderMap::new(),
            retry: RetryConfig {
                max_attempts: 1,
                base_delay: Duration::from_millis(200),
                retry_429: false,
                retry_5xx: false,
                retry_transport: false,
            },
            // Upstream requires a duration; Tokio treats an overflowing deadline as never.
            // Slow reasoning waits for provider completion, transport failure, or cancellation.
            stream_idle_timeout: Duration::MAX,
        };
        let auth = Arc::new(SubscriptionHeaders {
            headers: auth_headers(&auth)?,
        });
        let mut stream = self.generation_stream(request, provider, auth).await?;
        let mut output = String::new();
        let mut response_id = None;
        let mut usage = None;
        while let Some(event) = stream.next().await {
            match event.map_err(|mut error| {
                error.request_id = stream
                    .request_id()
                    .and_then(crate::error::safe_diagnostic)
                    .or(error.request_id);
                error
            })? {
                ResponseEvent::OutputTextDelta(delta) => {
                    if output.len().saturating_add(delta.len()) > MAX_OUTPUT_BYTES {
                        return Err(ProviderError::new(
                            OPENAI_SUBSCRIPTION_PROVIDER_ID,
                            ProviderErrorCode::OutputLimit,
                            false,
                            "OpenAI structured output exceeded the size limit",
                        ));
                    }
                    output.push_str(&delta);
                }
                ResponseEvent::ServerModel(model) if model != request.model.model_id => {
                    return Err(ProviderError::new(
                        OPENAI_SUBSCRIPTION_PROVIDER_ID,
                        ProviderErrorCode::InvalidResponse,
                        false,
                        "OpenAI returned a different model than requested",
                    ));
                }
                ResponseEvent::Completed {
                    response_id: id,
                    token_usage,
                    ..
                } => {
                    response_id = Some(id);
                    if let Some(token_usage) = token_usage {
                        usage = Some(TokenUsage {
                            input_tokens: nonnegative(token_usage.input_tokens),
                            output_tokens: nonnegative(token_usage.output_tokens),
                            total_tokens: nonnegative(token_usage.total_tokens),
                            cached_input_tokens: Some(nonnegative(token_usage.cached_input_tokens)),
                            reasoning_tokens: Some(nonnegative(
                                token_usage.reasoning_output_tokens,
                            )),
                        });
                    }
                    break;
                }
                _ => {}
            }
        }
        let response_id = response_id.ok_or_else(|| {
            let mut error = ProviderError::new(
                OPENAI_SUBSCRIPTION_PROVIDER_ID,
                ProviderErrorCode::InvalidResponse,
                true,
                "OpenAI response ended before completion",
            );
            error.request_id = stream.request_id().and_then(crate::error::safe_diagnostic);
            error
        })?;
        let output = serde_json::from_str::<Value>(&output).map_err(|_| {
            ProviderError::new(
                OPENAI_SUBSCRIPTION_PROVIDER_ID,
                ProviderErrorCode::InvalidResponse,
                false,
                "OpenAI returned invalid structured output",
            )
        })?;
        Ok(ProviderResponse {
            output: serde_json::to_vec(&output).map_err(|_| {
                ProviderError::new(
                    OPENAI_SUBSCRIPTION_PROVIDER_ID,
                    ProviderErrorCode::InvalidResponse,
                    false,
                    "OpenAI returned invalid structured output",
                )
            })?,
            usage,
            cost: None,
            finish_reason: FinishReason::Stop,
            request_id: Some(response_id),
        })
    }

    async fn generation_stream(
        &self,
        request: &ProviderRequest,
        provider: Provider,
        auth: Arc<SubscriptionHeaders>,
    ) -> Result<SubscriptionStream, ProviderError> {
        let url = provider
            .websocket_url_for_path("responses")
            .map_err(|_| invalid_websocket_request())?;
        let mut upgrade = url
            .as_str()
            .into_client_request()
            .map_err(|_| invalid_websocket_request())?;
        upgrade
            .headers_mut()
            .extend(codex_login::default_client::default_headers());
        auth.add_auth_headers(upgrade.headers_mut());
        upgrade.headers_mut().insert(
            "openai-beta",
            HeaderValue::from_static(RESPONSES_WEBSOCKET_BETA),
        );
        let connector =
            WebSocketConnector::new(&HttpClientFactory::new(OutboundProxyPolicy::ReqwestDefault))
                .map_err(|_| invalid_websocket_request())?;
        match connector.connect(upgrade, WebSocketConfig::default()).await {
            Ok((mut socket, response)) => {
                let request_id = response
                    .headers()
                    .get("x-request-id")
                    .and_then(|value| value.to_str().ok())
                    .and_then(crate::error::safe_diagnostic);
                if response
                    .headers()
                    .get("openai-model")
                    .and_then(|value| value.to_str().ok())
                    .is_some_and(|model| model != request.model.model_id)
                {
                    return Err(ProviderError::new(
                        OPENAI_SUBSCRIPTION_PROVIDER_ID,
                        ProviderErrorCode::InvalidResponse,
                        false,
                        "OpenAI returned a different model than requested",
                    ));
                }
                let mut body = generation_body(request);
                body.as_object_mut()
                    .expect("generation body is an object")
                    .remove("stream");
                body["type"] = json!("response.create");
                let now = Instant::now();
                let activity = WebsocketActivity {
                    started: now,
                    last_text: now,
                    sent_pings: 0,
                    received_pings: 0,
                    received_pongs: 0,
                };
                socket
                    .send(Message::Text(body.to_string().into()))
                    .await
                    .map_err(|error| {
                        let mut error = websocket_interrupted(
                            WebsocketTermination::Error(&error),
                            Some(&activity),
                        );
                        error.request_id = request_id.clone();
                        error
                    })?;
                // Keep silent reasoning visible to idle network paths without replaying the work order.
                let heartbeat_interval = Duration::from_secs(30);
                let mut heartbeat = tokio::time::interval_at(
                    tokio::time::Instant::now() + heartbeat_interval,
                    heartbeat_interval,
                );
                heartbeat.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
                Ok(SubscriptionStream::Websocket {
                    socket: Box::new(socket),
                    request_id,
                    expected_model: request.model.model_id.clone(),
                    heartbeat,
                    activity,
                })
            }
            // These handshake rejections establish that no response.create was dispatched.
            Err(WebSocketError::Http(response))
                if matches!(response.status().as_u16(), 405 | 426) =>
            {
                let stream = ResponsesClient::new(
                    ReqwestTransport::new(self.client.clone()),
                    provider,
                    auth,
                )
                .stream(
                    generation_body(request),
                    HeaderMap::new(),
                    Compression::None,
                    None,
                )
                .await
                .map_err(map_api_error)?;
                Ok(SubscriptionStream::Http(stream))
            }
            Err(WebSocketError::Http(response)) => Err(ProviderError::http(
                OPENAI_SUBSCRIPTION_PROVIDER_ID,
                response.status(),
                response.headers(),
            )),
            Err(_) => Err(ProviderError::new(
                OPENAI_SUBSCRIPTION_PROVIDER_ID,
                ProviderErrorCode::Transport,
                true,
                "OpenAI WebSocket connection could not be established",
            )),
        }
    }
}

// Own the socket inside the generation future. Cancelling that future drops the connection,
// including during silent reasoning; upstream's detached Responses pump cannot do this.
enum SubscriptionStream {
    Http(codex_api::ResponseStream),
    Websocket {
        socket: Box<WebSocketConnection>,
        request_id: Option<String>,
        expected_model: String,
        heartbeat: tokio::time::Interval,
        activity: WebsocketActivity,
    },
}

impl SubscriptionStream {
    fn request_id(&self) -> Option<&str> {
        match self {
            Self::Http(stream) => stream.upstream_request_id.as_deref(),
            Self::Websocket { request_id, .. } => request_id.as_deref(),
        }
    }

    async fn next(&mut self) -> Option<Result<ResponseEvent, ProviderError>> {
        let (socket, request_id, expected_model, heartbeat, activity) = match self {
            Self::Http(stream) => {
                return stream
                    .next()
                    .await
                    .map(|event| event.map_err(map_api_error));
            }
            Self::Websocket {
                socket,
                request_id,
                expected_model,
                heartbeat,
                activity,
            } => (socket, request_id, expected_model, heartbeat, activity),
        };
        loop {
            let message = tokio::select! {
                message = socket.next() => match message {
                    Some(Ok(message)) => message,
                    Some(Err(error)) => return Some(Err(websocket_interrupted(WebsocketTermination::Error(&error), Some(activity)))),
                    None => return Some(Err(websocket_interrupted(WebsocketTermination::Eof, Some(activity)))),
                },
                _ = heartbeat.tick() => {
                    if let Err(error) = socket.send(Message::Ping(Vec::new().into())).await {
                        return Some(Err(websocket_interrupted(WebsocketTermination::Error(&error), Some(activity))));
                    }
                    activity.sent_pings = activity.sent_pings.saturating_add(1);
                    continue;
                }
            };
            let text = match message {
                Message::Ping(payload) => {
                    activity.received_pings = activity.received_pings.saturating_add(1);
                    if let Err(error) = socket.send(Message::Pong(payload)).await {
                        return Some(Err(websocket_interrupted(
                            WebsocketTermination::Error(&error),
                            Some(activity),
                        )));
                    }
                    continue;
                }
                Message::Pong(_) => {
                    activity.received_pongs = activity.received_pongs.saturating_add(1);
                    continue;
                }
                Message::Text(text) => {
                    activity.last_text = Instant::now();
                    text
                }
                Message::Close(frame) => {
                    return Some(Err(websocket_interrupted(
                        WebsocketTermination::PeerClose(frame.as_ref()),
                        Some(activity),
                    )));
                }
                _ => continue,
            };
            let event = match serde_json::from_str::<SubscriptionEvent>(&text) {
                Ok(event) => event,
                Err(_) => {
                    return Some(Err(map_api_error(ApiError::Stream(
                        "failed to parse ResponseCompleted:".into(),
                    ))));
                }
            };
            if let Some(response) = event.response.as_ref()
                && request_id.is_none()
            {
                *request_id = response
                    .id
                    .as_deref()
                    .and_then(crate::error::safe_diagnostic);
            }
            if event
                .effective_model()
                .is_some_and(|model| model != expected_model.as_str())
            {
                return Some(Err(ProviderError::new(
                    OPENAI_SUBSCRIPTION_PROVIDER_ID,
                    ProviderErrorCode::InvalidResponse,
                    false,
                    "OpenAI returned a different model than requested",
                )));
            }
            match event.kind.as_str() {
                "response.output_text.delta" => {
                    return Some(event.delta.map(ResponseEvent::OutputTextDelta).ok_or_else(
                        || {
                            map_api_error(ApiError::Stream(
                                "failed to parse ResponseCompleted:".into(),
                            ))
                        },
                    ));
                }
                "response.completed" => {
                    let Some(response) = event
                        .response
                        .filter(|response| response.id.as_ref().is_some_and(|id| !id.is_empty()))
                    else {
                        return Some(Err(map_api_error(ApiError::Stream(
                            "failed to parse ResponseCompleted:".into(),
                        ))));
                    };
                    return Some(Ok(ResponseEvent::Completed {
                        response_id: response.id.unwrap(),
                        token_usage: response.usage.map(|usage| usage.into()),
                        end_turn: None,
                    }));
                }
                "response.failed" | "response.incomplete" | "error" => {
                    if let Some(status) = event
                        .status
                        .and_then(|status| http::StatusCode::from_u16(status).ok())
                    {
                        return Some(Err(ProviderError::http(
                            OPENAI_SUBSCRIPTION_PROVIDER_ID,
                            status,
                            &HeaderMap::new(),
                        )));
                    }
                    let code = event
                        .error
                        .as_ref()
                        .or_else(|| event.response.as_ref()?.error.as_ref())
                        .and_then(|error| error.code.as_deref());
                    let upstream = match code {
                        Some("context_length_exceeded") => ApiError::ContextWindowExceeded,
                        Some("rate_limit_exceeded") => ApiError::RateLimit("rate limit".into()),
                        Some("insufficient_quota") => ApiError::QuotaExceeded,
                        Some("usage_not_included") => ApiError::UsageNotIncluded,
                        Some("invalid_prompt" | "bio_policy") => ApiError::InvalidRequest {
                            message: "request rejected".into(),
                        },
                        Some("cyber_policy") => ApiError::CyberPolicy {
                            message: "request rejected".into(),
                        },
                        _ if event.kind == "response.incomplete" => ApiError::Stream(format!(
                            "Incomplete response returned, reason: {}",
                            event
                                .response
                                .and_then(|response| response.incomplete_details)
                                .and_then(|details| details.reason)
                                .unwrap_or_default()
                        )),
                        _ => ApiError::Stream("response.failed event received".into()),
                    };
                    return Some(Err(map_api_error(upstream)));
                }
                _ => {}
            }
        }
    }
}

#[derive(Deserialize)]
struct SubscriptionEvent {
    #[serde(rename = "type")]
    kind: String,
    delta: Option<String>,
    response: Option<SubscriptionResponse>,
    headers: Option<Value>,
    error: Option<SubscriptionResponseError>,
    #[serde(alias = "status_code")]
    status: Option<u16>,
}

#[derive(Deserialize)]
struct SubscriptionResponse {
    id: Option<String>,
    headers: Option<Value>,
    usage: Option<SubscriptionUsage>,
    error: Option<SubscriptionResponseError>,
    incomplete_details: Option<SubscriptionIncomplete>,
}

impl SubscriptionEvent {
    fn effective_model(&self) -> Option<&str> {
        // Match upstream: effective-model headers outrank payload labels and top-level metadata.
        self.response
            .as_ref()
            .and_then(|response| response.headers.as_ref())
            .and_then(subscription_header_model)
            .or_else(|| self.headers.as_ref().and_then(subscription_header_model))
    }
}

fn subscription_header_model(headers: &Value) -> Option<&str> {
    headers.as_object()?.iter().find_map(|(name, value)| {
        if name.eq_ignore_ascii_case("openai-model") || name.eq_ignore_ascii_case("x-openai-model")
        {
            subscription_header_value(value)
        } else {
            None
        }
    })
}

fn subscription_header_value(value: &Value) -> Option<&str> {
    match value {
        Value::String(value) => Some(value),
        Value::Array(items) => items.first().and_then(subscription_header_value),
        _ => None,
    }
}

#[derive(Deserialize)]
struct SubscriptionResponseError {
    code: Option<String>,
}
#[derive(Deserialize)]
struct SubscriptionIncomplete {
    reason: Option<String>,
}
#[derive(Deserialize)]
struct SubscriptionUsage {
    input_tokens: i64,
    output_tokens: i64,
    total_tokens: i64,
    input_tokens_details: Option<SubscriptionInputUsage>,
    output_tokens_details: Option<SubscriptionOutputUsage>,
}
#[derive(Deserialize)]
struct SubscriptionInputUsage {
    cached_tokens: i64,
}
#[derive(Deserialize)]
struct SubscriptionOutputUsage {
    reasoning_tokens: i64,
}

impl From<SubscriptionUsage> for codex_protocol::protocol::TokenUsage {
    fn from(usage: SubscriptionUsage) -> Self {
        Self {
            input_tokens: usage.input_tokens,
            output_tokens: usage.output_tokens,
            total_tokens: usage.total_tokens,
            cached_input_tokens: usage
                .input_tokens_details
                .map_or(0, |details| details.cached_tokens),
            reasoning_output_tokens: usage
                .output_tokens_details
                .map_or(0, |details| details.reasoning_tokens),
        }
    }
}

fn invalid_websocket_request() -> ProviderError {
    ProviderError::new(
        OPENAI_SUBSCRIPTION_PROVIDER_ID,
        ProviderErrorCode::InvalidRequest,
        false,
        "OpenAI WebSocket request could not be prepared",
    )
}

struct WebsocketActivity {
    started: Instant,
    last_text: Instant,
    sent_pings: u64,
    received_pings: u64,
    received_pongs: u64,
}

enum WebsocketTermination<'a> {
    PeerClose(Option<&'a CloseFrame>),
    Error(&'a WebSocketError),
    Eof,
}

fn websocket_interrupted(
    termination: WebsocketTermination<'_>,
    activity: Option<&WebsocketActivity>,
) -> ProviderError {
    let category = match termination {
        WebsocketTermination::PeerClose(Some(frame)) => format!(
            "peer-close code {} reason {}",
            u16::from(frame.code),
            websocket_close_reason_category(&frame.reason)
        ),
        WebsocketTermination::PeerClose(None) => "peer-close without status".into(),
        WebsocketTermination::Eof => "EOF without close frame".into(),
        WebsocketTermination::Error(error) => {
            let kind = match error {
                WebSocketError::Io(error) => format!("io {:?}", error.kind()),
                WebSocketError::Protocol(ProtocolError::ResetWithoutClosingHandshake) => {
                    "protocol-reset-without-close".into()
                }
                WebSocketError::Protocol(_) => "protocol".into(),
                WebSocketError::Tls(_) => "tls".into(),
                WebSocketError::Capacity(_) => "capacity".into(),
                WebSocketError::ConnectionClosed => "connection-closed".into(),
                WebSocketError::AlreadyClosed => "already-closed".into(),
                _ => "other".into(),
            };
            format!("transport-error {kind}")
        }
    };
    let mut detail = format!(
        "The OpenAI response stream ended before confirming completion. Completion and usage are unknown; review before retrying. WebSocket: {category}."
    );
    if let Some(activity) = activity {
        detail.push_str(&format!(" Sent pings {}, received pings {}, received pongs {}; elapsed {} ms, text silence {} ms.", activity.sent_pings, activity.received_pings, activity.received_pongs, activity.started.elapsed().as_millis(), activity.last_text.elapsed().as_millis()));
    }
    ProviderError::new(
        OPENAI_SUBSCRIPTION_PROVIDER_ID,
        ProviderErrorCode::Transport,
        true,
        detail,
    )
}

fn websocket_close_reason_category(reason: &str) -> &'static str {
    let reason = reason.to_ascii_lowercase();
    if reason.is_empty() {
        "empty"
    } else if reason.contains("idle")
        && (reason.contains("timeout") || reason.contains("timed out"))
    {
        "idle-timeout"
    } else if reason.contains("connection limit")
        || reason.contains("duration")
        || reason.contains("lifetime")
    {
        "connection-duration-limit"
    } else if reason.contains("restart") {
        "service-restart"
    } else if reason.contains("rate limit") {
        "rate-limit"
    } else if reason.contains("timeout") || reason.contains("timed out") {
        "timeout"
    } else {
        "other"
    }
}

#[async_trait]
impl GenerationProvider for OpenAiSubscription {
    fn provider_id(&self) -> &str {
        OPENAI_SUBSCRIPTION_PROVIDER_ID
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

pub struct BrowserLogin {
    pub authorization_url: String,
    pub callback_port: u16,
    server: LoginServer,
    auth: Arc<AuthManager>,
}

impl BrowserLogin {
    pub fn cancel(&self) {
        self.server.cancel();
    }

    pub async fn complete(self) -> Result<ProviderAccount, ProviderError> {
        self.server.block_until_done().await.map_err(|_| {
            ProviderError::new(
                OPENAI_SUBSCRIPTION_PROVIDER_ID,
                ProviderErrorCode::Authentication,
                false,
                "OpenAI account login failed",
            )
        })?;
        self.auth.reload().await;
        account_from_manager(&self.auth)
    }
}

pub struct DeviceLogin {
    pub verification_url: String,
    pub user_code: String,
    options: ServerOptions,
    device: DeviceCode,
    auth: Arc<AuthManager>,
}

impl DeviceLogin {
    pub async fn complete(self) -> Result<ProviderAccount, ProviderError> {
        complete_device_code_login(self.options, self.device)
            .await
            .map_err(|_| {
                ProviderError::new(
                    OPENAI_SUBSCRIPTION_PROVIDER_ID,
                    ProviderErrorCode::Authentication,
                    false,
                    "OpenAI device login failed",
                )
            })?;
        self.auth.reload().await;
        account_from_manager(&self.auth)
    }
}

fn account_from_manager(manager: &AuthManager) -> Result<ProviderAccount, ProviderError> {
    let Some(auth) = manager.auth_cached() else {
        return Err(not_logged_in());
    };
    validate_subscription_auth(&auth)?;
    Ok(account_from_auth(&auth))
}

fn account_from_auth(auth: &CodexAuth) -> ProviderAccount {
    ProviderAccount {
        provider_id: OPENAI_SUBSCRIPTION_PROVIDER_ID.to_owned(),
        email: auth.get_account_email(),
        account_id: auth.get_account_id(),
        plan: auth.account_plan_type().and_then(plan_wire_value),
    }
}

fn plan_wire_value(plan: impl Serialize) -> Option<String> {
    serde_json::to_value(plan)
        .ok()
        .and_then(|value| match value {
            Value::String(value) => Some(value),
            _ => None,
        })
}

fn validate_subscription_auth(auth: &CodexAuth) -> Result<(), ProviderError> {
    if auth.is_api_key_auth() || !auth.is_chatgpt_auth() || !auth.uses_codex_backend() {
        return Err(ProviderError::new(
            OPENAI_SUBSCRIPTION_PROVIDER_ID,
            ProviderErrorCode::Authentication,
            false,
            "a ChatGPT subscription-backed OpenAI account login is required",
        ));
    }
    Ok(())
}

fn not_logged_in() -> ProviderError {
    ProviderError::new(
        OPENAI_SUBSCRIPTION_PROVIDER_ID,
        ProviderErrorCode::Authentication,
        false,
        "not signed in with an OpenAI account",
    )
}

fn reconnect_required() -> ProviderError {
    ProviderError::new(
        OPENAI_SUBSCRIPTION_PROVIDER_ID,
        ProviderErrorCode::ReconnectRequired,
        false,
        "OpenAI account must be reconnected before generation can continue",
    )
}

fn refresh_error(error: RefreshTokenError) -> ProviderError {
    match error {
        RefreshTokenError::Permanent(_) => reconnect_required(),
        RefreshTokenError::Transient(_) => ProviderError::new(
            OPENAI_SUBSCRIPTION_PROVIDER_ID,
            ProviderErrorCode::Transport,
            true,
            "OpenAI session refresh could not be completed",
        ),
    }
}

fn invalid_session_credential() -> ProviderError {
    ProviderError::new(
        OPENAI_SUBSCRIPTION_PROVIDER_ID,
        ProviderErrorCode::Authentication,
        false,
        "OpenAI session credential is invalid",
    )
}

fn session_credential_storage_error() -> ProviderError {
    ProviderError::new(
        OPENAI_SUBSCRIPTION_PROVIDER_ID,
        ProviderErrorCode::Authentication,
        false,
        "OpenAI session credential could not be loaded",
    )
}

fn ephemeral_auth_home() -> PathBuf {
    loop {
        let sequence = EPHEMERAL_AUTH_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!(
            ".scraply-agent-openai-{}-{sequence}",
            std::process::id()
        ));
        if !path.exists() {
            return path;
        }
    }
}

struct SubscriptionHeaders {
    headers: HeaderMap,
}

impl AuthProvider for SubscriptionHeaders {
    fn add_auth_headers(&self, headers: &mut HeaderMap) {
        headers.extend(self.headers.clone());
    }
}

fn auth_headers(auth: &CodexAuth) -> Result<HeaderMap, ProviderError> {
    validate_subscription_auth(auth)?;
    let token = auth.get_token().map_err(|_| not_logged_in())?;
    let mut bearer =
        HeaderValue::from_str(&format!("Bearer {token}")).map_err(|_| not_logged_in())?;
    bearer.set_sensitive(true);
    let mut headers = HeaderMap::new();
    headers.insert(AUTHORIZATION, bearer);
    if let Some(account_id) = auth.get_account_id() {
        let mut value = HeaderValue::from_str(&account_id).map_err(|_| not_logged_in())?;
        value.set_sensitive(true);
        headers.insert(ACCOUNT_ID_HEADER, value);
    }
    if auth.is_fedramp_account() {
        headers.insert("x-openai-fedramp", HeaderValue::from_static("true"));
    }
    Ok(headers)
}

fn generation_body(request: &ProviderRequest) -> Value {
    let input: Vec<_> = prompt_messages(request)
        .into_iter()
        .map(|message| {
            let role = match message.role {
                PromptRole::System | PromptRole::Developer => "developer",
                PromptRole::User => "user",
            };
            json!({
                "type": "message",
                "role": role,
                "content": [{"type": "input_text", "text": message.content}]
            })
        })
        .collect();
    let mut body = json!({
        "model": request.model.model_id,
        "instructions": "",
        "input": input,
        "store": false,
        "stream": true,
        "text": {
            "format": {
                "type": "json_schema",
                "name": "scraply_result",
                "strict": true,
                "schema": request.output_schema
            }
        }
    });
    if let Some(effort) = request.reasoning_effort {
        body["reasoning"] = json!({"effort": effort});
    }
    body
}

#[derive(Deserialize)]
struct ModelsResponse {
    #[serde(default)]
    models: Vec<RemoteModel>,
}

#[derive(Deserialize)]
struct RemoteModel {
    slug: String,
    #[serde(default)]
    display_name: String,
    #[serde(default)]
    description: String,
    #[serde(
        default,
        rename = "default_reasoning_level",
        alias = "default_reasoning_effort"
    )]
    default_reasoning_effort: Option<String>,
    #[serde(
        default,
        rename = "supported_reasoning_levels",
        alias = "supported_reasoning_efforts"
    )]
    supported_reasoning_efforts: Vec<RemoteEffort>,
    #[serde(default)]
    priority: i64,
    #[serde(default)]
    visibility: Option<String>,
}

#[derive(Deserialize)]
struct RemoteEffort {
    effort: String,
    #[serde(default)]
    description: String,
}

fn resolve_models(catalog: ModelsResponse) -> Result<Vec<ModelMetadata>, ProviderError> {
    let mut models: Vec<_> = catalog
        .models
        .into_iter()
        // These explicit Scraply choices may be hidden from default menus, but must
        // still be present in this account's live catalog.
        .filter(|model| {
            matches!(
                model.slug.as_str(),
                "gpt-6-astra" | "gpt-6-sol" | "gpt-6-luna"
            ) || !matches!(model.visibility.as_deref(), Some("hide" | "none"))
        })
        .collect();
    models.sort_by_key(|model| model.priority);
    let models: Vec<_> = models
        .into_iter()
        .map(|model| {
            let reasoning_effort_descriptions = model
                .supported_reasoning_efforts
                .iter()
                .filter(|effort| !effort.description.is_empty())
                .map(|effort| (effort.effort.clone(), effort.description.clone()))
                .collect();
            ModelMetadata {
                identity: QualifiedModel {
                    provider_id: OPENAI_SUBSCRIPTION_PROVIDER_ID.to_owned(),
                    model_id: model.slug.clone(),
                },
                display_name: if model.display_name.is_empty() {
                    model.slug
                } else {
                    model.display_name
                },
                description: model.description,
                context_length: None,
                supports_structured_output: true,
                supported_reasoning_efforts: model
                    .supported_reasoning_efforts
                    .into_iter()
                    .map(|effort| effort.effort)
                    .collect(),
                reasoning_effort_descriptions,
                default_reasoning_effort: model.default_reasoning_effort,
                pricing: BTreeMap::new(),
            }
        })
        .collect();
    if models.is_empty() {
        return Err(ProviderError::new(
            OPENAI_SUBSCRIPTION_PROVIDER_ID,
            ProviderErrorCode::InvalidResponse,
            false,
            "OpenAI returned no available subscription models",
        ));
    }
    Ok(models)
}

fn map_api_error(error: ApiError) -> ProviderError {
    match error {
        ApiError::Api { status, .. } => {
            ProviderError::http(OPENAI_SUBSCRIPTION_PROVIDER_ID, status, &HeaderMap::new())
        }
        ApiError::Transport(TransportError::Http {
            status, headers, ..
        }) => ProviderError::http(
            OPENAI_SUBSCRIPTION_PROVIDER_ID,
            status,
            headers.as_ref().unwrap_or(&HeaderMap::new()),
        ),
        ApiError::QuotaExceeded | ApiError::UsageNotIncluded => ProviderError::new(
            OPENAI_SUBSCRIPTION_PROVIDER_ID,
            ProviderErrorCode::Authentication,
            false,
            "the OpenAI account does not include subscription generation usage",
        ),
        ApiError::ContextWindowExceeded => ProviderError::new(
            OPENAI_SUBSCRIPTION_PROVIDER_ID,
            ProviderErrorCode::InvalidRequest,
            false,
            "model context window was exceeded",
        ),
        ApiError::Transport(TransportError::Timeout) => ProviderError::new(
            OPENAI_SUBSCRIPTION_PROVIDER_ID,
            ProviderErrorCode::Timeout,
            true,
            "OpenAI request timed out",
        ),
        ApiError::RateLimit(_) => ProviderError::new(
            OPENAI_SUBSCRIPTION_PROVIDER_ID,
            ProviderErrorCode::RateLimited,
            true,
            "OpenAI rate limited the request",
        ),
        ApiError::ServerOverloaded => ProviderError::new(
            OPENAI_SUBSCRIPTION_PROVIDER_ID,
            ProviderErrorCode::Transport,
            true,
            "OpenAI is temporarily overloaded",
        ),
        ApiError::Stream(message) => ProviderError::new(
            OPENAI_SUBSCRIPTION_PROVIDER_ID,
            ProviderErrorCode::Transport,
            true,
            // Match upstream's stable categories, never expose a raw stream body or decoder error.
            match message.as_str() {
                "stream closed before response.completed" => {
                    "OpenAI closed the response stream before confirming completion. Completion and usage are unknown; review before retrying."
                }
                "idle timeout waiting for SSE" => {
                    "The OpenAI connection stopped delivering response events. Completion and usage are unknown; review before retrying."
                }
                "response.failed event received" => {
                    "OpenAI reported a failed response without a specific reason."
                }
                "Incomplete response returned, reason: max_output_tokens" => {
                    "OpenAI returned an incomplete response because its output token limit was reached."
                }
                "Incomplete response returned, reason: content_filter" => {
                    "OpenAI returned an incomplete response because of content filtering."
                }
                _ if message.starts_with("Incomplete response returned, reason:") => {
                    "OpenAI returned an incomplete response without a recognized reason."
                }
                _ if message.starts_with("failed to parse ResponseCompleted:") => {
                    "OpenAI sent a completion event that could not be decoded. Completion and usage could not be confirmed."
                }
                _ => {
                    "The OpenAI response stream could not be read. Completion and usage are unknown; review before retrying."
                }
            },
        ),
        ApiError::Retryable { .. } => ProviderError::new(
            OPENAI_SUBSCRIPTION_PROVIDER_ID,
            ProviderErrorCode::Transport,
            true,
            "OpenAI temporarily could not complete the request",
        ),
        ApiError::InvalidRequest { .. } => ProviderError::new(
            OPENAI_SUBSCRIPTION_PROVIDER_ID,
            ProviderErrorCode::InvalidRequest,
            false,
            "OpenAI rejected the request as invalid",
        ),
        ApiError::CyberPolicy { .. } => ProviderError::new(
            OPENAI_SUBSCRIPTION_PROVIDER_ID,
            ProviderErrorCode::InvalidRequest,
            false,
            "OpenAI rejected the request under its safety policy",
        ),
        ApiError::Transport(TransportError::RetryLimit | TransportError::Network(_)) => {
            ProviderError::new(
                OPENAI_SUBSCRIPTION_PROVIDER_ID,
                ProviderErrorCode::Transport,
                true,
                "OpenAI connection could not complete the request",
            )
        }
        ApiError::Transport(TransportError::Build(_)) => ProviderError::new(
            OPENAI_SUBSCRIPTION_PROVIDER_ID,
            ProviderErrorCode::InvalidRequest,
            false,
            "OpenAI request could not be prepared",
        ),
    }
}

fn nonnegative(value: i64) -> u64 {
    u64::try_from(value).unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
    use scraply_agent_core::{
        CompiledPrompt, GenerationAttempt, PromptIdentity, ProviderRequest, QualifiedModel,
    };

    fn generation_request(model_id: &str) -> ProviderRequest {
        ProviderRequest {
            model: QualifiedModel {
                provider_id: OPENAI_SUBSCRIPTION_PROVIDER_ID.to_owned(),
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

    fn test_session_credential() -> OpenAiSessionCredential {
        let claims = json!({
            "email": "person@example.test",
            "https://api.openai.com/auth": {
                "chatgpt_account_id": "account-test",
                "chatgpt_plan_type": "plus",
                "chatgpt_user_id": "user-test"
            }
        });
        let id_token = format!(
            "e30.{}.test-signature",
            URL_SAFE_NO_PAD.encode(serde_json::to_vec(&claims).unwrap())
        );
        OpenAiSessionCredential::try_from(
            json!({
                "auth_mode": "chatgpt",
                "OPENAI_API_KEY": null,
                "tokens": {
                    "id_token": id_token,
                    "access_token": "test-access-token",
                    "refresh_token": "test-refresh-token",
                    "account_id": "account-test"
                },
                "last_refresh": null
            })
            .to_string(),
        )
        .unwrap()
    }

    #[tokio::test]
    #[allow(
        clippy::result_large_err,
        reason = "Tungstenite requires this handshake callback's unboxed HTTP error response"
    )]
    async fn websocket_reasoning_keeps_connection_alive_and_preserves_assignment() {
        use futures_util::SinkExt;
        use tokio_tungstenite::tungstenite::Message;
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (socket, _) = listener.accept().await.unwrap();
            let mut socket = tokio_tungstenite::accept_hdr_async(
                socket,
                |request: &tokio_tungstenite::tungstenite::handshake::server::Request, response| {
                    assert_eq!(request.uri().path(), "/responses");
                    assert_eq!(
                        request.headers()["openai-beta"],
                        "responses_websockets=2026-02-06"
                    );
                    Ok(response)
                },
            )
            .await
            .unwrap();
            let message = socket.next().await.unwrap().unwrap();
            let body: Value = serde_json::from_str(message.to_text().unwrap()).unwrap();
            assert_eq!(body["type"], "response.create");
            assert_eq!(body["model"], "gpt-6-astra");
            assert_eq!(body["reasoning"]["effort"], "xhigh");
            assert_eq!(body["text"]["format"]["strict"], true);
            assert_eq!(body["text"]["format"]["schema"], json!({"type":"object"}));
            assert_eq!(body["store"], false);
            assert!(body.get("previous_response_id").is_none());
            assert!(body.get("background").is_none());
            assert!(body.get("stream").is_none());
            socket
                .send(Message::Text(
                    json!({"type":"response.created","response":{"id":"response-ws-test"}})
                        .to_string()
                        .into(),
                ))
                .await
                .unwrap();
            // A remote gateway can keep a silent reasoning connection alive with control frames.
            for _ in 0..3 {
                socket
                    .send(Message::Ping(b"keepalive".to_vec().into()))
                    .await
                    .unwrap();
                let pong = tokio::time::timeout(Duration::from_secs(2), socket.next())
                    .await
                    .unwrap()
                    .unwrap()
                    .unwrap();
                assert!(matches!(pong, Message::Pong(payload) if payload.as_ref() == b"keepalive"));
            }
            socket
                .send(Message::Text(
                    json!({"type":"response.output_text.delta","delta":"{}"})
                        .to_string()
                        .into(),
                ))
                .await
                .unwrap();
            socket.send(Message::Text(json!({"type":"response.completed","response":{"id":"response-ws-test","usage":{"input_tokens":4,"output_tokens":2,"total_tokens":6}}}).to_string().into())).await.unwrap();
            // No second response.create and no HTTP replay may follow completion.
            if let Ok(Some(Ok(Message::Text(_)))) =
                tokio::time::timeout(Duration::from_secs(2), socket.next()).await
            {
                panic!("assignment was dispatched twice");
            }
        });
        let provider = local_test_provider(address).await;
        let mut request = generation_request("gpt-6-astra");
        request.reasoning_effort = Some(scraply_agent_core::ReasoningEffort::Xhigh);
        let result =
            tokio::time::timeout(Duration::from_secs(5), provider.generate_request(&request))
                .await
                .unwrap()
                .unwrap();
        assert_eq!(result.output, b"{}");
        assert_eq!(result.request_id.as_deref(), Some("response-ws-test"));
        assert_eq!(result.usage.unwrap().total_tokens, 6);
        server.await.unwrap();
    }

    #[tokio::test]
    async fn websocket_checks_effective_model_headers_instead_of_response_model_labels() {
        for (event, rejects_model) in [
            (
                json!({"type":"response.created","response":{"id":"response-model-test","model":"gpt-6-astra","headers":{"OpenAI-Model":"different-model"}}}),
                true,
            ),
            (
                json!({"type":"response.created","headers":{"x-openai-model":"different-model"},"response":{"id":"response-model-test","model":"gpt-6-astra"}}),
                true,
            ),
            (
                json!({"type":"response.created","response":{"id":"response-model-test","model":"gpt-6-astra","headers":{"openai-model":["different-model"]}}}),
                true,
            ),
            (
                json!({"type":"response.created","headers":{"openai-model":"different-model"},"response":{"id":"response-model-test","model":"gpt-6-astra-alias","headers":{"X-OpenAI-Model":"gpt-6-astra"}}}),
                false,
            ),
            (
                json!({"type":"response.created","headers":{"OpenAI-Model":"gpt-6-astra"},"response":{"id":"response-model-test","model":"gpt-6-astra-alias"}}),
                false,
            ),
            (
                json!({"type":"response.created","response":{"id":"response-model-test","model":"gpt-6-astra-alias"}}),
                false,
            ),
        ] {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let address = listener.local_addr().unwrap();
            let server = tokio::spawn(async move {
                let (socket, _) = listener.accept().await.unwrap();
                let mut socket = tokio_tungstenite::accept_async(socket).await.unwrap();
                assert!(socket.next().await.unwrap().unwrap().is_text());
                for event in [
                    event,
                    json!({"type":"response.output_text.delta","delta":"{}"}),
                    json!({"type":"response.completed","response":{"id":"response-model-test"}}),
                ] {
                    if socket
                        .send(Message::Text(event.to_string().into()))
                        .await
                        .is_err()
                    {
                        break;
                    }
                }
            });
            let provider = local_test_provider(address).await;
            let result = tokio::time::timeout(
                Duration::from_secs(5),
                provider.generate_request(&generation_request("gpt-6-astra")),
            )
            .await
            .unwrap();
            if rejects_model {
                let error = result.unwrap_err();
                assert_eq!(error.code, ProviderErrorCode::InvalidResponse);
                assert_eq!(
                    error.detail,
                    "OpenAI returned a different model than requested"
                );
            } else {
                assert_eq!(result.unwrap().output, b"{}");
            }
            server.await.unwrap();
        }
    }

    #[tokio::test]
    async fn websocket_failures_keep_subscription_error_classification() {
        for (event, expected_code, retryable) in [
            (
                json!({"type":"response.failed","response":{"id":"response-rejected","error":{"code":"invalid_prompt","message":"private rejected request"}}}),
                ProviderErrorCode::InvalidRequest,
                false,
            ),
            (
                json!({"type":"response.failed","response":{"id":"response-rejected","error":{"code":"bio_policy","message":"private rejected request"}}}),
                ProviderErrorCode::InvalidRequest,
                false,
            ),
            (
                json!({"type":"response.failed","response":{"id":"response-rejected","error":{"code":"cyber_policy","message":"private rejected request"}}}),
                ProviderErrorCode::InvalidRequest,
                false,
            ),
            (
                json!({"type":"response.failed","response":{"id":"response-rejected","error":{"code":"usage_not_included","message":"private rejected request"}}}),
                ProviderErrorCode::Authentication,
                false,
            ),
            (
                json!({"type":"error","status_code":401,"error":{"message":"private rejected request"}}),
                ProviderErrorCode::Authentication,
                false,
            ),
            (
                json!({"type":"error","status":400,"error":{"message":"private rejected request"}}),
                ProviderErrorCode::InvalidRequest,
                false,
            ),
            (
                json!({"type":"error","status":429,"error":{"message":"private rejected request"}}),
                ProviderErrorCode::RateLimited,
                true,
            ),
            (
                json!({"type":"error","status_code":502,"error":{"message":"private rejected request"}}),
                ProviderErrorCode::Transport,
                true,
            ),
        ] {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let address = listener.local_addr().unwrap();
            let server = tokio::spawn(async move {
                let (socket, _) = listener.accept().await.unwrap();
                let mut socket = tokio_tungstenite::accept_async(socket).await.unwrap();
                assert!(socket.next().await.unwrap().unwrap().is_text());
                socket
                    .send(Message::Text(event.to_string().into()))
                    .await
                    .unwrap();
            });
            let provider = local_test_provider(address).await;
            let error = tokio::time::timeout(
                Duration::from_secs(5),
                provider.generate_request(&generation_request("gpt-6-astra")),
            )
            .await
            .unwrap()
            .unwrap_err();
            assert_eq!(error.code, expected_code);
            assert_eq!(error.retryable, retryable);
            assert!(!error.detail.contains("private rejected request"));
            server.await.unwrap();
        }
    }

    #[tokio::test]
    async fn websocket_cancellation_closes_silent_connection_without_replaying() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let cancellation = scraply_agent_core::CancellationToken::new();
        let server_cancellation = cancellation.clone();
        let server = tokio::spawn(async move {
            let (socket, _) = listener.accept().await.unwrap();
            let mut socket = tokio_tungstenite::accept_async(socket).await.unwrap();
            let request = socket.next().await.unwrap().unwrap();
            assert_eq!(
                serde_json::from_str::<Value>(request.to_text().unwrap()).unwrap()["type"],
                "response.create"
            );
            server_cancellation.cancel();
            let next = tokio::time::timeout(Duration::from_secs(2), socket.next())
                .await
                .expect("cancelled assignment left its socket open");
            assert!(!matches!(
                next,
                Some(Ok(tokio_tungstenite::tungstenite::Message::Text(_)))
            ));
        });
        let provider = local_test_provider(address).await;
        let error = provider
            .generate(
                generation_request("gpt-6-astra"),
                &OperationControl::until_cancelled(cancellation),
            )
            .await
            .unwrap_err();
        assert_eq!(
            error.failure().code,
            scraply_agent_core::FailureCode::Cancellation
        );
        server.await.unwrap();
    }

    async fn local_test_provider(address: std::net::SocketAddr) -> OpenAiSubscription {
        let mut provider = OpenAiSubscription::ephemeral().await.unwrap();
        provider.base_url = format!("http://{address}");
        let mut auth = test_session_credential().deserialize_auth().unwrap();
        auth.last_refresh = Some("2026-09-29T00:00:00Z".parse().unwrap());
        provider
            .set_session_credential(OpenAiSessionCredential::from_auth(&auth).unwrap())
            .await
            .unwrap();
        provider
    }

    #[tokio::test]
    async fn truncated_response_stream_reports_missing_completion_without_replaying() {
        use std::io::Write;
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            let mut socket = accept_test_http_assignment(&listener);
            let body = "data: {\"type\":\"response.created\",\"response\":{\"id\":\"response-test\"}}\n\ndata: {\"type\":\"response.output_text.delta\",\"delta\":\"partial private output\"}\n\n";
            write!(socket, "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nx-request-id: req_truncated-test\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", body.len(), body).unwrap();
        });
        let mut provider = OpenAiSubscription::ephemeral().await.unwrap();
        provider.base_url = format!("http://{address}");
        let mut auth = test_session_credential().deserialize_auth().unwrap();
        auth.last_refresh = Some("2026-09-29T00:00:00Z".parse().unwrap());
        provider
            .set_session_credential(OpenAiSessionCredential::from_auth(&auth).unwrap())
            .await
            .unwrap();
        let error = provider
            .generate_request(&generation_request("gpt-test"))
            .await
            .unwrap_err();
        server.join().unwrap();
        assert_eq!(error.code, ProviderErrorCode::Transport);
        assert_eq!(
            error.detail,
            "OpenAI closed the response stream before confirming completion. Completion and usage are unknown; review before retrying."
        );
        assert!(!error.detail.contains("private output"));
        assert_eq!(error.request_id.as_deref(), Some("req_truncated-test"));
    }

    #[tokio::test]
    #[ignore = "manual 16-minute transport check; uses only a local server and fake credentials"]
    async fn idle_response_stream_completes_after_fifteen_minutes() {
        use std::io::Write;
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            let mut socket = accept_test_http_assignment(&listener);
            let created = "data: {\"type\":\"response.created\",\"response\":{\"id\":\"response-slow-test\"}}\n\n";
            let completed = "data: {\"type\":\"response.output_text.delta\",\"delta\":\"{}\"}\n\ndata: {\"type\":\"response.completed\",\"response\":{\"id\":\"response-slow-test\"}}\n\n";
            write!(socket, "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", created.len() + completed.len(), created).unwrap();
            socket.flush().unwrap();
            // Real elapsed time also covers socket/HTTP timers outside Tokio's test clock.
            std::thread::sleep(Duration::from_secs(915));
            socket.write_all(completed.as_bytes()).unwrap();
        });
        let mut provider = OpenAiSubscription::ephemeral().await.unwrap();
        provider.base_url = format!("http://{address}");
        let mut auth = test_session_credential().deserialize_auth().unwrap();
        auth.last_refresh = Some("2026-09-29T00:00:00Z".parse().unwrap());
        provider
            .set_session_credential(OpenAiSessionCredential::from_auth(&auth).unwrap())
            .await
            .unwrap();
        let control =
            OperationControl::until_cancelled(scraply_agent_core::CancellationToken::new());
        let result = provider
            .generate(generation_request("gpt-test"), &control)
            .await
            .unwrap();
        server.join().unwrap();
        assert_eq!(result.output, b"{}");
        assert_eq!(result.request_id.as_deref(), Some("response-slow-test"));
    }

    // Reject only the upgrade, before dispatch, then accept exactly one HTTP assignment.
    fn accept_test_http_assignment(listener: &std::net::TcpListener) -> std::net::TcpStream {
        use std::io::{Read, Write};
        for _ in 0..2 {
            let (mut socket, _) = listener.accept().unwrap();
            socket
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            let mut request = Vec::new();
            let mut buffer = [0_u8; 4096];
            loop {
                let count = socket.read(&mut buffer).unwrap();
                assert!(count > 0);
                request.extend_from_slice(&buffer[..count]);
                if let Some(end) = request.windows(4).position(|part| part == b"\r\n\r\n") {
                    let headers = String::from_utf8_lossy(&request[..end]);
                    let length = headers
                        .lines()
                        .find_map(|line| {
                            let (name, value) = line.split_once(':')?;
                            name.eq_ignore_ascii_case("content-length")
                                .then(|| value.trim().parse::<usize>().unwrap())
                        })
                        .unwrap_or(0);
                    if request.len() >= end + 4 + length {
                        break;
                    }
                }
            }
            if request.starts_with(b"GET ") {
                socket.write_all(b"HTTP/1.1 426 Upgrade Required\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").unwrap();
            } else {
                assert!(request.starts_with(b"POST /responses "));
                return socket;
            }
        }
        panic!("HTTP assignment was never dispatched");
    }

    #[tokio::test]
    async fn interrupted_http_body_reproduces_unreadable_stream_without_replaying() {
        use std::io::Write;
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            let mut socket = accept_test_http_assignment(&listener);
            let body =
                "data: {\"type\":\"response.created\",\"response\":{\"id\":\"response-test\"}}\n\n";
            // Close before the declared HTTP body ends, reproducing the screenshot's read error.
            write!(socket, "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nx-request-id: req_body-read-test\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", body.len() + 100, body).unwrap();
        });
        let provider = local_test_provider(address).await;
        let error = provider
            .generate_request(&generation_request("gpt-6-astra"))
            .await
            .unwrap_err();
        server.join().unwrap();
        assert_eq!(error.code, ProviderErrorCode::Transport);
        assert_eq!(
            error.detail,
            "The OpenAI response stream could not be read. Completion and usage are unknown; review before retrying."
        );
        assert_eq!(error.request_id.as_deref(), Some("req_body-read-test"));
    }

    #[tokio::test]
    #[allow(
        clippy::result_large_err,
        reason = "Tungstenite requires this handshake callback's unboxed HTTP error response"
    )]
    async fn websocket_disconnect_keeps_safe_request_id_without_http_replay() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (socket, _) = listener.accept().await.unwrap();
            let mut socket = tokio_tungstenite::accept_hdr_async(socket, |_: &tokio_tungstenite::tungstenite::handshake::server::Request, mut response: tokio_tungstenite::tungstenite::handshake::server::Response| {
                response.headers_mut().insert("x-request-id", HeaderValue::from_static("req_ws-disconnect"));
                Ok(response)
            }).await.unwrap();
            assert!(socket.next().await.unwrap().unwrap().is_text());
            socket
                .send(Message::Text(
                    json!({"type":"response.created","response":{"id":"response-ws-lost"}})
                        .to_string()
                        .into(),
                ))
                .await
                .unwrap();
            socket
                .send(Message::Text(
                    json!({"type":"response.output_text.delta","delta":"partial private output"})
                        .to_string()
                        .into(),
                ))
                .await
                .unwrap();
            drop(socket);
            assert!(
                tokio::time::timeout(Duration::from_millis(100), listener.accept())
                    .await
                    .is_err(),
                "unknown completion was replayed over HTTP"
            );
        });
        let provider = local_test_provider(address).await;
        let error = provider
            .generate_request(&generation_request("gpt-6-astra"))
            .await
            .unwrap_err();
        assert_eq!(error.code, ProviderErrorCode::Transport);
        assert!(error.detail.contains("Completion and usage are unknown"));
        assert!(error.detail.contains("transport-error protocol"));
        assert!(!error.detail.contains("private output"));
        assert_eq!(error.request_id.as_deref(), Some("req_ws-disconnect"));
        server.await.unwrap();
    }

    #[tokio::test]
    async fn websocket_close_diagnostics_keep_only_safe_categories_and_activity() {
        use tokio_tungstenite::tungstenite::protocol::{CloseFrame, frame::coding::CloseCode};
        for (frame, expected) in [
            (
                Some(CloseFrame {
                    code: CloseCode::Away,
                    reason: "Idle timeout: private secret material".into(),
                }),
                "peer-close code 1001 reason idle-timeout",
            ),
            (
                Some(CloseFrame {
                    code: CloseCode::Error,
                    reason: "private secret material".into(),
                }),
                "peer-close code 1011 reason other",
            ),
            (None, "peer-close without status"),
        ] {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let address = listener.local_addr().unwrap();
            let server = tokio::spawn(async move {
                let (socket, _) = listener.accept().await.unwrap();
                let mut socket = tokio_tungstenite::accept_async(socket).await.unwrap();
                assert!(socket.next().await.unwrap().unwrap().is_text());
                socket
                    .send(Message::Text(
                        json!({"type":"response.created","response":{"id":"response-close-test"}})
                            .to_string()
                            .into(),
                    ))
                    .await
                    .unwrap();
                socket
                    .send(Message::Ping(b"private secret material".to_vec().into()))
                    .await
                    .unwrap();
                assert!(matches!(
                    socket.next().await.unwrap().unwrap(),
                    Message::Pong(_)
                ));
                socket
                    .send(Message::Pong(b"private secret material".to_vec().into()))
                    .await
                    .unwrap();
                socket.send(Message::Close(frame)).await.unwrap();
                assert!(
                    tokio::time::timeout(Duration::from_millis(100), listener.accept())
                        .await
                        .is_err(),
                    "unknown completion was replayed"
                );
            });
            let provider = local_test_provider(address).await;
            let error = tokio::time::timeout(
                Duration::from_secs(5),
                provider.generate_request(&generation_request("gpt-6-astra")),
            )
            .await
            .unwrap()
            .unwrap_err();
            assert_eq!(error.code, ProviderErrorCode::Transport);
            assert!(error.detail.contains("Completion and usage are unknown"));
            assert!(error.detail.contains(expected), "{}", error.detail);
            assert!(error.detail.contains("received pings 1, received pongs 1"));
            assert!(error.detail.contains("text silence"));
            assert!(!error.detail.contains("private secret material"));
            assert_eq!(error.request_id.as_deref(), Some("response-close-test"));
            server.await.unwrap();
        }
    }

    #[tokio::test]
    async fn websocket_client_ping_keeps_silent_connection_alive_without_server_pings() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (socket, _) = listener.accept().await.unwrap();
            let mut socket = tokio_tungstenite::accept_async(socket).await.unwrap();
            assert!(socket.next().await.unwrap().unwrap().is_text());
            socket
                .send(Message::Text(
                    json!({"type":"response.created","response":{"id":"response-client-ping"}})
                        .to_string()
                        .into(),
                ))
                .await
                .unwrap();
            let ping = tokio::time::timeout(Duration::from_secs(35), socket.next())
                .await
                .expect("silent connection received no client heartbeat")
                .unwrap()
                .unwrap();
            let Message::Ping(payload) = ping else {
                panic!("expected a control ping, not a second assignment")
            };
            assert!(payload.is_empty());
            socket.send(Message::Pong(payload)).await.unwrap();
            socket
                .send(Message::Text(
                    json!({"type":"response.output_text.delta","delta":"{}"})
                        .to_string()
                        .into(),
                ))
                .await
                .unwrap();
            socket
                .send(Message::Text(
                    json!({"type":"response.completed","response":{"id":"response-client-ping"}})
                        .to_string()
                        .into(),
                ))
                .await
                .unwrap();
        });
        let provider = local_test_provider(address).await;
        let response = tokio::time::timeout(
            Duration::from_secs(35),
            provider.generate_request(&generation_request("gpt-6-astra")),
        )
        .await
        .unwrap()
        .unwrap();
        assert_eq!(response.output, b"{}");
        server.await.unwrap();
    }

    #[test]
    fn websocket_termination_diagnostics_never_echo_transport_errors() {
        let io_error = WebSocketError::Io(std::io::Error::new(
            std::io::ErrorKind::ConnectionReset,
            "private secret material",
        ));
        let reset_error = WebSocketError::Protocol(ProtocolError::ResetWithoutClosingHandshake);
        for (termination, expected) in [
            (WebsocketTermination::Eof, "EOF without close frame"),
            (
                WebsocketTermination::Error(&io_error),
                "transport-error io ConnectionReset",
            ),
            (
                WebsocketTermination::Error(&reset_error),
                "transport-error protocol-reset-without-close",
            ),
        ] {
            let error = websocket_interrupted(termination, None);
            assert_eq!(error.code, ProviderErrorCode::Transport);
            assert!(error.detail.contains(expected));
            assert!(!error.detail.contains("private secret material"));
            assert!(error.detail.len() <= 512);
        }
    }

    async fn wait_for_test_keepalive_pong(
        socket: &mut tokio_tungstenite::WebSocketStream<tokio::net::TcpStream>,
    ) -> usize {
        let mut client_pings = 0;
        loop {
            let message = tokio::time::timeout(Duration::from_secs(2), socket.next())
                .await
                .expect("client did not answer the server keepalive")
                .unwrap()
                .unwrap();
            match message {
                Message::Ping(payload) => {
                    client_pings += 1;
                    socket.send(Message::Pong(payload)).await.unwrap();
                }
                Message::Pong(payload) if payload.as_ref() == b"keepalive" => return client_pings,
                Message::Pong(_) => {}
                _ => panic!("unexpected model message while checking keepalive control frames"),
            }
        }
    }

    #[tokio::test]
    async fn websocket_duration_fixture_handles_bidirectional_keepalives() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (socket, _) = listener.accept().await.unwrap();
            let mut socket = tokio_tungstenite::accept_async(socket).await.unwrap();
            socket
                .send(Message::Ping(b"keepalive".to_vec().into()))
                .await
                .unwrap();
            assert_eq!(wait_for_test_keepalive_pong(&mut socket).await, 1);
        });
        let socket = tokio::net::TcpStream::connect(address).await.unwrap();
        let (mut client, _) = tokio_tungstenite::client_async(format!("ws://{address}"), socket)
            .await
            .unwrap();
        client.send(Message::Ping(Vec::new().into())).await.unwrap();
        let Message::Ping(payload) = client.next().await.unwrap().unwrap() else {
            panic!("fixture server did not send its keepalive")
        };
        client.send(Message::Pong(payload)).await.unwrap();
        assert!(
            matches!(client.next().await.unwrap().unwrap(), Message::Pong(payload) if payload.is_empty())
        );
        server.await.unwrap();
    }

    #[tokio::test]
    #[ignore = "manual 16-minute WebSocket check; local server and fake credentials only"]
    async fn websocket_reasoning_completes_after_fifteen_minutes() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (socket, _) = listener.accept().await.unwrap();
            let mut socket = tokio_tungstenite::accept_async(socket).await.unwrap();
            assert!(socket.next().await.unwrap().unwrap().is_text());
            socket
                .send(Message::Text(
                    json!({"type":"response.created","response":{"id":"response-slow-ws"}})
                        .to_string()
                        .into(),
                ))
                .await
                .unwrap();
            for _ in 0..61 {
                tokio::time::sleep(Duration::from_secs(15)).await;
                socket
                    .send(Message::Ping(b"keepalive".to_vec().into()))
                    .await
                    .unwrap();
                wait_for_test_keepalive_pong(&mut socket).await;
            }
            socket
                .send(Message::Text(
                    json!({"type":"response.output_text.delta","delta":"{}"})
                        .to_string()
                        .into(),
                ))
                .await
                .unwrap();
            socket
                .send(Message::Text(
                    json!({"type":"response.completed","response":{"id":"response-slow-ws"}})
                        .to_string()
                        .into(),
                ))
                .await
                .unwrap();
        });
        let provider = local_test_provider(address).await;
        let started = Instant::now();
        let result = tokio::time::timeout(
            Duration::from_secs(940),
            provider.generate(
                generation_request("gpt-6-astra"),
                &OperationControl::until_cancelled(scraply_agent_core::CancellationToken::new()),
            ),
        )
        .await
        .expect("WebSocket fixture did not complete within 940 seconds")
        .unwrap();
        assert!(started.elapsed() >= Duration::from_secs(915));
        assert_eq!(result.output, b"{}");
        server.await.unwrap();
    }

    #[tokio::test]
    async fn catalog_version_exposes_requested_gpt_6_models_without_other_hidden_models() {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            let mut request = Vec::new();
            let mut buffer = [0_u8; 4096];
            while !request.windows(4).any(|window| window == b"\r\n\r\n") {
                let count = stream.read(&mut buffer).unwrap();
                if count == 0 {
                    break;
                }
                request.extend_from_slice(&buffer[..count]);
            }
            let request = String::from_utf8(request).unwrap();
            // Recent GPT-6 models are not offered to older catalog clients.
            let mut models = vec![
                json!({"slug":"gpt-reserve","visibility":"hide"}),
                json!({"slug":"gpt-5.6-sol","visibility":"list"}),
            ];
            if request.starts_with("GET /models?client_version=0.156.1 ") {
                models.push(json!({"slug":"gpt-6-astra","visibility":"list","supported_reasoning_levels":[{"effort":"low"}]}));
                models.push(json!({"slug":"gpt-6-sol","visibility":"hide","supported_reasoning_levels":[{"effort":"medium"}]}));
                models.push(json!({"slug":"gpt-6-luna","visibility":"list","supported_reasoning_levels":[{"effort":"high"}]}));
            }
            let body = json!({"models":models}).to_string();
            write!(stream, "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", body.len(), body).unwrap();
        });
        let mut provider = OpenAiSubscription::ephemeral().await.unwrap();
        provider.base_url = format!("http://{address}");
        let mut auth = test_session_credential().deserialize_auth().unwrap();
        auth.last_refresh = Some("2026-09-10T00:00:00Z".parse().unwrap());
        provider
            .set_session_credential(OpenAiSessionCredential::from_auth(&auth).unwrap())
            .await
            .unwrap();
        let models = provider.list_models().await.unwrap();
        server.join().unwrap();
        for model_id in ["gpt-6-astra", "gpt-6-sol", "gpt-6-luna"] {
            assert!(
                models
                    .iter()
                    .any(|model| model.identity.model_id == model_id)
            );
        }
        assert!(
            !models
                .iter()
                .any(|model| model.identity.model_id == "gpt-reserve")
        );
        provider.logout().await.unwrap();
    }

    #[test]
    fn empty_or_hidden_live_catalog_fails_closed() {
        for catalog in [
            ModelsResponse { models: Vec::new() },
            ModelsResponse {
                models: vec![RemoteModel {
                    slug: "hidden".to_owned(),
                    display_name: String::new(),
                    description: String::new(),
                    default_reasoning_effort: None,
                    supported_reasoning_efforts: Vec::new(),
                    priority: 0,
                    visibility: Some("hide".to_owned()),
                }],
            },
        ] {
            let error = resolve_models(catalog).unwrap_err();
            assert_eq!(error.code, ProviderErrorCode::InvalidResponse);
        }
    }

    #[test]
    fn catalog_does_not_invent_absent_models_or_reasoning_efforts() {
        let catalog: ModelsResponse = serde_json::from_value(json!({"models": [
            {"slug":"gpt-6-sol","visibility":"hide","default_reasoning_level":"high",
             "supported_reasoning_levels":[
                {"effort":"low","description":"Fast"},
                {"effort":"high","description":"Thorough"}
             ]},
            {"slug":"gpt-6-luna","visibility":"none","default_reasoning_level":"minimal",
             "supported_reasoning_levels":[{"effort":"minimal","description":"Brief"}]},
            {"slug":"gpt-internal","visibility":"hide"}
        ]}))
        .unwrap();
        let models = resolve_models(catalog).unwrap();
        assert_eq!(models.len(), 2);
        let sol = models
            .iter()
            .find(|model| model.identity.model_id == "gpt-6-sol")
            .unwrap();
        assert!(sol.supports_structured_output);
        assert_eq!(sol.default_reasoning_effort.as_deref(), Some("high"));
        assert_eq!(
            sol.supported_reasoning_efforts,
            ["low".to_owned(), "high".to_owned()]
        );
        assert_eq!(
            sol.reasoning_effort_descriptions
                .get("high")
                .map(String::as_str),
            Some("Thorough")
        );
        let luna = models
            .iter()
            .find(|model| model.identity.model_id == "gpt-6-luna")
            .unwrap();
        assert_eq!(luna.default_reasoning_effort.as_deref(), Some("minimal"));
        assert_eq!(luna.supported_reasoning_efforts, ["minimal".to_owned()]);
        assert!(
            !models
                .iter()
                .any(|model| model.identity.model_id == "gpt-6-astra")
        );
        assert!(
            !models
                .iter()
                .any(|model| model.identity.model_id == "gpt-internal")
        );
    }

    #[test]
    fn transient_token_refresh_error_remains_retryable_transport_failure() {
        let error = refresh_error(RefreshTokenError::Transient(std::io::Error::other(
            "temporary authority failure",
        )));
        assert_eq!(error.code, ProviderErrorCode::Transport);
        assert!(error.retryable);
        assert_eq!(
            error.detail,
            "OpenAI session refresh could not be completed"
        );
    }

    #[test]
    fn generation_api_errors_keep_safe_actionable_classification() {
        let cases = [
            (
                ApiError::Stream("secret streamed provider payload".to_owned()),
                ProviderErrorCode::Transport,
                true,
                "The OpenAI response stream could not be read. Completion and usage are unknown; review before retrying.",
            ),
            (
                ApiError::Retryable {
                    message: "secret retry payload".to_owned(),
                    delay: None,
                },
                ProviderErrorCode::Transport,
                true,
                "OpenAI temporarily could not complete the request",
            ),
            (
                ApiError::InvalidRequest {
                    message: "secret invalid request payload".to_owned(),
                },
                ProviderErrorCode::InvalidRequest,
                false,
                "OpenAI rejected the request as invalid",
            ),
            (
                ApiError::CyberPolicy {
                    message: "secret policy payload".to_owned(),
                },
                ProviderErrorCode::InvalidRequest,
                false,
                "OpenAI rejected the request under its safety policy",
            ),
            (
                ApiError::Transport(TransportError::Network(
                    "https://secret.example Authorization: bearer-secret".to_owned(),
                )),
                ProviderErrorCode::Transport,
                true,
                "OpenAI connection could not complete the request",
            ),
            (
                ApiError::Transport(TransportError::Build(
                    "secret serialized request".to_owned(),
                )),
                ProviderErrorCode::InvalidRequest,
                false,
                "OpenAI request could not be prepared",
            ),
        ];

        for (upstream, expected_code, expected_retryable, expected_detail) in cases {
            let error = map_api_error(upstream);
            assert_eq!(error.code, expected_code);
            assert_eq!(error.retryable, expected_retryable);
            assert_eq!(error.detail, expected_detail);
            assert!(!error.detail.contains("secret"));
        }
    }

    #[test]
    fn generation_body_has_no_tools_or_replay_contract() {
        let request = generation_request("gpt-test");
        let body = generation_body(&request);
        assert!(body.get("tools").is_none());
        assert!(body.get("tool_choice").is_none());
        assert!(body.get("previous_response_id").is_none());
        assert_eq!(body["text"]["format"]["strict"], true);
        assert_eq!(body["store"], false);
        assert!(body.get("max_output_tokens").is_none());
    }

    #[tokio::test]
    async fn subscription_token_ceiling_is_rejected_before_auth_or_dispatch() {
        let provider = OpenAiSubscription::ephemeral().await.unwrap();
        let mut request = generation_request("gpt-5.6-sol");
        request.max_output_tokens = Some(8192);
        let error = provider.generate_request(&request).await.unwrap_err();
        assert_eq!(error.code, ProviderErrorCode::InvalidRequest);
        assert_eq!(
            error.detail,
            "OpenAI subscription does not support an output-token ceiling; omit maxOutputTokens"
        );
        assert!(!error.retryable);
    }

    #[test]
    fn upstream_auth_types_do_not_cross_public_account() {
        let account = ProviderAccount {
            provider_id: OPENAI_SUBSCRIPTION_PROVIDER_ID.to_owned(),
            email: Some("person@example.test".to_owned()),
            account_id: None,
            plan: Some("plus".to_owned()),
        };
        let json = serde_json::to_value(account).unwrap();
        assert!(json.get("access_token").is_none());
        assert!(json.get("refresh_token").is_none());
    }

    #[test]
    fn session_credential_is_bounded_and_debug_is_redacted() {
        let credential = test_session_credential();
        let debug = format!("{credential:?}");
        assert_eq!(debug, "OpenAiSessionCredential([REDACTED])");
        assert!(!debug.contains("test-access-token"));

        let oversized = "x".repeat(MAX_SESSION_CREDENTIAL_BYTES + 1);
        assert!(OpenAiSessionCredential::try_from(oversized).is_err());
    }

    #[test]
    fn session_credential_rejects_invalid_auth_payload() {
        assert!(OpenAiSessionCredential::try_from("not json".to_owned()).is_err());
        assert!(OpenAiSessionCredential::try_from("{}".to_owned()).is_err());
    }

    #[tokio::test]
    async fn ephemeral_session_credential_roundtrip_stays_in_memory() {
        let credential =
            OpenAiSessionCredential::try_from(test_session_credential().into_host_credential())
                .unwrap();
        let provider = OpenAiSubscription::ephemeral().await.unwrap();
        let auth_home = provider.auth_home().to_path_buf();

        let account = provider.set_session_credential(credential).await.unwrap();

        assert_eq!(account.email.as_deref(), Some("person@example.test"));
        assert_eq!(account.account_id.as_deref(), Some("account-test"));
        assert_eq!(account.plan.as_deref(), Some("plus"));
        assert!(!auth_home.join("auth.json").exists());
        assert!(!auth_home.exists());
        assert!(
            load_auth_dot_json(
                &auth_home,
                AuthCredentialsStoreMode::Ephemeral,
                AuthKeyringBackendKind::default(),
            )
            .unwrap()
            .is_some()
        );
        assert!(provider.session_credential().is_ok());
        provider.logout().await.unwrap();
    }
}
