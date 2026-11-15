//! Chat and message model. `Chat` and `Message` are plain data; the turn
//! loop (application) owns transitions.
use crate::shared::ids::{ChatId, ChatMessageId};
use crate::shared::time::Timestamp;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChatStatus {
    Idle,
    Running,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MessageKind {
    User,
    Assistant,
    Tool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MessageStatus {
    Streaming,
    Done,
    Failed,
}

/// What a `tool` message records: the tool name, a one-line summary, the
/// workflow or run it touched, an expandable detail body, and — for a
/// successful `update_workflow` — the data `RevertChange` needs.
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct ToolCall {
    pub name: String,
    pub summary: String,
    pub is_error: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workflow_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workflow_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub run_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub revert: Option<Revert>,
    pub reverted: bool,
}

/// Pre-change YAML plus the post-change fingerprint (Revert's CAS key).
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct Revert {
    pub previous_yaml: String,
    pub fingerprint: String,
}

impl ToolCall {
    /// Only a successful, unreverted `update_workflow` with stored YAML can
    /// be reverted; everything else links to the normal UI instead.
    pub fn revertible(&self) -> bool {
        self.name == "update_workflow"
            && !self.is_error
            && !self.reverted
            && self.revert.is_some()
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct Message {
    pub id: ChatMessageId,
    pub chat_id: ChatId,
    pub seq: i32,
    pub kind: MessageKind,
    pub status: MessageStatus,
    /// Markdown for user/assistant; `None` for tool messages.
    pub text: Option<String>,
    pub tool: Option<ToolCall>,
    pub error: Option<String>,
    pub created_at: Timestamp,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Chat {
    pub id: ChatId,
    pub title: String,
    pub status: ChatStatus,
    pub cancel_requested: bool,
    pub created_at: Timestamp,
    pub updated_at: Timestamp,
}

impl Message {
    /// A user message must say something.
    pub fn new_user(text: &str) -> Result<String, &'static str> {
        let trimmed = text.trim();
        if trimmed.is_empty() {
            return Err("Write a message first.");
        }
        Ok(trimmed.to_string())
    }
}

/// Chat title from the first user message: trimmed, whitespace collapsed,
/// capped at 60 characters with an ellipsis.
pub fn title_from(first_message: &str) -> String {
    let collapsed: String = first_message
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    let chars: Vec<char> = collapsed.chars().collect();
    if chars.len() > 60 {
        let truncated: String = chars[..59].iter().collect();
        format!("{truncated}…")
    } else {
        collapsed
    }
}
