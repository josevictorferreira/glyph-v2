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
    /// Execution time accumulated by finished windows before the current one
    /// (audit ticket 4: dead time between a failure and its retry is not work).
    pub active_ms: i64,
    /// When the current execution window opened (set to the retry time when
    /// a terminal run is revived; None until then).
    pub resumed_at: Option<Timestamp>,
    pub failure_summary: Option<String>,
    pub first_failed_step_run_id: Option<StepRunId>,
    pub created_at: Timestamp,
}

impl Run {
    /// Active execution time: previous windows plus the current one, rounded
    /// ms. The current window opens at `resumed_at ?? started_at ??
    /// queued_at ?? created_at` — wall-clock time the run sat terminal
    /// between a failure and a retry never counts (audit ticket 4).
    pub fn elapsed_until(&self, ended_at: Timestamp) -> i64 {
        let start = self
            .resumed_at
            .or(self.started_at)
            .or(self.queued_at)
            .unwrap_or(self.created_at);
        self.active_ms + (ended_at - start).num_milliseconds()
    }

    /// Freezes the finished window into `active_ms` when a terminal run is
    /// revived (retry): the next window starts counting from `at`.
    pub fn resume_clock(&mut self, at: Timestamp) {
        if let Some(ended) = self.ended_at {
            let start = self
                .resumed_at
                .or(self.started_at)
                .or(self.queued_at)
                .unwrap_or(self.created_at);
            self.active_ms += (ended - start).num_milliseconds().max(0);
        }
        self.resumed_at = Some(at);
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

#[cfg(test)]
mod clock_tests {
    use super::*;

    fn run(started: &str, ended: Option<&str>) -> Run {
        let ts = |s: &str| {
            chrono::NaiveDateTime::parse_from_str(s, "%Y-%m-%d %H:%M:%S")
                .unwrap()
                .and_utc()
        };
        Run {
            id: RunId::new(),
            workflow_id: crate::shared::ids::WorkflowId::new(),
            status: RunStatus::Failed,
            trigger: RunTrigger::Manual,
            draft_test: false,
            snapshot: serde_json::from_str(
                r#"{"version":3,"captured_at":"2026-09-29T09:00:00Z","workflow":{"id":"00000000-0000-0000-0000-000000000000","name":"","status":"draft"}}"#,
            )
            .unwrap(),
            supplied_values: Map::new(),
            schedule_occurrence_key: None,
            queued_at: None,
            started_at: Some(ts(started)),
            ended_at: ended.map(ts),
            elapsed_ms: None,
            active_ms: 0,
            resumed_at: None,
            failure_summary: None,
            first_failed_step_run_id: None,
            created_at: ts(started),
        }
    }

    #[test]
    fn elapsed_measures_only_active_execution() {
        // Started 09:00, failed 09:00:01 — one second of real work.
        let mut r = run("2026-09-29 09:00:00", Some("2026-09-29 09:00:01"));
        assert_eq!(r.elapsed_until(r.ended_at.unwrap()), 1_000);
        // Retried 14h later: the dead window is frozen, the clock reopens.
        let retry_at =
            chrono::NaiveDateTime::parse_from_str("2026-09-29 23:05:00", "%Y-%m-%d %H:%M:%S")
                .unwrap()
                .and_utc();
        r.resume_clock(retry_at);
        assert_eq!(r.active_ms, 1_000);
        assert_eq!(r.resumed_at, Some(retry_at));
        // One more second of work in the new window.
        let ended = retry_at + chrono::Duration::seconds(1);
        assert_eq!(r.elapsed_until(ended), 2_000);
    }

    #[test]
    fn resume_clock_ignores_unfinished_windows() {
        // A live run (no ended_at) revived by retry: nothing to freeze.
        let mut r = run("2026-09-29 09:00:00", None);
        let retry_at =
            chrono::NaiveDateTime::parse_from_str("2026-09-29 09:00:30", "%Y-%m-%d %H:%M:%S")
                .unwrap()
                .and_utc();
        r.resume_clock(retry_at);
        assert_eq!(r.active_ms, 0);
        let ended = retry_at + chrono::Duration::seconds(5);
        assert_eq!(r.elapsed_until(ended), 5_000);
    }

    #[test]
    fn fallback_window_starts_at_queued_or_created() {
        let mut r = run("2026-09-29 09:00:00", Some("2026-09-29 09:00:02"));
        r.started_at = None; // never started: queued_at/created_at opens the window
        assert_eq!(r.elapsed_until(r.ended_at.unwrap()), 2_000);
    }
}
