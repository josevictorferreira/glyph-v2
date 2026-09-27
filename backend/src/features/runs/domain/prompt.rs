//! System and user prompts for a Pi step (Rails `PiAgentRunner`), with
//! `{{name}}` interpolation from resolved inputs, then workflow values.

use std::sync::LazyLock;

use regex::{Captures, Regex};
use serde_json::{Map, Value};

use crate::shared::output_format::OutputFileFormat;

static TOKEN: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\{\{([^{}]+)\}\}").unwrap());

fn format_directive(format: OutputFileFormat) -> &'static str {
    match format {
        OutputFileFormat::Html => {
            "Output format: a single complete HTML document beginning with <!doctype html> or <html>. Do not wrap it in markdown fences or add prose."
        }
        OutputFileFormat::Json => {
            "Output format: one valid JSON value only. Do not wrap it in markdown fences or add prose."
        }
        OutputFileFormat::Zip => {
            "Output format: the entire ZIP archive as base64-encoded bytes, and nothing else. Do not wrap it in markdown fences or add prose."
        }
        OutputFileFormat::FreeTextMarkdown => "",
    }
}

pub fn system_prompt(expected_output: Option<&str>, format: OutputFileFormat) -> String {
    format!(
        "You are executing one step of an automated workflow. There is no human
in the loop: produce the step's output directly, without asking
questions.

Expected output for this step:
{}

{}

Rules:
- Your final message must contain exactly the produced output and
  nothing else (no preamble, no explanations, no markdown fences
  unless the expected output asks for them).
- Use only the tools explicitly enabled for this step, if any.
- If you cannot produce the output, explain the concrete reason in one
  short paragraph as your final message.
",
        expected_output.unwrap_or(""),
        format_directive(format)
    )
}

fn render(value: &Value) -> String {
    match value {
        Value::String(s) => s.clone(),
        Value::Null => String::new(),
        other => other.to_string(),
    }
}

pub fn interpolate(text: &str, inputs: &Map<String, Value>, values: &Map<String, Value>) -> String {
    TOKEN
        .replace_all(text, |c: &Captures| {
            let name = c[1].trim();
            inputs
                .get(name)
                .or_else(|| values.get(name))
                .map(render)
                .unwrap_or_else(|| c[0].to_string())
        })
        .into_owned()
}

pub fn user_prompt(
    prompt: Option<&str>,
    additional_context: Option<&str>,
    inputs: &Map<String, Value>,
    values: &Map<String, Value>,
) -> String {
    let mut parts = vec![format!(
        "Step instructions:\n{}",
        interpolate(prompt.unwrap_or(""), inputs, values)
    )];
    if let Some(context) = additional_context.filter(|c| !c.trim().is_empty()) {
        parts.push(format!("Additional context:\n{}", interpolate(context, inputs, values)));
    }
    if !inputs.is_empty() {
        let rendered: Vec<String> = inputs
            .iter()
            .map(|(name, value)| format!("{name}:\n{}", render(value)))
            .collect();
        parts.push(format!("Inputs:\n{}", rendered.join("\n\n")));
    }
    parts.join("\n\n")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn map(v: Value) -> Map<String, Value> {
        v.as_object().unwrap().clone()
    }

    #[test]
    fn interpolates_inputs_then_values() {
        let inputs = map(json!({"generate_instruction": "the shared style guide", "topic": "nix", "obj": {"a": 1}}));
        let values = map(json!({"brand": "Acme", "topic": "ignored"}));
        assert_eq!(
            interpolate("Follow {{generate_instruction}} for {{topic}} by {{brand}}; {{obj}}.", &inputs, &values),
            "Follow the shared style guide for nix by Acme; {\"a\":1}."
        );
        assert_eq!(interpolate("Keep {{missing}} but expand {{ topic }}.", &inputs, &values), "Keep {{missing}} but expand nix.");
    }

    #[test]
    fn user_prompt_sections() {
        let inputs = map(json!({"topic": "nix"}));
        let p = user_prompt(Some("Do it"), Some("Style: {{topic}}"), &inputs, &Map::new());
        assert_eq!(p, "Step instructions:\nDo it\n\nAdditional context:\nStyle: nix\n\nInputs:\ntopic:\nnix");
        assert_eq!(user_prompt(Some("Do it"), Some(" "), &Map::new(), &Map::new()), "Step instructions:\nDo it");
    }

    #[test]
    fn system_prompt_has_directive() {
        let s = system_prompt(Some("A page"), OutputFileFormat::Html);
        assert!(s.starts_with("You are executing one step of an automated workflow."));
        assert!(s.contains("Expected output for this step:\nA page\n"));
        assert!(s.contains("single complete HTML document"));
        assert!(s.contains("Rules:\n- Your final message"));
    }
}
