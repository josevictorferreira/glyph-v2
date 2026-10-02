use std::sync::Mutex;

use async_trait::async_trait;
use glyph_backend::features::catalog::{FetchedModel, GatewayError, ModelGateway, Provider};
use serde_json::{Map, json};

/// A gateway returning scripted model lists (or an error).
pub struct FakeGateway {
    pub provider: Provider,
    pub next: Mutex<Result<Vec<FetchedModel>, GatewayError>>,
}

impl FakeGateway {
    pub fn new(provider: Provider, ids: &[&str]) -> Self {
        Self {
            provider,
            next: Mutex::new(Ok(models(provider, ids))),
        }
    }

    pub fn set(&self, ids: &[&str]) {
        *self.next.lock().unwrap() = Ok(models(self.provider, ids));
    }

    pub fn fail(&self, message: &str) {
        *self.next.lock().unwrap() = Err(GatewayError(message.into()));
    }
}

pub fn model(provider: Provider, id: &str) -> FetchedModel {
    FetchedModel {
        provider,
        model_id: id.into(),
        display_name: id.into(),
        capabilities: Map::new(),
        raw: json!({ "id": id }),
    }
}

pub fn models(provider: Provider, ids: &[&str]) -> Vec<FetchedModel> {
    ids.iter().map(|id| model(provider, id)).collect()
}

#[async_trait]
impl ModelGateway for FakeGateway {
    fn provider(&self) -> Provider {
        self.provider
    }

    async fn fetch_models(&self) -> Result<Vec<FetchedModel>, GatewayError> {
        self.next.lock().unwrap().clone()
    }
}
