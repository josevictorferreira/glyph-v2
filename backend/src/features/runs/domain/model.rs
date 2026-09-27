use serde_json::{Map, Value};

use crate::features::workflows::model::StepKind;
use crate::features::workflows::snapshot::{Snapshot, SnapshotTool};
use crate::shared::ids::{RunId, StepRunId, WorkflowId};
use crate::shared::output_format::OutputFileFormat;
use crate::shared::time::Timestamp;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum RunStatus {
    Queued,
    Running,
    Succeeded,
    Failed,
    Cancelled,
}

impl RunStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Queued => "queued",
            Self::Running => "running",
            Self::Succeeded => "succeeded",
            Self::Failed => "failed",
            Self::Cancelled => "cancelled",
        }
    }

    pub fn parse(raw: &str) -> Option<Self> {
        [
            Self::Queued,
            Self::Running,
            Self::Succeeded,
            Self::Failed,
            Self::Cancelled,
        ]
        .into_iter()
        .find(|s| s.as_str() == raw)
    }

    pub fn terminal(self) -> bool {
        matches!(self, Self::Succeeded | Self::Failed | Self::Cancelled)
    }

    pub fn live(self) -> bool {
        matches!(self, Self::Queued | Self::Running)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum StepRunStatus {
    Queued,
    Running,
    Succeeded,
    Failed,
    Skipped,
    Cancelled,
}

impl StepRunStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Queued => "queued",
            Self::Running => "running",
            Self::Succeeded => "succeeded",
            Self::Failed => "failed",
            Self::Skipped => "skipped",
            Self::Cancelled => "cancelled",
        }
    }

    pub fn parse(raw: &str) -> Option<Self> {
        [
            Self::Queued,
            Self::Running,
            Self::Succeeded,
            Self::Failed,
            Self::Skipped,
            Self::Cancelled,
        ]
        .into_iter()
        .find(|s| s.as_str() == raw)
    }

    pub fn terminal(self) -> bool {
        !matches!(self, Self::Queued | Self::Running)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum RunTrigger {
    Manual,
    Scheduled,
}

impl RunTrigger {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Manual => "manual",
            Self::Scheduled => "scheduled",
        }
    }

    pub fn parse(raw: &str) -> Option<Self> {
        match raw {
            "manual" => Some(Self::Manual),
            "scheduled" => Some(Self::Scheduled),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct Run {
    pub id: RunId,
    pub workflow_id: WorkflowId,
    pub status: RunStatus,
    pub trigger: RunTrigger,
    pub draft_test: bool,
    pub snapshot: Snapshot,
    /// Supplied at creation, keyed by workflow input name.
    pub supplied_values: Map<String, Value>,
    pub schedule_occurrence_key: Option<String>,
    pub queued_at: Option<Timestamp>,
    pub started_at: Option<Timestamp>,
    pub ended_at: Option<Timestamp>,
    pub elapsed_ms: Option<i64>,
    pub failure_summary: Option<String>,
    pub first_failed_step_run_id: Option<StepRunId>,
    pub created_at: Timestamp,
}

impl Run {
    /// `started_at ?? queued_at ?? created_at` → `ended_at`, rounded ms.
    pub fn elapsed_until(&self, ended_at: Timestamp) -> i64 {
        let start = self
            .started_at
            .or(self.queued_at)
            .unwrap_or(self.created_at);
        (ended_at - start).num_milliseconds()
    }
}

/// Status-level view of a step run (no evidence) — what dispatch needs.
#[derive(Debug, Clone, PartialEq)]
pub struct StepRunState {
    pub id: StepRunId,
    pub snapshot_step_id: String,
    pub step_name: String,
    pub status: StepRunStatus,
    pub allow_failure: bool,
    pub human_error: Option<String>,
    pub started_at: Option<Timestamp>,
    pub created_at: Timestamp,
}

/// Full step run with decrypted evidence.
#[derive(Debug, Clone, PartialEq)]
pub struct StepRun {
    pub id: StepRunId,
    pub run_id: RunId,
    pub snapshot_step_id: String,
    pub step_name: String,
    pub step_kind: StepKind,
    pub status: StepRunStatus,
    pub position: i32,
    pub allow_failure: bool,
    pub prompt: Option<String>,
    pub additional_context: Option<String>,
    pub expected_output: Option<String>,
    pub model_id: Option<String>,
    pub model_settings: Map<String, Value>,
    pub enabled_tools: Vec<SnapshotTool>,
    pub output_name: Option<String>,
    pub output_file_format: OutputFileFormat,
    /// `{name: {value, source}}`.
    pub resolved_inputs: Option<Value>,
    pub output: Option<Value>,
    pub output_text: Option<String>,
    pub messages: Option<Value>,
    pub session_content: Option<String>,
    pub technical_error: Option<String>,
    pub human_error: Option<String>,
    pub skipped_reason: Option<String>,
    pub queued_at: Option<Timestamp>,
    pub started_at: Option<Timestamp>,
    pub ended_at: Option<Timestamp>,
    pub elapsed_ms: Option<i64>,
    pub created_at: Timestamp,
}

impl StepRun {
    pub fn state(&self) -> StepRunState {
        StepRunState {
            id: self.id,
            snapshot_step_id: self.snapshot_step_id.clone(),
            step_name: self.step_name.clone(),
            status: self.status,
            allow_failure: self.allow_failure,
            human_error: self.human_error.clone(),
            started_at: self.started_at,
            created_at: self.created_at,
        }
    }

    pub fn has_output(&self) -> bool {
        match self.step_kind {
            StepKind::Helper => self.output.as_ref().is_some_and(|o| !o.is_null()),
            StepKind::Pi => {
                self.status == StepRunStatus::Succeeded
                    && self.output_text.as_deref().is_some_and(|t| !t.is_empty())
            }
        }
    }
}
