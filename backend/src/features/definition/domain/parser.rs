//! Reads workflow YAML and reports every problem the author can fix (Rails
//! `Workflows::Definition::Parser`). Stages stop at the first failing one:
//! blank, size, YAML load, map shape, JSON Schema, references.

use std::collections::{HashMap, HashSet};

use serde_json::{Map, Value};

use crate::features::definition::domain::types::*;
use crate::features::definition::domain::{schema, yaml};
use crate::features::workflows::model::StepKind;
use crate::features::workflows::schedule_calculator;
use crate::shared::ids::StepId;
use crate::shared::output_format::OutputFileFormat;

pub const SIZE_LIMIT: usize = 256 * 1024;

/// An existing workflow step the document may refer to by id or name.
#[derive(Debug, Clone)]
pub struct ExistingStep {
    pub id: StepId,
    pub name: String,
}

pub fn parse(text: &str, existing: Option<&[ExistingStep]>) -> Result<Document, Vec<DefinitionError>> {
    let err = |path: &str, line: Option<i32>, message: &str| {
        Err(vec![DefinitionError {
            path: Some(path.into()),
            line,
            message: message.into(),
        }])
    };
    if text.trim().is_empty() {
        return err("/", Some(1), "The document is empty. Start with a name and one step.");
    }
    if text.len() > SIZE_LIMIT {
        return err("/", None, "The document is too large (limit 256 KiB).");
    }
    let loaded = match yaml::load(text) {
        Ok(loaded) => loaded,
        Err(yaml::LoadError::AliasOrTag) => return err("/", None, "Aliases and tags are not allowed."),
        Err(yaml::LoadError::Syntax { line, message }) => {
            return err("/", line, &format!("YAML syntax error: {message}"));
        }
    };
    let Value::Object(root) = &loaded.value else {
        return err("/", None, "The document must be a map with name and steps.");
    };

    let schema_errors: Vec<DefinitionError> = schema::validate(&loaded.value)
        .into_iter()
        .map(|e| DefinitionError {
            line: loaded.lines.get(&e.path).copied(),
            path: Some(e.path),
            message: e.message,
        })
        .collect();
    if !schema_errors.is_empty() {
        return Err(schema_errors);
    }

    let mut checker = References {
        root,
        lines: &loaded.lines,
        errors: Vec::new(),
        ids: HashMap::new(),
    };
    checker.check(existing);
    if !checker.errors.is_empty() {
        return Err(checker.errors);
    }
    Ok(checker.build())
}

fn str_of(value: Option<&Value>) -> String {
    match value {
        None | Some(Value::Null) => String::new(),
        Some(Value::String(s)) => s.clone(),
        Some(other) => other.to_string(),
    }
}

fn opt_str(value: Option<&Value>) -> Option<String> {
    match value {
        None | Some(Value::Null) => None,
        Some(Value::String(s)) => Some(s.clone()),
        Some(other) => Some(other.to_string()),
    }
}

fn from_of(spec: &Value) -> Option<String> {
    match spec {
        Value::Object(o) => opt_str(o.get("from")),
        other => opt_str(Some(other)),
    }
    .filter(|s| !s.trim().is_empty())
}

static EMPTY: std::sync::LazyLock<Map<String, Value>> = std::sync::LazyLock::new(Map::new);

struct References<'a> {
    root: &'a Map<String, Value>,
    lines: &'a HashMap<String, i32>,
    errors: Vec<DefinitionError>,
    ids: HashMap<usize, StepId>,
}

impl<'a> References<'a> {
    fn add(&mut self, path: &str, message: String) {
        self.errors.push(DefinitionError {
            path: Some(path.to_string()),
            line: self.lines.get(path).copied(),
            message,
        });
    }

    fn steps(&self) -> &'a [Value] {
        self.root.get("steps").and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[])
    }

    fn inputs(&self) -> &'a Map<String, Value> {
        self.root.get("inputs").and_then(Value::as_object).unwrap_or(&EMPTY)
    }

    fn step_inputs(step: &'a Value) -> &'a Map<String, Value> {
        step.get("inputs").and_then(Value::as_object).unwrap_or(&EMPTY)
    }

    fn step_names(&self) -> Vec<String> {
        self.steps().iter().filter_map(|s| s.get("name").and_then(Value::as_str)).map(str::to_string).collect()
    }

    fn input_names(&self) -> Vec<String> {
        self.inputs().keys().cloned().collect()
    }

    fn is_step(&self, name: &str) -> bool {
        let lower = name.to_lowercase();
        self.step_names().iter().any(|n| n.to_lowercase() == lower)
    }

    fn is_input(&self, name: &str) -> bool {
        let lower = name.to_lowercase();
        self.input_names().iter().any(|n| n.to_lowercase() == lower)
    }

    fn check(&mut self, existing: Option<&[ExistingStep]>) {
        // name
        if str_of(self.root.get("name")).trim().is_empty() {
            self.add("/name", "Give the workflow a name.".into());
        }
        // constant inputs need a value
        for (name, spec) in self.inputs() {
            let (value, ask) = match spec {
                Value::Object(o) => {
                    let value = o.get("value").filter(|v| !v.is_null());
                    let ask = o.get("ask").and_then(Value::as_bool).unwrap_or(value.is_none());
                    (value, ask)
                }
                other => (Some(other).filter(|v| !v.is_null()), false),
            };
            if value.is_none() && !ask {
                self.add(
                    &format!("/inputs/{}", yaml::escape(name)),
                    format!("Constant input “{name}” needs a value, or set ask: true."),
                );
            }
        }
        // unique input names
        let mut seen = HashSet::new();
        for name in self.inputs().keys() {
            let key = name.to_lowercase();
            if !seen.insert(key.clone()) {
                self.add(&format!("/inputs/{}", yaml::escape(name)), format!("Two workflow inputs are named “{key}”."));
            }
        }
        // unique step names
        let mut seen = HashSet::new();
        for (index, step) in self.steps().iter().enumerate() {
            let name = str_of(step.get("name")).to_lowercase();
            if !seen.insert(name.clone()) {
                self.add(
                    &format!("/steps/{index}/name"),
                    format!("Two steps are named “{name}”. Step names must be unique."),
                );
            }
        }
        // step ids
        if let Some(existing) = existing {
            for (index, step) in self.steps().iter().enumerate() {
                if let Some(id) = opt_str(step.get("id")) {
                    match existing.iter().find(|e| e.id.to_string() == id) {
                        Some(found) => {
                            self.ids.insert(index, found.id);
                        }
                        None => self.add(
                            &format!("/steps/{index}/id"),
                            format!(
                                "No step with id “{id}” exists in this workflow. Remove the id to create a new step."
                            ),
                        ),
                    }
                } else {
                    let name = str_of(step.get("name"));
                    let lower = name.to_lowercase();
                    let matches: Vec<_> = existing.iter().filter(|e| e.name.to_lowercase() == lower).collect();
                    match matches.as_slice() {
                        [] => {}
                        [one] => {
                            self.ids.insert(index, one.id);
                        }
                        _ => self.add(
                            &format!("/steps/{index}/name"),
                            format!(
                                "The workflow already has two steps named “{name}”. Download the YAML to get their ids."
                            ),
                        ),
                    }
                }
            }
        }
        // step input sources
        for (index, step) in self.steps().iter().enumerate() {
            let step_name = str_of(step.get("name")).to_lowercase();
            for (name, spec) in Self::step_inputs(step) {
                let Some(from) = from_of(spec) else { continue };
                let pointer = format!("/steps/{index}/inputs/{}", yaml::escape(name));
                let (is_step, is_input) = (self.is_step(&from), self.is_input(&from));
                if is_step && is_input {
                    self.add(&pointer, format!("“{from}” is both a step and a workflow input. Rename one of them."));
                } else if is_step && from.to_lowercase() == step_name {
                    self.add(&pointer, format!("“{from}” cannot feed itself."));
                } else if !is_step && !is_input {
                    self.add(&pointer, format!("“{from}” is not a step or a workflow input. Check the spelling."));
                }
            }
        }
        // cycles
        if self.cyclic() {
            self.errors.push(DefinitionError {
                path: Some("/steps".into()),
                line: None,
                message: "The connections form a cycle. Remove the link that closes the loop.".into(),
            });
        }
        // schedule
        if let Some(Value::Object(schedule)) = self.root.get("schedule") {
            if schedule_calculator::parse_cron(&str_of(schedule.get("cron"))).is_none() {
                self.add("/schedule/cron", "The recurrence is not a valid cron expression.".into());
            }
            let tz = str_of(schedule.get("timezone"));
            if !tz.is_empty() && schedule_calculator::parse_timezone(&tz).is_none() {
                self.add("/schedule/timezone", "The schedule timezone is not a known IANA timezone.".into());
            }
            if let Some(values) = schedule.get("values").and_then(Value::as_object) {
                for name in values.keys() {
                    if !self.is_input(name) {
                        self.add(
                            &format!("/schedule/values/{}", yaml::escape(name)),
                            format!("The schedule sets “{name}”, which is not a workflow input."),
                        );
                    }
                }
            }
        }
    }

    /// Producer → consumer edges by step name (lower-cased).
    fn edges(&self) -> Vec<(String, String)> {
        let mut edges = Vec::new();
        for step in self.steps() {
            let consumer = str_of(step.get("name")).to_lowercase();
            for spec in Self::step_inputs(step).values() {
                let Some(from) = from_of(spec) else { continue };
                let from = from.to_lowercase();
                if self.is_step(&from) && from != consumer {
                    edges.push((from, consumer.clone()));
                }
            }
        }
        edges
    }

    fn cyclic(&self) -> bool {
        let names: Vec<String> = self.step_names().iter().map(|n| n.to_lowercase()).collect();
        crate::shared::dag::Dag::new(names, self.edges()).cyclic()
    }

    fn build(self) -> Document {
        let root = self.root;
        let defaults = root.get("defaults").and_then(Value::as_object).unwrap_or(&EMPTY);
        let inputs = self
            .inputs()
            .iter()
            .map(|(name, spec)| match spec {
                Value::Object(o) => {
                    let value = opt_str(o.get("value"));
                    InputDef {
                        name: name.clone(),
                        description: opt_str(o.get("description")),
                        required: o.get("required").and_then(Value::as_bool).unwrap_or(true),
                        ask: o.get("ask").and_then(Value::as_bool).unwrap_or(value.is_none()),
                        value,
                    }
                }
                other => InputDef {
                    name: name.clone(),
                    description: None,
                    value: Some(str_of(Some(other))),
                    required: true,
                    ask: false,
                },
            })
            .collect();

        let schedule = root.get("schedule").and_then(Value::as_object).map(|s| ScheduleDef {
            cron: str_of(s.get("cron")),
            timezone: str_of(s.get("timezone")),
            enabled: s.get("enabled").and_then(Value::as_bool).unwrap_or(true),
            description: opt_str(s.get("description")),
            values: s
                .get("values")
                .and_then(Value::as_object)
                .map(|v| v.iter().map(|(k, v)| (k.clone(), str_of(Some(v)))).collect())
                .unwrap_or_default(),
        });

        let steps = self
            .steps()
            .iter()
            .enumerate()
            .map(|(index, step)| {
                let helper = step.get("kind").and_then(Value::as_str) == Some("helper");
                let pick = |key: &str| {
                    if helper { None } else { step.get(key).or_else(|| defaults.get(key)).filter(|v| !v.is_null()) }
                };
                let name = str_of(step.get("name"));
                StepDef {
                    id: self.ids.get(&index).copied(),
                    kind: if helper { StepKind::Helper } else { StepKind::Pi },
                    description: opt_str(step.get("description")),
                    model: pick("model").and_then(|v| opt_str(Some(v))),
                    temperature: pick("temperature").and_then(Value::as_f64),
                    tools: pick("tools")
                        .and_then(Value::as_array)
                        .map(|t| t.iter().map(|v| str_of(Some(v))).collect())
                        .unwrap_or_default(),
                    prompt: opt_str(step.get("prompt")),
                    context: opt_str(step.get("context")),
                    expect: opt_str(step.get("expect")),
                    output: opt_str(step.get("output")).unwrap_or_else(|| name.clone()),
                    output_description: opt_str(step.get("output_description")),
                    format: match pick("format").and_then(Value::as_str) {
                        None | Some("markdown") => OutputFileFormat::FreeTextMarkdown,
                        Some(word) => OutputFileFormat::parse_or_default(word),
                    },
                    allow_failure: step.get("allow_failure").and_then(Value::as_bool).unwrap_or(false),
                    inputs: Self::step_inputs(step)
                        .iter()
                        .map(|(input_name, spec)| {
                            let options = spec.as_object();
                            StepInputDef {
                                name: input_name.clone(),
                                source: from_of(spec).map(|from| Source {
                                    kind: if self.is_step(&from) { SourceKind::Step } else { SourceKind::WorkflowInput },
                                    name: from,
                                }),
                                required: options
                                    .and_then(|o| o.get("required"))
                                    .and_then(Value::as_bool)
                                    .unwrap_or(true),
                                description: options.and_then(|o| opt_str(o.get("description"))),
                            }
                        })
                        .collect(),
                    name,
                }
            })
            .collect();

        Document {
            name: str_of(root.get("name")),
            description: opt_str(root.get("description")),
            fail_fast: root.get("fail_fast").and_then(Value::as_bool).unwrap_or(false),
            inputs,
            schedule,
            steps,
        }
    }
}
