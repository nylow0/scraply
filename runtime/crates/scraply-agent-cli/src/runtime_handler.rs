use std::collections::{HashMap, HashSet, hash_map::Entry};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use scraply_agent_core::{
    CancellationToken, CoreError, Failure, FailureCode, GenerationProvider, GenerationRequest,
    MAX_TIMEOUT, OperationControl, PromptCompiler, ProviderRequest, ProviderResponse, Runtime,
};
use scraply_agent_providers::{
    ModelMetadata, ModelProvider, OPENAI_SUBSCRIPTION_PROVIDER_ID, OPENROUTER_PROVIDER_ID,
    OpenAiSessionCredential, OpenAiSubscription, OpenRouter, OpenRouterPkce, OpenRouterSession,
    PendingPkce, ProviderAccount, ProviderError, ProviderErrorCode,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::app_server::{GenerationEventSink, HandlerOutcome, RuntimeContext, RuntimeHandler};
use crate::protocol::{
    Capability, ErrorCode, GenerationStreamEvent, Operation, ProviderRequestId, RuntimeFailure,
};

const MAX_GENERATION_ID_BYTES: usize = 128;

macro_rules! decode_payload {
    ($payload:expr) => {
        match decode($payload) {
            Ok(payload) => payload,
            Err(outcome) => return outcome,
        }
    };
}

pub struct RuntimeHost {
    openai: OpenAiSubscription,
    openrouter: Option<OpenRouter>,
    pending_logins: HashMap<String, PendingLogin>,
    next_login_id: u64,
    pending_persistence: HashMap<String, PersistenceMarker>,
    next_rotation_id: u64,
    disabled_providers: HashSet<String>,
    generations: Arc<Mutex<HashMap<String, CancellationToken>>>,
}

trait RuntimeProviderContract: GenerationProvider + ModelProvider {}

impl<T: GenerationProvider + ModelProvider> RuntimeProviderContract for T {}

#[derive(Clone)]
struct RuntimeProvider(Arc<dyn RuntimeProviderContract>);

#[async_trait]
impl GenerationProvider for RuntimeProvider {
    fn provider_id(&self) -> &str {
        self.0.provider_id()
    }

    async fn generate(
        &self,
        request: ProviderRequest,
        control: &OperationControl,
    ) -> Result<ProviderResponse, CoreError> {
        self.0.generate(request, control).await
    }
}

#[async_trait]
impl ModelProvider for RuntimeProvider {
    async fn list_models(&self) -> Result<Vec<ModelMetadata>, ProviderError> {
        self.0.list_models().await
    }
}

enum PendingLogin {
    OpenAi(
        tokio::task::JoinHandle<Result<(ProviderAccount, OpenAiSessionCredential), ProviderError>>,
    ),
    Router(PendingPkce),
    RouterCompleting(tokio::task::JoinHandle<Result<OpenRouterSession, ProviderError>>),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PersistenceMarker {
    provider_id: String,
    session_id: String,
    rotation_id: String,
}

impl RuntimeHost {
    pub async fn new() -> Result<Self, ProviderError> {
        Ok(Self {
            openai: OpenAiSubscription::ephemeral().await?,
            openrouter: None,
            pending_logins: HashMap::new(),
            next_login_id: 1,
            pending_persistence: HashMap::new(),
            next_rotation_id: 1,
            disabled_providers: HashSet::new(),
            generations: Arc::new(Mutex::new(HashMap::new())),
        })
    }

    async fn account_list(&self) -> HandlerOutcome {
        let mut accounts = Vec::new();
        if !self
            .disabled_providers
            .contains(OPENAI_SUBSCRIPTION_PROVIDER_ID)
        {
            match self.openai.account().await {
                Ok(Some(account)) => accounts.push(account),
                Ok(None) => {}
                Err(error) => return provider_failure(error),
            }
        }
        if self.openrouter.is_some() && !self.disabled_providers.contains(OPENROUTER_PROVIDER_ID) {
            accounts.push(ProviderAccount {
                provider_id: OPENROUTER_PROVIDER_ID.into(),
                email: None,
                account_id: None,
                plan: None,
            });
        }
        HandlerOutcome::Success(json!({ "accounts": accounts }))
    }

    async fn login_start(&mut self, payload: Value) -> HandlerOutcome {
        let payload: LoginStartPayload = decode_payload!(payload);
        let login_id = format!("login-{}", self.next_login_id);
        self.next_login_id = self.next_login_id.saturating_add(1);
        let (pending, result) = match (payload.provider_id.as_str(), payload.method.as_str()) {
            (OPENAI_SUBSCRIPTION_PROVIDER_ID, "browser") => {
                let login = match self.openai.begin_browser_login(false) {
                    Ok(login) => login,
                    Err(error) => return provider_failure(error),
                };
                let result = json!({
                    "loginId": login_id,
                    "providerId": OPENAI_SUBSCRIPTION_PROVIDER_ID,
                    "method": "browser",
                    "authorizationUrl": login.authorization_url.as_str(),
                    "callbackPort": login.callback_port,
                });
                let provider = self.openai.clone();
                let completion = tokio::spawn(async move {
                    let account = login.complete().await?;
                    let credential = provider.session_credential()?;
                    Ok((account, credential))
                });
                (PendingLogin::OpenAi(completion), result)
            }
            (OPENAI_SUBSCRIPTION_PROVIDER_ID, "device") => {
                let login = match self.openai.begin_device_login().await {
                    Ok(login) => login,
                    Err(error) => return provider_failure(error),
                };
                let result = json!({
                    "loginId": login_id,
                    "providerId": OPENAI_SUBSCRIPTION_PROVIDER_ID,
                    "method": "device",
                    "verificationUrl": login.verification_url,
                    "userCode": login.user_code,
                });
                let provider = self.openai.clone();
                let completion = tokio::spawn(async move {
                    let account = login.complete().await?;
                    let credential = provider.session_credential()?;
                    Ok((account, credential))
                });
                (PendingLogin::OpenAi(completion), result)
            }
            (OPENROUTER_PROVIDER_ID, "pkce") => {
                let Some(callback_url) = payload.callback_url else {
                    return invalid_payload("OpenRouter PKCE requires callbackUrl");
                };
                let login = match OpenRouterPkce::default().begin(&callback_url) {
                    Ok(login) => login,
                    Err(error) => return provider_failure(error),
                };
                let result = json!({
                    "loginId": login_id,
                    "providerId": OPENROUTER_PROVIDER_ID,
                    "method": "pkce",
                    "authorizationUrl": login.authorization_url.as_str(),
                });
                (PendingLogin::Router(login), result)
            }
            _ => return invalid_payload("provider login method is unsupported"),
        };
        self.pending_logins.insert(login_id, pending);
        HandlerOutcome::Success(result)
    }

    async fn login_complete(&mut self, context: &RuntimeContext, payload: Value) -> HandlerOutcome {
        let payload: LoginCompletePayload = decode_payload!(payload);
        let Some(pending) = self.pending_logins.remove(&payload.login_id) else {
            return failure(ErrorCode::LoginNotFound, "login operation was not found");
        };
        match pending {
            PendingLogin::OpenAi(completion) if !completion.is_finished() => {
                self.pending_logins
                    .insert(payload.login_id, PendingLogin::OpenAi(completion));
                retryable_failure(
                    ErrorCode::OperationUnavailable,
                    "provider login is still pending",
                )
            }
            PendingLogin::OpenAi(completion) => match completion.await {
                Ok(Ok((account, credential))) => self.credential_result(
                    context,
                    OPENAI_SUBSCRIPTION_PROVIDER_ID,
                    account,
                    credential.into_host_credential(),
                ),
                Ok(Err(error)) => provider_failure(error),
                Err(_) => failure(ErrorCode::Cancelled, "provider login was cancelled"),
            },
            PendingLogin::Router(login) => {
                let Some(code) = payload.code else {
                    return invalid_payload("OpenRouter login completion requires code");
                };
                let completion = tokio::spawn(async move { login.complete(&code).await });
                self.pending_logins
                    .insert(payload.login_id, PendingLogin::RouterCompleting(completion));
                retryable_failure(
                    ErrorCode::OperationUnavailable,
                    "provider login is still pending",
                )
            }
            PendingLogin::RouterCompleting(completion) if !completion.is_finished() => {
                self.pending_logins
                    .insert(payload.login_id, PendingLogin::RouterCompleting(completion));
                retryable_failure(
                    ErrorCode::OperationUnavailable,
                    "provider login is still pending",
                )
            }
            PendingLogin::RouterCompleting(completion) => match completion.await {
                Ok(Ok(session)) => {
                    let credential = session.clone().into_host_credential();
                    self.openrouter = Some(OpenRouter::new(session));
                    self.credential_result(
                        context,
                        OPENROUTER_PROVIDER_ID,
                        ProviderAccount {
                            provider_id: OPENROUTER_PROVIDER_ID.into(),
                            email: None,
                            account_id: None,
                            plan: None,
                        },
                        credential,
                    )
                }
                Ok(Err(error)) => provider_failure(error),
                Err(_) => failure(ErrorCode::Cancelled, "provider login was cancelled"),
            },
        }
    }

    fn login_cancel(&mut self, payload: Value) -> HandlerOutcome {
        let payload: LoginIdPayload = decode_payload!(payload);
        let Some(pending) = self.pending_logins.remove(&payload.login_id) else {
            return failure(ErrorCode::LoginNotFound, "login operation was not found");
        };
        match &pending {
            PendingLogin::OpenAi(completion) => completion.abort(),
            PendingLogin::RouterCompleting(completion) => completion.abort(),
            PendingLogin::Router(_) => {}
        }
        drop(pending);
        HandlerOutcome::Success(json!({ "cancelled": true }))
    }

    async fn account_logout(&mut self, payload: Value) -> HandlerOutcome {
        let payload: ProviderPayload = decode_payload!(payload);
        self.pending_persistence.remove(&payload.provider_id);
        self.disabled_providers.insert(payload.provider_id.clone());
        for cancellation in self
            .generations
            .lock()
            .expect("generation map poisoned")
            .values()
        {
            cancellation.cancel();
        }
        match payload.provider_id.as_str() {
            OPENAI_SUBSCRIPTION_PROVIDER_ID => match self.openai.logout().await {
                Ok(logged_out) => HandlerOutcome::Success(json!({ "loggedOut": logged_out })),
                Err(error) => provider_failure(error),
            },
            OPENROUTER_PROVIDER_ID => {
                let logged_out = self.openrouter.take().is_some();
                HandlerOutcome::Success(json!({ "loggedOut": logged_out }))
            }
            _ => invalid_payload("provider is unsupported"),
        }
    }

    async fn credential_session_set(&mut self, payload: Value) -> HandlerOutcome {
        let payload: CredentialPayload = decode_payload!(payload);
        match payload.provider_id.as_str() {
            OPENAI_SUBSCRIPTION_PROVIDER_ID => {
                let credential = match OpenAiSessionCredential::try_from(payload.credential) {
                    Ok(credential) => credential,
                    Err(error) => return provider_failure(error),
                };
                match self.openai.set_session_credential(credential).await {
                    Ok(_) => {
                        self.pending_persistence
                            .remove(OPENAI_SUBSCRIPTION_PROVIDER_ID);
                        self.disabled_providers
                            .remove(OPENAI_SUBSCRIPTION_PROVIDER_ID);
                        HandlerOutcome::Success(
                            json!({ "providerId": OPENAI_SUBSCRIPTION_PROVIDER_ID }),
                        )
                    }
                    Err(error) => provider_failure(error),
                }
            }
            OPENROUTER_PROVIDER_ID => {
                let session = match OpenRouterSession::manual(payload.credential) {
                    Ok(session) => session,
                    Err(error) => return provider_failure(error),
                };
                self.openrouter = Some(OpenRouter::new(session));
                self.pending_persistence.remove(OPENROUTER_PROVIDER_ID);
                self.disabled_providers.remove(OPENROUTER_PROVIDER_ID);
                HandlerOutcome::Success(json!({ "providerId": OPENROUTER_PROVIDER_ID }))
            }
            _ => invalid_payload("provider does not accept session credentials"),
        }
    }

    async fn account_refresh(
        &mut self,
        context: &RuntimeContext,
        payload: Value,
    ) -> HandlerOutcome {
        let payload: ProviderPayload = decode_payload!(payload);
        if let Err(outcome) = self.provider(
            context,
            &payload.provider_id,
            "provider does not support credential refresh",
        ) {
            return outcome;
        }
        match payload.provider_id.as_str() {
            OPENAI_SUBSCRIPTION_PROVIDER_ID => match self.openai.refresh().await {
                Ok((account, credential)) => self.credential_result(
                    context,
                    OPENAI_SUBSCRIPTION_PROVIDER_ID,
                    account,
                    credential.into_host_credential(),
                ),
                Err(error) => {
                    self.disabled_providers
                        .insert(OPENAI_SUBSCRIPTION_PROVIDER_ID.to_owned());
                    provider_failure(error)
                }
            },
            OPENROUTER_PROVIDER_ID => {
                self.disabled_providers
                    .insert(OPENROUTER_PROVIDER_ID.to_owned());
                failure(
                    ErrorCode::ReconnectRequired,
                    "provider account must be reconnected before generation can continue",
                )
            }
            _ => invalid_payload("provider does not support credential refresh"),
        }
    }

    fn credential_result(
        &mut self,
        context: &RuntimeContext,
        provider_id: &str,
        account: ProviderAccount,
        credential: String,
    ) -> HandlerOutcome {
        self.disabled_providers.remove(provider_id);
        let mut result = json!({
            "account": account,
            "credential": credential,
        });
        if context
            .capabilities
            .contains(&Capability::CredentialPersistenceAck)
        {
            let marker = PersistenceMarker {
                provider_id: provider_id.to_owned(),
                session_id: context.session_id.clone(),
                rotation_id: format!("rotation-{}", self.next_rotation_id),
            };
            self.next_rotation_id = self.next_rotation_id.saturating_add(1);
            self.pending_persistence
                .insert(provider_id.to_owned(), marker.clone());
            result["persistence"] =
                serde_json::to_value(marker).expect("persistence marker serialization cannot fail");
        }
        HandlerOutcome::Success(result)
    }

    fn credential_session_persisted(
        &mut self,
        context: &RuntimeContext,
        payload: Value,
    ) -> HandlerOutcome {
        let marker: PersistenceMarker = decode_payload!(payload);
        if marker.session_id != context.session_id {
            return failure(
                ErrorCode::CredentialPersistenceRequired,
                "credential acknowledgement belongs to another runtime session",
            );
        }
        let Some(pending) = self.pending_persistence.get(&marker.provider_id) else {
            return failure(
                ErrorCode::CredentialPersistenceRequired,
                "provider has no pending credential rotation",
            );
        };
        if pending != &marker {
            return failure(
                ErrorCode::CredentialPersistenceRequired,
                "credential acknowledgement does not match the pending rotation",
            );
        }
        self.pending_persistence.remove(&marker.provider_id);
        HandlerOutcome::Success(json!({
            "providerId": marker.provider_id,
            "sessionId": marker.session_id,
            "rotationId": marker.rotation_id,
            "ready": true,
        }))
    }

    fn shutdown(&mut self) -> HandlerOutcome {
        for (_, pending) in self.pending_logins.drain() {
            match pending {
                PendingLogin::OpenAi(completion) => completion.abort(),
                PendingLogin::RouterCompleting(completion) => completion.abort(),
                PendingLogin::Router(_) => {}
            }
        }
        for cancellation in self
            .generations
            .lock()
            .expect("generation map poisoned")
            .values()
        {
            cancellation.cancel();
        }
        HandlerOutcome::Success(json!({}))
    }

    async fn model_list(&self, context: &RuntimeContext, payload: Value) -> HandlerOutcome {
        let payload: ProviderPayload = decode_payload!(payload);
        let provider = match self.provider(context, &payload.provider_id, "provider is unsupported")
        {
            Ok(provider) => provider,
            Err(outcome) => return outcome,
        };
        match provider.list_models().await {
            Ok(models) => HandlerOutcome::Success(json!({ "models": models })),
            Err(error) => provider_failure(error),
        }
    }

    fn provider(
        &self,
        context: &RuntimeContext,
        provider_id: &str,
        unsupported_detail: &'static str,
    ) -> Result<RuntimeProvider, HandlerOutcome> {
        if self.disabled_providers.contains(provider_id) {
            return Err(failure(
                ErrorCode::AuthenticationFailed,
                "provider account is logged out",
            ));
        }
        if context
            .capabilities
            .contains(&Capability::CredentialPersistenceAck)
            && self.pending_persistence.contains_key(provider_id)
        {
            return Err(failure(
                ErrorCode::CredentialPersistenceRequired,
                "provider credential must be persisted before use",
            ));
        }
        match provider_id {
            OPENAI_SUBSCRIPTION_PROVIDER_ID => Ok(RuntimeProvider(Arc::new(self.openai.clone()))),
            OPENROUTER_PROVIDER_ID => self
                .openrouter
                .clone()
                .map(|provider| RuntimeProvider(Arc::new(provider)))
                .ok_or_else(|| {
                    failure(
                        ErrorCode::AuthenticationFailed,
                        "OpenRouter credential session is not connected",
                    )
                }),
            _ => Err(invalid_payload(unsupported_detail)),
        }
    }

    fn generation_start(
        &mut self,
        context: &RuntimeContext,
        payload: Value,
        generation_events: Option<GenerationEventSink>,
    ) -> HandlerOutcome {
        let payload: GenerationStartPayload = decode_payload!(payload);
        if !valid_operation_id(&payload.generation_id) {
            return invalid_payload("generationId is invalid");
        }
        if payload.deadline_ms == 0 || Duration::from_millis(payload.deadline_ms) > MAX_TIMEOUT {
            return invalid_payload("deadlineMs is outside the supported range");
        }
        let Some(events) = generation_events else {
            return failure(
                ErrorCode::Internal,
                "generation event channel is unavailable",
            );
        };
        let cancellation = CancellationToken::new();
        {
            let mut generations = self.generations.lock().expect("generation map poisoned");
            if !generations.is_empty() {
                return failure(ErrorCode::RequestConflict, "generationId is already active");
            }
            let Entry::Vacant(entry) = generations.entry(payload.generation_id.clone()) else {
                return failure(ErrorCode::RequestConflict, "generationId is already active");
            };
            entry.insert(cancellation.clone());
        }
        let control =
            match OperationControl::new(Duration::from_millis(payload.deadline_ms), cancellation) {
                Ok(control) => control,
                Err(error) => {
                    self.generations
                        .lock()
                        .expect("generation map poisoned")
                        .remove(&payload.generation_id);
                    return core_failure(error);
                }
            };
        let generation_id = payload.generation_id;
        let request = payload.request;
        let provider = match self.provider(
            context,
            &request.model.provider_id,
            "qualified model provider is unsupported",
        ) {
            Ok(provider) => provider,
            Err(outcome) => {
                self.generations
                    .lock()
                    .expect("generation map poisoned")
                    .remove(&generation_id);
                return outcome;
            }
        };
        spawn_generation(
            provider,
            request,
            generation_id.clone(),
            control,
            events,
            Arc::clone(&self.generations),
        );
        HandlerOutcome::GenerationAccepted(json!({
            "generationId": generation_id,
            "prompt": PromptCompiler.identity(),
        }))
    }

    fn generation_cancel(&self, payload: Value) -> HandlerOutcome {
        let payload: GenerationIdPayload = decode_payload!(payload);
        let generations = self.generations.lock().expect("generation map poisoned");
        let Some(cancellation) = generations.get(&payload.generation_id) else {
            return failure(ErrorCode::GenerationNotFound, "generation was not found");
        };
        cancellation.cancel();
        HandlerOutcome::Success(json!({
            "generationId": payload.generation_id,
            "cancelled": true,
        }))
    }
}

#[async_trait]
impl RuntimeHandler for RuntimeHost {
    async fn handle(
        &mut self,
        context: &RuntimeContext,
        operation: Operation,
        payload: Value,
        generation_events: Option<GenerationEventSink>,
    ) -> HandlerOutcome {
        match operation {
            Operation::AccountList => self.account_list().await,
            Operation::AccountLoginStart => self.login_start(payload).await,
            Operation::AccountLoginComplete => self.login_complete(context, payload).await,
            Operation::AccountLoginCancel => self.login_cancel(payload),
            Operation::AccountLogout => self.account_logout(payload).await,
            Operation::AccountRefresh => self.account_refresh(context, payload).await,
            Operation::CredentialSessionSet => self.credential_session_set(payload).await,
            Operation::CredentialSessionPersisted => {
                self.credential_session_persisted(context, payload)
            }
            Operation::ModelList => self.model_list(context, payload).await,
            Operation::GenerationStart => {
                self.generation_start(context, payload, generation_events)
            }
            Operation::GenerationCancel => self.generation_cancel(payload),
            Operation::RuntimeShutdown => self.shutdown(),
            Operation::RuntimeInitialize => failure(
                ErrorCode::OperationUnavailable,
                "operation is handled by the runtime transport",
            ),
        }
    }
}

fn spawn_generation(
    provider: RuntimeProvider,
    request: GenerationRequest,
    generation_id: String,
    control: OperationControl,
    events: GenerationEventSink,
    generations: Arc<Mutex<HashMap<String, CancellationToken>>>,
) {
    tokio::spawn(async move {
        let _ = events
            .send(GenerationStreamEvent::Started {
                generation_id: generation_id.clone(),
            })
            .await;
        let result = Runtime::new(provider).generate(request, &control).await;
        generations
            .lock()
            .expect("generation map poisoned")
            .remove(&generation_id);
        let event = match result {
            Ok(result) => match serde_json::to_value(result) {
                Ok(result) => GenerationStreamEvent::Completed {
                    generation_id,
                    result,
                },
                Err(_) => GenerationStreamEvent::Failed {
                    generation_id,
                    error: RuntimeFailure::new(
                        ErrorCode::Internal,
                        false,
                        "generation result could not be encoded",
                    ),
                    attempts: Vec::new(),
                },
            },
            Err(error) if error.code() == FailureCode::Cancellation => {
                GenerationStreamEvent::Cancelled {
                    generation_id,
                    attempts: error.attempts().to_vec(),
                }
            }
            Err(error) => {
                let attempts = error.attempts().to_vec();
                GenerationStreamEvent::Failed {
                    generation_id,
                    error: runtime_failure_from_failure(error.failure()),
                    attempts,
                }
            }
        };
        let _ = events.send(event).await;
    });
}

fn decode<T>(payload: Value) -> Result<T, HandlerOutcome>
where
    T: for<'de> Deserialize<'de>,
{
    serde_json::from_value(payload).map_err(|_| invalid_payload("operation payload is invalid"))
}

fn valid_operation_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= MAX_GENERATION_ID_BYTES
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
}

fn invalid_payload(detail: &'static str) -> HandlerOutcome {
    failure(ErrorCode::InvalidPayload, detail)
}

fn failure(code: ErrorCode, detail: &'static str) -> HandlerOutcome {
    HandlerOutcome::Failure(RuntimeFailure::new(code, false, detail))
}

fn retryable_failure(code: ErrorCode, detail: &'static str) -> HandlerOutcome {
    HandlerOutcome::Failure(RuntimeFailure::new(code, true, detail))
}

fn provider_failure(error: ProviderError) -> HandlerOutcome {
    HandlerOutcome::Failure(runtime_failure_from_provider(error))
}

fn core_failure(error: CoreError) -> HandlerOutcome {
    HandlerOutcome::Failure(runtime_failure_from_core(error))
}

fn runtime_failure_from_provider(error: ProviderError) -> RuntimeFailure {
    let code = match error.code {
        ProviderErrorCode::Authentication => ErrorCode::AuthenticationFailed,
        ProviderErrorCode::ReconnectRequired => ErrorCode::ReconnectRequired,
        ProviderErrorCode::InvalidRequest => ErrorCode::InvalidPayload,
        ProviderErrorCode::UnavailableModel => ErrorCode::ProviderUnavailable,
        ProviderErrorCode::RateLimited => ErrorCode::RateLimited,
        ProviderErrorCode::Timeout => ErrorCode::DeadlineExceeded,
        ProviderErrorCode::Cancelled => ErrorCode::Cancelled,
        ProviderErrorCode::OutputLimit => ErrorCode::OutputInvalid,
        ProviderErrorCode::InvalidResponse => ErrorCode::OutputInvalid,
        ProviderErrorCode::Transport => ErrorCode::ProviderUnavailable,
    };
    let mut failure = RuntimeFailure::new(code, error.retryable, error.detail);
    if let Some(request_id) = error
        .request_id
        .and_then(|value| ProviderRequestId::new(value).ok())
    {
        failure = failure.with_provider_request_id(request_id);
    }
    failure
}

fn runtime_failure_from_core(error: CoreError) -> RuntimeFailure {
    runtime_failure_from_failure(error.failure())
}

fn runtime_failure_from_failure(failure: Failure) -> RuntimeFailure {
    let code = match failure.code {
        FailureCode::Authentication => ErrorCode::AuthenticationFailed,
        FailureCode::RateLimit => ErrorCode::RateLimited,
        FailureCode::Timeout => ErrorCode::DeadlineExceeded,
        FailureCode::Cancellation => ErrorCode::Cancelled,
        FailureCode::InvalidRequest | FailureCode::InputLimit | FailureCode::SchemaLimit => {
            ErrorCode::InvalidPayload
        }
        FailureCode::Schema => ErrorCode::SchemaInvalid,
        FailureCode::InvalidOutput | FailureCode::OutputLimit => ErrorCode::OutputInvalid,
        FailureCode::UnavailableModel | FailureCode::Transport => ErrorCode::ProviderUnavailable,
        FailureCode::Io | FailureCode::Unknown => ErrorCode::Internal,
    };
    let mut runtime = RuntimeFailure::new(code, failure.retryable, failure.detail);
    if let Some(request_id) = failure
        .provider_request_id
        .and_then(|value| ProviderRequestId::new(value).ok())
    {
        runtime = runtime.with_provider_request_id(request_id);
    }
    runtime
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ProviderPayload {
    provider_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CredentialPayload {
    provider_id: String,
    credential: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LoginStartPayload {
    provider_id: String,
    method: String,
    #[serde(default)]
    callback_url: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LoginCompletePayload {
    login_id: String,
    #[serde(default)]
    code: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LoginIdPayload {
    login_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct GenerationIdPayload {
    generation_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct GenerationStartPayload {
    generation_id: String,
    deadline_ms: u64,
    #[serde(flatten)]
    request: GenerationRequest,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn operation_ids_are_bounded_and_safe() {
        assert!(valid_operation_id("run-1.alpha"));
        assert!(!valid_operation_id(""));
        assert!(!valid_operation_id("secret\nnext"));
        assert!(!valid_operation_id(
            &"x".repeat(MAX_GENERATION_ID_BYTES + 1)
        ));
    }

    #[test]
    fn provider_error_mapping_preserves_only_safe_request_id() {
        let error = ProviderError {
            code: ProviderErrorCode::RateLimited,
            provider_id: OPENROUTER_PROVIDER_ID.into(),
            retryable: true,
            status: Some(429),
            request_id: Some("request-safe_1".into()),
            detail: "provider rate limited the request".into(),
        };
        let failure = runtime_failure_from_provider(error);
        assert_eq!(failure.code, ErrorCode::RateLimited);
        assert!(failure.retryable);
        assert_eq!(
            failure
                .provider_request_id
                .as_ref()
                .map(ProviderRequestId::as_str),
            Some("request-safe_1")
        );
    }
}
