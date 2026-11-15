//! `app_settings` adapter.
use async_trait::async_trait;
use crate::features::settings::{SettingsStore, SettingsTx};
use crate::infrastructure::postgres::PgStore;
use crate::infrastructure::postgres::uow::{PgTx, db};
use crate::shared::error::DomainResult;

#[async_trait]
impl SettingsStore for PgStore {
    async fn get(&self, key: &str) -> DomainResult<Option<String>> {
        sqlx::query_scalar!("SELECT value FROM app_settings WHERE key = $1", key)
            .fetch_optional(&self.pool)
            .await
            .map_err(db)
    }
    async fn set(&self, key: &str, value: &str) -> DomainResult<()> {
        sqlx::query!(
            "INSERT INTO app_settings (key, value, updated_at) VALUES ($1, $2, now())
             ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()",
            key,
            value,
        )
        .execute(&self.pool)
        .await
        .map_err(db)?;
        Ok(())
    }
    async fn clear(&self, key: &str) -> DomainResult<()> {
        sqlx::query!("DELETE FROM app_settings WHERE key = $1", key)
            .execute(&self.pool)
            .await
            .map_err(db)?;
        Ok(())
    }
    async fn begin(&self) -> DomainResult<Box<dyn SettingsTx>> {
        Ok(Box::new(self.tx().await?))
    }
}

#[async_trait]
impl SettingsTx for PgTx {
    async fn set(&mut self, key: &str, value: &str) -> DomainResult<()> {
        sqlx::query!(
            "INSERT INTO app_settings (key, value, updated_at) VALUES ($1, $2, now())
             ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()",
            key,
            value,
        )
        .execute(&mut *self.tx)
        .await
        .map_err(db)?;
        Ok(())
    }
    async fn clear(&mut self, key: &str) -> DomainResult<()> {
        sqlx::query!("DELETE FROM app_settings WHERE key = $1", key)
            .execute(&mut *self.tx)
            .await
            .map_err(db)?;
        Ok(())
    }
}
