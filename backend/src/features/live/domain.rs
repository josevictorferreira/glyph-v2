use serde::{Deserialize, Serialize};

use crate::shared::events::DomainEvent;
use crate::shared::time::Timestamp;

pub const CHANNEL: &str = "glyph_events";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum LiveKind {
    WorkflowUpdated,
    RunQueued,
    RunStarted,
    RunSucceeded,
    RunFailed,
    RunCancelled,
    RunDeleted,
    StepRunQueued,
    StepRunStarted,
    StepRunProgress,
    StepRunSucceeded,
    StepRunFailed,
    StepRunSkipped,
    StepRunCancelled,
    Resync,
    Heartbeat,
}

/// The NOTIFY payload (ids only, well under the 8000-byte limit). Clients
/// re-fetch state on receipt.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LiveEvent {
    #[serde(rename = "type")]
    pub kind: LiveKind,
    pub workflow_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub run_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub step_run_id: Option<String>,
    pub occurred_at: Timestamp,
}

impl LiveEvent {
    /// The live notification a persisted domain event triggers, if any.
    pub fn from_domain(event: &DomainEvent, occurred_at: Timestamp) -> Option<Self> {
        let kind = match event.event_type.as_str() {
            "WorkflowRunQueued" => LiveKind::RunQueued,
            "WorkflowRunStarted" => LiveKind::RunStarted,
            "WorkflowRunSucceeded" => LiveKind::RunSucceeded,
            "WorkflowRunFailed" => LiveKind::RunFailed,
            "WorkflowRunCancelled" => LiveKind::RunCancelled,
            "WorkflowRunDeleted" => LiveKind::RunDeleted,
            "StepRunQueued" => LiveKind::StepRunQueued,
            "StepRunStarted" => LiveKind::StepRunStarted,
            "StepRunSucceeded" => LiveKind::StepRunSucceeded,
            "StepRunFailed" => LiveKind::StepRunFailed,
            "StepRunSkipped" => LiveKind::StepRunSkipped,
            "StepRunCancelled" => LiveKind::StepRunCancelled,
            t if t.starts_with("Workflow") => LiveKind::WorkflowUpdated,
            _ => return None,
        };
        Some(Self {
            kind,
            workflow_id: event.str_field("workflow_id")?.to_string(),
            run_id: event.str_field("workflow_run_id").map(str::to_string),
            step_run_id: event.str_field("step_run_id").map(str::to_string),
            occurred_at,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Utc;
    use serde_json::json;
    use uuid::Uuid;

    #[test]
    fn maps_run_and_workflow_events() {
        let now = Utc::now();
        let run = Uuid::new_v4();
        let e = DomainEvent::run("StepRunStarted", "wf", run, json!({"step_run_id": "sr"}));
        let live = LiveEvent::from_domain(&e, now).unwrap();
        assert_eq!(live.kind, LiveKind::StepRunStarted);
        assert_eq!(live.run_id.as_deref(), Some(run.to_string().as_str()));
        assert_eq!(live.step_run_id.as_deref(), Some("sr"));

        let e = DomainEvent::workflow("WorkflowStepAdded", "wf", json!({}));
        assert_eq!(
            LiveEvent::from_domain(&e, now).unwrap().kind,
            LiveKind::WorkflowUpdated
        );

        let e = DomainEvent {
            event_type: "ModelsRefreshed".into(),
            stream: "Velox$models".into(),
            correlation_id: None,
            data: json!({}),
        };
        assert!(LiveEvent::from_domain(&e, now).is_none());
    }

    #[test]
    fn payload_shape() {
        let e = LiveEvent {
            kind: LiveKind::RunQueued,
            workflow_id: "w".into(),
            run_id: Some("r".into()),
            step_run_id: None,
            occurred_at: "2026-01-01T00:00:00Z".parse().unwrap(),
        };
        let json = serde_json::to_value(&e).unwrap();
        assert_eq!(json["type"], "RUN_QUEUED");
        assert!(json.get("step_run_id").is_none());
    }
}
