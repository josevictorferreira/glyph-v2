//! Run engine: runs, step runs, dispatch, finalization, stop/retry
//! (Rails `app/domain/execution/*`, `WorkflowRunsController`).

pub mod application;
pub mod domain;
pub mod grpc;
pub mod http;
pub mod ports;

pub use application::{NotCreated, RunService};
pub use domain::engine::NewRun;
pub use domain::model::{Run, RunStatus, RunTrigger, StepRun, StepRunStatus};
pub use ports::repository::{RunStore, RunTx};
pub use ports::step_runner::{OutcomeStatus, ProgressSink, StepRunContext, StepRunOutcome, StepRunner};

/// Transcript blocks rendered from session content (filled by 0009).
pub fn transcript_blocks(_session_content: Option<&str>) -> Vec<crate::proto::pb::TranscriptBlock> {
    Vec::new()
}
