use async_trait::async_trait;

use crate::features::workflows::domain::catalog_view::CatalogView;
use crate::shared::error::DomainResult;

/// Catalog facts for validation and snapshots.
#[async_trait]
pub trait CatalogReader: Send + Sync {
    async fn view(&self) -> DomainResult<CatalogView>;
}
