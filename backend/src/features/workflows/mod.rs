//! Workflow design: aggregate, editor mutations, validator, lifecycle,
//! schedule, snapshot (Rails `app/domain/workflows/*` + `Editor`).
//!
//! Other features use only the re-exports below.

pub mod application;
pub mod domain;
pub mod grpc;
pub mod ports;

pub use application::{Mutation, WorkflowService};
pub use domain::catalog_view::{self, CatalogView};
pub use domain::events;
pub use domain::model::{self, Workflow, WorkflowStatus};
pub use domain::schedule_calculator;
pub use domain::shared_text;
pub use domain::snapshot::{self, Snapshot};
pub use domain::validator;
pub use domain::workflow::{Events, WorkflowInputFields};
pub use grpc::workflow_to_pb;
pub use ports::catalog::CatalogReader;
pub use ports::repository::{WorkflowStore, WorkflowTx};
