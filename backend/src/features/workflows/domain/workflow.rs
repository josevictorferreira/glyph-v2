//! Editor mutations on the Workflow aggregate (Rails `Components::Workflows::Editor`,
//! `Activation`, `Pauser`, `Resumer`, `Revalidator`). Pure: callers pass `now`
//! and catalog facts; each method returns the events to append.

use std::collections::{BTreeMap, HashSet};
use std::sync::LazyLock;

use regex::Regex;
use serde_json::{Value, json};

use crate::features::workflows::domain::catalog_view::CatalogView;
use crate::features::workflows::domain::events::{self, event};
use crate::features::workflows::domain::model::*;
use crate::features::workflows::domain::schedule_calculator::{self, Recurrence};
use crate::features::workflows::domain::validator;
use crate::shared::error::{DomainError, DomainResult};
use crate::shared::events::DomainEvent;
use crate::shared::ids::{
    ConnectionId, SharedTextId, StepId, StepInputId, WorkflowId, WorkflowInputId,
};
use crate::shared::issue::{Issue, any_blocking, blocking_messages};
use crate::shared::output_format::OutputFileFormat;
use crate::shared::time::Timestamp;

pub const CANVAS_MAX_X: i32 = 4000;
pub const CANVAS_MAX_Y: i32 = 3000;
pub const UNTITLED: &str = "Untitled workflow";

pub static INPUT_NAME_PATTERN: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[A-Za-z][A-Za-z0-9_ ]*$").unwrap());

pub type Events = Vec<DomainEvent>;

/// Fields of a workflow input form.
#[derive(Debug, Clone, Default)]
pub struct WorkflowInputFields {
    pub name: String,
    pub description: Option<String>,
    pub required: bool,
    pub value: Option<String>,
    pub ask_at_run_time: bool,
}

fn opt(value: Option<String>) -> Option<String> {
    value.filter(|v| !v.is_empty())
}

fn clamp_x(x: i32) -> i32 {
    x.clamp(0, CANVAS_MAX_X)
}

fn clamp_y(y: i32) -> i32 {
    y.clamp(0, CANVAS_MAX_Y)
}

/// Rails `Array#to_sentence`.
fn to_sentence(parts: &[String]) -> String {
    match parts {
        [] => String::new(),
        [one] => one.clone(),
        [a, b] => format!("{a} and {b}"),
        [init @ .., last] => format!("{}, and {last}", init.join(", ")),
    }
}

fn unable(errors: &[String]) -> DomainError {
    DomainError::Invalid(format!("Unable to save — {}.", to_sentence(errors)))
}

fn not_found_step() -> DomainError {
    DomainError::NotFound("step")
}

impl Workflow {
    /// A new draft; blank name → "Untitled workflow".
    pub fn create(
        name: &str,
        description: Option<String>,
        fail_fast: bool,
        now: Timestamp,
    ) -> (Self, Events) {
        let id = WorkflowId::new();
        let workflow = Self {
            id,
            name: if blank(name) {
                UNTITLED.into()
            } else {
                name.to_string()
            },
            description: opt(description),
            status: WorkflowStatus::Draft,
            fail_fast,
            last_run_at: None,
            last_run_status: None,
            next_run_at: None,
            created_at: now,
            updated_at: now,
            inputs: Vec::new(),
            texts: Vec::new(),
            steps: Vec::new(),
            connections: Vec::new(),
            schedule: None,
        };
        (
            workflow,
            vec![event(events::WORKFLOW_CREATED, id, json!({}))],
        )
    }

    fn ev(&self, event_type: &str, extra: Value) -> DomainEvent {
        event(event_type, self.id, extra)
    }

    pub fn update_details(
        &mut self,
        name: &str,
        description: Option<String>,
        fail_fast: bool,
    ) -> DomainResult<Events> {
        if blank(name) {
            return Err(DomainError::invalid(
                "Unable to save — the workflow needs a name.",
            ));
        }
        self.name = name.trim().to_string();
        self.description = opt(description);
        self.fail_fast = fail_fast;
        Ok(vec![self.ev(events::WORKFLOW_UPDATED, json!({}))])
    }

    // --- steps ---------------------------------------------------------------

    /// Explicit position is clamped; otherwise the next slot of a 4-wide grid.
    pub fn add_step(
        &mut self,
        kind: StepKind,
        position: Option<(i32, i32)>,
        now: Timestamp,
    ) -> (StepId, Events) {
        let count = self.steps.len() as i32;
        let (x, y) = match position {
            Some((x, y)) => (clamp_x(x), clamp_y(y)),
            None => (120 + (count % 4) * 300, 120 + (count / 4) * 220),
        };
        let step = Step::new(kind, self.next_step_position(), x, y, now);
        let id = step.id;
        self.steps.push(step);
        let events = vec![self.ev(
            events::WORKFLOW_STEP_ADDED,
            json!({ "step_id": id.to_string(), "kind": kind.as_str() }),
        )];
        (id, events)
    }

    /// Copies kind, name, description, prompt, context (including shared-text
    /// links with their vars), allow_failure and the inputs (unconnected).
    /// Model, tools and output fields are not copied.
    pub fn duplicate_step(
        &mut self,
        step_id: StepId,
        now: Timestamp,
    ) -> DomainResult<(StepId, Events)> {
        let source = self.step(step_id).ok_or_else(not_found_step)?.clone();
        let mut step = Step::new(
            source.kind,
            self.next_step_position(),
            source.canvas_x + 40,
            source.canvas_y + 40,
            now,
        );
        step.name = source.name.clone();
        step.description = source.description.clone();
        step.prompt = source.prompt.clone();
        step.additional_context = source.additional_context.clone();
        step.prompt_ref = source.prompt_ref.clone();
        step.context_ref = source.context_ref.clone();
        step.allow_failure = source.allow_failure;
        step.inputs = source
            .inputs
            .iter()
            .map(|input| StepInput {
                id: StepInputId::new(),
                name: input.name.clone(),
                description: input.description.clone(),
                required: true,
                position: input.position,
                workflow_input_id: None,
                created_at: now,
            })
            .collect();
        let id = step.id;
        let kind = step.kind;
        self.steps.push(step);
        Ok((
            id,
            vec![self.ev(
                events::WORKFLOW_STEP_ADDED,
                json!({ "step_id": id.to_string(), "kind": kind.as_str() }),
            )],
        ))
    }

    fn step_updated(&self, step_id: StepId) -> DomainEvent {
        self.ev(
            events::WORKFLOW_STEP_UPDATED,
            json!({ "step_id": step_id.to_string() }),
        )
    }

    pub fn update_step_details(
        &mut self,
        step_id: StepId,
        name: &str,
        description: Option<String>,
        allow_failure: bool,
    ) -> DomainResult<Events> {
        let step = self.step_mut(step_id).ok_or_else(not_found_step)?;
        step.name = name.trim().to_string();
        step.description = opt(description);
        step.allow_failure = allow_failure;
        Ok(vec![self.step_updated(step_id)])
    }

    /// A blank field leaves a linked shared text in place; plain text
    /// replaces the link.
    pub fn update_step_prompt(
        &mut self,
        step_id: StepId,
        prompt: Option<String>,
        additional_context: Option<String>,
    ) -> DomainResult<Events> {
        let step = self.step_mut(step_id).ok_or_else(not_found_step)?;
        if step.prompt_ref.is_none() || prompt.as_deref().is_some_and(|p| !p.trim().is_empty()) {
            step.prompt = opt(prompt);
            step.prompt_ref = None;
        }
        if step.context_ref.is_none()
            || additional_context
                .as_deref()
                .is_some_and(|c| !c.trim().is_empty())
        {
            step.additional_context = opt(additional_context);
            step.context_ref = None;
        }
        Ok(vec![self.step_updated(step_id)])
    }

    /// Renaming the output renames it on the step's outgoing connections.
    pub fn update_step_output(
        &mut self,
        step_id: StepId,
        output_name: &str,
        output_description: Option<String>,
        expected_output: Option<String>,
        format: OutputFileFormat,
    ) -> DomainResult<Events> {
        let new_name = output_name.trim().to_string();
        let step = self.step_mut(step_id).ok_or_else(not_found_step)?;
        let changed = step.output_name.as_deref().unwrap_or("") != new_name;
        step.output_name = opt(Some(new_name.clone()));
        step.output_description = opt(output_description);
        if step.expect_ref.is_none()
            || expected_output
                .as_deref()
                .is_some_and(|e| !e.trim().is_empty())
        {
            step.expected_output = opt(expected_output);
            step.expect_ref = None;
        }
        step.output_file_format = format;
        if changed {
            for connection in self
                .connections
                .iter_mut()
                .filter(|c| c.source_step_id == step_id)
            {
                connection.source_output_name = new_name.clone();
            }
        }
        Ok(vec![self.step_updated(step_id)])
    }

    /// Empty model id clears it; temperature absent removes the setting.
    pub fn update_step_model(
        &mut self,
        step_id: StepId,
        model_id: &str,
        temperature: Option<f64>,
    ) -> DomainResult<Events> {
        if let Some(t) = temperature
            && !(t.is_finite() && (0.0..=2.0).contains(&t))
        {
            return Err(DomainError::invalid(
                "Unable to save — temperature must be a number between 0 and 2.",
            ));
        }
        let step = self.step_mut(step_id).ok_or_else(not_found_step)?;
        match temperature {
            Some(t) => {
                step.model_settings.insert("temperature".into(), json!(t));
            }
            None => {
                step.model_settings.remove("temperature");
            }
        }
        step.model_id = opt(Some(model_id.trim().to_string()));
        Ok(vec![self.step_updated(step_id)])
    }

    pub fn toggle_step_tool(
        &mut self,
        step_id: StepId,
        tool_key: &str,
        catalog: &CatalogView,
    ) -> DomainResult<Events> {
        if self.step(step_id).is_none() {
            return Err(not_found_step());
        }
        if !catalog.tool_enabled(tool_key) {
            return Err(DomainError::invalid(
                "Unable to save — that tool is not available.",
            ));
        }
        let step = self.step_mut(step_id).ok_or_else(not_found_step)?;
        if let Some(i) = step.enabled_tool_ids.iter().position(|k| k == tool_key) {
            step.enabled_tool_ids.remove(i);
        } else {
            step.enabled_tool_ids.push(tool_key.to_string());
        }
        Ok(vec![self.step_updated(step_id)])
    }

    /// Canvas position only: no event, no revalidation.
    pub fn move_step(&mut self, step_id: StepId, x: i32, y: i32) -> DomainResult<()> {
        let step = self.step_mut(step_id).ok_or_else(not_found_step)?;
        step.canvas_x = clamp_x(x);
        step.canvas_y = clamp_y(y);
        Ok(())
    }

    /// Removes the downstream inputs fed by the step's outgoing connections,
    /// then the step with its inputs and connections.
    pub fn delete_step(&mut self, step_id: StepId) -> DomainResult<Events> {
        let step = self.step(step_id).ok_or_else(not_found_step)?;
        let mut removed_inputs: HashSet<StepInputId> = step.inputs.iter().map(|i| i.id).collect();
        removed_inputs.extend(
            self.connections
                .iter()
                .filter(|c| c.source_step_id == step_id)
                .map(|c| c.destination_input_id),
        );
        for s in &mut self.steps {
            s.inputs.retain(|i| !removed_inputs.contains(&i.id));
        }
        self.steps.retain(|s| s.id != step_id);
        self.connections.retain(|c| {
            c.source_step_id != step_id
                && c.destination_step_id != step_id
                && !removed_inputs.contains(&c.destination_input_id)
        });
        Ok(vec![self.ev(
            events::WORKFLOW_STEP_DELETED,
            json!({ "step_id": step_id.to_string() }),
        )])
    }

    // --- step inputs ---------------------------------------------------------

    fn step_input_name_taken(step: &Step, name: &str, except: Option<StepInputId>) -> bool {
        step.inputs
            .iter()
            .any(|i| Some(i.id) != except && i.name.to_lowercase() == name.to_lowercase())
    }

    pub fn add_step_input(
        &mut self,
        step_id: StepId,
        name: &str,
        required: bool,
        now: Timestamp,
    ) -> DomainResult<(StepInputId, Events)> {
        let step = self.step(step_id).ok_or_else(not_found_step)?;
        if blank(name) {
            return Err(DomainError::invalid("Unable to save — name the input."));
        }
        let name = name.trim().to_string();
        if Self::step_input_name_taken(step, &name, None) {
            return Err(unable(&["Name has already been taken".into()]));
        }
        let input = StepInput {
            id: StepInputId::new(),
            name,
            description: None,
            required,
            position: step.next_input_position(),
            workflow_input_id: None,
            created_at: now,
        };
        let id = input.id;
        self.step_mut(step_id)
            .ok_or_else(not_found_step)?
            .inputs
            .push(input);
        Ok((id, vec![self.step_updated(step_id)]))
    }

    /// Removes the input and its incoming connection.
    pub fn remove_step_input(&mut self, input_id: StepInputId) -> DomainResult<Events> {
        let (step, _) = self
            .step_input(input_id)
            .ok_or(DomainError::NotFound("input"))?;
        let step_id = step.id;
        for s in &mut self.steps {
            s.inputs.retain(|i| i.id != input_id);
        }
        self.connections
            .retain(|c| c.destination_input_id != input_id);
        Ok(vec![self.step_updated(step_id)])
    }

    pub fn map_step_input(
        &mut self,
        input_id: StepInputId,
        workflow_input_id: Option<WorkflowInputId>,
    ) -> DomainResult<Events> {
        if self.step_input(input_id).is_none() {
            return Err(DomainError::NotFound("input"));
        }
        if let Some(wi) = workflow_input_id
            && self.input(wi).is_none()
        {
            return Err(DomainError::invalid(
                "Unable to save — that workflow value does not exist.",
            ));
        }
        self.step_input_mut(input_id)
            .ok_or(DomainError::NotFound("input"))?
            .workflow_input_id = workflow_input_id;
        Ok(vec![self.ev(
            events::WORKFLOW_INPUT_MAPPED,
            json!({
                "step_input_id": input_id.to_string(),
                "workflow_input_id": workflow_input_id.map(|i| i.to_string()),
            }),
        )])
    }

    // --- workflow inputs -----------------------------------------------------

    /// Rails `WorkflowInput` validations as `errors.full_messages`.
    fn workflow_input_errors(
        &self,
        fields: &WorkflowInputFields,
        except: Option<WorkflowInputId>,
    ) -> Vec<String> {
        let mut errors = Vec::new();
        let lower = fields.name.to_lowercase();
        if self
            .inputs
            .iter()
            .any(|i| Some(i.id) != except && i.name.to_lowercase() == lower)
        {
            errors.push("Name has already been taken".into());
        }
        if !INPUT_NAME_PATTERN.is_match(&fields.name) {
            errors.push(
                "Name must start with a letter and use letters, numbers, spaces or underscores"
                    .into(),
            );
        }
        if fields.required && !fields.ask_at_run_time && !present(&fields.value) {
            errors.push("Value can't be blank".into());
        }
        errors
    }

    fn normalize_input_fields(fields: WorkflowInputFields) -> DomainResult<WorkflowInputFields> {
        if blank(&fields.name) {
            return Err(DomainError::invalid(
                "Unable to save — name the workflow value.",
            ));
        }
        Ok(WorkflowInputFields {
            name: fields.name.trim().to_string(),
            description: opt(fields.description),
            value: opt(fields.value),
            ..fields
        })
    }

    pub fn add_workflow_input(
        &mut self,
        fields: WorkflowInputFields,
        now: Timestamp,
    ) -> DomainResult<(WorkflowInputId, Events)> {
        let fields = Self::normalize_input_fields(fields)?;
        let errors = self.workflow_input_errors(&fields, None);
        if !errors.is_empty() {
            return Err(unable(&errors));
        }
        let input = WorkflowInput {
            id: WorkflowInputId::new(),
            name: fields.name,
            description: fields.description,
            required: fields.required,
            ask_at_run_time: fields.ask_at_run_time,
            value: fields.value,
            position: self.next_input_position(),
            created_at: now,
        };
        let id = input.id;
        let name = input.name.clone();
        self.inputs.push(input);
        Ok((
            id,
            vec![self.ev(
                events::WORKFLOW_INPUT_MAPPED,
                json!({ "workflow_input_id": id.to_string(), "name": name }),
            )],
        ))
    }

    pub fn update_workflow_input(
        &mut self,
        input_id: WorkflowInputId,
        fields: WorkflowInputFields,
    ) -> DomainResult<Events> {
        if self.input(input_id).is_none() {
            return Err(DomainError::NotFound("workflow input"));
        }
        let fields = Self::normalize_input_fields(fields)?;
        let errors = self.workflow_input_errors(&fields, Some(input_id));
        if !errors.is_empty() {
            return Err(unable(&errors));
        }
        let input = self
            .inputs
            .iter_mut()
            .find(|i| i.id == input_id)
            .ok_or(DomainError::NotFound("workflow input"))?;
        input.name = fields.name;
        input.description = fields.description;
        input.required = fields.required;
        input.value = fields.value;
        input.ask_at_run_time = fields.ask_at_run_time;
        Ok(vec![self.ev(events::WORKFLOW_UPDATED, json!({}))])
    }

    /// Mapped step inputs are unmapped; its schedule values are deleted.
    pub fn remove_workflow_input(&mut self, input_id: WorkflowInputId) -> DomainResult<Events> {
        if self.input(input_id).is_none() {
            return Err(DomainError::NotFound("workflow input"));
        }
        self.inputs.retain(|i| i.id != input_id);
        for input in self.steps.iter_mut().flat_map(|s| s.inputs.iter_mut()) {
            if input.workflow_input_id == Some(input_id) {
                input.workflow_input_id = None;
            }
        }
        if let Some(schedule) = &mut self.schedule {
            schedule.values.retain(|v| v.workflow_input_id != input_id);
        }
        Ok(vec![self.ev(
            events::WORKFLOW_UPDATED,
            json!({ "removed_workflow_input_id": input_id.to_string() }),
        )])
    }

    // --- shared texts --------------------------------------------------------

    /// Key validation, mirroring the `WorkflowInput` name rules.
    fn shared_text_key_errors(&self, key: &str, except: Option<SharedTextId>) -> Vec<String> {
        let mut errors = Vec::new();
        let lower = key.to_lowercase();
        if self
            .texts
            .iter()
            .any(|t| Some(t.id) != except && t.key.to_lowercase() == lower)
        {
            errors.push("Name has already been taken".into());
        }
        if !INPUT_NAME_PATTERN.is_match(key) {
            errors.push(
                "Name must start with a letter and use letters, numbers, spaces or underscores"
                    .into(),
            );
        }
        errors
    }

    pub fn add_text(
        &mut self,
        key: &str,
        description: Option<String>,
        body: &str,
    ) -> DomainResult<(SharedTextId, Events)> {
        let key = key.trim();
        if blank(key) {
            return Err(DomainError::invalid(
                "Unable to save — name the shared text.",
            ));
        }
        let errors = self.shared_text_key_errors(key, None);
        if !errors.is_empty() {
            return Err(unable(&errors));
        }
        let text = SharedText {
            id: SharedTextId::new(),
            key: key.to_string(),
            description: opt(description),
            body: body.to_string(),
            position: self.next_text_position(),
        };
        let id = text.id;
        self.texts.push(text);
        Ok((id, vec![self.ev(events::WORKFLOW_UPDATED, json!({}))]))
    }

    pub fn update_text(
        &mut self,
        text_id: SharedTextId,
        key: &str,
        description: Option<String>,
        body: &str,
    ) -> DomainResult<Events> {
        if self.text(text_id).is_none() {
            return Err(DomainError::NotFound("shared text"));
        }
        let key = key.trim();
        if blank(key) {
            return Err(DomainError::invalid(
                "Unable to save — name the shared text.",
            ));
        }
        let errors = self.shared_text_key_errors(key, Some(text_id));
        if !errors.is_empty() {
            return Err(unable(&errors));
        }
        let text = self
            .text_mut(text_id)
            .ok_or(DomainError::NotFound("shared text"))?;
        text.key = key.to_string();
        text.description = opt(description);
        text.body = body.to_string();
        Ok(vec![self.ev(events::WORKFLOW_UPDATED, json!({}))])
    }

    /// Refused while any step still links the text.
    pub fn remove_text(&mut self, text_id: SharedTextId) -> DomainResult<Events> {
        let text = self
            .text(text_id)
            .ok_or(DomainError::NotFound("shared text"))?;
        let used_by = self.steps_using_text(text_id).len();
        if used_by > 0 {
            return Err(DomainError::precondition(
                "SHARED_TEXT_IN_USE",
                format!(
                    "“{}” is used by {} steps. Detach them first.",
                    text.key, used_by
                ),
            ));
        }
        self.texts.retain(|t| t.id != text_id);
        Ok(vec![self.ev(events::WORKFLOW_UPDATED, json!({}))])
    }

    /// Links (or detaches) a step field. Detaching copies the rendered text
    /// into the step's own field, so nothing is lost.
    pub fn set_step_text_ref(
        &mut self,
        step_id: StepId,
        field: TextField,
        text_ref: Option<TextRef>,
    ) -> DomainResult<Events> {
        let Some(step) = self.step(step_id) else {
            return Err(not_found_step());
        };
        if step.kind == StepKind::Helper {
            return Err(DomainError::invalid(
                "Unable to save — helper steps don't use prompts, context or expected output.",
            ));
        }
        if let Some(r) = &text_ref
            && self.text(r.text_id).is_none()
        {
            return Err(DomainError::NotFound("shared text"));
        }
        let has_ref = match field {
            TextField::Prompt => step.prompt_ref.is_some(),
            TextField::Context => step.context_ref.is_some(),
            TextField::Expect => step.expect_ref.is_some(),
        };
        // The rendered copy for a detach, taken before the mutable borrow.
        let detached = match (&text_ref, has_ref) {
            (None, true) => Some(match field {
                TextField::Prompt => self.effective_prompt(step),
                TextField::Context => self.effective_context(step),
                TextField::Expect => self.effective_expect(step),
            }),
            _ => None,
        };
        let step = self.step_mut(step_id).ok_or_else(not_found_step)?;
        match (field, text_ref, detached) {
            (TextField::Prompt, Some(r), _) => {
                step.prompt = None;
                step.prompt_ref = Some(r);
            }
            (TextField::Prompt, None, Some(rendered)) => {
                step.prompt = rendered;
                step.prompt_ref = None;
            }
            (TextField::Context, Some(r), _) => {
                step.additional_context = None;
                step.context_ref = Some(r);
            }
            (TextField::Context, None, Some(rendered)) => {
                step.additional_context = rendered;
                step.context_ref = None;
            }
            (TextField::Expect, Some(r), _) => {
                step.expected_output = None;
                step.expect_ref = Some(r);
            }
            (TextField::Expect, None, Some(rendered)) => {
                step.expected_output = rendered;
                step.expect_ref = None;
            }
            // Detaching a field that is not linked changes nothing.
            (_, None, None) => {}
        }
        Ok(vec![self.step_updated(step_id)])
    }

    /// "Make shared": creates a shared text from the step's own field, links
    /// the step with empty vars and clears the field, in one change.
    pub fn extract_text(
        &mut self,
        step_id: StepId,
        field: TextField,
        key: &str,
    ) -> DomainResult<(SharedTextId, Events)> {
        let step = self.step(step_id).ok_or_else(not_found_step)?;
        if step.kind == StepKind::Helper {
            return Err(DomainError::invalid(
                "Unable to save — helper steps don't use prompts, context or expected output.",
            ));
        }
        let Some(body) = self.own_text(step, field).cloned().filter(|b| !blank(b)) else {
            return Err(DomainError::invalid(
                "There is nothing to share yet. Write the text first.",
            ));
        };
        let key = key.trim();
        if blank(key) {
            return Err(DomainError::invalid(
                "Unable to save — name the shared text.",
            ));
        }
        let errors = self.shared_text_key_errors(key, None);
        if !errors.is_empty() {
            return Err(unable(&errors));
        }
        let text_id = SharedTextId::new();
        self.texts.push(SharedText {
            id: text_id,
            key: key.to_string(),
            description: None,
            body,
            position: self.next_text_position(),
        });
        let step = self.step_mut(step_id).ok_or_else(not_found_step)?;
        let text_ref = TextRef {
            text_id,
            vars: BTreeMap::new(),
        };
        match field {
            TextField::Prompt => {
                step.prompt = None;
                step.prompt_ref = Some(text_ref);
            }
            TextField::Context => {
                step.additional_context = None;
                step.context_ref = Some(text_ref);
            }
            TextField::Expect => {
                step.expected_output = None;
                step.expect_ref = Some(text_ref);
            }
        }
        Ok((
            text_id,
            vec![
                self.ev(events::WORKFLOW_UPDATED, json!({})),
                self.step_updated(step_id),
            ],
        ))
    }

    // --- connections ---------------------------------------------------------

    fn build_connection(
        &mut self,
        source: StepId,
        input: StepInputId,
        now: Timestamp,
    ) -> (ConnectionId, DomainEvent) {
        let destination = self
            .step_input(input)
            .map(|(s, _)| s.id)
            .expect("destination input exists");
        let output = self
            .step(source)
            .and_then(|s| s.output_name.clone())
            .unwrap_or_default();
        let connection = Connection {
            id: ConnectionId::new(),
            source_step_id: source,
            source_output_name: output,
            destination_step_id: destination,
            destination_input_id: input,
            created_at: now,
        };
        let id = connection.id;
        self.connections.push(connection);
        let event = self.ev(
            events::WORKFLOW_CONNECTION_CREATED,
            json!({
                "source_step_id": source.to_string(),
                "destination_input_id": input.to_string(),
            }),
        );
        (id, event)
    }

    /// Removes the input's incoming connection and workflow-value mapping.
    fn disconnect_input(&mut self, input: StepInputId) {
        self.connections.retain(|c| c.destination_input_id != input);
        if let Some(i) = self.step_input_mut(input) {
            i.workflow_input_id = None;
        }
    }

    pub fn create_connection(
        &mut self,
        source_id: StepId,
        input_id: StepInputId,
        replace_existing: bool,
        now: Timestamp,
    ) -> DomainResult<(ConnectionId, Events)> {
        let (Some(source), Some((destination, input))) =
            (self.step(source_id), self.step_input(input_id))
        else {
            return Err(DomainError::invalid(
                "Unable to save — choose an output and an input to connect.",
            ));
        };
        if source.id == destination.id {
            return Err(DomainError::invalid(
                "Unable to save — a step cannot connect to itself.",
            ));
        }
        if !present(&source.output_name) {
            return Err(DomainError::invalid(format!(
                "Unable to save — “{}” has no named output yet.",
                source.name
            )));
        }
        let fed = self.connected(input_id) || input.workflow_input_id.is_some();
        if fed && !replace_existing {
            let existing = self
                .incoming_connection(input_id)
                .and_then(|c| self.step(c.source_step_id))
                .map(|s| s.name.clone())
                .or_else(|| {
                    input
                        .workflow_input_id
                        .and_then(|wi| self.input(wi))
                        .map(|i| i.name.clone())
                })
                .unwrap_or_default();
            return Err(DomainError::Precondition {
                code: "CONNECTION_SOURCE_EXISTS",
                reason: format!(
                    "“{}” already has a source. Connecting from {} replaces it.",
                    input.name, source.name
                ),
                meta: vec![
                    ("existing_source_label".into(), existing),
                    ("source_label".into(), source.name.clone()),
                    ("input_name".into(), input.name.clone()),
                ],
                issues: Vec::new(),
            });
        }
        if self
            .dag()
            .adds_cycle(&source_id.to_string(), &destination.id.to_string())
        {
            return Err(DomainError::invalid(
                "Unable to save — that connection would create a cycle.",
            ));
        }
        if fed {
            self.disconnect_input(input_id);
        }
        let (id, event) = self.build_connection(source_id, input_id, now);
        Ok((id, vec![event]))
    }

    /// Drag an output onto a card: new optional input named after the output.
    pub fn connect_output_to_step(
        &mut self,
        source_id: StepId,
        target_id: StepId,
        now: Timestamp,
    ) -> DomainResult<(ConnectionId, StepInputId, Events)> {
        let (Some(source), Some(target)) = (self.step(source_id), self.step(target_id)) else {
            return Err(DomainError::invalid(
                "Unable to save — choose an output and an input to connect.",
            ));
        };
        if source.id == target.id {
            return Err(DomainError::invalid(
                "Unable to save — a step cannot connect to itself.",
            ));
        }
        let Some(output) = source.output_name.clone().filter(|o| !blank(o)) else {
            return Err(DomainError::invalid(format!(
                "Unable to save — “{}” has no named output yet.",
                source.name
            )));
        };
        if Self::step_input_name_taken(target, &output, None) {
            return Err(unable(&["Name has already been taken".into()]));
        }
        if self
            .dag()
            .adds_cycle(&source_id.to_string(), &target_id.to_string())
        {
            return Err(DomainError::invalid(
                "Unable to save — that connection would create a cycle.",
            ));
        }
        let input = StepInput {
            id: StepInputId::new(),
            name: output,
            description: None,
            required: false,
            position: target.next_input_position(),
            workflow_input_id: None,
            created_at: now,
        };
        let input_id = input.id;
        self.step_mut(target_id)
            .ok_or_else(not_found_step)?
            .inputs
            .push(input);
        let (connection_id, created) = self.build_connection(source_id, input_id, now);
        Ok((
            connection_id,
            input_id,
            vec![created, self.step_updated(target_id)],
        ))
    }

    /// Removes the connection together with its destination input.
    pub fn remove_connection(&mut self, connection_id: ConnectionId) -> DomainResult<Events> {
        let connection = self
            .connections
            .iter()
            .find(|c| c.id == connection_id)
            .ok_or(DomainError::NotFound("connection"))?;
        let input = connection.destination_input_id;
        for s in &mut self.steps {
            s.inputs.retain(|i| i.id != input);
        }
        self.connections
            .retain(|c| c.id != connection_id && c.destination_input_id != input);
        Ok(vec![self.ev(
            events::WORKFLOW_CONNECTION_REMOVED,
            json!({ "connection_id": connection_id.to_string() }),
        )])
    }

    // --- schedule ------------------------------------------------------------

    /// `None` removes the schedule. Enabled only when not a draft.
    pub fn save_schedule(
        &mut self,
        recurrence: Option<Recurrence>,
        timezone: &str,
        enabled: bool,
        now: Timestamp,
    ) -> DomainResult<Events> {
        let Some(recurrence) = recurrence else {
            self.schedule = None;
            self.next_run_at = None;
            return Ok(vec![
                self.ev(events::WORKFLOW_SCHEDULE_CHANGED, json!({ "mode": "none" })),
            ]);
        };
        let timezone = timezone.trim();
        let cron = schedule_calculator::cron_for(&recurrence)
            .filter(|_| schedule_calculator::parse_timezone(timezone).is_some())
            .ok_or_else(|| {
                DomainError::invalid("Unable to save — the recurrence or timezone is invalid.")
            })?;
        let enabled = enabled && self.status != WorkflowStatus::Draft;
        let next = if enabled {
            schedule_calculator::next_run_at(&cron, timezone, now)
        } else {
            None
        };
        let schedule = self.schedule.get_or_insert_with(|| Schedule::new(now));
        schedule.enabled = enabled;
        schedule.cron_expression = Some(cron.clone());
        schedule.timezone = Some(timezone.to_string());
        schedule.human_description = Some(schedule_calculator::human_description_for(
            &recurrence,
            timezone,
        ));
        schedule.next_run_at = next;
        self.next_run_at = if self.status == WorkflowStatus::Active {
            next
        } else {
            None
        };
        Ok(vec![self.ev(
            events::WORKFLOW_SCHEDULE_CHANGED,
            json!({ "mode": recurrence.mode(), "cron_expression": cron }),
        )])
    }

    pub fn set_schedule_value(
        &mut self,
        input_id: WorkflowInputId,
        value: &str,
        now: Timestamp,
    ) -> DomainResult<()> {
        if self.input(input_id).is_none() {
            return Err(DomainError::NotFound("workflow input"));
        }
        let schedule = self.schedule.as_mut().ok_or_else(|| {
            DomainError::invalid("Unable to save — the workflow has no schedule yet.")
        })?;
        let value = opt(Some(value.to_string()));
        match schedule
            .values
            .iter_mut()
            .find(|v| v.workflow_input_id == input_id)
        {
            Some(existing) => existing.value = value,
            None => schedule.values.push(ScheduleValue {
                id: Default::default(),
                workflow_input_id: input_id,
                value,
                created_at: now,
            }),
        }
        Ok(())
    }

    // --- lifecycle -----------------------------------------------------------

    /// Computes (and stores on the schedule) the next run when the schedule is
    /// enabled and configured.
    fn recompute_next_run(&mut self, now: Timestamp) -> Option<Timestamp> {
        let schedule = self.schedule.as_mut()?;
        if !(schedule.enabled && schedule.configured()) {
            return None;
        }
        let next = schedule_calculator::next_run_at(
            schedule.cron_expression.as_deref()?,
            schedule.timezone.as_deref()?,
            now,
        );
        schedule.next_run_at = next;
        next
    }

    pub fn activate(&mut self, catalog: &CatalogView, now: Timestamp) -> DomainResult<Events> {
        let issues = validator::validate(self, catalog);
        if any_blocking(&issues) {
            return Err(DomainError::Precondition {
                code: "VALIDATION_FAILED",
                reason: "Resolve the issues before activating the workflow.".into(),
                meta: Vec::new(),
                issues,
            });
        }
        self.status = WorkflowStatus::Active;
        self.next_run_at = self.recompute_next_run(now);
        Ok(vec![self.ev(events::WORKFLOW_ACTIVATED, json!({}))])
    }

    pub fn pause(&mut self) -> Events {
        self.status = WorkflowStatus::Paused;
        self.next_run_at = None;
        if let Some(schedule) = &mut self.schedule {
            schedule.next_run_at = None;
        }
        vec![self.ev(events::WORKFLOW_PAUSED, json!({}))]
    }

    /// Valid → active with the next run recomputed; invalid → needs_attention.
    pub fn resume(&mut self, catalog: &CatalogView, now: Timestamp) -> (bool, Vec<Issue>, Events) {
        let issues = validator::validate(self, catalog);
        if any_blocking(&issues) {
            let events = self.mark_needs_attention(blocking_messages(&issues));
            return (false, issues, events);
        }
        self.status = WorkflowStatus::Active;
        self.next_run_at = self.recompute_next_run(now);
        let events = vec![self.ev(events::WORKFLOW_RESUMED, json!({ "issues": [] }))];
        (true, issues, events)
    }

    /// After an edit: an active workflow that became invalid moves to
    /// needs_attention (which never auto-heals).
    pub fn revalidate(&mut self, catalog: &CatalogView) -> (Vec<Issue>, Events) {
        let issues = validator::validate(self, catalog);
        let events = if self.status == WorkflowStatus::Active && any_blocking(&issues) {
            self.mark_needs_attention(blocking_messages(&issues))
        } else {
            Vec::new()
        };
        (issues, events)
    }

    pub fn mark_needs_attention(&mut self, messages: Vec<String>) -> Events {
        self.status = WorkflowStatus::NeedsAttention;
        self.next_run_at = None;
        vec![events::needs_attention(self.id, messages)]
    }

    pub fn uses_any_model(&self, model_ids: &[String]) -> bool {
        self.steps
            .iter()
            .filter_map(|s| s.model_id.as_deref())
            .any(|m| model_ids.iter().any(|id| id == m))
    }
}
