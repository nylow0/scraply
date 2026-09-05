use std::fmt;

use scraply_agent_providers::{ModelProvider, OpenAiSubscription};
use serde_json::{Value, json};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use crate::account;

const MAX_LINE_BYTES: usize = 1024 * 1024;

#[derive(Debug)]
pub enum LegacyServerError {
    Provider,
    Input,
    Output,
}

impl LegacyServerError {
    pub const fn sanitized_message(&self) -> &'static str {
        match self {
            Self::Provider => "OpenAI compatibility provider failed",
            Self::Input => "compatibility input failed",
            Self::Output => "compatibility output failed",
        }
    }
}

impl fmt::Display for LegacyServerError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.sanitized_message())
    }
}

pub async fn run() -> Result<(), LegacyServerError> {
    let provider = account::connect()
        .await
        .map_err(|_| LegacyServerError::Provider)?;
    run_with_io(tokio::io::stdin(), tokio::io::stdout(), &provider).await
}

async fn run_with_io<R, W>(
    mut input: R,
    mut output: W,
    provider: &OpenAiSubscription,
) -> Result<(), LegacyServerError>
where
    R: tokio::io::AsyncRead + Unpin,
    W: tokio::io::AsyncWrite + Unpin,
{
    let mut initialized = false;
    let mut read_buffer = [0; 8192];
    let mut line = Vec::new();
    let mut oversized = false;
    loop {
        let read = input
            .read(&mut read_buffer)
            .await
            .map_err(|_| LegacyServerError::Input)?;
        if read == 0 {
            break;
        }
        for &byte in &read_buffer[..read] {
            if byte == b'\n' {
                if oversized {
                    write_error(
                        &mut output,
                        Value::Null,
                        -32600,
                        "request line is too large",
                    )
                    .await?;
                } else if !line.is_empty() {
                    handle_line(&line, &mut initialized, provider, &mut output).await?;
                }
                line.clear();
                oversized = false;
            } else if !oversized && line.len() == MAX_LINE_BYTES {
                line.clear();
                oversized = true;
            } else if !oversized {
                line.push(byte);
            }
        }
    }
    if !oversized && !line.is_empty() {
        handle_line(&line, &mut initialized, provider, &mut output).await?;
    }
    Ok(())
}

async fn handle_line<W>(
    line: &[u8],
    initialized: &mut bool,
    provider: &OpenAiSubscription,
    output: &mut W,
) -> Result<(), LegacyServerError>
where
    W: tokio::io::AsyncWrite + Unpin,
{
    let line = line.strip_suffix(b"\r").unwrap_or(line);
    let message = match serde_json::from_slice(line) {
        Ok(message) => message,
        Err(_) => return write_error(output, Value::Null, -32700, "invalid JSON").await,
    };
    handle_message(message, initialized, provider, output).await
}

async fn handle_message<W>(
    message: Value,
    initialized: &mut bool,
    provider: &OpenAiSubscription,
    output: &mut W,
) -> Result<(), LegacyServerError>
where
    W: tokio::io::AsyncWrite + Unpin,
{
    let Some(object) = message.as_object() else {
        return write_error(output, Value::Null, -32600, "invalid request").await;
    };
    let Some(method) = object.get("method").and_then(Value::as_str) else {
        return write_error(output, request_id(object), -32600, "invalid request").await;
    };
    let id = request_id(object);
    match method {
        "initialize" if !*initialized && !id.is_null() => {
            *initialized = true;
            write_result(
                output,
                id,
                json!({ "userAgent": format!("scraply-agent/{}", env!("CARGO_PKG_VERSION")) }),
            )
            .await
        }
        "initialized" if *initialized && id.is_null() => Ok(()),
        "account/read" if *initialized && !id.is_null() => {
            let refresh = object
                .get("params")
                .and_then(|params| params.get("refreshToken"))
                .and_then(Value::as_bool)
                .unwrap_or(false);
            if refresh && provider.refresh().await.is_err() {
                return write_error(output, id, -32603, "account refresh failed").await;
            }
            let account = match provider.account().await {
                Ok(account) => account,
                Err(_) => return write_error(output, id, -32603, "account read failed").await,
            };
            let requires_openai_auth = account.is_none();
            let account = account.map(|account| {
                json!({
                    "type": "chatgpt",
                    "email": account.email,
                    "planType": account.plan,
                    "usesCodexManagedCredentials": true,
                })
            });
            write_result(
                output,
                id,
                json!({
                    "account": account,
                    "requiresOpenaiAuth": requires_openai_auth,
                }),
            )
            .await
        }
        "model/list" if *initialized && !id.is_null() => {
            let params = object.get("params").and_then(Value::as_object);
            if params
                .and_then(|params| params.get("includeHidden"))
                .and_then(Value::as_bool)
                == Some(true)
            {
                return write_error(output, id, -32602, "invalid params").await;
            }
            let offset = params
                .and_then(|params| params.get("cursor"))
                .and_then(Value::as_str)
                .map(parse_cursor)
                .transpose();
            let offset = match offset {
                Ok(Some(offset)) => offset,
                Err(()) => return write_error(output, id, -32602, "invalid params").await,
                Ok(None) => 0,
            };
            let limit = params
                .and_then(|params| params.get("limit"))
                .and_then(Value::as_u64)
                .unwrap_or(100)
                .clamp(1, 100) as usize;
            let models = match provider.list_models().await {
                Ok(models) => models,
                Err(_) => return write_error(output, id, -32603, "model list failed").await,
            };
            if offset > models.len() {
                return write_error(output, id, -32602, "invalid params").await;
            }
            let end = offset.saturating_add(limit).min(models.len());
            let data: Vec<Value> = models[offset..end]
                .iter()
                .enumerate()
                .map(|(index, model)| {
                    let efforts: Vec<Value> = model
                        .supported_reasoning_efforts
                        .iter()
                        .map(|effort| {
                            json!({
                                "reasoningEffort": effort,
                                "description": model
                                    .reasoning_effort_descriptions
                                    .get(effort)
                                    .map(String::as_str)
                                    .unwrap_or(""),
                            })
                        })
                        .collect();
                    json!({
                        "id": model.identity.model_id,
                        "displayName": model.display_name,
                        "description": model.description,
                        "supportedReasoningEfforts": efforts,
                        "defaultReasoningEffort": model.default_reasoning_effort,
                        "hidden": false,
                        "isDefault": offset + index == 0,
                    })
                })
                .collect();
            let next_cursor = (end < models.len()).then(|| format!("offset:{end}"));
            write_result(
                output,
                id,
                json!({ "data": data, "nextCursor": next_cursor }),
            )
            .await
        }
        _ if id.is_null() => Ok(()),
        _ => write_error(output, id, -32600, "invalid request").await,
    }
}

fn request_id(object: &serde_json::Map<String, Value>) -> Value {
    match object.get("id") {
        Some(Value::String(value)) if !value.is_empty() => Value::String(value.clone()),
        Some(Value::Number(value)) if value.is_i64() || value.is_u64() => {
            Value::Number(value.clone())
        }
        _ => Value::Null,
    }
}

fn parse_cursor(value: &str) -> Result<usize, ()> {
    value
        .strip_prefix("offset:")
        .ok_or(())?
        .parse()
        .map_err(|_| ())
}

async fn write_result<W>(output: &mut W, id: Value, result: Value) -> Result<(), LegacyServerError>
where
    W: tokio::io::AsyncWrite + Unpin,
{
    write_json(output, &json!({ "id": id, "result": result })).await
}

async fn write_error<W>(
    output: &mut W,
    id: Value,
    code: i32,
    message: &'static str,
) -> Result<(), LegacyServerError>
where
    W: tokio::io::AsyncWrite + Unpin,
{
    write_json(
        output,
        &json!({ "id": id, "error": { "code": code, "message": message } }),
    )
    .await
}

async fn write_json<W>(output: &mut W, value: &Value) -> Result<(), LegacyServerError>
where
    W: tokio::io::AsyncWrite + Unpin,
{
    let mut bytes = serde_json::to_vec(value).map_err(|_| LegacyServerError::Output)?;
    if bytes.len() >= MAX_LINE_BYTES {
        return Err(LegacyServerError::Output);
    }
    bytes.push(b'\n');
    output
        .write_all(&bytes)
        .await
        .map_err(|_| LegacyServerError::Output)?;
    output.flush().await.map_err(|_| LegacyServerError::Output)
}
