//! Normalizes a finished Pi process (NDJSON stdout, stderr, exit, timeout)
//! into a step outcome (Rails `PiAgentRunner#normalize`). Everything that
//! leaves this function is redacted.

use serde_json::{Value, json};

use crate::features::runs::domain::output_format_validator;
use crate::features::runs::ports::step_runner::{OutcomeStatus, StepRunOutcome};
use crate::shared::output_format::OutputFileFormat;
use crate::shared::redactor::Redactor;

pub struct Finished<'a> {
    pub stdout: &'a str,
    pub stderr: &'a str,
    pub exit_code: Option<i32>,
    pub timed_out: bool,
    pub timeout_seconds: u64,
    pub format: OutputFileFormat,
    pub elapsed_ms: i64,
}

const TAIL: usize = 2_000;

fn tail(redactor: &Redactor, text: &str) -> String {
    let redacted = redactor.redact(text);
    let count = redacted.chars().count();
    redacted.chars().skip(count.saturating_sub(TAIL)).collect()
}

fn exit(code: Option<i32>) -> String {
    code.map(|c| c.to_string()).unwrap_or_default()
}

pub fn failure(
    status: OutcomeStatus,
    human: &str,
    technical: String,
    session_content: Option<String>,
    messages: Option<Value>,
    elapsed_ms: i64,
) -> StepRunOutcome {
    StepRunOutcome {
        status,
        output_text: None,
        output: None,
        messages,
        session_content,
        usage: Some(json!({})),
        exit_status: None,
        human_error: Some(human.to_string()),
        technical_error: Some(technical),
        elapsed_ms,
    }
}

/// `None` when any non-blank line is not a JSON object.
pub fn parse_events(stdout: &str) -> Option<Vec<Value>> {
    let mut events = Vec::new();
    for line in stdout.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        match serde_json::from_str::<Value>(line) {
            Ok(v @ Value::Object(_)) => events.push(v),
            _ => return None,
        }
    }
    Some(events)
}

fn content(message: &Value) -> &[Value] {
    message.get("content").and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[])
}

fn text_of(message: &Value) -> String {
    content(message)
        .iter()
        .filter(|b| b.get("type").and_then(Value::as_str) == Some("text"))
        .filter_map(|b| b.get("text").and_then(Value::as_str))
        .collect::<Vec<_>>()
        .join("\n")
}

fn messages(events: &[Value], redactor: &Redactor) -> Value {
    Value::Array(
        events
            .iter()
            .filter(|e| e.get("type").and_then(Value::as_str) == Some("message_end"))
            .filter_map(|e| {
                let message = e.get("message")?;
                let text = text_of(message);
                let tool_calls = content(message)
                    .iter()
                    .filter(|b| b.get("type").and_then(Value::as_str) == Some("toolCall"))
                    .count();
                if text.is_empty() && tool_calls == 0 {
                    return None;
                }
                let mut m = json!({
                    "role": message.get("role").cloned().unwrap_or(Value::Null),
                    "text": redactor.redact(&text),
                    "tool_calls": tool_calls,
                });
                if let Some(reason) = message.get("stopReason").filter(|v| !v.is_null()) {
                    m["stop_reason"] = reason.clone();
                }
                if let Some(error) = message.get("errorMessage").and_then(Value::as_str) {
                    m["error"] = json!(redactor.redact(error));
                }
                Some(m)
            })
            .collect(),
    )
}

pub fn normalize(f: Finished<'_>, redactor: &Redactor) -> StepRunOutcome {
    let session = Some(redactor.redact(f.stdout));
    if f.timed_out {
        return failure(
            OutcomeStatus::Timeout,
            &format!("The agent did not finish within {} seconds.", f.timeout_seconds),
            format!(
                "Process timed out. Partial output: {} {}",
                tail(redactor, f.stdout),
                tail(redactor, f.stderr)
            )
            .trim()
            .to_string(),
            session,
            None,
            f.elapsed_ms,
        );
    }
    let Some(events) = parse_events(f.stdout) else {
        return failure(
            OutcomeStatus::MalformedOutput,
            "The agent produced unreadable output.",
            format!(
                "Could not parse Pi's NDJSON stream (exit {}). stderr: {}",
                exit(f.exit_code),
                tail(redactor, f.stderr)
            ),
            session,
            None,
            f.elapsed_ms,
        );
    };
    let messages = Some(messages(&events, redactor));
    let final_message = events.iter().rev().find(|e| {
        e.get("type").and_then(Value::as_str) == Some("message_end")
            && e.pointer("/message/role").and_then(Value::as_str) == Some("assistant")
    });
    let Some(message) = final_message.and_then(|e| e.get("message")) else {
        return failure(
            OutcomeStatus::ExitError,
            "The agent stopped before producing a result.",
            format!(
                "No assistant message in Pi stream (exit {}). stderr: {}",
                exit(f.exit_code),
                tail(redactor, f.stderr)
            ),
            session,
            messages,
            f.elapsed_ms,
        );
    };
    if message.get("stopReason").and_then(Value::as_str) == Some("error") {
        return failure(
            OutcomeStatus::ModelError,
            "The selected model or provider could not complete the step.",
            redactor.redact(message.get("errorMessage").and_then(Value::as_str).unwrap_or("")),
            session,
            messages,
            f.elapsed_ms,
        );
    }
    if f.exit_code != Some(0) {
        return failure(
            OutcomeStatus::ExitError,
            "The agent process exited with an error.",
            format!("Exit {}. stderr: {}", exit(f.exit_code), tail(redactor, f.stderr)),
            session,
            messages,
            f.elapsed_ms,
        );
    }
    let text = text_of(message).trim().to_string();
    if text.is_empty() {
        let reason = message.get("stopReason").and_then(Value::as_str).unwrap_or("");
        return failure(
            OutcomeStatus::MalformedOutput,
            "The agent finished without producing any output.",
            format!("Assistant message ended with stop reason \"{reason}\" but no text content."),
            session,
            messages,
            f.elapsed_ms,
        );
    }
    let redacted = redactor.redact(&text);
    let accepted = match output_format_validator::validate(f.format, &redacted) {
        Ok(value) => value,
        Err(human) => {
            return failure(
                OutcomeStatus::MalformedOutput,
                human,
                format!("Output format validation failed for format {}.", f.format.as_str()),
                session,
                messages,
                f.elapsed_ms,
            );
        }
    };
    StepRunOutcome {
        status: OutcomeStatus::Success,
        output: serde_json::from_str(&accepted).ok(),
        output_text: Some(accepted),
        messages,
        session_content: session,
        usage: Some(message.get("usage").cloned().unwrap_or_else(|| json!({}))),
        exit_status: f.exit_code,
        human_error: None,
        technical_error: None,
        elapsed_ms: f.elapsed_ms,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn finished(stdout: &str) -> Finished<'_> {
        Finished {
            stdout,
            stderr: "",
            exit_code: Some(0),
            timed_out: false,
            timeout_seconds: 900,
            format: OutputFileFormat::FreeTextMarkdown,
            elapsed_ms: 5,
        }
    }

    fn ok_stream(text: &str) -> String {
        [
            json!({"type": "session"}),
            json!({"type": "message_end", "message": {"role": "user", "content": [{"type": "text", "text": "hi"}]}}),
            json!({"type": "message_end", "message": {"role": "assistant", "content": [{"type": "text", "text": text}, {"type": "toolCall"}], "stopReason": "stop", "usage": {"totalTokens": 12}}}),
        ]
        .iter()
        .map(|e| e.to_string() + "\n")
        .collect()
    }

    #[test]
    fn success() {
        let r = Redactor::default();
        let stdout = ok_stream("the answer");
        let o = normalize(finished(&stdout), &r);
        assert_eq!(o.status, OutcomeStatus::Success);
        assert_eq!(o.output_text.as_deref(), Some("the answer"));
        assert_eq!(o.usage, Some(json!({"totalTokens": 12})));
        let m = o.messages.unwrap();
        assert_eq!(m.as_array().unwrap().len(), 2);
        assert_eq!(m[1]["role"], "assistant");
        assert_eq!(m[1]["tool_calls"], 1);
        assert_eq!(m[1]["stop_reason"], "stop");
    }

    #[test]
    fn json_output_is_parsed() {
        let stdout = ok_stream(r#"{"key":"value"}"#);
        let o = normalize(Finished { format: OutputFileFormat::Json, ..finished(&stdout) }, &Redactor::default());
        assert_eq!(o.output, Some(json!({"key": "value"})));
    }

    #[test]
    fn failure_branches() {
        let r = Redactor::new(["sk-live-supersecret".to_string()]);
        let err = json!({"type": "message_end", "message": {"role": "assistant", "content": [], "stopReason": "error", "errorMessage": "400: no such model sk-live-supersecret"}}).to_string();
        let o = normalize(finished(&err), &r);
        assert_eq!(o.status, OutcomeStatus::ModelError);
        assert_eq!(o.technical_error.as_deref(), Some("400: no such model [redacted]"));

        let o = normalize(finished("this is not json"), &r);
        assert_eq!(o.status, OutcomeStatus::MalformedOutput);
        assert_eq!(o.human_error.as_deref(), Some("The agent produced unreadable output."));

        let o = normalize(Finished { exit_code: Some(3), stderr: "boom happened", ..finished("") }, &r);
        assert_eq!(o.status, OutcomeStatus::ExitError);
        assert_eq!(o.human_error.as_deref(), Some("The agent stopped before producing a result."));
        assert!(o.technical_error.unwrap().contains("boom happened"));

        let stdout = ok_stream("x");
        let o = normalize(Finished { exit_code: Some(1), ..finished(&stdout) }, &r);
        assert_eq!(o.human_error.as_deref(), Some("The agent process exited with an error."));

        let empty = json!({"type": "message_end", "message": {"role": "assistant", "content": [], "stopReason": "stop"}}).to_string();
        let o = normalize(finished(&empty), &r);
        assert_eq!(o.human_error.as_deref(), Some("The agent finished without producing any output."));

        let o = normalize(Finished { timed_out: true, timeout_seconds: 1, ..finished("partial") }, &r);
        assert_eq!(o.status, OutcomeStatus::Timeout);
        assert_eq!(o.human_error.as_deref(), Some("The agent did not finish within 1 seconds."));
        assert!(o.technical_error.unwrap().starts_with("Process timed out. Partial output: partial"));

        let stdout = ok_stream("not json at all");
        let o = normalize(Finished { format: OutputFileFormat::Json, ..finished(&stdout) }, &r);
        assert_eq!(o.human_error.as_deref(), Some("The agent did not produce valid JSON."));
        assert!(!o.technical_error.unwrap().contains("not json at all"));
    }

    #[test]
    fn output_and_session_are_redacted() {
        let r = Redactor::new(["test-key-123".to_string()]);
        let stdout = ok_stream("key is test-key-123");
        let o = normalize(finished(&stdout), &r);
        assert_eq!(o.output_text.as_deref(), Some("key is [redacted]"));
        assert!(!o.session_content.unwrap().contains("test-key-123"));
    }
}
