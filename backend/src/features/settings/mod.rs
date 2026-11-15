//! App-wide settings (single-user): the chat agent's model today.
pub mod application;
pub mod grpc;
pub mod ports;

pub use application::{Settings, SettingsService};
pub use ports::{CHAT_MODEL_ID, SettingsStore, SettingsTx};
