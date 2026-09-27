use crate::features::workflows::model::StepKind;
use crate::shared::ids::StepId;
use crate::shared::output_format::OutputFileFormat;

/// A located definition problem (`path` is a JSON pointer).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DefinitionError {
    pub path: Option<String>,
    pub line: Option<i32>,
    pub message: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SourceKind {
    Step,
    WorkflowInput,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Source {
    pub kind: SourceKind,
    pub name: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct StepInputDef {
    pub name: String,
    pub source: Option<Source>,
    pub required: bool,
    pub description: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct StepDef {
    /// Existing step matched by id or name (None → create).
    pub id: Option<StepId>,
    pub name: String,
    pub kind: StepKind,
    pub description: Option<String>,
    pub model: Option<String>,
    pub temperature: Option<f64>,
    pub tools: Vec<String>,
    pub prompt: Option<String>,
    pub context: Option<String>,
    pub expect: Option<String>,
    pub output: String,
    pub output_description: Option<String>,
    pub format: OutputFileFormat,
    pub allow_failure: bool,
    /// In document order.
    pub inputs: Vec<StepInputDef>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct InputDef {
    pub name: String,
    pub description: Option<String>,
    pub value: Option<String>,
    pub required: bool,
    pub ask: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ScheduleDef {
    pub cron: String,
    pub timezone: String,
    pub enabled: bool,
    pub description: Option<String>,
    /// (input name, value) in document order.
    pub values: Vec<(String, String)>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Document {
    pub name: String,
    pub description: Option<String>,
    pub fail_fast: bool,
    pub inputs: Vec<InputDef>,
    pub schedule: Option<ScheduleDef>,
    pub steps: Vec<StepDef>,
}
