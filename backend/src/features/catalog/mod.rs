//! Model & tool catalog (Rails `ModelsCatalog`, `Velox`, `AvailableModel`,
//! `ToolDefinition`).

pub mod application;
pub mod domain;
pub mod grpc;
pub mod ports;

pub use application::list::{ListModels, ModelList};
pub use application::refresh_models::{ProviderRefresh, RefreshModels};
pub use domain::{AvailableModel, FetchedModel, Provider, ToolDefinition};
pub use ports::{CatalogStore, CatalogTx, GatewayError, ModelGateway, WorkflowFlagger};
