use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Severity {
    Error,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EntityType {
    Workflow,
    WorkflowStep,
    StepInput,
    WorkflowInput,
    WorkflowConnection,
    WorkflowSchedule,
}

/// A structured readiness problem (Rails `Workflows::Validator::Issue`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Issue {
    pub severity: Severity,
    pub entity_type: EntityType,
    pub entity_id: String,
    pub field: String,
    pub message: String,
}

impl Issue {
    pub fn error(
        entity_type: EntityType,
        entity_id: impl ToString,
        field: &str,
        message: impl Into<String>,
    ) -> Self {
        Self {
            severity: Severity::Error,
            entity_type,
            entity_id: entity_id.to_string(),
            field: field.to_string(),
            message: message.into(),
        }
    }

    pub fn blocking(&self) -> bool {
        self.severity == Severity::Error
    }
}

pub fn any_blocking(issues: &[Issue]) -> bool {
    issues.iter().any(Issue::blocking)
}

/// First five blocking messages — the payload of `WorkflowNeedsAttention`.
pub fn blocking_messages(issues: &[Issue]) -> Vec<String> {
    issues
        .iter()
        .filter(|i| i.blocking())
        .take(5)
        .map(|i| i.message.clone())
        .collect()
}
