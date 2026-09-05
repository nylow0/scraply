use crate::{ModelMetadata, ProviderError, ProviderErrorCode};
use reqwest::{StatusCode, Url, header};
use serde::Deserialize;
use serde_json::Value;
use std::{collections::BTreeMap, sync::Arc};
use tokio::sync::Mutex;

const MODELS_DEV_PROVIDER_ID: &str = "models-dev";
const CATALOG_URL: &str = "https://models.dev/api.json";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OverlayFreshness {
    Fresh,
    NotModified,
    Stale,
}

/// Adds labels and limits to models already returned by an authenticated
/// provider catalog. It never creates a model or changes whether one is
/// runnable.
#[derive(Clone)]
pub struct ModelsDevOverlay {
    client: reqwest::Client,
    endpoint: Url,
    cache: Arc<Mutex<Option<CachedCatalog>>>,
}

impl std::fmt::Debug for ModelsDevOverlay {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("ModelsDevOverlay")
            .field("endpoint", &self.endpoint)
            .finish_non_exhaustive()
    }
}

impl Default for ModelsDevOverlay {
    fn default() -> Self {
        Self {
            client: reqwest::Client::new(),
            endpoint: Url::parse(CATALOG_URL).expect("Models.dev catalog URL must be valid"),
            cache: Arc::new(Mutex::new(None)),
        }
    }
}

impl ModelsDevOverlay {
    /// Refreshes metadata, then enriches only the supplied provider models.
    /// `metadata_provider_id` is the Models.dev provider namespace, such as
    /// `openrouter` or `openai`.
    pub async fn enrich(
        &self,
        metadata_provider_id: &str,
        models: &mut [ModelMetadata],
    ) -> Result<OverlayFreshness, ProviderError> {
        let (catalog, freshness) = self.catalog().await?;
        let Some(provider) = catalog.providers.get(metadata_provider_id) else {
            return Ok(freshness);
        };
        for model in models {
            let Some(metadata) = provider.models.get(&model.identity.model_id) else {
                continue;
            };
            if !metadata.name.is_empty() {
                model.display_name.clone_from(&metadata.name);
            }
            if model.description.is_empty() {
                model.description.clone_from(&metadata.description);
            }
            if model.context_length.is_none() {
                model.context_length = metadata.limit.as_ref().and_then(|limit| limit.context);
            }
            if model.pricing.is_empty() {
                model.pricing = metadata
                    .cost
                    .iter()
                    .filter_map(|(name, value)| {
                        let value = match value {
                            Value::String(value) => value.clone(),
                            Value::Number(value) => value.to_string(),
                            _ => return None,
                        };
                        Some((name.clone(), value))
                    })
                    .collect();
            }
        }
        Ok(freshness)
    }

    async fn catalog(&self) -> Result<(Catalog, OverlayFreshness), ProviderError> {
        let etag = self
            .cache
            .lock()
            .await
            .as_ref()
            .and_then(|cache| cache.etag.clone());
        let request = self.catalog_request(etag.as_deref());
        let response = match request.send().await {
            Ok(response) => response,
            Err(error) => return self.stale_or_error(Some(&error)).await,
        };
        if response.status() == StatusCode::NOT_MODIFIED {
            let cache = self.cache.lock().await;
            let catalog = cache
                .as_ref()
                .map(|cache| cache.catalog.clone())
                .ok_or_else(|| {
                    ProviderError::new(
                        MODELS_DEV_PROVIDER_ID,
                        ProviderErrorCode::InvalidResponse,
                        false,
                        "Models.dev returned not-modified without cached metadata",
                    )
                })?;
            return Ok((catalog, OverlayFreshness::NotModified));
        }
        if !response.status().is_success() {
            return self
                .stale_or_http(response.status(), response.headers())
                .await;
        }
        let etag = response
            .headers()
            .get(header::ETAG)
            .and_then(|value| value.to_str().ok())
            .map(str::to_owned);
        let providers = match response.json::<BTreeMap<String, RemoteProvider>>().await {
            Ok(providers) => providers,
            Err(error) => return self.stale_or_error(Some(&error)).await,
        };
        let catalog = Catalog { providers };
        *self.cache.lock().await = Some(CachedCatalog {
            etag,
            catalog: catalog.clone(),
        });
        Ok((catalog, OverlayFreshness::Fresh))
    }

    async fn stale_or_error(
        &self,
        error: Option<&reqwest::Error>,
    ) -> Result<(Catalog, OverlayFreshness), ProviderError> {
        if let Some(cache) = self.cache.lock().await.as_ref() {
            return Ok((cache.catalog.clone(), OverlayFreshness::Stale));
        }
        Err(match error {
            Some(error) => ProviderError::transport(MODELS_DEV_PROVIDER_ID, error),
            None => ProviderError::new(
                MODELS_DEV_PROVIDER_ID,
                ProviderErrorCode::InvalidResponse,
                false,
                "Models.dev returned invalid metadata",
            ),
        })
    }

    async fn stale_or_http(
        &self,
        status: StatusCode,
        headers: &header::HeaderMap,
    ) -> Result<(Catalog, OverlayFreshness), ProviderError> {
        if let Some(cache) = self.cache.lock().await.as_ref() {
            return Ok((cache.catalog.clone(), OverlayFreshness::Stale));
        }
        Err(ProviderError::http(MODELS_DEV_PROVIDER_ID, status, headers))
    }

    fn catalog_request(&self, etag: Option<&str>) -> reqwest::RequestBuilder {
        let request = self.client.get(self.endpoint.clone());
        match etag {
            Some(etag) => request.header(header::IF_NONE_MATCH, etag),
            None => request,
        }
    }

    #[cfg(test)]
    fn fixture(endpoint: Url, cache: Option<CachedCatalog>) -> Self {
        Self {
            client: reqwest::Client::builder()
                .no_proxy()
                .build()
                .expect("test client should build"),
            endpoint,
            cache: Arc::new(Mutex::new(cache)),
        }
    }
}

#[derive(Clone)]
struct CachedCatalog {
    etag: Option<String>,
    catalog: Catalog,
}

#[derive(Clone)]
struct Catalog {
    providers: BTreeMap<String, RemoteProvider>,
}

#[derive(Clone, Deserialize)]
struct RemoteProvider {
    #[serde(default)]
    models: BTreeMap<String, RemoteModel>,
}

#[derive(Clone, Default, Deserialize)]
struct RemoteModel {
    #[serde(default)]
    name: String,
    #[serde(default)]
    description: String,
    limit: Option<RemoteLimit>,
    #[serde(default)]
    cost: BTreeMap<String, Value>,
}

#[derive(Clone, Deserialize)]
struct RemoteLimit {
    context: Option<u64>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use scraply_agent_core::QualifiedModel;

    fn cached_catalog() -> CachedCatalog {
        CachedCatalog {
            etag: Some("\"catalog-v1\"".to_owned()),
            catalog: Catalog {
                providers: BTreeMap::from([(
                    "openrouter".to_owned(),
                    RemoteProvider {
                        models: BTreeMap::from([(
                            "lab/model".to_owned(),
                            RemoteModel {
                                name: "Friendly name".to_owned(),
                                description: "Metadata only".to_owned(),
                                limit: Some(RemoteLimit {
                                    context: Some(128_000),
                                }),
                                cost: BTreeMap::from([(
                                    "input".to_owned(),
                                    Value::String("0.000001".to_owned()),
                                )]),
                            },
                        )]),
                    },
                )]),
            },
        }
    }

    #[tokio::test]
    async fn stale_cache_enriches_existing_models_without_creating_availability() {
        let overlay = ModelsDevOverlay::fixture(
            Url::parse("http://127.0.0.1:1/api.json").unwrap(),
            Some(cached_catalog()),
        );
        let mut models = vec![ModelMetadata {
            identity: QualifiedModel {
                provider_id: "openrouter".to_owned(),
                model_id: "lab/model".to_owned(),
            },
            display_name: "lab/model".to_owned(),
            description: String::new(),
            context_length: None,
            supports_structured_output: false,
            supported_reasoning_efforts: Vec::new(),
            reasoning_effort_descriptions: BTreeMap::new(),
            default_reasoning_effort: None,
            pricing: BTreeMap::new(),
        }];
        let freshness = overlay.enrich("openrouter", &mut models).await.unwrap();
        assert_eq!(freshness, OverlayFreshness::Stale);
        assert_eq!(models.len(), 1);
        assert_eq!(models[0].display_name, "Friendly name");
        assert_eq!(models[0].context_length, Some(128_000));
        assert!(!models[0].supports_structured_output);
    }

    #[tokio::test]
    async fn metadata_for_missing_models_never_adds_catalog_entries() {
        let overlay = ModelsDevOverlay::fixture(
            Url::parse("http://127.0.0.1:1/api.json").unwrap(),
            Some(cached_catalog()),
        );
        let mut models = Vec::new();
        overlay.enrich("openrouter", &mut models).await.unwrap();
        assert!(models.is_empty());
    }

    #[test]
    fn cached_etag_is_sent_as_a_conditional_request() {
        let overlay = ModelsDevOverlay::default();
        let request = overlay
            .catalog_request(Some("\"catalog-v1\""))
            .build()
            .unwrap();
        assert_eq!(
            request
                .headers()
                .get(header::IF_NONE_MATCH)
                .and_then(|value| value.to_str().ok()),
            Some("\"catalog-v1\"")
        );
    }
}
