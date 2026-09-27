//! Run event types (stream `WorkflowRun${id}`, correlation = run id).

use serde_json::{Value, json};

use crate::features::runs::domain::model::{Run, StepRunState};
use crate::shared::events::DomainEvent;
use crate::shared::ids::{RunId, WorkflowId};

pub const RUN_QUEUED: &str = "WorkflowRunQueued";
pub const RUN_STARTED: &str = "WorkflowRunStarted";
pub const RUN_SUCCEEDED: &str = "WorkflowRunSucceeded";
pub const RUN_FAILED: &str = "WorkflowRunFailed";
pub const RUN_CANCELLED: &str = "WorkflowRunCancelled";
pub const RUN_DELETED: &str = "WorkflowRunDeleted";
pub const STEP_QUEUED: &str = "StepRunQueued";
pub const STEP_STARTED: &str = "StepRunStarted";
pub const STEP_SUCCEEDED: &str = "StepRunSucceeded";
pub const STEP_FAILED: &str = "StepRunFailed";
pub const STEP_SKIPPED: &str = "StepRunSkipped";
pub const STEP_CANCELLED: &str = "StepRunCancelled";

pub fn run_event(event_type: &str, workflow: WorkflowId, run: RunId, extra: Value) -> DomainEvent {
    DomainEvent::run(event_type, workflow, run.as_uuid(), extra)
}

pub fn run_status(event_type: &str, run: &Run, reason: Option<&str>) -> DomainEvent {
    let mut extra = json!({ "status": run.status.as_str() });
    if let Some(reason) = reason {
        extra["reason"] = json!(reason);
    }
    run_event(event_type, run.workflow_id, run.id, extra)
}

pub fn step(
    event_type: &str,
    workflow: WorkflowId,
    run: RunId,
    step_run: impl ToString,
    status: Option<&str>,
    reason: Option<&str>,
) -> DomainEvent {
    let mut extra = json!({ "step_run_id": step_run.to_string() });
    if let Some(status) = status {
        extra["status"] = json!(status);
    }
    if let Some(reason) = reason {
        extra["reason"] = json!(reason);
    }
    run_event(event_type, workflow, run, extra)
}

pub fn step_state(event_type: &str, run: &Run, s: &StepRunState, reason: Option<&str>) -> DomainEvent {
    step(event_type, run.workflow_id, run.id, s.id, Some(s.status.as_str()), reason)
}
