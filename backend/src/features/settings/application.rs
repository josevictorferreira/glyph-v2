//! Settings use cases: today, choosing the chat agent's model.
use crate::features::catalog::ListModels;
use crate::features::settings::{CHAT_MODEL_ID, SettingsStore};
use crate::shared::error::{DomainError, DomainResult};
use crate::shared::events::DomainEvent;
use crate::shared::time::Clock;
use serde_json::json;
use std::sync::Arc;

pub const SETTINGS_STREAM: &str = "Settings$app";

#[derive(Clone)]
pub struct SettingsService {
    store: Arc<dyn SettingsStore>,
    catalog: Arc<ListModels>,
    clock: Arc<dyn Clock>,
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Settings {
    pub chat_model_id: Option<String>,
}

impl SettingsService {
    pub fn new(
        store: Arc<dyn SettingsStore>,
        catalog: Arc<ListModels>,
        clock: Arc<dyn Clock>,
    ) -> Self {
        Self {
            store,
            catalog,
            clock,
        }
    }

    pub async fn get(&self) -> DomainResult<Settings> {
        Ok(Settings {
            chat_model_id: self.store.get(CHAT_MODEL_ID).await?,
        })
    }

    /// The chat feature's read of the chat model.
    pub async fn chat_model_id(&self) -> DomainResult<Option<String>> {
        self.store.get(CHAT_MODEL_ID).await
    }

    pub async fn update(&self, chat_model_id: Option<String>) -> DomainResult<Settings> {
        let chat_model_id = chat_model_id
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());
        if let Some(id) = &chat_model_id {
            let models = self.catalog.models(false).await?;
            if !models.models.iter().any(|m| &m.full_id() == id) {
                return Err(DomainError::invalid(format!(
                    "\u{201c}{id}\u{201d} is not an available model. Pick one from the list."
                )));
            }
        }
        let mut tx = self.store.begin().await?;
        let _ = self.clock.now();
        match &chat_model_id {
            Some(id) => tx.set(CHAT_MODEL_ID, id).await?,
            None => tx.clear(CHAT_MODEL_ID).await?,
        }
        tx.append_events(&[DomainEvent {
            event_type: "SettingsUpdated".into(),
            stream: SETTINGS_STREAM.into(),
            correlation_id: None,
            data: json!({ "chat_model_id": chat_model_id }),
        }])
        .await?;
        tx.commit().await?;
        Ok(Settings { chat_model_id })
    }
}
