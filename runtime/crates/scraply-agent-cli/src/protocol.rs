#![forbid(unsafe_code)]

//! Versioned, provider-neutral JSONL messages for the persistent Scraply runtime.
//!
//! The protocol owns framing, correlation, operation names, version negotiation,
//! and safe failures. Product request and result schemas cross the runtime seam as
//! JSON objects so the core crate remains their single source of truth.

use std::error::Error;
use std::fmt;
use std::str::FromStr;

use scraply_agent_core::{
    GenerationAttemptMetadata, MAX_INPUT_BYTES, MAX_OUTPUT_BYTES, MAX_SCHEMA_BYTES, PromptIdentity,
};
use serde::de::{self, Deserializer};
use serde::{Deserialize, Serialize, Serializer};
use serde_json::Value;

pub const CURRENT_PROTOCOL_VERSION: &str = "1.1";
/// Historical draft identifier retained only for rejection and drift tests.
#[cfg(test)]
pub const LEGACY_PROTOCOL_VERSION: &str = "1.0";
pub const SUPPORTED_PROTOCOL_VERSIONS: &[&str] = &[CURRENT_PROTOCOL_VERSION];
/// Maximum serialized request, response, or event bytes before the JSONL newline.
///
/// This is intentionally larger than content limits because JSON escaping can
/// expand otherwise valid input and output values.
pub const MAX_ENVELOPE_BYTES: usize = 16 * 1024 * 1024;
pub const DEFAULT_MAX_LINE_BYTES: usize = MAX_ENVELOPE_BYTES;
pub const MAX_REQUEST_ID_BYTES: usize = 128;
pub const MAX_PROTOCOL_VERSION_BYTES: usize = 32;
pub const MAX_ERROR_DETAIL_CHARS: usize = 512;
pub const MAX_PROVIDER_REQUEST_ID_BYTES: usize = 256;

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize)]
#[serde(untagged)]
pub enum RequestId {
    Integer(i64),
    String(String),
}

impl<'de> Deserialize<'de> for RequestId {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = Value::deserialize(deserializer)?;
        parse_request_id(value).map_err(de::Error::custom)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct ProtocolVersion(String);

impl ProtocolVersion {
    pub fn new(value: impl Into<String>) -> Result<Self, ProtocolError> {
        let value = value.into();
        let valid = !value.is_empty()
            && value.len() <= MAX_PROTOCOL_VERSION_BYTES
            && value
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-'));
        if !valid {
            return Err(ProtocolError::InvalidEnvelope);
        }
        Ok(Self(value))
    }

    pub fn current() -> Self {
        Self(CURRENT_PROTOCOL_VERSION.to_owned())
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for ProtocolVersion {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl Serialize for ProtocolVersion {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(&self.0)
    }
}

impl<'de> Deserialize<'de> for ProtocolVersion {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = String::deserialize(deserializer)?;
        Self::new(value).map_err(de::Error::custom)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum Operation {
    #[serde(rename = "runtime.initialize")]
    RuntimeInitialize,
    #[serde(rename = "account.list")]
    AccountList,
    #[serde(rename = "account.login.start")]
    AccountLoginStart,
    #[serde(rename = "account.login.complete")]
    AccountLoginComplete,
    #[serde(rename = "account.login.cancel")]
    AccountLoginCancel,
    #[serde(rename = "account.logout")]
    AccountLogout,
    #[serde(rename = "account.refresh")]
    AccountRefresh,
    #[serde(rename = "credential.session.set")]
    CredentialSessionSet,
    #[serde(rename = "credential.session.persisted")]
    CredentialSessionPersisted,
    #[serde(rename = "model.list")]
    ModelList,
    #[serde(rename = "generation.start")]
    GenerationStart,
    #[serde(rename = "generation.cancel")]
    GenerationCancel,
    #[serde(rename = "runtime.shutdown")]
    RuntimeShutdown,
}

impl Operation {
    pub const ALL: [Self; 13] = [
        Self::RuntimeInitialize,
        Self::AccountList,
        Self::AccountLoginStart,
        Self::AccountLoginComplete,
        Self::AccountLoginCancel,
        Self::AccountLogout,
        Self::AccountRefresh,
        Self::CredentialSessionSet,
        Self::CredentialSessionPersisted,
        Self::ModelList,
        Self::GenerationStart,
        Self::GenerationCancel,
        Self::RuntimeShutdown,
    ];

    pub const fn as_str(self) -> &'static str {
        match self {
            Self::RuntimeInitialize => "runtime.initialize",
            Self::AccountList => "account.list",
            Self::AccountLoginStart => "account.login.start",
            Self::AccountLoginComplete => "account.login.complete",
            Self::AccountLoginCancel => "account.login.cancel",
            Self::AccountLogout => "account.logout",
            Self::AccountRefresh => "account.refresh",
            Self::CredentialSessionSet => "credential.session.set",
            Self::CredentialSessionPersisted => "credential.session.persisted",
            Self::ModelList => "model.list",
            Self::GenerationStart => "generation.start",
            Self::GenerationCancel => "generation.cancel",
            Self::RuntimeShutdown => "runtime.shutdown",
        }
    }

    pub fn supported_in(self, version: &ProtocolVersion) -> bool {
        match self {
            Self::AccountRefresh | Self::CredentialSessionPersisted => {
                version.as_str() == CURRENT_PROTOCOL_VERSION
            }
            _ => true,
        }
    }
}

impl fmt::Display for Operation {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.as_str())
    }
}

impl FromStr for Operation {
    type Err = ProtocolError;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        Self::ALL
            .into_iter()
            .find(|operation| operation.as_str() == value)
            .ok_or(ProtocolError::UnsupportedOperation)
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RequestEnvelope {
    pub protocol_version: ProtocolVersion,
    pub id: RequestId,
    pub operation: Operation,
    pub payload: Value,
}

impl RequestEnvelope {
    pub fn new(
        protocol_version: ProtocolVersion,
        id: RequestId,
        operation: Operation,
        payload: Value,
    ) -> Result<Self, ProtocolError> {
        if !payload.is_object() {
            return Err(ProtocolError::InvalidPayload);
        }
        Ok(Self {
            protocol_version,
            id,
            operation,
            payload,
        })
    }

    pub fn payload_as<T>(&self) -> Result<T, ProtocolError>
    where
        T: for<'de> Deserialize<'de>,
    {
        serde_json::from_value(self.payload.clone()).map_err(|_| ProtocolError::InvalidPayload)
    }
}

impl<'de> Deserialize<'de> for RequestEnvelope {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = Value::deserialize(deserializer)?;
        parse_request_value(value).map_err(|error| de::Error::custom(error.kind.sanitized_detail()))
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ClientDescriptor {
    pub name: String,
    pub version: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InitializePayload {
    pub supported_protocol_versions: Vec<ProtocolVersion>,
    #[serde(default)]
    pub required_capabilities: Vec<Capability>,
    pub client: ClientDescriptor,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuntimeDescriptor {
    pub name: String,
    pub version: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InitializeResult {
    pub selected_protocol_version: ProtocolVersion,
    pub session_id: String,
    pub runtime: RuntimeDescriptor,
    pub prompt: PromptIdentity,
    pub operations: Vec<Operation>,
    pub capabilities: Vec<Capability>,
    pub limits: ProtocolLimits,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Capability {
    EnvelopeLimits,
    AccountRefresh,
    CredentialPersistenceAck,
    GenerationAttemptMetadata,
    ExactlyOneTerminal,
}

impl Capability {
    pub const V1_1: [Self; 5] = [
        Self::EnvelopeLimits,
        Self::AccountRefresh,
        Self::CredentialPersistenceAck,
        Self::GenerationAttemptMetadata,
        Self::ExactlyOneTerminal,
    ];
}

pub fn capabilities_for(version: &ProtocolVersion) -> Vec<Capability> {
    if version.as_str() == CURRENT_PROTOCOL_VERSION {
        Capability::V1_1.to_vec()
    } else {
        Vec::new()
    }
}

pub fn operations_for(version: &ProtocolVersion) -> Vec<Operation> {
    Operation::ALL
        .into_iter()
        .filter(|operation| operation.supported_in(version))
        .collect()
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProtocolLimits {
    pub max_envelope_bytes: usize,
    pub max_input_bytes: usize,
    pub max_schema_bytes: usize,
    pub max_output_bytes: usize,
}

impl ProtocolLimits {
    pub const fn current() -> Self {
        Self {
            max_envelope_bytes: MAX_ENVELOPE_BYTES,
            max_input_bytes: MAX_INPUT_BYTES,
            max_schema_bytes: MAX_SCHEMA_BYTES,
            max_output_bytes: MAX_OUTPUT_BYTES,
        }
    }
}

pub fn negotiate_protocol_version(
    client_versions: &[ProtocolVersion],
) -> Result<ProtocolVersion, ProtocolError> {
    SUPPORTED_PROTOCOL_VERSIONS
        .iter()
        .find(|supported| {
            client_versions
                .iter()
                .any(|client| client.as_str() == **supported)
        })
        .map(|version| ProtocolVersion((*version).to_owned()))
        .ok_or(ProtocolError::UnsupportedProtocolVersion)
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SuccessEnvelope {
    pub protocol_version: ProtocolVersion,
    pub id: RequestId,
    pub operation: Operation,
    pub result: Value,
}

impl SuccessEnvelope {
    pub fn from_serializable<T>(
        protocol_version: ProtocolVersion,
        id: RequestId,
        operation: Operation,
        result: T,
    ) -> Result<Self, ProtocolError>
    where
        T: Serialize,
    {
        Ok(Self {
            protocol_version,
            id,
            operation,
            result: serde_json::to_value(result).map_err(|_| ProtocolError::Internal)?,
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ErrorCode {
    MalformedJson,
    InvalidEnvelope,
    InvalidRequestId,
    UnsupportedProtocolVersion,
    UnsupportedOperation,
    InvalidPayload,
    LineTooLarge,
    NotInitialized,
    AlreadyInitialized,
    RequestConflict,
    OperationUnavailable,
    RequiredCapabilityUnavailable,
    CredentialPersistenceRequired,
    ReconnectRequired,
    GenerationNotFound,
    LoginNotFound,
    Cancelled,
    DeadlineExceeded,
    AuthenticationFailed,
    ProviderUnavailable,
    RateLimited,
    SchemaInvalid,
    OutputInvalid,
    Internal,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SanitizedDetail(String);

impl SanitizedDetail {
    pub fn new(detail: impl AsRef<str>) -> Self {
        let mut sanitized = String::new();
        for character in detail.as_ref().chars() {
            if sanitized.chars().count() >= MAX_ERROR_DETAIL_CHARS {
                break;
            }
            if character.is_control() {
                if !sanitized.ends_with(' ') {
                    sanitized.push(' ');
                }
            } else {
                sanitized.push(character);
            }
        }
        Self(sanitized.trim().to_owned())
    }

    #[cfg(test)]
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl Serialize for SanitizedDetail {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(&self.0)
    }
}

impl<'de> Deserialize<'de> for SanitizedDetail {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        Ok(Self::new(String::deserialize(deserializer)?))
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct ProviderRequestId(String);

impl ProviderRequestId {
    pub fn new(value: impl Into<String>) -> Result<Self, ProtocolError> {
        let value = value.into();
        let valid = !value.is_empty()
            && value.len() <= MAX_PROVIDER_REQUEST_ID_BYTES
            && value.bytes().all(|byte| byte.is_ascii_graphic());
        if !valid {
            return Err(ProtocolError::InvalidPayload);
        }
        Ok(Self(value))
    }

    #[cfg(test)]
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl Serialize for ProviderRequestId {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(&self.0)
    }
}

impl<'de> Deserialize<'de> for ProviderRequestId {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        Self::new(String::deserialize(deserializer)?).map_err(de::Error::custom)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuntimeFailure {
    pub code: ErrorCode,
    pub retryable: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_request_id: Option<ProviderRequestId>,
    pub detail: SanitizedDetail,
}

impl RuntimeFailure {
    pub fn new(code: ErrorCode, retryable: bool, safe_detail: impl AsRef<str>) -> Self {
        Self {
            code,
            retryable,
            provider_request_id: None,
            detail: SanitizedDetail::new(safe_detail),
        }
    }

    pub fn with_provider_request_id(mut self, provider_request_id: ProviderRequestId) -> Self {
        self.provider_request_id = Some(provider_request_id);
        self
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FailureEnvelope {
    pub protocol_version: ProtocolVersion,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<RequestId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub operation: Option<Operation>,
    pub error: RuntimeFailure,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind")]
pub enum GenerationStreamEvent {
    #[serde(rename = "generation.started", rename_all = "camelCase")]
    Started { generation_id: String },
    #[serde(rename = "generation.delta", rename_all = "camelCase")]
    Delta {
        generation_id: String,
        sequence: u64,
        delta: Value,
    },
    #[serde(rename = "generation.completed", rename_all = "camelCase")]
    Completed {
        generation_id: String,
        result: Value,
    },
    #[serde(rename = "generation.failed", rename_all = "camelCase")]
    Failed {
        generation_id: String,
        error: RuntimeFailure,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        attempts: Vec<GenerationAttemptMetadata>,
    },
    #[serde(rename = "generation.cancelled", rename_all = "camelCase")]
    Cancelled {
        generation_id: String,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        attempts: Vec<GenerationAttemptMetadata>,
    },
}

impl GenerationStreamEvent {
    #[cfg(test)]
    pub fn generation_id(&self) -> &str {
        match self {
            Self::Started { generation_id }
            | Self::Delta { generation_id, .. }
            | Self::Completed { generation_id, .. }
            | Self::Failed { generation_id, .. }
            | Self::Cancelled { generation_id, .. } => generation_id,
        }
    }

    pub const fn is_terminal(&self) -> bool {
        matches!(
            self,
            Self::Completed { .. } | Self::Failed { .. } | Self::Cancelled { .. }
        )
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EventEnvelope {
    pub protocol_version: ProtocolVersion,
    pub request_id: RequestId,
    pub operation: Operation,
    pub event: GenerationStreamEvent,
}

impl EventEnvelope {
    pub fn generation(
        protocol_version: ProtocolVersion,
        request_id: RequestId,
        event: GenerationStreamEvent,
    ) -> Self {
        Self {
            protocol_version,
            request_id,
            operation: Operation::GenerationStart,
            event,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum ServerEnvelope {
    Success(SuccessEnvelope),
    Failure(FailureEnvelope),
    Event(EventEnvelope),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProtocolError {
    MalformedJson,
    InvalidEnvelope,
    InvalidRequestId,
    UnsupportedProtocolVersion,
    UnsupportedOperation,
    InvalidPayload,
    LineTooLarge,
    Internal,
}

impl ProtocolError {
    pub const fn code(self) -> ErrorCode {
        match self {
            Self::MalformedJson => ErrorCode::MalformedJson,
            Self::InvalidEnvelope => ErrorCode::InvalidEnvelope,
            Self::InvalidRequestId => ErrorCode::InvalidRequestId,
            Self::UnsupportedProtocolVersion => ErrorCode::UnsupportedProtocolVersion,
            Self::UnsupportedOperation => ErrorCode::UnsupportedOperation,
            Self::InvalidPayload => ErrorCode::InvalidPayload,
            Self::LineTooLarge => ErrorCode::LineTooLarge,
            Self::Internal => ErrorCode::Internal,
        }
    }

    pub const fn sanitized_detail(self) -> &'static str {
        match self {
            Self::MalformedJson => "malformed JSON",
            Self::InvalidEnvelope => "invalid request envelope",
            Self::InvalidRequestId => "invalid request id",
            Self::UnsupportedProtocolVersion => "unsupported protocol version",
            Self::UnsupportedOperation => "unsupported operation",
            Self::InvalidPayload => "invalid operation payload",
            Self::LineTooLarge => "JSONL line exceeds the configured limit",
            Self::Internal => "internal runtime error",
        }
    }

    pub fn failure(self) -> RuntimeFailure {
        RuntimeFailure::new(self.code(), false, self.sanitized_detail())
    }
}

impl fmt::Display for ProtocolError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.sanitized_detail())
    }
}

impl Error for ProtocolError {}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DecodeError {
    pub id: Option<RequestId>,
    pub operation: Option<Operation>,
    pub kind: ProtocolError,
}

impl DecodeError {
    fn new(kind: ProtocolError, id: Option<RequestId>, operation: Option<Operation>) -> Self {
        Self {
            id,
            operation,
            kind,
        }
    }

    pub fn into_failure(self, protocol_version: ProtocolVersion) -> FailureEnvelope {
        FailureEnvelope {
            protocol_version,
            id: self.id,
            operation: self.operation,
            error: self.kind.failure(),
        }
    }
}

impl fmt::Display for DecodeError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.kind.fmt(formatter)
    }
}

impl Error for DecodeError {}

#[cfg(test)]
pub fn parse_request_line(bytes: &[u8]) -> Result<RequestEnvelope, DecodeError> {
    decode_request_line(bytes, DEFAULT_MAX_LINE_BYTES)
}

pub fn decode_request_line(
    line: &[u8],
    max_line_bytes: usize,
) -> Result<RequestEnvelope, DecodeError> {
    if max_line_bytes == 0 {
        return Err(DecodeError::new(ProtocolError::InvalidEnvelope, None, None));
    }
    let line = line.strip_suffix(b"\n").unwrap_or(line);
    let line = line.strip_suffix(b"\r").unwrap_or(line);
    if line.len() > max_line_bytes {
        return Err(DecodeError::new(ProtocolError::LineTooLarge, None, None));
    }
    if line.is_empty() {
        return Err(DecodeError::new(ProtocolError::MalformedJson, None, None));
    }
    let value = serde_json::from_slice(line)
        .map_err(|_| DecodeError::new(ProtocolError::MalformedJson, None, None))?;
    parse_request_value(value)
}

pub fn parse_request_value(value: Value) -> Result<RequestEnvelope, DecodeError> {
    let mut object = match value {
        Value::Object(object) => object,
        _ => {
            return Err(DecodeError::new(ProtocolError::InvalidEnvelope, None, None));
        }
    };

    let recovered_id = object
        .get("id")
        .cloned()
        .and_then(|id| parse_request_id(id).ok());
    let recovered_operation = object
        .get("operation")
        .and_then(Value::as_str)
        .and_then(|operation| Operation::from_str(operation).ok());

    if object.keys().any(|key| {
        key != "protocolVersion" && key != "id" && key != "operation" && key != "payload"
    }) {
        return Err(DecodeError::new(
            ProtocolError::InvalidEnvelope,
            recovered_id,
            recovered_operation,
        ));
    }

    let protocol_version = object
        .remove("protocolVersion")
        .ok_or_else(|| {
            DecodeError::new(
                ProtocolError::InvalidEnvelope,
                recovered_id.clone(),
                recovered_operation,
            )
        })
        .and_then(|value| {
            serde_json::from_value(value).map_err(|_| {
                DecodeError::new(
                    ProtocolError::InvalidEnvelope,
                    recovered_id.clone(),
                    recovered_operation,
                )
            })
        })?;

    let id = object
        .remove("id")
        .ok_or_else(|| DecodeError::new(ProtocolError::InvalidRequestId, None, recovered_operation))
        .and_then(|value| {
            parse_request_id(value)
                .map_err(|kind| DecodeError::new(kind, None, recovered_operation))
        })?;

    let operation = object
        .remove("operation")
        .and_then(|value| value.as_str().map(str::to_owned))
        .ok_or_else(|| DecodeError::new(ProtocolError::InvalidEnvelope, Some(id.clone()), None))
        .and_then(|value| {
            Operation::from_str(&value)
                .map_err(|kind| DecodeError::new(kind, Some(id.clone()), None))
        })?;

    let payload = object.remove("payload").ok_or_else(|| {
        DecodeError::new(
            ProtocolError::InvalidPayload,
            Some(id.clone()),
            Some(operation),
        )
    })?;
    RequestEnvelope::new(protocol_version, id.clone(), operation, payload)
        .map_err(|kind| DecodeError::new(kind, Some(id), Some(operation)))
}

fn parse_request_id(value: Value) -> Result<RequestId, ProtocolError> {
    match value {
        Value::Number(number) => number
            .as_i64()
            .map(RequestId::Integer)
            .ok_or(ProtocolError::InvalidRequestId),
        Value::String(value) if !value.is_empty() && value.len() <= MAX_REQUEST_ID_BYTES => {
            Ok(RequestId::String(value))
        }
        _ => Err(ProtocolError::InvalidRequestId),
    }
}

#[derive(Debug, Clone)]
pub struct LineFramer {
    buffer: Vec<u8>,
    max_line_bytes: usize,
    discarding_oversized_line: bool,
}

impl LineFramer {
    pub fn new(max_line_bytes: usize) -> Result<Self, ProtocolError> {
        if max_line_bytes == 0 {
            return Err(ProtocolError::InvalidEnvelope);
        }
        Ok(Self {
            buffer: Vec::new(),
            max_line_bytes,
            discarding_oversized_line: false,
        })
    }

    pub fn push(&mut self, chunk: &[u8]) -> Vec<Result<RequestEnvelope, DecodeError>> {
        let mut frames = Vec::new();
        for &byte in chunk {
            if self.discarding_oversized_line {
                if byte == b'\n' {
                    self.discarding_oversized_line = false;
                }
                continue;
            }

            if byte == b'\n' {
                let line = std::mem::take(&mut self.buffer);
                frames.push(decode_request_line(&line, self.max_line_bytes));
                continue;
            }

            if self.buffer.len() == self.max_line_bytes {
                self.buffer.clear();
                self.discarding_oversized_line = true;
                frames.push(Err(DecodeError::new(
                    ProtocolError::LineTooLarge,
                    None,
                    None,
                )));
                continue;
            }
            self.buffer.push(byte);
        }
        frames
    }

    pub fn finish(&mut self) -> Option<Result<RequestEnvelope, DecodeError>> {
        if self.discarding_oversized_line {
            self.discarding_oversized_line = false;
            return None;
        }
        if self.buffer.is_empty() {
            return None;
        }
        let line = std::mem::take(&mut self.buffer);
        Some(decode_request_line(&line, self.max_line_bytes))
    }
}

impl Default for LineFramer {
    fn default() -> Self {
        Self {
            buffer: Vec::new(),
            max_line_bytes: DEFAULT_MAX_LINE_BYTES,
            discarding_oversized_line: false,
        }
    }
}

pub fn encode_json_line<T>(value: &T, max_line_bytes: usize) -> Result<Vec<u8>, ProtocolError>
where
    T: Serialize,
{
    if max_line_bytes == 0 {
        return Err(ProtocolError::InvalidEnvelope);
    }
    let mut bytes = serde_json::to_vec(value).map_err(|_| ProtocolError::Internal)?;
    if bytes.len() > max_line_bytes {
        return Err(ProtocolError::LineTooLarge);
    }
    bytes.push(b'\n');
    Ok(bytes)
}

#[cfg(test)]
pub fn decode_json_line<T>(line: &[u8], max_line_bytes: usize) -> Result<T, ProtocolError>
where
    T: for<'de> Deserialize<'de>,
{
    let line = line.strip_suffix(b"\n").unwrap_or(line);
    let line = line.strip_suffix(b"\r").unwrap_or(line);
    if line.is_empty() {
        return Err(ProtocolError::MalformedJson);
    }
    if line.len() > max_line_bytes {
        return Err(ProtocolError::LineTooLarge);
    }
    serde_json::from_slice(line).map_err(|_| ProtocolError::MalformedJson)
}

#[cfg(test)]
#[path = "protocol/tests.rs"]
mod tests;
