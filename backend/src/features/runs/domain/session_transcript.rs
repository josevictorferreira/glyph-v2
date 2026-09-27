//! Redacted Pi NDJSON session → display blocks (Rails `SessionTranscript`).
//! Tolerant of a partial trailing line (progress snapshots split mid-line).

use std::collections::HashMap;

use serde_json::Value;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ToolState {
    Running,
    Done,
    Error,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Block {
    Text(String),
    Thinking(String),
    Tool {
        name: String,
        summary: String,
        state: ToolState,
    },
}

pub fn blocks(session_content: &str) -> Vec<Block> {
    let mut out: Vec<Block> = Vec::new();
    let mut tools: HashMap<String, usize> = HashMap::new();
    let mut pending: Option<Value> = None;
    for line in session_content.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let Ok(Value::Object(event)) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        let assistant = |m: Option<&Value>| {
            m.filter(|m| m.get("role").and_then(Value::as_str) == Some("assistant"))
                .cloned()
        };
        match event.get("type").and_then(Value::as_str) {
            Some("message_start" | "message_update") => {
                if let Some(m) = assistant(event.get("message")) {
                    pending = Some(m);
                }
            }
            Some("message_end") => {
                if let Some(m) = assistant(event.get("message")) {
                    append_message(&mut out, &m);
                    pending = None;
                }
            }
            Some("tool_execution_start") => {
                out.push(tool_block(&event, ToolState::Running));
                if let Some(id) = event.get("toolCallId") {
                    tools.insert(id.to_string(), out.len() - 1);
                }
            }
            Some("tool_execution_end") => {
                let state = if event
                    .get("isError")
                    .and_then(Value::as_bool)
                    .unwrap_or(false)
                {
                    ToolState::Error
                } else {
                    ToolState::Done
                };
                let known = event
                    .get("toolCallId")
                    .and_then(|id| tools.get(&id.to_string()))
                    .copied();
                match known {
                    Some(i) => {
                        if let Block::Tool { state: s, .. } = &mut out[i] {
                            *s = state;
                        }
                    }
                    None => out.push(tool_block(&event, state)),
                }
            }
            _ => {}
        }
    }
    if let Some(m) = pending {
        append_message(&mut out, &m);
    }
    out
}

fn append_message(out: &mut Vec<Block>, message: &Value) {
    let Some(parts) = message.get("content").and_then(Value::as_array) else {
        return;
    };
    for part in parts {
        match part.get("type").and_then(Value::as_str) {
            Some("text") => {
                let text = part
                    .get("text")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .trim();
                if !text.is_empty() {
                    out.push(Block::Text(text.to_string()));
                }
            }
            Some("thinking") => {
                let text = part
                    .get("thinking")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .trim();
                if !text.is_empty() {
                    out.push(Block::Thinking(text.to_string()));
                }
            }
            _ => {}
        }
    }
}

fn tool_block(event: &serde_json::Map<String, Value>, state: ToolState) -> Block {
    let name = event
        .get("toolName")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let summary = match event.get("args") {
        Some(Value::Object(args)) => {
            let s = args
                .get("command")
                .or_else(|| args.get("path"))
                .map(|v| {
                    v.as_str()
                        .map(str::to_string)
                        .unwrap_or_else(|| v.to_string())
                })
                .unwrap_or_else(|| Value::Object(args.clone()).to_string());
            truncate(&s, 120)
        }
        _ => String::new(),
    };
    Block::Tool {
        name,
        summary,
        state,
    }
}

/// Rails `String#truncate`: at most `max` chars including the "..." suffix.
fn truncate(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        s.to_string()
    } else {
        let mut out: String = s.chars().take(max - 3).collect();
        out.push_str("...");
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn ndjson(events: &[Value]) -> String {
        events.iter().map(|e| e.to_string() + "\n").collect()
    }

    #[test]
    fn text_and_thinking() {
        let content = ndjson(&[
            json!({"type": "session", "version": 3}),
            json!({"type": "agent_start"}),
            json!({"type": "message_end", "message": {"role": "assistant", "content": [
                {"type": "thinking", "thinking": "hmm"}, {"type": "text", "text": "**Hello**"}]}}),
            json!({"type": "agent_end"}),
        ]);
        assert_eq!(
            blocks(&content),
            vec![
                Block::Thinking("hmm".into()),
                Block::Text("**Hello**".into())
            ]
        );
    }

    #[test]
    fn tool_states() {
        let content = ndjson(&[
            json!({"type": "tool_execution_start", "toolCallId": "1", "toolName": "bash", "args": {"command": "ls -la"}}),
            json!({"type": "tool_execution_end", "toolCallId": "1", "toolName": "bash", "result": {}, "isError": false}),
            json!({"type": "tool_execution_start", "toolCallId": "2", "toolName": "read", "args": {"path": "/tmp/x"}}),
            json!({"type": "tool_execution_end", "toolCallId": "2", "toolName": "read", "result": {}, "isError": true}),
            json!({"type": "tool_execution_end", "toolCallId": "3", "toolName": "edit", "args": {"x": 1}}),
        ]);
        assert_eq!(
            blocks(&content),
            vec![
                Block::Tool {
                    name: "bash".into(),
                    summary: "ls -la".into(),
                    state: ToolState::Done
                },
                Block::Tool {
                    name: "read".into(),
                    summary: "/tmp/x".into(),
                    state: ToolState::Error
                },
                Block::Tool {
                    name: "edit".into(),
                    summary: "{\"x\":1}".into(),
                    state: ToolState::Done
                },
            ]
        );
    }

    #[test]
    fn streaming_message_and_partial_line() {
        let content = ndjson(&[
            json!({"type": "message_end", "message": {"role": "assistant", "content": [{"type": "text", "text": "first"}]}}),
            json!({"type": "message_start", "message": {"role": "assistant", "content": []}}),
            json!({"type": "message_update", "message": {"role": "assistant", "content": [{"type": "text", "text": "partial out"}]}}),
        ]) + "{\"type\":\"message_upda";
        assert_eq!(
            blocks(&content),
            vec![
                Block::Text("first".into()),
                Block::Text("partial out".into())
            ]
        );
    }

    #[test]
    fn ignores_other_roles() {
        let content = ndjson(&[
            json!({"type": "message_end", "message": {"role": "user", "content": [{"type": "text", "text": "the prompt"}]}}),
            json!({"type": "message_end", "message": {"role": "toolResult", "content": [{"type": "text", "text": "tool out"}]}}),
        ]);
        assert!(blocks(&content).is_empty());
    }

    #[test]
    fn long_summaries_truncate() {
        let long = "x".repeat(200);
        let content = ndjson(&[
            json!({"type": "tool_execution_start", "toolCallId": "1", "toolName": "bash", "args": {"command": long}}),
        ]);
        let Block::Tool { summary, .. } = &blocks(&content)[0] else {
            panic!()
        };
        assert_eq!(summary.chars().count(), 120);
        assert!(summary.ends_with("..."));
    }
}
