//! OpenAI-compatible `/models` gateways (velox, omniroute).

use std::time::Duration;

use async_trait::async_trait;
use reqwest::header::{ACCEPT, AUTHORIZATION, HeaderValue};
use secrecy::{ExposeSecret, SecretString};
use serde_json::{Map, Value};

use crate::features::catalog::{FetchedModel, GatewayError, ModelGateway, Provider};

const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
const READ_TIMEOUT: Duration = Duration::from_secs(30);

/// The error with its cause chain (DNS, TLS, timeout…); the URL is removed
/// and reqwest errors never contain request headers.
fn describe(error: reqwest::Error) -> String {
    let error = error.without_url();
    let mut text = error.to_string();
    let mut source = std::error::Error::source(&error);
    while let Some(cause) = source {
        text.push_str(": ");
        text.push_str(&cause.to_string());
        source = cause.source();
    }
    text
}

pub struct OpenAiCompatibleGateway {
    provider: Provider,
    base_url: String,
    api_key: Option<SecretString>,
    client: reqwest::Client,
}

impl OpenAiCompatibleGateway {
    pub fn new(provider: Provider, base_url: &str, api_key: Option<SecretString>) -> Self {
        let client = reqwest::Client::builder()
            .connect_timeout(CONNECT_TIMEOUT)
            .read_timeout(READ_TIMEOUT)
            .build()
            .expect("the HTTP client configuration is valid");
        Self {
            provider,
            base_url: base_url.trim_end_matches('/').to_string(),
            api_key,
            client,
        }
    }

    fn parse(&self, body: &str) -> Result<Vec<FetchedModel>, GatewayError> {
        let provider = self.provider;
        let payload: Value = serde_json::from_str(body)
            .map_err(|_| GatewayError(format!("{provider} /models returned invalid JSON")))?;
        let data = payload
            .get("data")
            .and_then(Value::as_array)
            .ok_or_else(|| {
                GatewayError(format!("{provider} /models returned an unexpected payload"))
            })?;
        Ok(data
            .iter()
            .filter_map(|entry| build_model(provider, entry))
            .collect())
    }
}

fn build_model(provider: Provider, entry: &Value) -> Option<FetchedModel> {
    let id = match entry.get("id") {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Null) | None => String::new(),
        Some(other) => other.to_string(),
    };
    if id.is_empty() {
        return None;
    }
    // Velox lists aliases only: no name or capability surface.
    let (display_name, capabilities) = match provider {
        Provider::Velox => (id.clone(), Map::new()),
        Provider::Omniroute => (
            entry
                .get("name")
                .and_then(Value::as_str)
                .filter(|s| !s.trim().is_empty())
                .unwrap_or(&id)
                .to_string(),
            entry
                .get("capabilities")
                .and_then(Value::as_object)
                .cloned()
                .unwrap_or_default(),
        ),
    };
    Some(FetchedModel {
        provider,
        model_id: id,
        display_name,
        capabilities,
        raw: entry.clone(),
    })
}

#[async_trait]
impl ModelGateway for OpenAiCompatibleGateway {
    fn provider(&self) -> Provider {
        self.provider
    }

    async fn fetch_models(&self) -> Result<Vec<FetchedModel>, GatewayError> {
        let provider = self.provider;
        let key = self
            .api_key
            .as_ref()
            .map(|k| k.expose_secret().trim().to_string())
            .filter(|k| !k.is_empty())
            .ok_or_else(|| GatewayError(format!("{} is not configured", provider.api_key_var())))?;
        let mut auth = HeaderValue::from_str(&format!("Bearer {key}"))
            .map_err(|_| GatewayError(format!("{} is invalid", provider.api_key_var())))?;
        auth.set_sensitive(true);

        let response = self
            .client
            .get(format!("{}/models", self.base_url))
            .header(AUTHORIZATION, auth)
            .header(ACCEPT, "application/json")
            .send()
            .await
            .map_err(|e| GatewayError(format!("{provider} /models failed: {}", describe(e))))?;
        let status = response.status();
        if !status.is_success() {
            return Err(GatewayError(format!(
                "{provider} /models answered {}",
                status.as_u16()
            )));
        }
        let body = response
            .text()
            .await
            .map_err(|e| GatewayError(format!("{provider} /models failed: {}", describe(e))))?;
        self.parse(&body)
    }
}
