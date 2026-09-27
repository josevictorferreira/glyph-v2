//! Workflow → YAML definition (Rails `Definition::Exporter`).

use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};

use crate::features::definition::domain::{emit, schema};
use crate::features::workflows::model::{Step, StepInput, StepKind, Workflow};
use crate::shared::output_format::OutputFileFormat;

const FOLDABLE_KEYS: [&str; 4] = ["model", "temperature", "tools", "format"];

pub fn document_hash(workflow: &Workflow) -> Value {
    let mut step_hashes: Vec<Map<String, Value>> = workflow
        .steps
        .iter()
        .map(|s| step_hash(workflow, s))
        .collect();
    let defaults = fold_defaults(workflow, &mut step_hashes);

    let mut doc = Map::new();
    doc.insert("name".into(), json!(workflow.name));
    if let Some(d) = &workflow.description {
        doc.insert("description".into(), json!(d));
    }
    if workflow.fail_fast {
        doc.insert("fail_fast".into(), json!(true));
    }
    if let Some(defaults) = defaults {
        doc.insert("defaults".into(), Value::Object(defaults));
    }
    if !workflow.inputs.is_empty() {
        let inputs: Map<String, Value> = workflow
            .inputs
            .iter()
            .map(|i| {
                // Scalar shorthand only when it reads back identically:
                // a required constant without description.
                let value = match &i.value {
                    Some(v) if i.description.is_none() && i.required && !i.ask_at_run_time => {
                        json!(v)
                    }
                    _ => input_object(i),
                };
                (i.name.clone(), value)
            })
            .collect();
        doc.insert("inputs".into(), Value::Object(inputs));
    }
    if let Some(schedule) = &workflow.schedule {
        let mut s = Map::new();
        s.insert("cron".into(), json!(schedule.cron_expression));
        s.insert("timezone".into(), json!(schedule.timezone));
        if !schedule.enabled {
            s.insert("enabled".into(), json!(false));
        }
        if let Some(d) = &schedule.human_description {
            s.insert("description".into(), json!(d));
        }
        let mut rows: Vec<_> = schedule
            .values
            .iter()
            .filter_map(|v| {
                workflow
                    .input(v.workflow_input_id)
                    .map(|i| (i.position, i.name.clone(), v.value.clone()))
            })
            .collect();
        rows.sort_by_key(|(p, _, _)| *p);
        if !rows.is_empty() {
            s.insert(
                "values".into(),
                Value::Object(rows.into_iter().map(|(_, n, v)| (n, json!(v))).collect()),
            );
        }
        doc.insert("schedule".into(), Value::Object(s));
    }
    doc.insert(
        "steps".into(),
        Value::Array(step_hashes.into_iter().map(Value::Object).collect()),
    );
    Value::Object(doc)
}

/// Object form of a workflow input (Rails `workflow_input_hash`).
fn input_object(i: &crate::features::workflows::model::WorkflowInput) -> Value {
    let mut h = Map::new();
    if let Some(d) = &i.description {
        h.insert("description".into(), json!(d));
    }
    if let Some(v) = &i.value {
        h.insert("value".into(), json!(v));
    }
    if !i.required {
        h.insert("required".into(), json!(false));
    }
    if !(i.value.is_none() && i.ask_at_run_time) {
        h.insert("ask".into(), json!(i.ask_at_run_time));
    }
    Value::Object(h)
}

fn step_hash(workflow: &Workflow, step: &Step) -> Map<String, Value> {
    let mut h = Map::new();
    h.insert("id".into(), json!(step.id.to_string()));
    h.insert("name".into(), json!(step.name));
    if step.kind == StepKind::Helper {
        h.insert("kind".into(), json!("helper"));
        h.insert("inputs".into(), step_inputs(workflow, step));
        return h;
    }
    if let Some(d) = &step.description {
        h.insert("description".into(), json!(d));
    }
    if let Some(m) = &step.model_id {
        h.insert("model".into(), json!(m));
    }
    if let Some(t) = step.temperature() {
        h.insert("temperature".into(), json!(t));
    }
    if !step.enabled_tool_ids.is_empty() {
        h.insert("tools".into(), json!(step.enabled_tool_ids));
    }
    if let Some(p) = &step.prompt {
        h.insert("prompt".into(), json!(p));
    }
    if let Some(c) = &step.additional_context {
        h.insert("context".into(), json!(c));
    }
    if let Some(e) = &step.expected_output {
        h.insert("expect".into(), json!(e));
    }
    if let Some(o) = &step.output_name
        && *o != step.name
    {
        h.insert("output".into(), json!(o));
    }
    if let Some(d) = &step.output_description {
        h.insert("output_description".into(), json!(d));
    }
    if step.output_file_format != OutputFileFormat::FreeTextMarkdown {
        h.insert("format".into(), json!(step.output_file_format.as_str()));
    }
    if step.allow_failure {
        h.insert("allow_failure".into(), json!(true));
    }
    if !step.inputs.is_empty() {
        h.insert("inputs".into(), step_inputs(workflow, step));
    }
    h
}

fn step_inputs(workflow: &Workflow, step: &Step) -> Value {
    Value::Object(
        step.inputs
            .iter()
            .map(|i| (i.name.clone(), step_input(workflow, i)))
            .collect(),
    )
}

fn step_input(workflow: &Workflow, input: &StepInput) -> Value {
    let source = workflow
        .incoming_connection(input.id)
        .and_then(|c| workflow.step(c.source_step_id))
        .map(|s| s.name.clone())
        .or_else(|| {
            input
                .workflow_input_id
                .and_then(|w| workflow.input(w))
                .map(|w| w.name.clone())
        });
    if let Some(source) = &source
        && input.required
        && input.description.is_none()
    {
        return json!(source);
    }
    let mut h = Map::new();
    if let Some(source) = source {
        h.insert("from".into(), json!(source));
    }
    if !input.required {
        h.insert("required".into(), json!(false));
    }
    if let Some(d) = &input.description {
        h.insert("description".into(), json!(d));
    }
    Value::Object(h)
}

fn fold_defaults(
    workflow: &Workflow,
    hashes: &mut [Map<String, Value>],
) -> Option<Map<String, Value>> {
    let pi: Vec<usize> = workflow
        .steps
        .iter()
        .enumerate()
        .filter(|(_, s)| s.kind != StepKind::Helper)
        .map(|(i, _)| i)
        .collect();
    if pi.len() < 2 {
        return None;
    }
    let mut defaults = Map::new();
    for key in FOLDABLE_KEYS {
        let values: Vec<Option<&Value>> = pi.iter().map(|i| hashes[*i].get(key)).collect();
        if values.iter().any(Option::is_none) {
            continue;
        }
        let first = values[0].cloned();
        if values.iter().all(|v| v.cloned() == first) {
            defaults.insert(key.into(), first.unwrap());
            for i in &pi {
                hashes[*i].remove(key);
            }
        }
    }
    (!defaults.is_empty()).then_some(defaults)
}

/// The YAML text with its schema header. `schema_url` defaults to the route.
pub fn export(workflow: &Workflow, schema_url: Option<&str>) -> String {
    let url = schema_url.unwrap_or(schema::ROUTE);
    format!(
        "# yaml-language-server: $schema={url}\n{}",
        emit::to_yaml(&document_hash(workflow))
    )
}

/// sha256 of the canonical (route-relative) export.
pub fn fingerprint(workflow: &Workflow) -> String {
    hex::encode(Sha256::digest(export(workflow, None).as_bytes()))
}

/// `{parameterized name or "workflow"}.yml`.
pub fn filename(workflow: &Workflow) -> String {
    let mut slug = String::new();
    for c in workflow.name.to_lowercase().chars() {
        if c.is_ascii_alphanumeric() {
            slug.push(c);
        } else if !slug.ends_with('-') && !slug.is_empty() {
            slug.push('-');
        }
    }
    let slug = slug.trim_matches('-');
    format!("{}.yml", if slug.is_empty() { "workflow" } else { slug })
}
