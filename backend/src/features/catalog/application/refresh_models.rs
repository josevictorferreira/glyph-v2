use std::collections::HashSet;
use std::sync::Arc;

use serde_json::json;

use crate::features::catalog::domain::{Provider, full_id};
use crate::features::catalog::ports::{CatalogStore, ModelGateway, WorkflowFlagger};
use crate::shared::error::DomainResult;
use crate::shared::events::DomainEvent;
use crate::shared::time::Clock;

#[derive(Debug, Clone, PartialEq)]
pub struct ProviderRefresh {
    pub provider: Provider,
    pub refreshed: bool,
    pub count: usize,
    pub became_unavailable: Vec<String>,
    pub error: Option<String>,
}

/// Refreshes the model cache per provider (Rails `ModelsCatalog::Refresher`):
/// upsert seen models, flip vanished ones to unavailable, append
/// `ModelsRefreshed` — all in one transaction — then flag active workflows
/// whose models vanished.
#[derive(Clone)]
pub struct RefreshModels {
    store: Arc<dyn CatalogStore>,
    gateways: Vec<Arc<dyn ModelGateway>>,
    flagger: Arc<dyn WorkflowFlagger>,
    clock: Arc<dyn Clock>,
}

impl RefreshModels {
    pub fn new(
        store: Arc<dyn CatalogStore>,
        gateways: Vec<Arc<dyn ModelGateway>>,
        flagger: Arc<dyn WorkflowFlagger>,
        clock: Arc<dyn Clock>,
    ) -> Self {
        Self {
            store,
            gateways,
            flagger,
            clock,
        }
    }

    /// Refreshes every provider; failures are reported per provider and never fatal.
    pub async fn refresh_all(&self) -> Vec<ProviderRefresh> {
        let mut results = Vec::new();
        for gateway in &self.gateways {
            let result = match self.refresh(gateway.as_ref()).await {
                Ok(result) => result,
                Err(error) => ProviderRefresh {
                    provider: gateway.provider(),
                    refreshed: false,
                    count: 0,
                    became_unavailable: Vec::new(),
                    error: Some(error.to_string()),
                },
            };
            if let Some(error) = &result.error {
                tracing::warn!(provider = %result.provider, %error, "model refresh failed");
            }
            results.push(result);
        }
        results
    }

    pub async fn refresh(&self, gateway: &dyn ModelGateway) -> DomainResult<ProviderRefresh> {
        let provider = gateway.provider();
        let models = match gateway.fetch_models().await {
            Ok(models) => models,
            Err(error) => {
                return Ok(ProviderRefresh {
                    provider,
                    refreshed: false,
                    count: 0,
                    became_unavailable: Vec::new(),
                    error: Some(error.0),
                });
            }
        };

        let seen: Vec<String> = models.iter().map(|m| m.model_id.clone()).collect();
        let seen_set: HashSet<&str> = seen.iter().map(String::as_str).collect();

        let mut tx = self.store.begin().await?;
        let became_unavailable: Vec<String> = tx
            .available_model_ids(provider)
            .await?
            .into_iter()
            .filter(|id| !seen_set.contains(id.as_str()))
            .collect();
        tx.upsert_models(&models, self.clock.now()).await?;
        tx.mark_unavailable(provider, &seen).await?;
        tx.append_events(&[DomainEvent {
            event_type: "ModelsRefreshed".into(),
            stream: provider.models_stream(),
            correlation_id: None,
            data: json!({
                "provider": provider.as_str(),
                "model_count": models.len(),
                "unavailable_model_ids": became_unavailable,
            }),
        }])
        .await?;
        tx.commit().await?;

        if !became_unavailable.is_empty() {
            // Steps store full ids ("velox/x"); legacy steps store the bare id.
            let ids: Vec<String> = became_unavailable
                .iter()
                .flat_map(|id| [id.clone(), full_id(provider.as_str(), id)])
                .collect();
            if let Err(error) = self.flagger.flag_workflows_using_models(&ids).await {
                tracing::warn!(%error, "flagging workflows with vanished models failed");
            }
        }

        Ok(ProviderRefresh {
            provider,
            refreshed: true,
            count: models.len(),
            became_unavailable,
            error: None,
        })
    }
}
