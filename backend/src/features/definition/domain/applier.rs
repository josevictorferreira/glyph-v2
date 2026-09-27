//! Applies a parsed document onto a workflow aggregate (Rails
//! `Definition::Applier`), in the same order and with the same events:
//! attributes, absent steps, inputs, steps, step inputs, connections,
//! schedule. Pure: the caller checks the fingerprint, revalidates and saves.

use std::collections::HashMap;

use serde_json::{Map, Value, json};

use crate::features::definition::domain::layout;
use crate::features::definition::domain::types::*;
use crate::features::workflows::Events;
use crate::features::workflows::events::{self, event};
use crate::features::workflows::model::*;
use crate::features::workflows::schedule_calculator;
use crate::shared::ids::*;
use crate::shared::time::Timestamp;

fn opt(value: &Option<String>) -> Option<String> {
    value.clone().filter(|v| !v.is_empty())
}

pub fn apply(workflow: &mut Workflow, document: &Document, now: Timestamp) -> Events {
    let mut a = Applier {
        wf: workflow,
        doc: document,
        now,
        events: Vec::new(),
    };
    a.attributes();
    a.delete_absent_steps();
    a.inputs();
    let step_ids = a.upsert_steps();
    a.step_inputs(&step_ids);
    a.connections(&step_ids);
    a.schedule();
    a.events
}

struct Applier<'a> {
    wf: &'a mut Workflow,
    doc: &'a Document,
    now: Timestamp,
    events: Events,
}

impl Applier<'_> {
    fn publish(&mut self, event_type: &str, extra: Value) {
        self.events.push(event(event_type, self.wf.id, extra));
    }

    fn attributes(&mut self) {
        let description = opt(&self.doc.description);
        if self.wf.name != self.doc.name
            || self.wf.description != description
            || self.wf.fail_fast != self.doc.fail_fast
        {
            self.wf.name = self.doc.name.clone();
            self.wf.description = description;
            self.wf.fail_fast = self.doc.fail_fast;
            self.publish(events::WORKFLOW_UPDATED, json!({}));
        }
    }

    /// Removes steps the document no longer lists (with their inputs and
    /// connections; downstream inputs stay).
    fn delete_absent_steps(&mut self) {
        let keep: Vec<StepId> = self.doc.steps.iter().filter_map(|s| s.id).collect();
        let gone: Vec<StepId> = self
            .wf
            .steps
            .iter()
            .map(|s| s.id)
            .filter(|id| !keep.contains(id))
            .collect();
        for id in gone {
            let inputs: Vec<StepInputId> = self
                .wf
                .step(id)
                .map(|s| s.inputs.iter().map(|i| i.id).collect())
                .unwrap_or_default();
            self.wf.steps.retain(|s| s.id != id);
            self.wf.connections.retain(|c| {
                c.source_step_id != id
                    && c.destination_step_id != id
                    && !inputs.contains(&c.destination_input_id)
            });
            self.publish(
                events::WORKFLOW_STEP_DELETED,
                json!({ "step_id": id.to_string() }),
            );
        }
    }

    fn inputs(&mut self) {
        let mut remaining: Vec<WorkflowInputId> = self.wf.inputs.iter().map(|i| i.id).collect();
        for (index, def) in self.doc.inputs.iter().enumerate() {
            let position = index as i32 + 1;
            let lower = def.name.to_lowercase();
            let description = opt(&def.description);
            let found = self
                .wf
                .inputs
                .iter()
                .position(|i| remaining.contains(&i.id) && i.name.to_lowercase() == lower);
            match found {
                Some(i) => {
                    let id = self.wf.inputs[i].id;
                    remaining.retain(|r| *r != id);
                    let record = &mut self.wf.inputs[i];
                    let changed = record.name != def.name
                        || record.description != description
                        || record.value != def.value
                        || record.required != def.required
                        || record.ask_at_run_time != def.ask;
                    record.position = position;
                    if changed {
                        record.name = def.name.clone();
                        record.description = description;
                        record.value = def.value.clone();
                        record.required = def.required;
                        record.ask_at_run_time = def.ask;
                        self.publish(events::WORKFLOW_UPDATED, json!({}));
                    }
                }
                None => {
                    let id = WorkflowInputId::new();
                    self.wf.inputs.push(WorkflowInput {
                        id,
                        name: def.name.clone(),
                        description,
                        required: def.required,
                        ask_at_run_time: def.ask,
                        value: def.value.clone(),
                        position,
                        created_at: self.now,
                    });
                    self.publish(
                        events::WORKFLOW_INPUT_MAPPED,
                        json!({ "workflow_input_id": id.to_string(), "name": def.name }),
                    );
                }
            }
        }
        for id in remaining {
            self.wf.inputs.retain(|i| i.id != id);
            for input in self.wf.steps.iter_mut().flat_map(|s| s.inputs.iter_mut()) {
                if input.workflow_input_id == Some(id) {
                    input.workflow_input_id = None;
                }
            }
            if let Some(schedule) = &mut self.wf.schedule {
                schedule.values.retain(|v| v.workflow_input_id != id);
            }
            self.publish(
                events::WORKFLOW_UPDATED,
                json!({ "removed_workflow_input_id": id.to_string() }),
            );
        }
        self.wf.inputs.sort_by_key(|i| (i.position, i.created_at));
    }

    fn step_edges(&self) -> Vec<(String, String)> {
        self.doc
            .steps
            .iter()
            .flat_map(|def| {
                def.inputs.iter().filter_map(move |i| match &i.source {
                    Some(Source {
                        kind: SourceKind::Step,
                        name,
                    }) => {
                        let lower = name.to_lowercase();
                        let source = self
                            .doc
                            .steps
                            .iter()
                            .find(|s| s.name.to_lowercase() == lower)
                            .map_or_else(|| name.clone(), |s| s.name.clone());
                        Some((source, def.name.clone()))
                    }
                    _ => None,
                })
            })
            .collect()
    }

    /// Returns the step id for each document step, in document order.
    fn upsert_steps(&mut self) -> Vec<StepId> {
        let new_names: Vec<String> = self
            .doc
            .steps
            .iter()
            .filter(|s| s.id.is_none())
            .map(|s| s.name.clone())
            .collect();
        let existing: Vec<(String, i32, i32)> = self
            .wf
            .steps
            .iter()
            .map(|s| (s.name.clone(), s.canvas_x, s.canvas_y))
            .collect();
        let layout = layout::positions(&new_names, &existing, &self.step_edges());

        let mut ids = Vec::new();
        for (index, def) in self.doc.steps.iter().enumerate() {
            let position = index as i32 + 1;
            let mut settings = Map::new();
            if let Some(t) = def.temperature {
                settings.insert("temperature".into(), json!(t));
            }
            match def
                .id
                .and_then(|id| self.wf.steps.iter().position(|s| s.id == id))
            {
                Some(i) => {
                    let before = self.wf.steps[i].clone();
                    let step = &mut self.wf.steps[i];
                    assign(step, def, settings);
                    step.position = position;
                    let id = step.id;
                    let new_output = step.output_name.clone().unwrap_or_default();
                    let changed = *step != before;
                    if before.output_name != step.output_name {
                        for c in self
                            .wf
                            .connections
                            .iter_mut()
                            .filter(|c| c.source_step_id == id)
                        {
                            c.source_output_name = new_output.clone();
                        }
                    }
                    if changed {
                        self.publish(
                            events::WORKFLOW_STEP_UPDATED,
                            json!({ "step_id": id.to_string() }),
                        );
                    }
                    ids.push(id);
                }
                None => {
                    let (x, y) = layout
                        .get(&def.name)
                        .copied()
                        .unwrap_or((layout::ROOT_X, layout::ROOT_Y));
                    let mut step = Step::new(def.kind, position, x, y, self.now);
                    assign(&mut step, def, settings);
                    let id = step.id;
                    self.wf.steps.push(step);
                    self.publish(
                        events::WORKFLOW_STEP_ADDED,
                        json!({ "step_id": id.to_string(), "kind": def.kind.as_str() }),
                    );
                    ids.push(id);
                }
            }
        }
        self.wf.steps.sort_by_key(|s| (s.position, s.created_at));
        ids
    }

    fn workflow_input_for(&self, input: &StepInputDef) -> Option<WorkflowInputId> {
        match &input.source {
            Some(Source {
                kind: SourceKind::WorkflowInput,
                name,
            }) => {
                let lower = name.to_lowercase();
                self.wf
                    .inputs
                    .iter()
                    .find(|i| i.name.to_lowercase() == lower)
                    .map(|i| i.id)
            }
            _ => None,
        }
    }

    fn step_inputs(&mut self, step_ids: &[StepId]) {
        for (def, step_id) in self.doc.steps.iter().zip(step_ids) {
            let mapped: Vec<Option<WorkflowInputId>> = def
                .inputs
                .iter()
                .map(|i| self.workflow_input_for(i))
                .collect();
            let now = self.now;
            let mut new_events = Vec::new();
            let Some(step) = self.wf.step_mut(*step_id) else {
                continue;
            };
            let mut remaining: Vec<StepInputId> = step.inputs.iter().map(|i| i.id).collect();
            let mut changed = false;
            for (index, (input, workflow_input_id)) in def.inputs.iter().zip(mapped).enumerate() {
                let position = index as i32 + 1;
                let lower = input.name.to_lowercase();
                let description = opt(&input.description);
                let found = step
                    .inputs
                    .iter()
                    .position(|i| remaining.contains(&i.id) && i.name.to_lowercase() == lower);
                let i = match found {
                    Some(i) => {
                        remaining.retain(|r| *r != step.inputs[i].id);
                        i
                    }
                    None => {
                        step.inputs.push(StepInput {
                            id: StepInputId::new(),
                            name: input.name.clone(),
                            description: None,
                            required: true,
                            position,
                            workflow_input_id: None,
                            created_at: now,
                        });
                        changed = true;
                        step.inputs.len() - 1
                    }
                };
                let record = &mut step.inputs[i];
                let differs = record.name != input.name
                    || record.description != description
                    || record.required != input.required
                    || record.workflow_input_id != workflow_input_id
                    || record.position != position;
                if differs {
                    let mapping_changed = record.workflow_input_id != workflow_input_id;
                    record.name = input.name.clone();
                    record.description = description;
                    record.required = input.required;
                    record.workflow_input_id = workflow_input_id;
                    record.position = position;
                    if let Some(wi) = workflow_input_id
                        && mapping_changed
                    {
                        new_events.push((record.id, wi));
                    }
                    changed = true;
                }
            }
            let removed = !remaining.is_empty();
            step.inputs.retain(|i| !remaining.contains(&i.id));
            step.inputs.sort_by_key(|i| (i.position, i.created_at));
            self.wf
                .connections
                .retain(|c| !remaining.contains(&c.destination_input_id));
            for (input_id, wi) in new_events {
                self.publish(
                    events::WORKFLOW_INPUT_MAPPED,
                    json!({ "step_input_id": input_id.to_string(), "workflow_input_id": wi.to_string() }),
                );
            }
            if changed || removed {
                self.publish(
                    events::WORKFLOW_STEP_UPDATED,
                    json!({ "step_id": step_id.to_string() }),
                );
            }
        }
    }

    fn step_by_name(&self, name: &str) -> Option<&Step> {
        let lower = name.to_lowercase();
        self.wf
            .steps
            .iter()
            .find(|s| s.name.to_lowercase() == lower)
    }

    fn connections(&mut self, step_ids: &[StepId]) {
        // (source step, destination input) → output name, in document order.
        let mut desired: Vec<((StepId, StepInputId), String)> = Vec::new();
        for (def, step_id) in self.doc.steps.iter().zip(step_ids) {
            for input in &def.inputs {
                let Some(Source {
                    kind: SourceKind::Step,
                    name,
                }) = &input.source
                else {
                    continue;
                };
                let Some(source) = self.step_by_name(name) else {
                    continue;
                };
                let lower = input.name.to_lowercase();
                let Some(destination) = self
                    .wf
                    .step(*step_id)
                    .and_then(|s| s.inputs.iter().find(|i| i.name.to_lowercase() == lower))
                else {
                    continue;
                };
                let key = (source.id, destination.id);
                let output = source.output_name.clone().unwrap_or_default();
                desired.retain(|(k, _)| *k != key);
                desired.push((key, output));
            }
        }
        let mut desired_map: HashMap<(StepId, StepInputId), String> =
            desired.iter().cloned().collect();

        let existing: Vec<(ConnectionId, StepId, StepInputId)> = self
            .wf
            .connections
            .iter()
            .map(|c| (c.id, c.source_step_id, c.destination_input_id))
            .collect();
        for (id, source, input) in existing {
            match desired_map.remove(&(source, input)) {
                None => {
                    self.wf.connections.retain(|c| c.id != id);
                    self.publish(
                        events::WORKFLOW_CONNECTION_REMOVED,
                        json!({ "connection_id": id.to_string() }),
                    );
                }
                Some(output) => {
                    if let Some(c) = self.wf.connections.iter_mut().find(|c| c.id == id) {
                        c.source_output_name = output;
                    }
                }
            }
        }
        for (key, output) in desired {
            let Some(output) = desired_map.remove(&key).map(|_| output) else {
                continue;
            };
            let (source, input) = key;
            let Some(destination) = self.wf.step_input(input).map(|(s, _)| s.id) else {
                continue;
            };
            self.wf.connections.push(Connection {
                id: ConnectionId::new(),
                source_step_id: source,
                source_output_name: output,
                destination_step_id: destination,
                destination_input_id: input,
                created_at: self.now,
            });
            self.publish(
                events::WORKFLOW_CONNECTION_CREATED,
                json!({ "source_step_id": source.to_string(), "destination_input_id": input.to_string() }),
            );
        }
    }

    fn schedule(&mut self) {
        let Some(def) = &self.doc.schedule else {
            if self.wf.schedule.take().is_some() {
                self.wf.next_run_at = None;
                self.publish(events::WORKFLOW_SCHEDULE_CHANGED, json!({ "mode": "none" }));
            }
            return;
        };
        let active = self.wf.status == WorkflowStatus::Active;
        let next = if def.enabled && active {
            schedule_calculator::next_run_at(&def.cron, &def.timezone, self.now)
        } else {
            None
        };
        // Values by exact input name, as Rails.
        let desired: Vec<(WorkflowInputId, String)> = def
            .values
            .iter()
            .filter_map(|(name, value)| {
                self.wf
                    .inputs
                    .iter()
                    .find(|i| i.name == *name)
                    .map(|i| (i.id, value.clone()))
            })
            .collect();
        let description = opt(&def.description);

        if let Some(existing) = &self.wf.schedule {
            let mut current: Vec<(WorkflowInputId, String)> = existing
                .values
                .iter()
                .filter_map(|v| v.value.clone().map(|value| (v.workflow_input_id, value)))
                .collect();
            let mut wanted = desired.clone();
            current.sort();
            wanted.sort();
            if existing.enabled == def.enabled
                && existing.cron_expression.as_deref() == Some(def.cron.as_str())
                && existing.timezone.as_deref() == Some(def.timezone.as_str())
                && existing.human_description == description
                && existing.next_run_at == next
                && current == wanted
            {
                return;
            }
        }

        let now = self.now;
        let schedule = self.wf.schedule.get_or_insert_with(|| Schedule::new(now));
        schedule.enabled = def.enabled;
        schedule.cron_expression = Some(def.cron.clone());
        schedule.timezone = Some(def.timezone.clone());
        schedule.human_description = description;
        schedule.next_run_at = next;
        schedule
            .values
            .retain(|v| desired.iter().any(|(id, _)| *id == v.workflow_input_id));
        for (input, value) in &desired {
            match schedule
                .values
                .iter_mut()
                .find(|v| v.workflow_input_id == *input)
            {
                Some(existing) => existing.value = Some(value.clone()),
                None => schedule.values.push(ScheduleValue {
                    id: ScheduleValueId::new(),
                    workflow_input_id: *input,
                    value: Some(value.clone()),
                    created_at: now,
                }),
            }
        }
        self.wf.next_run_at = if active { next } else { None };
        self.publish(
            events::WORKFLOW_SCHEDULE_CHANGED,
            json!({ "mode": "yaml", "cron_expression": def.cron }),
        );
    }
}

fn assign(step: &mut Step, def: &StepDef, settings: Map<String, Value>) {
    step.name = def.name.clone();
    step.kind = def.kind;
    step.description = opt(&def.description);
    step.prompt = opt(&def.prompt);
    step.additional_context = opt(&def.context);
    step.expected_output = opt(&def.expect);
    step.output_name = Some(def.output.clone()).filter(|o| !o.is_empty());
    step.output_description = opt(&def.output_description);
    step.output_file_format = def.format;
    step.model_id = opt(&def.model);
    step.model_settings = settings;
    step.enabled_tool_ids = def.tools.clone();
    step.allow_failure = def.allow_failure;
}
