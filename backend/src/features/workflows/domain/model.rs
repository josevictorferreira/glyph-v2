use std::collections::BTreeMap;

use serde_json::{Map, Value};

use crate::shared::ids::{
    ConnectionId, ScheduleId, ScheduleValueId, SharedTextId, StepId, StepInputId, WorkflowId,
    WorkflowInputId,
};
use crate::shared::output_format::OutputFileFormat;
use crate::shared::time::Timestamp;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum WorkflowStatus {
    Draft,
    Active,
    Paused,
    NeedsAttention,
}

impl WorkflowStatus {
    pub const ALL: [Self; 4] = [
        Self::Draft,
        Self::Active,
        Self::Paused,
        Self::NeedsAttention,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Draft => "draft",
            Self::Active => "active",
            Self::Paused => "paused",
            Self::NeedsAttention => "needs_attention",
        }
    }

    pub fn parse(raw: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|s| s.as_str() == raw)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default)]
pub enum StepKind {
    #[default]
    Pi,
    Helper,
}

impl StepKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Pi => "pi",
            Self::Helper => "helper",
        }
    }

    pub fn parse(raw: &str) -> Option<Self> {
        match raw {
            "pi" => Some(Self::Pi),
            "helper" => Some(Self::Helper),
            _ => None,
        }
    }
}

pub(crate) fn present(value: &Option<String>) -> bool {
    value.as_deref().is_some_and(|v| !v.trim().is_empty())
}

pub(crate) fn blank(value: &str) -> bool {
    value.trim().is_empty()
}

#[derive(Debug, Clone, PartialEq)]
pub struct WorkflowInput {
    pub id: WorkflowInputId,
    pub name: String,
    pub description: Option<String>,
    pub required: bool,
    /// false = constant, fixed at design time.
    pub ask_at_run_time: bool,
    pub value: Option<String>,
    pub position: i32,
    pub created_at: Timestamp,
}

impl WorkflowInput {
    pub fn constant(&self) -> bool {
        !self.ask_at_run_time
    }
}

/// A workflow-level named text that steps reference from their prompt,
/// context or expect fields.
#[derive(Debug, Clone, PartialEq)]
pub struct SharedText {
    pub id: SharedTextId,
    pub key: String,
    pub description: Option<String>,
    pub body: String,
    pub position: i32,
}

/// A step's link to a shared text, with the per-step `{{variable}}` values.
#[derive(Debug, Clone, PartialEq)]
pub struct TextRef {
    pub text_id: SharedTextId,
    pub vars: BTreeMap<String, String>,
}

/// The three step fields a shared text can feed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TextField {
    Prompt,
    Context,
    Expect,
}

impl TextField {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Prompt => "prompt",
            Self::Context => "context",
            Self::Expect => "expect",
        }
    }

    pub fn parse(raw: &str) -> Option<Self> {
        match raw {
            "prompt" => Some(Self::Prompt),
            "context" => Some(Self::Context),
            "expect" => Some(Self::Expect),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct StepInput {
    pub id: StepInputId,
    pub name: String,
    pub description: Option<String>,
    pub required: bool,
    pub position: i32,
    pub workflow_input_id: Option<WorkflowInputId>,
    pub created_at: Timestamp,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Step {
    pub id: StepId,
    pub kind: StepKind,
    pub name: String,
    pub description: Option<String>,
    pub prompt: Option<String>,
    pub additional_context: Option<String>,
    pub expected_output: Option<String>,
    /// Linked shared text for the prompt; `prompt` is NULL while set.
    pub prompt_ref: Option<TextRef>,
    /// Linked shared text for the context; `additional_context` is NULL while set.
    pub context_ref: Option<TextRef>,
    /// Linked shared text for the expect; `expected_output` is NULL while set.
    pub expect_ref: Option<TextRef>,
    pub output_name: Option<String>,
    pub output_description: Option<String>,
    pub output_file_format: OutputFileFormat,
    pub model_id: Option<String>,
    pub model_settings: Map<String, Value>,
    /// Tool keys (column name kept from Rails).
    pub enabled_tool_ids: Vec<String>,
    pub allow_failure: bool,
    pub canvas_x: i32,
    pub canvas_y: i32,
    pub position: i32,
    pub inputs: Vec<StepInput>,
    pub created_at: Timestamp,
}

impl Step {
    pub fn new(
        kind: StepKind,
        position: i32,
        canvas_x: i32,
        canvas_y: i32,
        now: Timestamp,
    ) -> Self {
        Self {
            id: StepId::new(),
            kind,
            name: String::new(),
            description: None,
            prompt: None,
            additional_context: None,
            expected_output: None,
            prompt_ref: None,
            context_ref: None,
            expect_ref: None,
            output_name: None,
            output_description: None,
            output_file_format: OutputFileFormat::default(),
            model_id: None,
            model_settings: Map::new(),
            enabled_tool_ids: Vec::new(),
            allow_failure: false,
            canvas_x,
            canvas_y,
            position,
            inputs: Vec::new(),
            created_at: now,
        }
    }

    /// Whether the step has everything it needs. Text fields count through
    /// their linked shared texts, so pass the owning workflow.
    pub fn configured(&self, workflow: &Workflow) -> bool {
        let named = !blank(&self.name) && present(&self.output_name);
        match self.kind {
            StepKind::Helper => named,
            StepKind::Pi => {
                named
                    && present(&workflow.effective_prompt(self))
                    && present(&workflow.effective_expect(self))
                    && present(&self.model_id)
            }
        }
    }

    /// "Unnamed step" when blank — the validator's label.
    pub fn label(&self) -> &str {
        if blank(&self.name) {
            "Unnamed step"
        } else {
            &self.name
        }
    }

    pub fn temperature(&self) -> Option<f64> {
        self.model_settings
            .get("temperature")
            .and_then(Value::as_f64)
    }

    pub fn next_input_position(&self) -> i32 {
        self.inputs.iter().map(|i| i.position).max().unwrap_or(0) + 1
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct Connection {
    pub id: ConnectionId,
    pub source_step_id: StepId,
    pub source_output_name: String,
    pub destination_step_id: StepId,
    pub destination_input_id: StepInputId,
    pub created_at: Timestamp,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ScheduleValue {
    pub id: ScheduleValueId,
    pub workflow_input_id: WorkflowInputId,
    pub value: Option<String>,
    pub created_at: Timestamp,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Schedule {
    pub id: ScheduleId,
    pub enabled: bool,
    pub cron_expression: Option<String>,
    pub timezone: Option<String>,
    pub human_description: Option<String>,
    pub next_run_at: Option<Timestamp>,
    pub last_dispatched_at: Option<Timestamp>,
    pub values: Vec<ScheduleValue>,
    pub created_at: Timestamp,
}

impl Schedule {
    pub fn new(now: Timestamp) -> Self {
        Self {
            id: ScheduleId::new(),
            enabled: false,
            cron_expression: None,
            timezone: None,
            human_description: None,
            next_run_at: None,
            last_dispatched_at: None,
            values: Vec::new(),
            created_at: now,
        }
    }

    /// Enabled with a recurrence and timezone.
    pub fn configured(&self) -> bool {
        present(&self.cron_expression) && present(&self.timezone)
    }

    pub fn value_for(&self, input: WorkflowInputId) -> Option<&str> {
        self.values
            .iter()
            .find(|v| v.workflow_input_id == input)
            .and_then(|v| v.value.as_deref())
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct Workflow {
    pub id: WorkflowId,
    pub name: String,
    pub description: Option<String>,
    pub status: WorkflowStatus,
    pub fail_fast: bool,
    pub last_run_at: Option<Timestamp>,
    pub last_run_status: Option<String>,
    pub next_run_at: Option<Timestamp>,
    pub created_at: Timestamp,
    pub updated_at: Timestamp,
    /// Ordered by (position, created_at).
    pub inputs: Vec<WorkflowInput>,
    /// Shared texts, ordered by (position, created_at).
    pub texts: Vec<SharedText>,
    /// Ordered by (position, created_at); each step's inputs likewise.
    pub steps: Vec<Step>,
    /// Ordered by created_at.
    pub connections: Vec<Connection>,
    pub schedule: Option<Schedule>,
}

impl Workflow {
    pub fn step(&self, id: StepId) -> Option<&Step> {
        self.steps.iter().find(|s| s.id == id)
    }

    pub fn step_mut(&mut self, id: StepId) -> Option<&mut Step> {
        self.steps.iter_mut().find(|s| s.id == id)
    }

    pub fn input(&self, id: WorkflowInputId) -> Option<&WorkflowInput> {
        self.inputs.iter().find(|i| i.id == id)
    }

    pub fn text(&self, id: SharedTextId) -> Option<&SharedText> {
        self.texts.iter().find(|t| t.id == id)
    }

    pub fn text_mut(&mut self, id: SharedTextId) -> Option<&mut SharedText> {
        self.texts.iter_mut().find(|t| t.id == id)
    }

    /// Steps whose field is linked to the shared text `id`.
    pub fn steps_using_text(&self, id: SharedTextId) -> Vec<&Step> {
        self.steps
            .iter()
            .filter(|s| {
                [&s.prompt_ref, &s.context_ref, &s.expect_ref]
                    .into_iter()
                    .flatten()
                    .any(|r| r.text_id == id)
            })
            .collect()
    }

    pub fn next_text_position(&self) -> i32 {
        self.texts.iter().map(|t| t.position).max().unwrap_or(0) + 1
    }

    /// The step input with `id` and the step owning it.
    pub fn step_input(&self, id: StepInputId) -> Option<(&Step, &StepInput)> {
        self.steps
            .iter()
            .find_map(|s| s.inputs.iter().find(|i| i.id == id).map(|i| (s, i)))
    }

    pub fn step_input_mut(&mut self, id: StepInputId) -> Option<&mut StepInput> {
        self.steps
            .iter_mut()
            .find_map(|s| s.inputs.iter_mut().find(|i| i.id == id))
    }

    pub fn incoming_connection(&self, input: StepInputId) -> Option<&Connection> {
        self.connections
            .iter()
            .find(|c| c.destination_input_id == input)
    }

    pub fn connected(&self, input: StepInputId) -> bool {
        self.incoming_connection(input).is_some()
    }

    pub fn scheduled(&self) -> bool {
        self.schedule.as_ref().is_some_and(|s| s.enabled)
    }

    pub fn next_step_position(&self) -> i32 {
        self.steps.iter().map(|s| s.position).max().unwrap_or(0) + 1
    }

    pub fn next_input_position(&self) -> i32 {
        self.inputs.iter().map(|i| i.position).max().unwrap_or(0) + 1
    }

    pub fn dag(&self) -> crate::shared::dag::Dag {
        crate::shared::dag::Dag::new(
            self.steps.iter().map(|s| s.id),
            self.connections.iter().map(|c| {
                (
                    c.source_step_id.to_string(),
                    c.destination_step_id.to_string(),
                )
            }),
        )
    }
}

/// Listing row (Rails index page).
#[derive(Debug, Clone, PartialEq)]
pub struct WorkflowSummary {
    pub id: WorkflowId,
    pub name: String,
    pub description: Option<String>,
    pub status: WorkflowStatus,
    pub fail_fast: bool,
    pub last_run_at: Option<Timestamp>,
    pub last_run_status: Option<String>,
    pub next_run_at: Option<Timestamp>,
    pub schedule_summary: Option<String>,
    pub created_at: Timestamp,
    pub updated_at: Timestamp,
}

impl WorkflowSummary {
    pub fn of(workflow: &Workflow) -> Self {
        Self {
            id: workflow.id,
            name: workflow.name.clone(),
            description: workflow.description.clone(),
            status: workflow.status,
            fail_fast: workflow.fail_fast,
            last_run_at: workflow.last_run_at,
            last_run_status: workflow.last_run_status.clone(),
            next_run_at: workflow.next_run_at,
            schedule_summary: workflow
                .schedule
                .as_ref()
                .filter(|s| s.enabled)
                .and_then(|s| s.human_description.clone()),
            created_at: workflow.created_at,
            updated_at: workflow.updated_at,
        }
    }
}
