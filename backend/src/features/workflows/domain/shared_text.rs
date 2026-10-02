//! Workflow-level shared texts: the `{{variable}}` token regex shared with the
//! validator, reference rendering, and the effective prompt / context / expect
//! a step uses when its field is linked to a shared text.

use std::collections::BTreeMap;
use std::sync::LazyLock;

use regex::Regex;

use super::model::{Step, TextField, TextRef, Workflow};

/// `{{name}}` references; the restricted charset keeps brace-heavy literals
/// such as `{{"a": 1}}` out of the scan.
pub static VARIABLE_PATTERN: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\{\{([A-Za-z0-9_ -]+)\}\}").unwrap());

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

/// Replaces only the tokens whose trimmed name is in `vars`; every other
/// token stays verbatim for run-time interpolation. Single pass: a value
/// containing `{{input}}` is left as-is.
pub fn render(body: &str, vars: &BTreeMap<String, String>) -> String {
    VARIABLE_PATTERN
        .replace_all(body, |c: &regex::Captures| match vars.get(c[1].trim()) {
            Some(value) => value.clone(),
            None => c[0].to_string(),
        })
        .into_owned()
}

impl Workflow {
    fn effective(&self, text_ref: &Option<TextRef>, own: &Option<String>) -> Option<String> {
        match text_ref {
            Some(r) => self.text(r.text_id).map(|t| render(&t.body, &r.vars)),
            None => own.clone(),
        }
    }

    /// The rendered shared text when the prompt is linked, else the prompt.
    pub fn effective_prompt(&self, step: &Step) -> Option<String> {
        self.effective(&step.prompt_ref, &step.prompt)
    }

    /// The rendered shared text when the context is linked, else the context.
    pub fn effective_context(&self, step: &Step) -> Option<String> {
        self.effective(&step.context_ref, &step.additional_context)
    }

    /// The rendered shared text when the expect is linked, else the expect.
    pub fn effective_expect(&self, step: &Step) -> Option<String> {
        self.effective(&step.expect_ref, &step.expected_output)
    }

    /// The step's own text of a field: the stored column, never a ref.
    pub fn own_text<'a>(&self, step: &'a Step, field: TextField) -> Option<&'a String> {
        match field {
            TextField::Prompt => step.prompt.as_ref(),
            TextField::Context => step.additional_context.as_ref(),
            TextField::Expect => step.expected_output.as_ref(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn vars(pairs: &[(&str, &str)]) -> BTreeMap<String, String> {
        pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect()
    }

    #[test]
    fn renders_only_named_tokens_in_one_pass() {
        let body = "Hello {{name}}, then {{ x }}, again {{name}}, keep {{missing}}.";
        assert_eq!(
            render(body, &vars(&[("name", "Ada"), ("x", "42")])),
            "Hello Ada, then 42, again Ada, keep {{missing}}."
        );
    }

    #[test]
    fn a_value_with_tokens_is_left_for_run_time() {
        let body = "Style: {{style}}";
        assert_eq!(
            render(body, &vars(&[("style", "{{guide}}")])),
            "Style: {{guide}}"
        );
    }

    #[test]
    fn trimmed_names_match_and_literals_stay() {
        assert_eq!(
            render("{{ a }}", &vars(&[("a", "A")])),
            "A",
            "trimmed token names match"
        );
        assert_eq!(
            render("{{\"a\": 1}}", &vars(&[("a", "A")])),
            "{{\"a\": 1}}",
            "brace-heavy literals are not tokens"
        );
    }
}
