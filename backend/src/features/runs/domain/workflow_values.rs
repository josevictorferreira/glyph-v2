//! Effective workflow values for a run (Rails `Workflows::WorkflowValues`):
//! a non-blank supplied value wins over the snapshotted one.

use serde_json::{Map, Value};

use crate::features::workflows::snapshot::SnapshotInput;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ValueSource {
    Supplied,
    Stored,
    Constant,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Entry {
    pub name: String,
    pub value: Option<Value>,
    pub source: ValueSource,
}

fn present(value: Option<&Value>) -> Option<&Value> {
    value.filter(|v| match v {
        Value::Null => false,
        Value::String(s) => !s.trim().is_empty(),
        _ => true,
    })
}

/// Snapshot inputs in order with the value that applies and where it came from.
pub fn entries(inputs: &[SnapshotInput], supplied: &Map<String, Value>) -> Vec<Entry> {
    inputs
        .iter()
        .map(|input| {
            let provided = present(supplied.get(&input.name));
            let value = provided
                .cloned()
                .or_else(|| input.value.clone().map(Value::String));
            let source = if provided.is_some() {
                ValueSource::Supplied
            } else if input.ask_at_run_time {
                ValueSource::Stored
            } else {
                ValueSource::Constant
            };
            Entry {
                name: input.name.clone(),
                value,
                source,
            }
        })
        .collect()
}

/// Name → value for `{{token}}` interpolation (entries without a value dropped).
pub fn values(inputs: &[SnapshotInput], supplied: &Map<String, Value>) -> Map<String, Value> {
    entries(inputs, supplied)
        .into_iter()
        .filter_map(|e| e.value.map(|v| (e.name, v)))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::shared::ids::WorkflowInputId;
    use serde_json::json;

    fn input(name: &str, value: Option<&str>, ask: bool) -> SnapshotInput {
        SnapshotInput {
            id: WorkflowInputId::new(),
            name: name.into(),
            description: None,
            required: true,
            position: 1,
            value: value.map(str::to_string),
            ask_at_run_time: ask,
        }
    }

    fn supplied(v: Value) -> Map<String, Value> {
        v.as_object().cloned().unwrap_or_default()
    }

    #[test]
    fn supplied_wins() {
        let i = [input("api_key", Some("stored-value"), true)];
        assert_eq!(values(&i, &supplied(json!({"api_key": "supplied-value"}))), supplied(json!({"api_key": "supplied-value"})));
    }

    #[test]
    fn blank_supplied_falls_back() {
        let i = [input("api_key", Some("stored-value"), true)];
        assert_eq!(values(&i, &supplied(json!({"api_key": "  "}))), supplied(json!({"api_key": "stored-value"})));
    }

    #[test]
    fn stored_constant_and_drops() {
        let i = [input("brand", Some("Acme"), false)];
        assert_eq!(values(&i, &Map::new()), supplied(json!({"brand": "Acme"})));
        let i = [input("tone", None, true), input("brand", Some("Acme"), false)];
        assert_eq!(values(&i, &supplied(json!({"tone": ""}))), supplied(json!({"brand": "Acme"})));
    }

    #[test]
    fn labels_sources() {
        let i = [
            input("brand", Some("Acme"), false),
            input("api_key", Some("stored-key"), true),
            input("tone", Some("formal"), true),
        ];
        let e = entries(&i, &supplied(json!({"brand": "New Co", "tone": ""})));
        let got: Vec<_> = e.iter().map(|e| (e.name.as_str(), e.value.clone(), e.source)).collect();
        assert_eq!(
            got,
            vec![
                ("brand", Some(json!("New Co")), ValueSource::Supplied),
                ("api_key", Some(json!("stored-key")), ValueSource::Stored),
                ("tone", Some(json!("formal")), ValueSource::Stored),
            ]
        );
        assert_eq!(entries(&[input("brand", Some("Acme"), false)], &Map::new())[0].source, ValueSource::Constant);
    }
}
