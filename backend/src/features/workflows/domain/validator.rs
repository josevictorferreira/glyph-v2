//! The single readiness source (Rails `Workflows::Validator`): editor badge,
//! manual runs, activation, resume and scheduler eligibility. Returns
//! structured issues; never fails for invalid configuration.

use std::collections::HashSet;
use std::sync::LazyLock;

use regex::Regex;

use crate::features::workflows::domain::catalog_view::CatalogView;
use crate::features::workflows::domain::model::{StepKind, Workflow, blank, present};
use crate::features::workflows::domain::schedule_calculator;
use crate::shared::issue::{EntityType, Issue};

/// `{{name}}` references; the restricted charset keeps brace-heavy literals
/// such as `{{"a": 1}}` out of the scan.
pub static VARIABLE_PATTERN: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\{\{([A-Za-z0-9_ -]+)\}\}").unwrap());

/// Model settings Glyph understands, gated per model by capability.
const SUPPORTED_SETTING_KEYS: &[(&str, &str)] = &[("temperature", "temperature")];

pub fn validate(workflow: &Workflow, catalog: &CatalogView) -> Vec<Issue> {
    let mut v = Validator {
        workflow,
        catalog,
        issues: Vec::new(),
    };
    v.check_workflow_basics();
    v.check_steps();
    v.check_step_inputs();
    v.check_prompt_variables();
    v.check_workflow_values();
    v.check_connections();
    v.check_schedule();
    v.issues
}

/// Variable tokens used in a text, stripped and de-duplicated in order.
pub fn variable_tokens(text: &str) -> Vec<String> {
    let mut seen = Vec::new();
    for capture in VARIABLE_PATTERN.captures_iter(text) {
        let token = capture[1].trim().to_string();
        if !seen.contains(&token) {
            seen.push(token);
        }
    }
    seen
}

struct Validator<'a> {
    workflow: &'a Workflow,
    catalog: &'a CatalogView,
    issues: Vec<Issue>,
}

impl Validator<'_> {
    fn error(&mut self, entity: EntityType, id: impl ToString, field: &str, message: String) {
        self.issues.push(Issue::error(entity, id, field, message));
    }

    fn check_workflow_basics(&mut self) {
        let wf = self.workflow;
        if blank(&wf.name) {
            self.error(
                EntityType::Workflow,
                wf.id,
                "name",
                "Give the workflow a name before it can run.".into(),
            );
        }
        if wf.steps.is_empty() {
            self.error(
                EntityType::Workflow,
                wf.id,
                "steps",
                "Add at least one step before the workflow can run.".into(),
            );
        }
    }

    fn check_steps(&mut self) {
        for step in &self.workflow.steps {
            let label = step.label().to_string();
            if blank(&step.name) {
                self.error(
                    EntityType::WorkflowStep,
                    step.id,
                    "name",
                    "Name the step.".into(),
                );
            }
            if !present(&step.output_name) {
                self.error(
                    EntityType::WorkflowStep,
                    step.id,
                    "output_name",
                    format!("Name the output exposed by “{label}”."),
                );
            }
            if step.kind == StepKind::Helper {
                continue;
            }
            if !present(&step.prompt) {
                self.error(
                    EntityType::WorkflowStep,
                    step.id,
                    "prompt",
                    format!("“{label}” needs a prompt."),
                );
            }
            if !present(&step.expected_output) {
                self.error(
                    EntityType::WorkflowStep,
                    step.id,
                    "expected_output",
                    format!("Describe the expected output of “{label}”."),
                );
            }

            // Model choice and availability.
            match step.model_id.as_deref().filter(|m| !m.trim().is_empty()) {
                None => self.error(
                    EntityType::WorkflowStep,
                    step.id,
                    "model_id",
                    format!("Choose a model for “{label}”."),
                ),
                Some(model) if !self.catalog.model_available(model) => self.error(
                    EntityType::WorkflowStep,
                    step.id,
                    "model_id",
                    format!(
                        "The model “{model}” selected for “{label}” is no longer available. Choose a replacement."
                    ),
                ),
                Some(_) => {}
            }

            let model = step.model_id.clone().unwrap_or_default();
            for key in step.model_settings.keys() {
                match SUPPORTED_SETTING_KEYS.iter().find(|(k, _)| k == key) {
                    None => self.error(
                        EntityType::WorkflowStep,
                        step.id,
                        "model_settings",
                        format!("“{key}” is not a supported model setting."),
                    ),
                    Some((_, capability)) if !self.catalog.supports(&model, capability) => self
                        .error(
                            EntityType::WorkflowStep,
                            step.id,
                            "model_settings",
                            format!(
                                "The selected model does not support “{key}”. Remove the setting."
                            ),
                        ),
                    Some(_) => {}
                }
            }

            for key in &step.enabled_tool_ids {
                if !self.catalog.tool_enabled(key) {
                    self.error(
                        EntityType::WorkflowStep,
                        step.id,
                        "enabled_tool_ids",
                        format!(
                            "The tool “{key}” enabled for “{label}” is not available. Remove it."
                        ),
                    );
                }
            }
        }
    }

    fn check_step_inputs(&mut self) {
        let wf = self.workflow;
        for step in &wf.steps {
            for input in &step.inputs {
                let sources = usize::from(wf.connected(input.id))
                    + usize::from(input.workflow_input_id.is_some());
                if sources > 1 {
                    self.error(
                        EntityType::StepInput,
                        input.id,
                        "source",
                        format!(
                            "Input “{}” on “{}” has two sources; keep one.",
                            input.name, step.name
                        ),
                    );
                } else if input.required && sources == 0 {
                    self.error(
                        EntityType::StepInput,
                        input.id,
                        "source",
                        format!(
                            "Required input “{}” on “{}” needs a connection or a workflow value.",
                            input.name, step.name
                        ),
                    );
                }
            }
        }
    }

    fn check_prompt_variables(&mut self) {
        let wf = self.workflow;
        let workflow_names: HashSet<&str> = wf.inputs.iter().map(|i| i.name.as_str()).collect();
        for step in &wf.steps {
            if step.kind == StepKind::Helper {
                continue;
            }
            let mut known = workflow_names.clone();
            known.extend(step.inputs.iter().map(|i| i.name.as_str()));
            let label = step.label().to_string();
            for text in [&step.prompt, &step.additional_context]
                .into_iter()
                .flatten()
            {
                for token in variable_tokens(text) {
                    if known.contains(token.as_str()) {
                        continue;
                    }
                    self.error(
                        EntityType::WorkflowStep,
                        step.id,
                        "prompt",
                        format!(
                            "“{label}” uses “{{{{{token}}}}}” but no workflow value or input provides it. Add one or fix the spelling."
                        ),
                    );
                }
            }
        }
    }

    fn check_workflow_values(&mut self) {
        for input in &self.workflow.inputs {
            if !input.required || input.ask_at_run_time || present(&input.value) {
                continue;
            }
            self.error(
                EntityType::WorkflowInput,
                input.id,
                "value",
                format!(
                    "Set a value for the constant workflow input “{}” or ask for it at run time.",
                    input.name
                ),
            );
        }
    }

    fn check_connections(&mut self) {
        let wf = self.workflow;
        for connection in &wf.connections {
            let source = wf.step(connection.source_step_id);
            let destination = wf.step(connection.destination_step_id);
            let input = wf.step_input(connection.destination_input_id);
            let (Some(source), Some(destination), Some(_)) = (source, destination, input) else {
                self.error(
                    EntityType::WorkflowConnection,
                    connection.id,
                    "base",
                    "A connection references a removed step or input.".into(),
                );
                continue;
            };
            if source.id == destination.id {
                self.error(
                    EntityType::WorkflowConnection,
                    connection.id,
                    "base",
                    format!("“{}” cannot connect to itself.", source.name),
                );
            }
            if !present(&source.output_name)
                || source.output_name.as_deref() != Some(connection.source_output_name.as_str())
            {
                self.error(
                    EntityType::WorkflowConnection,
                    connection.id,
                    "source_output_name",
                    format!(
                        "The connection from “{}” refers to an output that no longer exists.",
                        source.name
                    ),
                );
            }
        }
        if wf.dag().cyclic() {
            self.error(
                EntityType::Workflow,
                wf.id,
                "connections",
                "The connections form a cycle. Remove the link that closes the loop.".into(),
            );
        }
    }

    fn check_schedule(&mut self) {
        let wf = self.workflow;
        let Some(schedule) = &wf.schedule else {
            return;
        };
        if let Some(cron) = schedule.cron_expression.as_deref().filter(|c| !blank(c))
            && schedule_calculator::parse_cron(cron).is_none()
        {
            self.error(
                EntityType::WorkflowSchedule,
                schedule.id,
                "cron_expression",
                "The recurrence is not a valid cron expression.".into(),
            );
        }
        if let Some(tz) = schedule.timezone.as_deref().filter(|t| !blank(t))
            && schedule_calculator::parse_timezone(tz).is_none()
        {
            self.error(
                EntityType::WorkflowSchedule,
                schedule.id,
                "timezone",
                "The schedule timezone is not a known IANA timezone.".into(),
            );
        }
        if !schedule.enabled {
            return;
        }
        if !schedule.configured() {
            self.error(
                EntityType::WorkflowSchedule,
                schedule.id,
                "cron_expression",
                "An enabled schedule needs a recurrence and a timezone.".into(),
            );
        }
        for input in wf.inputs.iter().filter(|i| i.required) {
            if present(&input.value) {
                continue;
            }
            let scheduled = schedule
                .value_for(input.id)
                .is_some_and(|v| !v.trim().is_empty());
            if !scheduled {
                self.error(
                    EntityType::WorkflowSchedule,
                    schedule.id,
                    "values",
                    format!(
                        "The schedule needs a value for the required workflow input “{}”.",
                        input.name
                    ),
                );
            }
        }
    }
}
