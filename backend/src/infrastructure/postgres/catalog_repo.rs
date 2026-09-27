use async_trait::async_trait;
use serde_json::Value;

use crate::features::catalog::{
    AvailableModel, CatalogStore, CatalogTx, FetchedModel, Provider, ToolDefinition,
};
use crate::infrastructure::postgres::PgStore;
use crate::infrastructure::postgres::uow::{PgTx, db};
use crate::shared::error::DomainResult;
use crate::shared::time::Timestamp;

fn object(value: Value) -> serde_json::Map<String, Value> {
    match value {
        Value::Object(map) => map,
        _ => serde_json::Map::new(),
    }
}

#[async_trait]
impl CatalogStore for PgStore {
    async fn models(&self, include_unavailable: bool) -> DomainResult<Vec<AvailableModel>> {
        let rows = sqlx::query!(
            r#"SELECT provider, model_id, display_name, available, capabilities, fetched_at
               FROM available_models
               WHERE available OR $1
               ORDER BY CASE provider WHEN 'velox' THEN 0 ELSE 1 END, model_id"#,
            include_unavailable
        )
        .fetch_all(&self.pool)
        .await
        .map_err(db)?;
        Ok(rows
            .into_iter()
            .map(|r| AvailableModel {
                provider: r.provider,
                model_id: r.model_id,
                display_name: r.display_name,
                available: r.available,
                capabilities: object(r.capabilities),
                fetched_at: r.fetched_at,
            })
            .collect())
    }

    async fn max_fetched_at(&self) -> DomainResult<Option<Timestamp>> {
        sqlx::query_scalar!("SELECT max(fetched_at) FROM available_models")
            .fetch_one(&self.pool)
            .await
            .map_err(db)
    }

    async fn enabled_tools(&self) -> DomainResult<Vec<ToolDefinition>> {
        let rows = sqlx::query!(
            "SELECT key, display_name, description, pi_tool_name, enabled
             FROM tool_definitions WHERE enabled ORDER BY key"
        )
        .fetch_all(&self.pool)
        .await
        .map_err(db)?;
        Ok(rows
            .into_iter()
            .map(|r| ToolDefinition {
                key: r.key,
                display_name: r.display_name,
                description: r.description,
                pi_tool_name: r.pi_tool_name,
                enabled: r.enabled,
            })
            .collect())
    }

    async fn begin(&self) -> DomainResult<Box<dyn CatalogTx>> {
        Ok(Box::new(self.tx().await?))
    }
}

#[async_trait]
impl CatalogTx for PgTx {
    async fn available_model_ids(&mut self, provider: Provider) -> DomainResult<Vec<String>> {
        sqlx::query_scalar!(
            "SELECT model_id FROM available_models WHERE provider = $1 AND available ORDER BY model_id",
            provider.as_str()
        )
        .fetch_all(&mut *self.tx)
        .await
        .map_err(db)
    }

    async fn upsert_models(&mut self, models: &[FetchedModel], now: Timestamp) -> DomainResult<()> {
        for model in models {
            sqlx::query!(
                r#"INSERT INTO available_models
                     (provider, model_id, display_name, capabilities, raw, available, fetched_at)
                   VALUES ($1, $2, $3, $4, $5, true, $6)
                   ON CONFLICT (provider, model_id) DO UPDATE SET
                     display_name = EXCLUDED.display_name,
                     capabilities = EXCLUDED.capabilities,
                     raw = EXCLUDED.raw,
                     available = true,
                     fetched_at = EXCLUDED.fetched_at,
                     updated_at = now()"#,
                model.provider.as_str(),
                model.model_id,
                model.display_name,
                Value::Object(model.capabilities.clone()),
                model.raw,
                now,
            )
            .execute(&mut *self.tx)
            .await
            .map_err(db)?;
        }
        Ok(())
    }

    async fn mark_unavailable(&mut self, provider: Provider, seen: &[String]) -> DomainResult<()> {
        sqlx::query!(
            "UPDATE available_models SET available = false, updated_at = now()
             WHERE provider = $1 AND available AND NOT (model_id = ANY($2))",
            provider.as_str(),
            seen,
        )
        .execute(&mut *self.tx)
        .await
        .map_err(db)?;
        Ok(())
    }
}

#[async_trait]
impl crate::features::workflows::ports::catalog::CatalogReader for PgStore {
    async fn view(
        &self,
    ) -> DomainResult<crate::features::workflows::domain::catalog_view::CatalogView> {
        use crate::features::workflows::domain::catalog_view::{
            CatalogModel, CatalogView, ToolRef,
        };
        let models = sqlx::query!(
            "SELECT provider, model_id, available, capabilities FROM available_models ORDER BY provider, model_id"
        )
        .fetch_all(&self.pool)
        .await
        .map_err(db)?
        .into_iter()
        .map(|r| CatalogModel {
            provider: r.provider,
            model_id: r.model_id,
            available: r.available,
            capabilities: object(r.capabilities),
        })
        .collect();
        let tools = sqlx::query!(
            "SELECT key, display_name, pi_tool_name, enabled FROM tool_definitions ORDER BY key"
        )
        .fetch_all(&self.pool)
        .await
        .map_err(db)?
        .into_iter()
        .map(|r| ToolRef {
            key: r.key,
            display_name: r.display_name,
            pi_tool_name: r.pi_tool_name,
            enabled: r.enabled,
        })
        .collect();
        Ok(CatalogView { models, tools })
    }
}
