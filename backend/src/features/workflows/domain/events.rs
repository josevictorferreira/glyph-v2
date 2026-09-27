//! Workflow event types (stream `Workflow${id}`; data = ids only).

use serde_json::{Value, json};

use crate::shared::events::DomainEvent;
use crate::shared::ids::WorkflowId;

pub const WORKFLOW_CREATED: &str = "WorkflowCreated";
pub const WORKFLOW_UPDATED: &str = "WorkflowUpdated";
pub const WORKFLOW_STEP_ADDED: &str = "WorkflowStepAdded";
pub const WORKFLOW_STEP_UPDATED: &str = "WorkflowStepUpdated";
pub const WORKFLOW_STEP_DELETED: &str = "WorkflowStepDeleted";
pub const WORKFLOW_INPUT_MAPPED: &str = "WorkflowInputMapped";
pub const WORKFLOW_CONNECTION_CREATED: &str = "WorkflowConnectionCreated";
pub const WORKFLOW_CONNECTION_REMOVED: &str = "WorkflowConnectionRemoved";
pub const WORKFLOW_SCHEDULE_CHANGED: &str = "WorkflowScheduleChanged";
pub const WORKFLOW_ACTIVATED: &str = "WorkflowActivated";
pub const WORKFLOW_PAUSED: &str = "WorkflowPaused";
pub const WORKFLOW_RESUMED: &str = "WorkflowResumed";
pub const WORKFLOW_NEEDS_ATTENTION: &str = "WorkflowNeedsAttention";

pub fn event(event_type: &str, workflow: WorkflowId, extra: Value) -> DomainEvent {
    DomainEvent::workflow(event_type, workflow, extra)
}

pub fn needs_attention(workflow: WorkflowId, messages: Vec<String>) -> DomainEvent {
    event(
        WORKFLOW_NEEDS_ATTENTION,
        workflow,
        json!({ "issues": messages }),
    )
}
