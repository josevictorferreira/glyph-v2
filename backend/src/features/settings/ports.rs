use crate::shared::error::DomainResult;
use crate::shared::uow::UnitOfWork;
use async_trait::async_trait;

/// Key of the chat agent's model in `app_settings`.
pub const CHAT_MODEL_ID: &str = "chat_model_id";

/// Reads and writes of `app_settings`.
#[async_trait]
pub trait SettingsStore: Send + Sync {
    async fn get(&self, key: &str) -> DomainResult<Option<String>>;
    async fn set(&self, key: &str, value: &str) -> DomainResult<()>;
    async fn clear(&self, key: &str) -> DomainResult<()>;
    async fn begin(&self) -> DomainResult<Box<dyn SettingsTx>>;
}

/// In-transaction writes, so a setting change and its event commit together.
#[async_trait]
pub trait SettingsTx: UnitOfWork {
    async fn set(&mut self, key: &str, value: &str) -> DomainResult<()>;
    async fn clear(&mut self, key: &str) -> DomainResult<()>;
}
