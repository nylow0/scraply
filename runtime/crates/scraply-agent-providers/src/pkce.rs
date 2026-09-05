use crate::{OpenRouterSession, ProviderError, ProviderErrorCode};
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use reqwest::Url;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

const OPENROUTER_PROVIDER_ID: &str = "openrouter";
const AUTH_URL: &str = "https://openrouter.ai/auth";
const EXCHANGE_URL: &str = "https://openrouter.ai/api/v1/auth/keys";
const VERIFIER_BYTES: usize = 32;

/// Starts OpenRouter PKCE without owning a browser or callback listener.
///
/// The host opens `PendingPkce::authorization_url` and owns the callback. It
/// then passes the returned code to `complete`. The verifier never leaves this
/// state object except in the TLS-protected exchange request.
#[derive(Clone)]
pub struct OpenRouterPkce {
    client: reqwest::Client,
    auth_url: Url,
    exchange_url: Url,
}

impl std::fmt::Debug for OpenRouterPkce {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("OpenRouterPkce")
            .field("auth_url", &self.auth_url)
            .field("exchange_url", &self.exchange_url)
            .finish_non_exhaustive()
    }
}

impl Default for OpenRouterPkce {
    fn default() -> Self {
        Self {
            client: reqwest::Client::new(),
            auth_url: Url::parse(AUTH_URL).expect("OpenRouter auth URL must be valid"),
            exchange_url: Url::parse(EXCHANGE_URL).expect("OpenRouter exchange URL must be valid"),
        }
    }
}

impl OpenRouterPkce {
    pub fn begin(&self, callback_url: &str) -> Result<PendingPkce, ProviderError> {
        let callback_url = validate_callback_url(callback_url)?;
        let mut verifier_bytes = [0_u8; VERIFIER_BYTES];
        getrandom::fill(&mut verifier_bytes).map_err(|_| {
            ProviderError::new(
                OPENROUTER_PROVIDER_ID,
                ProviderErrorCode::Transport,
                false,
                "could not create PKCE verifier",
            )
        })?;
        let verifier = URL_SAFE_NO_PAD.encode(verifier_bytes);
        let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
        let mut authorization_url = self.auth_url.clone();
        authorization_url
            .query_pairs_mut()
            .append_pair("callback_url", callback_url.as_str())
            .append_pair("code_challenge", &challenge)
            .append_pair("code_challenge_method", "S256");
        Ok(PendingPkce {
            authorization_url,
            verifier,
            exchange_url: self.exchange_url.clone(),
            client: self.client.clone(),
        })
    }
}

pub struct PendingPkce {
    pub authorization_url: Url,
    verifier: String,
    exchange_url: Url,
    client: reqwest::Client,
}

impl std::fmt::Debug for PendingPkce {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("PendingPkce")
            .field("authorization_url", &self.authorization_url)
            .field("verifier", &"[REDACTED]")
            .finish_non_exhaustive()
    }
}

impl PendingPkce {
    pub async fn complete(self, code: &str) -> Result<OpenRouterSession, ProviderError> {
        if code.is_empty() || code.len() > 4 * 1024 {
            return Err(ProviderError::new(
                OPENROUTER_PROVIDER_ID,
                ProviderErrorCode::InvalidRequest,
                false,
                "OpenRouter authorization code is invalid",
            ));
        }
        let response = self
            .client
            .post(self.exchange_url)
            .json(&ExchangeRequest {
                code,
                code_verifier: &self.verifier,
                code_challenge_method: "S256",
            })
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
        let exchange = response.json::<ExchangeResponse>().await.map_err(|_| {
            ProviderError::new(
                OPENROUTER_PROVIDER_ID,
                ProviderErrorCode::InvalidResponse,
                false,
                "OpenRouter returned an invalid PKCE exchange response",
            )
        })?;
        OpenRouterSession::manual(exchange.key)
    }
}

#[derive(Serialize)]
struct ExchangeRequest<'a> {
    code: &'a str,
    code_verifier: &'a str,
    code_challenge_method: &'static str,
}

#[derive(Deserialize)]
struct ExchangeResponse {
    key: String,
}

fn validate_callback_url(value: &str) -> Result<Url, ProviderError> {
    let url = Url::parse(value).map_err(|_| invalid_callback())?;
    let is_https = url.scheme() == "https";
    let is_loopback_http = url.scheme() == "http"
        && matches!(
            url.host_str(),
            Some("localhost" | "127.0.0.1" | "::1" | "[::1]")
        );
    if (!is_https && !is_loopback_http)
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
    {
        return Err(invalid_callback());
    }
    Ok(url)
}

fn invalid_callback() -> ProviderError {
    ProviderError::new(
        OPENROUTER_PROVIDER_ID,
        ProviderErrorCode::InvalidRequest,
        false,
        "PKCE callback must be HTTPS or an HTTP loopback URL",
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        io::{Read, Write},
        net::TcpListener,
        sync::mpsc,
        thread,
        time::Duration,
    };

    #[test]
    fn begin_builds_s256_authorization_without_exposing_verifier() {
        let pending = OpenRouterPkce::default()
            .begin("http://127.0.0.1:43123/callback")
            .unwrap();
        let query = pending
            .authorization_url
            .query_pairs()
            .collect::<std::collections::BTreeMap<_, _>>();
        assert_eq!(
            query.get("callback_url").map(|value| value.as_ref()),
            Some("http://127.0.0.1:43123/callback")
        );
        assert_eq!(
            query
                .get("code_challenge_method")
                .map(|value| value.as_ref()),
            Some("S256")
        );
        assert!(
            query
                .get("code_challenge")
                .is_some_and(|value| !value.is_empty())
        );
        let debug = format!("{pending:?}");
        assert!(!debug.contains(&pending.verifier));
        assert!(debug.contains("[REDACTED]"));
    }

    #[test]
    fn callback_validation_rejects_remote_plain_http_and_credentials() {
        for callback in [
            "http://example.com/callback",
            "https://user:password@example.com/callback",
            "not-a-url",
        ] {
            assert!(OpenRouterPkce::default().begin(callback).is_err());
        }
    }

    #[tokio::test]
    async fn complete_exchanges_code_and_verifier_once_without_exposing_key() {
        let (exchange_url, captured, server) = fake_exchange_server();
        let verifier = "private-verifier".to_owned();
        let pending = PendingPkce {
            authorization_url: Url::parse("https://openrouter.ai/auth").unwrap(),
            verifier: verifier.clone(),
            exchange_url: Url::parse(&exchange_url).unwrap(),
            client: reqwest::Client::builder().no_proxy().build().unwrap(),
        };
        let key = "sk-or-returned-secret";
        let session = pending.complete("authorization-code").await.unwrap();
        let request = captured.recv_timeout(Duration::from_secs(2)).unwrap();
        server.join().unwrap();
        let (_, body) = request.split_once("\r\n\r\n").unwrap();
        let body: serde_json::Value = serde_json::from_str(body).unwrap();
        assert_eq!(body["code"], "authorization-code");
        assert_eq!(body["code_verifier"], verifier);
        assert_eq!(body["code_challenge_method"], "S256");
        assert!(!format!("{session:?}").contains(key));
    }

    fn fake_exchange_server() -> (String, mpsc::Receiver<String>, thread::JoinHandle<()>) {
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
                        let text = String::from_utf8_lossy(&request);
                        if text.contains("authorization-code") && text.contains("private-verifier")
                        {
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
                    Err(error) => panic!("fake exchange server read failed: {error}"),
                }
            }
            sender.send(String::from_utf8(request).unwrap()).unwrap();
            let body = r#"{"key":"sk-or-returned-secret","user_id":"user-1"}"#;
            let response = format!(
                "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{}",
                body.len(),
                body
            );
            stream.write_all(response.as_bytes()).unwrap();
        });
        (format!("http://{address}/exchange"), receiver, server)
    }
}
