use std::sync::Arc;

use async_trait::async_trait;
use serde_json::{Map, Value};

use crate::features::workflows::snapshot::SnapshotTool;
use crate::shared::ids::{RunId, StepRunId, WorkflowId};
use crate::shared::output_format::OutputFileFormat;

/// Everything the agent needs for one step, taken from the step run's
/// immutable evidence (never the live workflow).
#[derive(Debug, Clone)]
pub struct StepRunContext {
    pub workflow_id: WorkflowId,
    pub run_id: RunId,
    pub step_run_id: StepRunId,
    pub step_name: String,
    pub prompt: Option<String>,
    pub additional_context: Option<String>,
    pub expected_output: Option<String>,
    pub model_id: Option<String>,
    pub model_settings: Map<String, Value>,
    pub enabled_tools: Vec<SnapshotTool>,
    pub output_file_format: OutputFileFormat,
    /// Resolved inputs by name.
    pub inputs: Map<String, Value>,
    /// Effective workflow values by name.
    pub workflow_values: Map<String, Value>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OutcomeStatus {
    Success,
    ModelError,
    Timeout,
    ExitError,
    MalformedOutput,
    InternalError,
}

#[derive(Debug, Clone, PartialEq)]
pub struct StepRunOutcome {
    pub status: OutcomeStatus,
    pub output_text: Option<String>,
    /// Parsed structured output (JSON format).
    pub output: Option<Value>,
    pub messages: Option<Value>,
    pub session_content: Option<String>,
    pub usage: Option<Value>,
    pub exit_status: Option<i32>,
    pub human_error: Option<String>,
    pub technical_error: Option<String>,
    pub elapsed_ms: i64,
}

impl StepRunOutcome {
    pub fn success(&self) -> bool {
        self.status == OutcomeStatus::Success
    }
}

/// Receives redacted session snapshots while the agent runs.
#[async_trait]
pub trait ProgressSink: Send + Sync {
    async fn report(&self, session_content: String);
}

/// Executes one pi step (the Pi agent in production, scripted in tests).
#[async_trait]
pub trait StepRunner: Send + Sync {
    async fn run(&self, context: StepRunContext, progress: Arc<dyn ProgressSink>) -> StepRunOutcome;
}
