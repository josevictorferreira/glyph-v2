//! Ports for the chat feature: persistence, the runner, the event bus.
use async_trait::async_trait;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;
use crate::features::chat::domain::model::*;
use crate::shared::error::DomainResult;
use crate::shared::ids::{ChatId, ChatMessageId};
use crate::shared::uow::UnitOfWork;

/// A stored Pi session file: bytes plus its path relative to the session dir.
pub struct SessionFile {
    pub relative_path: String,
    pub bytes: Vec<u8>,
}

/// Reads of chats; writes go through `ChatTx`.
#[async_trait]
pub trait ChatStore: Send + Sync {
    async fn list(&self) -> DomainResult<Vec<Chat>>;
    async fn find(&self, id: ChatId) -> DomainResult<Option<(Chat, Vec<Message>)>>;
    async fn begin(&self) -> DomainResult<Box<dyn ChatTx>>;
}

/// One transaction's chat writes.
#[async_trait]
pub trait ChatTx: UnitOfWork {
    async fn create_chat(&mut self, chat: &Chat) -> DomainResult<()>;
    async fn rename_chat(&mut self, id: ChatId, title: &str) -> DomainResult<()>;
    async fn delete_chat(&mut self, id: ChatId) -> DomainResult<()>;
    /// Compare-and-set `idle → running`; also clears `cancel_requested`.
    /// Returns false when the chat is not idle (or missing).
    async fn begin_turn(&mut self, id: ChatId) -> DomainResult<bool>;
    /// Sets status and `updated_at`; keeps `cancel_requested`.
    async fn end_turn(&mut self, id: ChatId, status: ChatStatus) -> DomainResult<()>;
    async fn request_cancel(&mut self, id: ChatId) -> DomainResult<()>;
    async fn cancel_requested(&mut self, id: ChatId) -> DomainResult<bool>;
    /// Appends a message at the next gap-free `seq`.
    async fn insert_message(&mut self, message: &NewMessage) -> DomainResult<ChatMessageId>;
    /// Overwrites a message's text (assistant accumulation) and status.
    async fn update_message_text(
        &mut self,
        id: ChatMessageId,
        text: &str,
        status: MessageStatus,
    ) -> DomainResult<()>;
    async fn set_message_status(
        &mut self,
        id: ChatMessageId,
        status: MessageStatus,
        error: Option<&str>,
    ) -> DomainResult<()>;
    async fn delete_message(&mut self, id: ChatMessageId) -> DomainResult<()>;
    async fn save_session(
        &mut self,
        id: ChatId,
        session: Option<&SessionFile>,
    ) -> DomainResult<()>;
    async fn load_session(&mut self, id: ChatId) -> DomainResult<Option<SessionFile>>;
}

/// A message to insert; `seq` is assigned by the store.
pub struct NewMessage {
    pub chat_id: ChatId,
    pub kind: MessageKind,
    pub status: MessageStatus,
    pub text: Option<String>,
    pub tool: Option<ToolCall>,
}

/// One turn of the conversation, handed to a runner.
pub struct Turn {
    pub chat_id: ChatId,
    pub model_id: String,
    pub message: String,
    pub session: Option<SessionFile>,
}

/// What a runner reports while a turn runs.
pub enum AgentEvent {
    TextDelta(String),
    ToolStarted {
        call_id: String,
        name: String,
    },
    ToolFinished {
        call_id: String,
        name: String,
        text: String,
        details: serde_json::Value,
        is_error: bool,
    },
}

pub struct TurnError {
    /// What the user sees.
    pub human: String,
    /// What diagnostics log (already redacted).
    pub technical: String,
}

pub struct TurnEnd {
    pub session: Option<SessionFile>,
    pub error: Option<TurnError>,
}

/// Runs one chat turn, translating a process (or a test script) into events.
/// The application owns the turn loop; runners never touch storage.
#[async_trait]
pub trait ChatRunner: Send + Sync {
    async fn run(
        &self,
        turn: Turn,
        events: mpsc::Sender<AgentEvent>,
        cancel: CancellationToken,
    ) -> TurnEnd;
}
