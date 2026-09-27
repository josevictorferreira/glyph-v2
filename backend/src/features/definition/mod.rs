//! YAML workflow definitions: schema, parser, applier, exporter, importer
//! (Rails `app/domain/workflows/definition/*`).

pub mod application;
pub mod domain;
pub mod grpc;
pub mod http;

pub use application::DefinitionService;
pub use domain::schema::ROUTE as SCHEMA_ROUTE;
