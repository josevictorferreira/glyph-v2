use std::sync::Arc;

use chrono::Duration;

use crate::features::catalog::domain::{AvailableModel, ToolDefinition};
use crate::features::catalog::ports::CatalogStore;
use crate::shared::error::DomainResult;
use crate::shared::time::Clock;

pub struct ModelList {
    pub models: Vec<AvailableModel>,
    /// Never fetched, or the newest fetch is older than the cache TTL.
    pub stale: bool,
}

#[derive(Clone)]
pub struct ListModels {
    store: Arc<dyn CatalogStore>,
    clock: Arc<dyn Clock>,
    ttl: Duration,
}

impl ListModels {
    pub fn new(store: Arc<dyn CatalogStore>, clock: Arc<dyn Clock>, ttl: Duration) -> Self {
        Self { store, clock, ttl }
    }

    pub async fn models(&self, include_unavailable: bool) -> DomainResult<ModelList> {
        let models = self.store.models(include_unavailable).await?;
        let stale = match self.store.max_fetched_at().await? {
            None => true,
            Some(at) => at < self.clock.now() - self.ttl,
        };
        Ok(ModelList { models, stale })
    }

    pub async fn tools(&self) -> DomainResult<Vec<ToolDefinition>> {
        self.store.enabled_tools().await
    }
}
