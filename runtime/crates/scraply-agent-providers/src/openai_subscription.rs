use crate::{
    ModelMetadata, ModelProvider, ProviderAccount, ProviderError, ProviderErrorCode,
    generation::{PromptRole, controlled, prompt_messages, validate_model},
};
use async_trait::async_trait;
use codex_api::{
    ApiError, AuthProvider, Compression, Provider, ReqwestTransport, ResponseEvent,
    ResponsesClient, RetryConfig, TransportError,
};
use codex_login::{
    AuthCredentialsStoreMode, AuthDotJson, AuthKeyringBackendKind, AuthManager, CodexAuth,
    DeviceCode, LoginServer, ServerOptions, complete_device_code_login, load_auth_dot_json,
    oauth_client_id, request_device_code, run_login_server, save_auth,
};
use futures_util::StreamExt;
use http::{HeaderMap, HeaderValue, header::AUTHORIZATION};
use scraply_agent_core::{
    CoreError, FinishReason, GenerationProvider, MAX_OUTPUT_BYTES, OperationControl,
    ProviderRequest, ProviderResponse, QualifiedModel, TokenUsage,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::sync::atomic::{AtomicU64, Ordering};
use std::{collections::BTreeMap, path::PathBuf, sync::Arc, time::Duration};

pub const OPENAI_SUBSCRIPTION_PROVIDER_ID: &str = "openai-subscription";
const CHATGPT_CODEX_BASE_URL: &str = "https://chatgpt.com/backend-api/codex";
const ACCOUNT_ID_HEADER: &str = "chatgpt-account-id";
const PINNED_CLIENT_VERSION: &str = "0.144.4";
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
    auth_credentials_store_mode: AuthCredentialsStoreMode,
    base_url: String,
    client: reqwest::Client,
    #[cfg(debug_assertions)]
    fixture: Option<FixtureData>,
}

impl OpenAiSubscription {
    pub async fn persistent(auth_home: PathBuf) -> Result<Self, ProviderError> {
        Self::with_storage(auth_home, AuthCredentialsStoreMode::Auto).await
    }

    pub async fn ephemeral() -> Result<Self, ProviderError> {
        Self::with_storage(ephemeral_auth_home(), AuthCredentialsStoreMode::Ephemeral).await
    }

    async fn with_storage(
        auth_home: PathBuf,
        auth_credentials_store_mode: AuthCredentialsStoreMode,
    ) -> Result<Self, ProviderError> {
        let auth = Arc::new(
            AuthManager::new(
                auth_home.clone(),
                false,
                auth_credentials_store_mode,
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
            auth_credentials_store_mode,
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
        if self.auth_credentials_store_mode != AuthCredentialsStoreMode::Ephemeral {
            return Err(reconnect_required());
        }
        let Some(auth) = self.current_auth().await else {
            return Err(not_logged_in());
        };
        validate_subscription_auth(&auth)?;
        self.auth
            .refresh_token_from_authority()
            .await
            .map_err(|_| reconnect_required())?;
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
        if self.auth_credentials_store_mode != AuthCredentialsStoreMode::Ephemeral {
            return Err(invalid_session_credential());
        }
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
        if self.auth_credentials_store_mode != AuthCredentialsStoreMode::Ephemeral {
            return Err(ProviderError::new(
                OPENAI_SUBSCRIPTION_PROVIDER_ID,
                ProviderErrorCode::InvalidRequest,
                false,
                "persistent OpenAI adapters do not accept session credentials",
            ));
        }
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
            self.auth_credentials_store_mode,
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
        if self.auth_credentials_store_mode == AuthCredentialsStoreMode::Ephemeral {
            self.auth.auth_cached()
        } else {
            self.auth.auth().await
        }
    }

    async fn request_models(&self, auth: &CodexAuth) -> Result<reqwest::Response, ProviderError> {
        self.client
            .get(format!("{}/models", self.base_url.trim_end_matches('/')))
            .query(&[("client_version", PINNED_CLIENT_VERSION)])
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
            stream_idle_timeout: Duration::from_secs(120),
        };
        let auth = Arc::new(SubscriptionHeaders {
            headers: auth_headers(&auth)?,
        });
        let client =
            ResponsesClient::new(ReqwestTransport::new(self.client.clone()), provider, auth);
        let mut stream = client
            .stream(
                generation_body(request),
                HeaderMap::new(),
                Compression::None,
                None,
            )
            .await
            .map_err(map_api_error)?;
        let mut output = String::new();
        let mut response_id = None;
        let mut usage = None;
        while let Some(event) = stream.next().await {
            match event.map_err(map_api_error)? {
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
            ProviderError::new(
                OPENAI_SUBSCRIPTION_PROVIDER_ID,
                ProviderErrorCode::InvalidResponse,
                true,
                "OpenAI response ended before completion",
            )
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

pub fn resolve_subscription_auth_home() -> Result<PathBuf, ProviderError> {
    codex_utils_home_dir::find_codex_home()
        .map(Into::into)
        .map_err(|_| {
            ProviderError::new(
                OPENAI_SUBSCRIPTION_PROVIDER_ID,
                ProviderErrorCode::Transport,
                false,
                "could not resolve the OpenAI subscription credential directory",
            )
        })
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
        .filter(|model| !matches!(model.visibility.as_deref(), Some("hide" | "none")))
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
        _ => ProviderError::new(
            OPENAI_SUBSCRIPTION_PROVIDER_ID,
            ProviderErrorCode::Transport,
            true,
            "OpenAI subscription request failed",
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
