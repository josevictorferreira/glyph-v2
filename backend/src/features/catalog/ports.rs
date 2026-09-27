use async_trait::async_trait;

use crate::features::catalog::domain::{AvailableModel, FetchedModel, Provider, ToolDefinition};
use crate::shared::error::DomainResult;
use crate::shared::time::Timestamp;
use crate::shared::uow::UnitOfWork;

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{0}")]
pub struct GatewayError(pub String);

/// An OpenAI-compatible `/models` endpoint.
#[async_trait]
pub trait ModelGateway: Send + Sync {
    fn provider(&self) -> Provider;
    async fn fetch_models(&self) -> Result<Vec<FetchedModel>, GatewayError>;
}

#[async_trait]
pub trait CatalogStore: Send + Sync {
    /// Velox first, then by model id.
    async fn models(&self, include_unavailable: bool) -> DomainResult<Vec<AvailableModel>>;
    async fn max_fetched_at(&self) -> DomainResult<Option<Timestamp>>;
    /// Enabled tools ordered by key.
    async fn enabled_tools(&self) -> DomainResult<Vec<ToolDefinition>>;
    async fn begin(&self) -> DomainResult<Box<dyn CatalogTx>>;
}

#[async_trait]
pub trait CatalogTx: UnitOfWork {
    async fn available_model_ids(&mut self, provider: Provider) -> DomainResult<Vec<String>>;
    async fn upsert_models(&mut self, models: &[FetchedModel], now: Timestamp) -> DomainResult<()>;
    /// Flips previously-available models of `provider` not in `seen` to unavailable.
    async fn mark_unavailable(&mut self, provider: Provider, seen: &[String]) -> DomainResult<()>;
}

/// Moves active workflows using any of `model_ids` to needs_attention
/// (implemented by the workflows feature).
#[async_trait]
pub trait WorkflowFlagger: Send + Sync {
    async fn flag_workflows_using_models(&self, model_ids: &[String]) -> DomainResult<usize>;
}
