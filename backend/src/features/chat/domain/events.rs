//! Chat events: what the worker broadcasts during a turn (spec 0024).
//! Carried over `pg_notify` on the chat channel; serialized like
//! `LiveEvent` (`type` field, absent-when-None).

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

/// The Postgres LISTEN/NOTIFY channel for chat events.
pub const CHANNEL: &str = "glyph_chat";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ChatEventKind {
    TextDelta,
    MessageUpdated,
    ChatUpdated,
    Resync,
    Heartbeat,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatEvent {
    #[serde(rename = "type")]
    pub kind: ChatEventKind,
    pub chat_id: String,
    /// Character offset of `text` in the message being streamed.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub offset: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message_id: Option<String>,
    pub occurred_at: DateTime<Utc>,
}

/// NOTIFY payloads must stay small; Postgres and the wire both prefer
/// it. Split on character boundaries with contiguous offsets.
pub fn split_oversized(event: &ChatEvent) -> Vec<ChatEvent> {
    const MAX_PAYLOAD_BYTES: usize = 1800;
    let text = match &event.text {
        Some(t) if t.len() > MAX_PAYLOAD_BYTES => t.clone(),
        _ => return vec![event.clone()],
    };
    let mut parts = Vec::new();
    let mut offset = event.offset.unwrap_or(0);
    let mut chars = text.chars().peekable();
    while chars.peek().is_some() {
        let mut chunk = String::new();
        while let Some(c) = chars.peek() {
            if chunk.len() + c.len_utf8() > MAX_PAYLOAD_BYTES {
                break;
            }
            chunk.push(*chars.peek().unwrap());
            chars.next();
        }
        parts.push(ChatEvent {
            kind: ChatEventKind::TextDelta,
            chat_id: event.chat_id.clone(),
            offset: Some(offset),
            text: Some(chunk.clone()),
            message_id: event.message_id.clone(),
            occurred_at: event.occurred_at,
        });
        offset += chunk.chars().count();
    }
    parts
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Mirrors the payload-shape test in `live/domain.rs`.
    #[test]
    fn payload_shape() {
        let e = ChatEvent {
            kind: ChatEventKind::TextDelta,
            chat_id: "c".into(),
            offset: Some(3),
            text: Some("lo".into()),
            message_id: Some("m".into()),
            occurred_at: "2026-01-01T00:00:00Z".parse().unwrap(),
        };
        let json = serde_json::to_value(&e).unwrap();
        assert_eq!(json["type"], "TEXT_DELTA");
        assert_eq!(json["chat_id"], "c");
        assert_eq!(json["offset"], 3);
        assert_eq!(json["text"], "lo");
        assert_eq!(json["message_id"], "m");
        // round trip
        let back: ChatEvent = serde_json::from_value(json).unwrap();
        assert_eq!(back.kind, ChatEventKind::TextDelta);
    }

    #[test]
    fn none_fields_are_absent() {
        let e = ChatEvent {
            kind: ChatEventKind::ChatUpdated,
            chat_id: "c".into(),
            offset: None,
            text: None,
            message_id: None,
            occurred_at: "2026-01-01T00:00:00Z".parse().unwrap(),
        };
        let json = serde_json::to_value(&e).unwrap();
        assert!(json.get("offset").is_none());
        assert!(json.get("text").is_none());
        assert!(json.get("message_id").is_none());
    }
}
