//! Workflow design: aggregate, editor mutations, validator, lifecycle,
//! schedule, snapshot (Rails `app/domain/workflows/*` + `Editor`).

pub mod application;
pub mod domain;
pub mod grpc;
pub mod ports;

pub use application::{Mutation, WorkflowService};
pub use domain::catalog_view::CatalogView;
pub use domain::model::{Workflow, WorkflowStatus};
pub use domain::snapshot::Snapshot;
pub use ports::catalog::CatalogReader;
pub use ports::repository::{WorkflowStore, WorkflowTx};
