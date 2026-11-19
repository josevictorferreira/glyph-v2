//! Chat agent: conversations with a Pi-backed agent that edits workflows
//! through the ten Glyph tools (spec 0024).
pub mod application;
pub mod domain;
pub mod grpc;
pub mod http;
pub mod ports;

pub use application::ChatService;
pub use domain::model::{
    Chat, ChatStatus, Message, MessageKind, MessageStatus, ToolCall, title_from,
};
pub use ports::{ChatStore, ChatTx};
pub use application::{CHAT_QUEUE, RUN_CHAT_TURN};
