//! The workflow JSON Schema (draft 2020-12), compiled once, with validator
//! output rewritten into the sentences Rails shows authors.

use std::sync::LazyLock;

use jsonschema::error::ValidationErrorKind;
use jsonschema::{ValidationError, Validator};
use serde_json::Value;

pub const SCHEMA_JSON: &str = include_str!("../schema.json");
pub const ROUTE: &str = "/schemas/workflow.json";

static VALIDATOR: LazyLock<Validator> = LazyLock::new(|| {
    let schema: Value = serde_json::from_str(SCHEMA_JSON).expect("schema.json is valid JSON");
    jsonschema::draft202012::new(&schema).expect("schema.json is a valid 2020-12 schema")
});

/// A schema failure: JSON pointer of the node it belongs to + message.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SchemaError {
    pub path: String,
    pub message: String,
}

pub fn url(host: &str) -> String {
    format!("{}{ROUTE}", host.trim_end_matches('/'))
}

pub fn validate(document: &Value) -> Vec<SchemaError> {
    let mut out = Vec::new();
    for error in VALIDATOR.iter_errors(document) {
        push(&error, &mut out);
    }
    out
}

fn pointer(error: &ValidationError<'_>) -> String {
    let p = error.instance_path().to_string();
    if p.is_empty() { "/".into() } else { p }
}

/// Ruby `String#inspect`-alike for the offending value.
fn inspect(value: &Value) -> String {
    match value {
        Value::String(_) => serde_json::to_string(value).unwrap_or_default(),
        other => other.to_string(),
    }
}

fn push(error: &ValidationError<'_>, out: &mut Vec<SchemaError>) {
    let path = pointer(error);
    let message = match error.kind() {
        ValidationErrorKind::Required { property } => {
            let key = property.as_str().map(str::to_string).unwrap_or_else(|| property.to_string());
            format!("Add the required key \"{key}\".")
        }
        ValidationErrorKind::AdditionalProperties { unexpected } => {
            for key in unexpected {
                out.push(SchemaError {
                    path: path.clone(),
                    message: format!("{} is not a known key here.", inspect(&Value::String(key.clone()))),
                });
            }
            return;
        }
        ValidationErrorKind::PropertyNames { error: inner } => {
            let name = inner.instance();
            match inner.kind() {
                ValidationErrorKind::Enum { .. } => {
                    format!("{} is not allowed on a helper step.", inspect(name))
                }
                ValidationErrorKind::Pattern { .. } => format!(
                    "{} must start with a letter and use letters, digits, spaces or underscores.",
                    inspect(name)
                ),
                _ => inner.to_string(),
            }
        }
        ValidationErrorKind::Enum { options } => {
            let options = options
                .as_array()
                .map(|o| {
                    o.iter()
                        .map(|v| v.as_str().map(str::to_string).unwrap_or_else(|| v.to_string()))
                        .collect::<Vec<_>>()
                        .join(", ")
                })
                .unwrap_or_default();
            format!("{} is not one of: {options}.", inspect(error.instance()))
        }
        ValidationErrorKind::Minimum { .. } | ValidationErrorKind::Maximum { .. } => {
            "temperature must be between 0 and 2.".into()
        }
        ValidationErrorKind::Pattern { .. } => format!(
            "{} must start with a letter and use letters, digits, spaces or underscores.",
            inspect(error.instance())
        ),
        _ => error.to_string(),
    };
    out.push(SchemaError { path, message });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::features::definition::domain::yaml;

    fn fixture(name: &str) -> Value {
        let text = match name {
            "minimal" => include_str!("../../../../tests/fixtures/definitions/minimal.yml"),
            "full" => include_str!("../../../../tests/fixtures/definitions/full.yml"),
            "helper_with_prompt" => {
                include_str!("../../../../tests/fixtures/definitions/helper_with_prompt.yml")
            }
            "unknown_key" => include_str!("../../../../tests/fixtures/definitions/unknown_key.yml"),
            _ => unreachable!(),
        };
        yaml::load(text).unwrap().value
    }

    #[test]
    fn accepts_the_fixtures() {
        assert_eq!(validate(&fixture("minimal")), vec![]);
        assert_eq!(validate(&fixture("full")), vec![]);
    }

    #[test]
    fn rejects_a_prompt_on_a_helper() {
        let errors = validate(&fixture("helper_with_prompt"));
        assert_eq!(errors.len(), 1, "{errors:?}");
        assert_eq!(errors[0].path, "/steps/0");
        assert_eq!(errors[0].message, "\"prompt\" is not allowed on a helper step.");
    }

    #[test]
    fn rejects_an_unknown_key() {
        let errors = validate(&fixture("unknown_key"));
        assert_eq!(errors.len(), 1, "{errors:?}");
        assert_eq!(errors[0].path, "/steps/0");
        assert_eq!(errors[0].message, "\"bogus\" is not a known key here.");
    }

    #[test]
    fn rewrites_messages() {
        let v = |s: &str| validate(&yaml::load(s).unwrap().value);
        assert_eq!(v("steps: [{name: a}]")[0].message, "Add the required key \"name\".");
        assert_eq!(
            v("name: w\nsteps:\n- name: a\n  temperature: 5\n")[0],
            SchemaError { path: "/steps/0/temperature".into(), message: "temperature must be between 0 and 2.".into() }
        );
        assert_eq!(
            v("name: w\nsteps:\n- name: a\n  format: pdf\n")[0].message,
            "\"pdf\" is not one of: markdown, html, json, zip."
        );
        assert_eq!(
            v("name: w\ninputs:\n  9bad: x\nsteps:\n- name: a\n")[0].message,
            "\"9bad\" must start with a letter and use letters, digits, spaces or underscores."
        );
    }

    #[test]
    fn url_for_host() {
        assert_eq!(url("https://glyph.example"), "https://glyph.example/schemas/workflow.json");
    }
}
