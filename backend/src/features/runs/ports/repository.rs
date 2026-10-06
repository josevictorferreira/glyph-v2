use async_trait::async_trait;
use serde_json::Value;

use crate::features::runs::domain::input_resolver::Upstream;
use crate::features::runs::domain::model::*;
use crate::features::runs::ports::step_runner::StepRunOutcome;
use crate::features::workflows::WorkflowTx;
use crate::shared::error::DomainResult;
use crate::shared::ids::{RunId, StepRunId, WorkflowId};
use crate::shared::time::Timestamp;

#[derive(Debug, Clone, Default)]
pub struct RunListFilter {
    pub limit: i64,
    pub before: Option<Timestamp>,
}

#[async_trait]
pub trait RunStore: Send + Sync {
    async fn find_run(&self, id: RunId) -> DomainResult<Option<Run>>;
    /// Newest first.
    async fn list_runs(
        &self,
        workflow: WorkflowId,
        filter: &RunListFilter,
    ) -> DomainResult<Vec<Run>>;
    /// Ordered by (position, created_at), without `session_content`: a run
    /// overview never renders transcripts, and they can be large.
    async fn step_runs(&self, run: RunId) -> DomainResult<Vec<StepRun>>;
    async fn find_step_run(&self, id: StepRunId) -> DomainResult<Option<StepRun>>;
    /// Progress snapshot: writes (encrypted) session content and notifies
    /// `STEP_RUN_PROGRESS`, in its own short transaction.
    async fn record_progress(
        &self,
        workflow: WorkflowId,
        run: RunId,
        step_run: StepRunId,
        session_content: &str,
    ) -> DomainResult<()>;
    async fn begin(&self) -> DomainResult<Box<dyn RunTx>>;
}

/// Run persistence inside a transaction that also exposes workflow
/// persistence (run creation locks the workflow; finalization updates its
/// last-run pointers).
#[async_trait]
pub trait RunTx: WorkflowTx {
    async fn insert_run(&mut self, run: &Run, step_runs: &[StepRun]) -> DomainResult<()>;
    /// `SELECT … FOR UPDATE` on the run row.
    async fn lock_run(&mut self, id: RunId) -> DomainResult<Option<Run>>;
    async fn step_run_states(&mut self, run: RunId) -> DomainResult<Vec<StepRunState>>;
    /// Succeeded/failed step runs with their outputs (input resolution).
    async fn upstreams(&mut self, run: RunId) -> DomainResult<Vec<Upstream>>;
    /// Updates status/timestamps/summary columns of the run.
    async fn save_run(&mut self, run: &Run) -> DomainResult<()>;
    /// CAS queued → running; false when another worker won.
    async fn start_run(&mut self, id: RunId, at: Timestamp) -> DomainResult<bool>;
    /// CAS queued → running.
    async fn start_step_run(&mut self, id: StepRunId, at: Timestamp) -> DomainResult<bool>;
    async fn set_resolved_inputs(&mut self, id: StepRunId, resolved: &Value) -> DomainResult<()>;
    /// Moves step runs currently in `from` to `to` with `ended_at`/`skipped_reason`.
    /// Returns the ids actually changed.
    async fn mark_step_runs(
        &mut self,
        ids: &[StepRunId],
        from: &[StepRunStatus],
        to: StepRunStatus,
        ended_at: Timestamp,
        skipped_reason: Option<&str>,
    ) -> DomainResult<Vec<StepRunId>>;
    /// CAS `from` → outcome status with all evidence. False when the step run
    /// left `from` meanwhile (e.g. fail-fast cancelled it).
    async fn finish_step_run(
        &mut self,
        id: StepRunId,
        from: StepRunStatus,
        finish: &StepFinish,
    ) -> DomainResult<bool>;
    /// Back to queued with every evidence field cleared (retry). `queued_at`
    /// restarts at `now` so timelines don't stretch across the dead window.
    async fn reset_step_runs(
        &mut self,
        ids: &[StepRunId],
        from: &[StepRunStatus],
        now: Timestamp,
    ) -> DomainResult<Vec<StepRunId>>;
    async fn set_workflow_last_run(
        &mut self,
        workflow: WorkflowId,
        at: Timestamp,
        status: RunStatus,
    ) -> DomainResult<()>;
    async fn delete_run(&mut self, id: RunId) -> DomainResult<bool>;
}

/// Terminal evidence written by `finish_step_run`.
#[derive(Debug, Clone, PartialEq)]
pub struct StepFinish {
    pub status: StepRunStatus,
    pub ended_at: Timestamp,
    pub elapsed_ms: Option<i64>,
    pub output: Option<Value>,
    pub output_text: Option<String>,
    pub messages: Option<Value>,
    pub session_content: Option<String>,
    pub human_error: Option<String>,
    pub technical_error: Option<String>,
    pub skipped_reason: Option<String>,
}

impl StepFinish {
    pub fn from_outcome(outcome: &StepRunOutcome, ended_at: Timestamp) -> Self {
        let success = outcome.success();
        Self {
            status: if success {
                StepRunStatus::Succeeded
            } else {
                StepRunStatus::Failed
            },
            ended_at,
            elapsed_ms: Some(outcome.elapsed_ms),
            output: if success {
                outcome.output.clone()
            } else {
                None
            },
            output_text: outcome.output_text.clone(),
            messages: outcome.messages.clone(),
            session_content: outcome.session_content.clone(),
            human_error: if success {
                None
            } else {
                outcome.human_error.clone()
            },
            technical_error: if success {
                None
            } else {
                outcome.technical_error.clone()
            },
            skipped_reason: None,
        }
    }
}
