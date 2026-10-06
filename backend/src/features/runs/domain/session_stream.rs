//! Bounded capture of Pi's NDJSON session stream.
//!
//! Pi emits one `message_update` record per streamed token (Pi 0.83 even
//! repeated the whole partial message in each) and one `tool_execution_update`
//! per tool progress tick. Persisting that verbatim grows with the token count,
//! and every progress snapshot rewrites it. The compactor keeps every other
//! record verbatim and folds streaming records into one in-flight assistant
//! message, so the session stays proportional to the conversation itself.

use serde_json::{Value, json};

#[derive(Debug, Default)]
pub struct SessionCompactor {
    /// Complete records kept verbatim, each terminated by `\n`.
    kept: String,
    /// Bytes of the current, not yet terminated record.
    pending: Vec<u8>,
    /// Assistant message being streamed, rebuilt from `message_update` deltas.
    partial: Option<Value>,
}

impl SessionCompactor {
    pub fn push(&mut self, bytes: &[u8]) {
        let mut rest = bytes;
        while let Some(i) = rest.iter().position(|&b| b == b'\n') {
            self.pending.extend_from_slice(&rest[..i]);
            let line = std::mem::take(&mut self.pending);
            self.record(&line);
            rest = &rest[i + 1..];
        }
        self.pending.extend_from_slice(rest);
    }

    /// Kept records, then the in-flight message as one `message_update`
    /// record, then any unterminated tail (a crash mid-record stays visible,
    /// so it still fails NDJSON parsing).
    pub fn snapshot(&self) -> String {
        let mut out = self.kept.clone();
        if let Some(message) = &self.partial {
            out.push_str(&json!({ "type": "message_update", "message": message }).to_string());
            out.push('\n');
        }
        out.push_str(&String::from_utf8_lossy(&self.pending));
        out
    }

    fn record(&mut self, line: &[u8]) {
        let line = String::from_utf8_lossy(line);
        let line = line.strip_suffix('\r').unwrap_or(&line);
        if line.trim().is_empty() {
            return;
        }
        let event = match serde_json::from_str::<Value>(line) {
            Ok(Value::Object(event)) => event,
            _ => return self.keep(line),
        };
        match event.get("type").and_then(Value::as_str) {
            Some("message_update") => match event.get("message") {
                Some(message) => self.partial = Some(message.clone()),
                None => {
                    if let Some(delta) = event.get("assistantMessageEvent") {
                        self.apply(delta);
                    }
                }
            },
            Some("tool_execution_update") => {}
            Some("message_start") => {
                self.partial = event
                    .get("message")
                    .filter(|m| m.get("role").and_then(Value::as_str) == Some("assistant"))
                    .cloned();
                self.keep(line);
            }
            Some("message_end") => {
                self.partial = None;
                self.keep(line);
            }
            _ => self.keep(line),
        }
    }

    fn keep(&mut self, line: &str) {
        self.kept.push_str(line);
        self.kept.push('\n');
    }

    /// Applies one delta-only `assistantMessageEvent` (Pi ≥ 0.87).
    fn apply(&mut self, delta: &Value) {
        let Some(index) = delta
            .get("contentIndex")
            .and_then(Value::as_u64)
            .map(|i| i as usize)
        else {
            return;
        };
        let message = self
            .partial
            .get_or_insert_with(|| json!({ "role": "assistant", "content": [] }));
        if !message.get("content").is_some_and(Value::is_array) {
            message["content"] = json!([]);
        }
        let content = message["content"]
            .as_array_mut()
            .expect("content is an array");
        if content.len() <= index {
            content.resize(index + 1, json!({}));
        }
        let block = &mut content[index];
        let text = |s: Option<&Value>| s.and_then(Value::as_str).unwrap_or("").to_string();
        match delta.get("type").and_then(Value::as_str) {
            Some("text_start") => *block = json!({ "type": "text", "text": "" }),
            Some("text_delta") => append(block, "text", &text(delta.get("delta"))),
            Some("text_end") => {
                *block = json!({ "type": "text", "text": text(delta.get("content")) })
            }
            Some("thinking_start") => *block = json!({ "type": "thinking", "thinking": "" }),
            Some("thinking_delta") => append(block, "thinking", &text(delta.get("delta"))),
            Some("thinking_end") => {
                *block = json!({ "type": "thinking", "thinking": text(delta.get("content")) })
            }
            Some("toolcall_start") => {
                *block = json!({
                    "type": "toolCall",
                    "id": delta.get("id").cloned().unwrap_or(Value::Null),
                    "name": delta.get("toolName").cloned().unwrap_or(Value::Null),
                })
            }
            Some("toolcall_end") => {
                if let Some(call) = delta.get("toolCall") {
                    *block = call.clone();
                }
            }
            _ => {}
        }
    }
}

/// Appends to `block[field]`, turning the block into that kind if needed.
fn append(block: &mut Value, field: &str, delta: &str) {
    if let Some(Value::String(s)) = block.get_mut(field) {
        s.push_str(delta);
    } else {
        *block = json!({ "type": field, field: delta });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::features::runs::domain::session_transcript::{Block, blocks};

    fn ndjson(events: &[Value]) -> String {
        events.iter().map(|e| e.to_string() + "\n").collect()
    }

    fn compact(raw: &str) -> String {
        let mut c = SessionCompactor::default();
        c.push(raw.as_bytes());
        c.snapshot()
    }

    fn update(delta: Value) -> Value {
        json!({ "type": "message_update", "usage": { "output": 1 }, "assistantMessageEvent": delta })
    }

    #[test]
    fn keeps_records_verbatim_and_drops_finished_deltas() {
        let end = json!({"type": "message_end", "message": {"role": "assistant", "content": [{"type": "text", "text": "Hello world"}]}});
        let raw = ndjson(&[
            json!({"type": "session", "version": 3}),
            json!({"type": "message_start", "message": {"role": "assistant", "content": []}}),
            update(json!({"type": "text_start", "contentIndex": 0})),
            update(json!({"type": "text_delta", "contentIndex": 0, "delta": "Hello "})),
            update(json!({"type": "text_delta", "contentIndex": 0, "delta": "world"})),
            end.clone(),
            json!({"type": "agent_end", "messages": []}),
        ]);
        assert_eq!(
            compact(&raw),
            ndjson(&[
                json!({"type": "session", "version": 3}),
                json!({"type": "message_start", "message": {"role": "assistant", "content": []}}),
                end,
                json!({"type": "agent_end", "messages": []}),
            ])
        );
    }

    #[test]
    fn in_flight_message_is_rebuilt_from_deltas() {
        let raw = ndjson(&[
            json!({"type": "message_start", "message": {"role": "assistant", "content": []}}),
            update(json!({"type": "thinking_start", "contentIndex": 0})),
            update(json!({"type": "thinking_delta", "contentIndex": 0, "delta": "let me "})),
            update(json!({"type": "thinking_delta", "contentIndex": 0, "delta": "think"})),
            update(json!({"type": "thinking_end", "contentIndex": 0, "content": "let me think"})),
            update(json!({"type": "text_start", "contentIndex": 1})),
            update(json!({"type": "text_delta", "contentIndex": 1, "delta": "<html>"})),
            update(
                json!({"type": "toolcall_start", "contentIndex": 2, "id": "c1", "toolName": "bash"}),
            ),
            update(json!({"type": "toolcall_delta", "contentIndex": 2, "delta": "{\"comm"})),
        ]);
        let snapshot = compact(&raw);
        assert_eq!(snapshot.lines().count(), 2, "{snapshot}");
        assert_eq!(
            blocks(&snapshot),
            vec![
                Block::Thinking("let me think".into()),
                Block::Text("<html>".into())
            ]
        );
        let last: Value = serde_json::from_str(snapshot.lines().last().unwrap()).unwrap();
        assert_eq!(
            last.pointer("/message/content/2"),
            Some(&json!({"type": "toolCall", "id": "c1", "name": "bash"}))
        );
    }

    #[test]
    fn size_tracks_the_text_not_the_token_count() {
        let mut c = SessionCompactor::default();
        c.push(
            json!({"type": "message_start", "message": {"role": "assistant", "content": []}})
                .to_string()
                .as_bytes(),
        );
        c.push(b"\n");
        for _ in 0..10_000 {
            let line = update(json!({"type": "text_delta", "contentIndex": 0, "delta": "ab"}));
            c.push((line.to_string() + "\n").as_bytes());
        }
        let snapshot = c.snapshot();
        assert!(snapshot.len() < 20_000 + 500, "{}", snapshot.len());
        assert_eq!(blocks(&snapshot), vec![Block::Text("ab".repeat(10_000))]);
    }

    #[test]
    fn cumulative_updates_from_older_pi_keep_only_the_latest() {
        let raw = ndjson(&[
            json!({"type": "message_update", "message": {"role": "assistant", "content": [{"type": "text", "text": "a"}]}}),
            json!({"type": "message_update", "message": {"role": "assistant", "content": [{"type": "text", "text": "ab"}]}}),
        ]);
        assert_eq!(
            compact(&raw),
            ndjson(&[
                json!({"type": "message_update", "message": {"role": "assistant", "content": [{"type": "text", "text": "ab"}]}})
            ])
        );
    }

    #[test]
    fn tool_progress_ticks_are_dropped() {
        let start = json!({"type": "tool_execution_start", "toolCallId": "1", "toolName": "bash", "args": {"command": "ls"}});
        let end = json!({"type": "tool_execution_end", "toolCallId": "1", "toolName": "bash", "result": {}, "isError": false});
        let raw = ndjson(&[
            start.clone(),
            json!({"type": "tool_execution_update", "toolCallId": "1", "partialResult": {"content": [{"type": "text", "text": "x".repeat(1000)}]}}),
            end.clone(),
        ]);
        assert_eq!(compact(&raw), ndjson(&[start, end]));
    }

    #[test]
    fn records_split_across_chunks_and_unparseable_lines_survive() {
        let mut c = SessionCompactor::default();
        c.push(b"{\"type\":\"agent_");
        c.push(b"start\"}\r\nnot json\n\n{\"type\":\"message_e");
        assert_eq!(
            c.snapshot(),
            "{\"type\":\"agent_start\"}\nnot json\n{\"type\":\"message_e"
        );
    }

    #[test]
    fn a_finished_message_replaces_the_partial() {
        let raw = ndjson(&[
            json!({"type": "message_start", "message": {"role": "assistant", "content": []}}),
            update(json!({"type": "text_delta", "contentIndex": 0, "delta": "draft"})),
            json!({"type": "message_end", "message": {"role": "assistant", "content": [{"type": "text", "text": "final"}]}}),
            json!({"type": "message_start", "message": {"role": "user", "content": []}}),
        ]);
        let snapshot = compact(&raw);
        assert!(!snapshot.contains("draft"), "{snapshot}");
        assert_eq!(blocks(&snapshot), vec![Block::Text("final".into())]);
    }
}
