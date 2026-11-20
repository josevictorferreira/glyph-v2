//! Pi chat event parser (spec 0024, task 4.5): turns Pi's JSONL session
//! events into `AgentEvent`s. Wire shapes follow Pi 1.0.3 `docs/json.md`;
//! the fixture `tests/fixtures/pi_chat_events.ndjson` is copied from it.
//! Parsing lives in the domain: no I/O, no process types.
use serde::Deserialize;
use serde_json::Value;

/// One parsed `AgentEvent` plus, for provider errors, the technical text.
#[derive(Debug, PartialEq)]
pub enum Parsed {
    Delta(String),
    ToolStarted {
        call_id: String,
        name: String,
    },
    ToolFinished {
        call_id: String,
        name: String,
        text: String,
        details: Value,
        is_error: bool,
    },
    /// A provider-level failure on the assistant stream.
    ProviderError(String),
    /// A well-formed line the turn loop does not act on.
    Ignored,
}

#[derive(Deserialize)]
struct Record {
    #[serde(rename = "type")]
    kind: String,
    #[serde(default)]
    #[serde(rename = "assistantMessageEvent")]
    assistant_message_event: Option<AssistantMessageEvent>,
    #[serde(default, rename = "toolCallId")]
    tool_call_id: Option<String>,
    #[serde(default, rename = "toolName")]
    tool_name: Option<String>,
    #[serde(default)]
    result: Option<ToolResult>,
    #[serde(default)]
    is_error: Option<bool>,
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum AssistantMessageEvent {
    TextDelta { delta: String },
    Error { error: Value },
}

#[derive(Deserialize)]
struct ToolResult {
    #[serde(default)]
    content: Vec<ContentBlock>,
    #[serde(default)]
    details: Value,
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum ContentBlock {
    Text { text: String },
}

/// Parses one JSONL record. Unreadable and uninteresting lines yield
/// `Parsed::Ignored`; the loop reading them never crashes on noise.
pub fn parse_line(line: &str) -> Parsed {
    let record: Record = match serde_json::from_str(line.trim()) {
        Ok(record) => record,
        Err(_) => return Parsed::Ignored,
    };
    match record.kind.as_str() {
        "message_update" => match record.assistant_message_event {
            Some(AssistantMessageEvent::TextDelta { delta }) => Parsed::Delta(delta),
            Some(AssistantMessageEvent::Error { error }) => {
                Parsed::ProviderError(technical_error(&error))
            }
            None => Parsed::Ignored,
        },
        "tool_execution_start" => match (record.tool_call_id, record.tool_name) {
            (Some(call_id), Some(name)) => Parsed::ToolStarted { call_id, name },
            _ => Parsed::Ignored,
        },
        "tool_execution_end" => match (record.tool_call_id, record.tool_name) {
            (Some(call_id), Some(name)) => {
                let result = record.result.unwrap_or(ToolResult {
                    content: Vec::new(),
                    details: Value::Null,
                });
                let text = result
                    .content
                    .into_iter()
                    .map(|block| match block {
                        ContentBlock::Text { text } => text,
                    })
                    .collect::<Vec<_>>()
                    .join("");
                Parsed::ToolFinished {
                    call_id,
                    name,
                    text,
                    details: result.details,
                    is_error: record.is_error.unwrap_or(false),
                }
            }
            _ => Parsed::Ignored,
        },
        // The authoritative final message arrives via `message_end`; the
        // turn loop already has every delta, so nothing to emit.
        _ => Parsed::Ignored,
    }
}

/// The technical text of a provider error, redaction upstream.
fn technical_error(error: &Value) -> String {
    error
        .get("message")
        .and_then(Value::as_str)
        .or_else(|| error.as_str())
        .unwrap_or("the provider stream failed")
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    const FIXTURE: &str = include_str!("../../../../tests/fixtures/pi_chat_events.ndjson");

    fn events() -> Vec<Parsed> {
        FIXTURE.lines().map(parse_line).collect()
    }

    #[test]
    fn text_deltas_stream_and_thinking_and_toolcall_deltas_are_ignored() {
        let deltas: Vec<_> = events()
            .into_iter()
            .filter_map(|e| match e {
                Parsed::Delta(delta) => Some(delta),
                _ => None,
            })
            .collect();
        assert_eq!(deltas, ["I'll ", "start with ", "Done. ", "Here you go."]);
    }

    #[test]
    fn tool_lifecycle_becomes_started_then_finished_with_text_and_details() {
        let events = events();
        let started = events.iter().find_map(|e| match e {
            Parsed::ToolStarted { call_id, name } => Some((call_id, name)),
            _ => None,
        });
        assert_eq!(
            started,
            Some((&"call_abc123".to_string(), &"list_workflows".to_string()))
        );
        let finished = events.iter().find_map(|e| match e {
            Parsed::ToolFinished { call_id, text, details, is_error, .. } => {
                Some((call_id, text, details, is_error))
            }
            _ => None,
        });
        let (call_id, text, details, is_error) = finished.expect("tool finished");
        assert_eq!(call_id, "call_abc123");
        assert_eq!(text, "Weekly digest (abc, active)");
        assert_eq!(details["workflows"][0]["name"], "Weekly digest");
        assert!(!is_error);
    }

    #[test]
    fn unreadable_lines_are_skipped() {
        assert_eq!(parse_line("not json at all"), Parsed::Ignored);
        assert_eq!(parse_line(""), Parsed::Ignored);
        // The fixture itself contains a noise line among real events.
        assert!(events().iter().any(|e| matches!(e, Parsed::Ignored)));
    }

    #[test]
    fn provider_error_yields_technical_error() {
        let errors: Vec<_> = events()
            .into_iter()
            .filter_map(|e| match e {
                Parsed::ProviderError(technical) => Some(technical),
                _ => None,
            })
            .collect();
        assert_eq!(errors, ["provider exploded"]);
    }

    #[test]
    fn unknown_event_kinds_are_ignored() {
        assert_eq!(parse_line(r#"{"type":"agent_start"}"#), Parsed::Ignored);
        assert_eq!(
            parse_line(r#"{"type":"queue_update","steering":[],"followUp":[]}"#),
            Parsed::Ignored
        );
    }
}
