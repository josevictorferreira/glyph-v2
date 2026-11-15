//! Chat agent: conversations with a Pi-backed agent that edits workflows
//! through the ten Glyph tools (spec 0024).
pub mod domain;

pub use domain::model::{
    Chat, ChatStatus, Message, MessageKind, MessageStatus, ToolCall, title_from,
};
