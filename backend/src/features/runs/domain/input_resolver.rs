//! Resolves a step's inputs for one run from the immutable snapshot, the
//! run's workflow values and succeeded upstream step runs (Rails
//! `Workflows::InputResolver`). Each value records where it came from.

use serde_json::{Map, Value, json};

use crate::features::runs::domain::model::StepRunStatus;
use crate::features::runs::domain::workflow_values::{Entry, ValueSource};
use crate::features::workflows::snapshot::{Snapshot, SnapshotStep, SnapshotStepInput};
use crate::shared::ids::StepRunId;

/// What the resolver needs from an upstream step run.
#[derive(Debug, Clone)]
pub struct Upstream {
    pub id: StepRunId,
    pub snapshot_step_id: String,
    pub step_name: String,
    pub status: StepRunStatus,
    pub allow_failure: bool,
    pub output: Option<Value>,
    pub output_text: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Resolution {
    pub name: String,
    pub value: Option<Value>,
    pub required: bool,
    pub source: Value,
}

impl Resolution {
    fn present(&self) -> bool {
        match &self.value {
            None | Some(Value::Null) => false,
            Some(Value::String(s)) => !s.is_empty(),
            Some(_) => true,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("Required input “{0}” has no value")]
pub struct MissingRequiredInput(pub String);

pub fn resolve(
    snapshot: &Snapshot,
    step: &SnapshotStep,
    upstreams: &[Upstream],
    values: &[Entry],
) -> Result<Vec<Resolution>, MissingRequiredInput> {
    step.inputs
        .iter()
        .map(|input| {
            let resolution = resolve_one(snapshot, step, input, upstreams, values);
            if resolution.required && !resolution.present() {
                Err(MissingRequiredInput(resolution.name))
            } else {
                Ok(resolution)
            }
        })
        .collect()
}

/// `{name: value}` for the runner and helpers.
pub fn values_map(resolutions: &[Resolution]) -> Map<String, Value> {
    resolutions
        .iter()
        .map(|r| (r.name.clone(), r.value.clone().unwrap_or(Value::Null)))
        .collect()
}

/// `{name: {value, source}}` evidence persisted on the step run.
pub fn evidence(resolutions: &[Resolution]) -> Value {
    Value::Object(
        resolutions
            .iter()
            .map(|r| {
                (
                    r.name.clone(),
                    json!({ "value": r.value.clone().unwrap_or(Value::Null), "source": r.source }),
                )
            })
            .collect(),
    )
}

fn resolve_one(
    snapshot: &Snapshot,
    step: &SnapshotStep,
    input: &SnapshotStepInput,
    upstreams: &[Upstream],
    values: &[Entry],
) -> Resolution {
    let connection = snapshot
        .connections
        .iter()
        .find(|c| c.destination_input_id == input.id && c.destination_step_id == step.id);
    if let Some(connection) = connection {
        let source_id = connection.source_step_id.to_string();
        let upstream = upstreams.iter().find(|u| u.snapshot_step_id == source_id);
        if let Some(up) = upstream.filter(|u| u.status == StepRunStatus::Succeeded) {
            // Structured output wins; an empty object is valid (nil check only).
            let value = up
                .output
                .clone()
                .filter(|o| !o.is_null())
                .or_else(|| up.output_text.clone().map(Value::String));
            return Resolution {
                name: input.name.clone(),
                value,
                required: input.required,
                source: json!({
                    "kind": "step_output",
                    "step_run_id": up.id.to_string(),
                    "label": format!("Output from {}", up.step_name),
                }),
            };
        }
        // A failed allow-failure upstream waives the required check.
        let waived = upstream.is_some_and(|u| u.status == StepRunStatus::Failed && u.allow_failure);
        let source_name = snapshot
            .step(connection.source_step_id)
            .map(|s| s.name.clone())
            .unwrap_or_default();
        let suffix = if waived {
            " (failed — continuing without it)"
        } else {
            " (unavailable)"
        };
        return Resolution {
            name: input.name.clone(),
            value: None,
            required: input.required && !waived,
            source: json!({
                "kind": "step_output",
                "step_run_id": upstream.map(|u| u.id.to_string()),
                "label": format!("Output from {source_name}{suffix}"),
            }),
        };
    }
    if let Some(workflow_input_id) = input.workflow_input_id {
        let name = input.workflow_input_name.clone().unwrap_or_default();
        let entry = values.iter().find(|e| e.name == name);
        let source = match entry.map(|e| e.source) {
            Some(ValueSource::Constant) => json!({
                "kind": "constant",
                "workflow_input_id": workflow_input_id.to_string(),
                "label": format!("Constant “{name}”"),
            }),
            _ => json!({
                "kind": "workflow_value",
                "workflow_input_id": workflow_input_id.to_string(),
                "label": format!("Workflow value “{name}”"),
            }),
        };
        return Resolution {
            name: input.name.clone(),
            value: entry.and_then(|e| e.value.clone()),
            required: input.required,
            source,
        };
    }
    Resolution {
        name: input.name.clone(),
        value: None,
        required: input.required,
        source: json!({ "kind": "none", "label": "Not connected" }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::features::runs::domain::workflow_values;
    use crate::features::workflows::WorkflowInputFields;
    use crate::features::workflows::catalog_view::CatalogView;
    use crate::features::workflows::model::{StepKind, Workflow};
    use crate::features::workflows::snapshot;
    use chrono::Utc;

    struct Fixture {
        snapshot: Snapshot,
        a: SnapshotStep,
        b: SnapshotStep,
    }

    fn fixture() -> Fixture {
        let now = Utc::now();
        let (mut wf, _) = Workflow::create("W", None, false, now);
        let (a, _) = wf.add_step(StepKind::Pi, None, now);
        let (b, _) = wf.add_step(StepKind::Pi, None, now);
        wf.step_mut(a).unwrap().name = "A".into();
        wf.step_mut(a).unwrap().output_name = Some("result".into());
        wf.step_mut(b).unwrap().name = "B".into();
        let (topic, _) = wf
            .add_workflow_input(
                WorkflowInputFields {
                    name: "topic".into(),
                    required: true,
                    ask_at_run_time: true,
                    ..Default::default()
                },
                now,
            )
            .unwrap();
        let (input_a, _) = wf.add_step_input(a, "topic", true, now).unwrap();
        wf.map_step_input(input_a, Some(topic)).unwrap();
        wf.connect_output_to_step(a, b, now).unwrap();
        wf.step_mut(b).unwrap().inputs[0].required = true;
        wf.step_mut(b).unwrap().inputs[0].name = "facts".into();
        let snapshot = snapshot::build(&wf, &CatalogView::default(), now);
        Fixture {
            a: snapshot.steps[0].clone(),
            b: snapshot.steps[1].clone(),
            snapshot,
        }
    }

    fn values(f: &Fixture, supplied: Value) -> Vec<Entry> {
        workflow_values::entries(&f.snapshot.inputs, supplied.as_object().unwrap())
    }

    fn upstream(
        f: &Fixture,
        status: StepRunStatus,
        output: Option<Value>,
        text: Option<&str>,
    ) -> Upstream {
        Upstream {
            id: StepRunId::new(),
            snapshot_step_id: f.a.id.to_string(),
            step_name: "A".into(),
            status,
            allow_failure: false,
            output,
            output_text: text.map(str::to_string),
        }
    }

    #[test]
    fn workflow_values_with_labels() {
        let f = fixture();
        let r = resolve(&f.snapshot, &f.a, &[], &values(&f, json!({"topic": "nix"}))).unwrap();
        assert_eq!(r[0].value, Some(json!("nix")));
        assert_eq!(r[0].source["kind"], "workflow_value");
        assert_eq!(r[0].source["label"], "Workflow value “topic”");
    }

    #[test]
    fn connected_outputs() {
        let f = fixture();
        let v = values(&f, json!({}));
        let up = upstream(&f, StepRunStatus::Succeeded, None, Some("facts here"));
        let r = resolve(&f.snapshot, &f.b, &[up], &v).unwrap();
        assert_eq!(r[0].value, Some(json!("facts here")));
        assert_eq!(r[0].source["label"], "Output from A");

        let up = upstream(
            &f,
            StepRunStatus::Succeeded,
            Some(json!({"topic": "nix"})),
            Some("raw"),
        );
        assert_eq!(
            resolve(&f.snapshot, &f.b, &[up], &v).unwrap()[0].value,
            Some(json!({"topic": "nix"}))
        );
        let up = upstream(&f, StepRunStatus::Succeeded, Some(json!({})), None);
        assert_eq!(
            resolve(&f.snapshot, &f.b, &[up], &v).unwrap()[0].value,
            Some(json!({}))
        );
    }

    #[test]
    fn missing_required_and_waivers() {
        let f = fixture();
        let err = resolve(&f.snapshot, &f.a, &[], &values(&f, json!({}))).unwrap_err();
        assert_eq!(err.to_string(), "Required input “topic” has no value");

        let mut optional = f.a.clone();
        optional.inputs[0].required = false;
        let r = resolve(&f.snapshot, &optional, &[], &values(&f, json!({}))).unwrap();
        assert!(r[0].value.is_none());

        let failed = upstream(&f, StepRunStatus::Failed, None, None);
        assert!(resolve(&f.snapshot, &f.b, std::slice::from_ref(&failed), &[]).is_err());
        let waived = Upstream {
            allow_failure: true,
            ..failed
        };
        let r = resolve(&f.snapshot, &f.b, &[waived], &[]).unwrap();
        assert_eq!(
            r[0].source["label"],
            "Output from A (failed — continuing without it)"
        );
        assert!(!r[0].required);
    }
}
