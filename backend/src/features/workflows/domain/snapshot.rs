//! Immutable run configuration (Rails `SnapshotBuilder`, version 3). Created
//! before a run is queued and never mutated; contains no runtime secrets.

use chrono::SecondsFormat;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::features::workflows::domain::catalog_view::CatalogView;
use crate::features::workflows::domain::model::{StepKind, Workflow};
use crate::shared::ids::{StepId, StepInputId, WorkflowId, WorkflowInputId};
use crate::shared::output_format::OutputFileFormat;
use crate::shared::time::Timestamp;

pub const VERSION: i32 = 3;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Snapshot {
    pub version: i32,
    /// RFC 3339 with microseconds.
    pub captured_at: String,
    pub workflow: SnapshotWorkflow,
    #[serde(default)]
    pub inputs: Vec<SnapshotInput>,
    #[serde(default)]
    pub steps: Vec<SnapshotStep>,
    #[serde(default)]
    pub connections: Vec<SnapshotConnection>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SnapshotWorkflow {
    pub id: WorkflowId,
    pub name: String,
    #[serde(default)]
    pub description: Option<String>,
    pub status: String,
    #[serde(default)]
    pub schedule: Option<SnapshotSchedule>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SnapshotSchedule {
    pub enabled: bool,
    #[serde(default)]
    pub cron_expression: Option<String>,
    #[serde(default)]
    pub timezone: Option<String>,
    #[serde(default)]
    pub human_description: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SnapshotInput {
    pub id: WorkflowInputId,
    pub name: String,
    #[serde(default)]
    pub description: Option<String>,
    pub required: bool,
    pub position: i32,
    #[serde(default)]
    pub value: Option<String>,
    #[serde(default = "default_true")]
    pub ask_at_run_time: bool,
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SnapshotTool {
    pub key: String,
    pub display_name: String,
    pub pi_tool_name: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SnapshotStep {
    pub id: StepId,
    pub kind: String,
    pub allow_failure: bool,
    pub name: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub prompt: Option<String>,
    #[serde(default)]
    pub additional_context: Option<String>,
    #[serde(default)]
    pub output_name: Option<String>,
    #[serde(default)]
    pub output_description: Option<String>,
    #[serde(default)]
    pub expected_output: Option<String>,
    #[serde(default)]
    pub output_file_format: OutputFileFormat,
    #[serde(default)]
    pub model_id: Option<String>,
    #[serde(default)]
    pub model_settings: Map<String, Value>,
    #[serde(default)]
    pub enabled_tools: Vec<SnapshotTool>,
    #[serde(default)]
    pub canvas_x: i32,
    #[serde(default)]
    pub canvas_y: i32,
    #[serde(default)]
    pub position: i32,
    #[serde(default)]
    pub inputs: Vec<SnapshotStepInput>,
}

impl SnapshotStep {
    pub fn kind(&self) -> StepKind {
        StepKind::parse(&self.kind).unwrap_or_default()
    }

    pub fn temperature(&self) -> Option<f64> {
        self.model_settings.get("temperature").and_then(Value::as_f64)
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SnapshotStepInput {
    pub id: StepInputId,
    pub name: String,
    #[serde(default)]
    pub description: Option<String>,
    pub required: bool,
    #[serde(default)]
    pub position: i32,
    #[serde(default)]
    pub workflow_input_id: Option<WorkflowInputId>,
    #[serde(default)]
    pub workflow_input_name: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SnapshotConnection {
    pub source_step_id: StepId,
    pub source_output_name: String,
    pub destination_step_id: StepId,
    pub destination_input_id: StepInputId,
    #[serde(default)]
    pub destination_input_name: Option<String>,
}

impl Snapshot {
    pub fn step(&self, id: StepId) -> Option<&SnapshotStep> {
        self.steps.iter().find(|s| s.id == id)
    }

    pub fn dag(&self) -> crate::shared::dag::Dag {
        crate::shared::dag::Dag::new(
            self.steps.iter().map(|s| s.id),
            self.connections
                .iter()
                .map(|c| (c.source_step_id.to_string(), c.destination_step_id.to_string())),
        )
    }
}

pub fn build(workflow: &Workflow, catalog: &CatalogView, now: Timestamp) -> Snapshot {
    Snapshot {
        version: VERSION,
        captured_at: now.to_rfc3339_opts(SecondsFormat::Micros, true),
        workflow: SnapshotWorkflow {
            id: workflow.id,
            name: workflow.name.clone(),
            description: workflow.description.clone(),
            status: workflow.status.as_str().to_string(),
            schedule: workflow.schedule.as_ref().map(|s| SnapshotSchedule {
                enabled: s.enabled,
                cron_expression: s.cron_expression.clone(),
                timezone: s.timezone.clone(),
                human_description: s.human_description.clone(),
            }),
        },
        inputs: workflow
            .inputs
            .iter()
            .map(|i| SnapshotInput {
                id: i.id,
                name: i.name.clone(),
                description: i.description.clone(),
                required: i.required,
                position: i.position,
                value: i.value.clone(),
                ask_at_run_time: i.ask_at_run_time,
            })
            .collect(),
        steps: workflow
            .steps
            .iter()
            .map(|step| SnapshotStep {
                id: step.id,
                kind: step.kind.as_str().to_string(),
                allow_failure: step.allow_failure,
                name: step.name.clone(),
                description: step.description.clone(),
                prompt: step.prompt.clone(),
                additional_context: step.additional_context.clone(),
                output_name: step.output_name.clone(),
                output_description: step.output_description.clone(),
                expected_output: step.expected_output.clone(),
                output_file_format: step.output_file_format,
                model_id: step.model_id.clone(),
                model_settings: step.model_settings.clone(),
                enabled_tools: step
                    .enabled_tool_ids
                    .iter()
                    .filter_map(|key| catalog.tool(key))
                    .map(|t| SnapshotTool {
                        key: t.key.clone(),
                        display_name: t.display_name.clone(),
                        pi_tool_name: t.pi_tool_name.clone(),
                    })
                    .collect(),
                canvas_x: step.canvas_x,
                canvas_y: step.canvas_y,
                position: step.position,
                inputs: step
                    .inputs
                    .iter()
                    .map(|i| SnapshotStepInput {
                        id: i.id,
                        name: i.name.clone(),
                        description: i.description.clone(),
                        required: i.required,
                        position: i.position,
                        workflow_input_id: i.workflow_input_id,
                        workflow_input_name: i
                            .workflow_input_id
                            .and_then(|wi| workflow.input(wi))
                            .map(|wi| wi.name.clone()),
                    })
                    .collect(),
            })
            .collect(),
        connections: workflow
            .connections
            .iter()
            .map(|c| SnapshotConnection {
                source_step_id: c.source_step_id,
                source_output_name: c.source_output_name.clone(),
                destination_step_id: c.destination_step_id,
                destination_input_id: c.destination_input_id,
                destination_input_name: workflow
                    .step_input(c.destination_input_id)
                    .map(|(_, i)| i.name.clone()),
            })
            .collect(),
    }
}
