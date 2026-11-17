//! Chat use cases: CRUD today; send/cancel/watch/revert arrive with the
//! turn pipeline. Mutations append their events in the same transaction.
use std::sync::Arc;
use crate::features::chat::domain::model::*;
use crate::features::chat::ports::{ChatStore, NewMessage};
use crate::features::settings::SettingsService;
use crate::shared::error::{DomainError, DomainResult};
use crate::shared::events::Job;
use crate::shared::ids::ChatId;
use crate::shared::time::Clock;

pub const RUN_CHAT_TURN: &str = "run_chat_turn";
pub const CHAT_QUEUE: &str = "chat";

#[derive(Clone)]
pub struct ChatService {
    store: Arc<dyn ChatStore>,
    settings: SettingsService,
    clock: Arc<dyn Clock>,
}

impl ChatService {
    pub fn new(store: Arc<dyn ChatStore>, settings: SettingsService, clock: Arc<dyn Clock>) -> Self {
        Self { store, settings, clock }
    }

    fn chat_event(event_type: &str, chat: ChatId, extra: serde_json::Value) -> crate::shared::events::DomainEvent {
        let mut data = serde_json::Map::new();
        data.insert("chat_id".into(), serde_json::json!(chat.to_string()));
        if let serde_json::Value::Object(fields) = extra {
            data.extend(fields);
        }
        crate::shared::events::DomainEvent {
            event_type: event_type.to_string(),
            stream: format!("Chat${chat}"),
            correlation_id: None,
            data: serde_json::Value::Object(data),
        }
    }

    async fn chat(&self, id: ChatId) -> DomainResult<Chat> {
        self.store
            .find(id)
            .await?
            .map(|(chat, _)| chat)
            .ok_or(DomainError::NotFound("chat"))
    }

    pub async fn list(&self) -> DomainResult<Vec<Chat>> {
        self.store.list().await
    }

    pub async fn get(&self, id: ChatId) -> DomainResult<(Chat, Vec<Message>)> {
        self.store
            .find(id)
            .await?
            .ok_or(DomainError::NotFound("chat"))
    }

    pub async fn create(&self) -> DomainResult<Chat> {
        let now = self.clock.now();
        let chat = Chat {
            id: ChatId::new(),
            title: String::new(),
            status: ChatStatus::Idle,
            cancel_requested: false,
            created_at: now,
            updated_at: now,
        };
        let mut tx = self.store.begin().await?;
        tx.create_chat(&chat).await?;
        tx.append_events(&[Self::chat_event(
            "ChatCreated",
            chat.id,
            serde_json::json!({}),
        )])
        .await?;
        tx.commit().await?;
        Ok(chat)
    }

    pub async fn rename(&self, id: ChatId, title: &str) -> DomainResult<Chat> {
        let title = title.trim();
        if title.is_empty() {
            return Err(DomainError::invalid("Write a title first."));
        }
        let mut tx = self.store.begin().await?;
        tx.rename_chat(id, title).await?;
        tx.append_events(&[Self::chat_event(
            "ChatRenamed",
            id,
            serde_json::json!({ "title": title }),
        )])
        .await?;
        tx.commit().await?;
        self.chat(id).await
    }

    /// Marks the running turn for cancellation; the turn loop notices
    /// within its poll interval. Idempotent on idle chats.
    pub async fn cancel_turn(&self, id: ChatId) -> DomainResult<()> {
        let mut tx = self.store.begin().await?;
        tx.request_cancel(id).await?;
        tx.commit().await?;
        Ok(())
    }

    /// Crash recovery: a turn whose worker died is finalised `failed` with
    /// the interrupted message, in one transaction.
    pub async fn interrupt_turn(&self, id: ChatId) -> DomainResult<()> {
        let (chat, messages) = self.store.find(id).await?.ok_or(DomainError::NotFound("chat"))?;
        if chat.status != ChatStatus::Running {
            return Ok(());
        }
        let assistant = messages
            .iter()
            .rev()
            .find(|m| m.kind == MessageKind::Assistant)
            .ok_or(DomainError::internal(anyhow::anyhow!("running chat without assistant message")))?;
        let mut tx = self.store.begin().await?;
        if assistant.status == MessageStatus::Streaming {
            tx.set_message_status(
                assistant.id,
                MessageStatus::Failed,
                Some("The turn was interrupted before it finished."),
            )
            .await?;
        }
        tx.end_turn(id, ChatStatus::Idle).await?;
        tx.append_events(&[Self::chat_event(
            "ChatTurnFailed",
            id,
            serde_json::json!({ "reason": "interrupted" }),
        )])
        .await?;
        tx.commit().await?;
        Ok(())
    }

    /// Appends the user message and an empty `streaming` assistant message,
    /// flips the chat to `running` (CAS) and enqueues exactly one turn job.
    pub async fn send(&self, id: ChatId, text: &str) -> DomainResult<()> {
        let text = text.trim();
        if text.is_empty() {
            return Err(DomainError::invalid("Write a message first."));
        }
        let chat = self.chat(id).await?;
        if chat.status == ChatStatus::Running {
            return Err(DomainError::precondition(
                "CHAT_TURN_RUNNING",
                "The agent is already replying; wait for it to finish.",
            ));
        }
        let Some(_model_id) = self.settings.chat_model_id().await? else {
            return Err(DomainError::precondition(
                "CHAT_MODEL_MISSING",
                "Pick a model for the agent in Settings first.",
            ));
        };
        let mut tx = self.store.begin().await?;
        if !tx.begin_turn(id).await? {
            return Err(DomainError::precondition(
                "CHAT_TURN_RUNNING",
                "The agent is already replying; wait for it to finish.",
            ));
        }
        tx.insert_message(&NewMessage {
            chat_id: id,
            kind: MessageKind::User,
            status: MessageStatus::Done,
            text: Some(text.to_string()),
            tool: None,
        })
        .await?;
        tx.insert_message(&NewMessage {
            chat_id: id,
            kind: MessageKind::Assistant,
            status: MessageStatus::Streaming,
            text: None,
            tool: None,
        })
        .await?;
        if chat.title.is_empty() {
            tx.rename_chat(id, &title_from(text)).await?;
        }
        tx.append_events(&[Self::chat_event(
            "ChatTurnStarted",
            id,
            serde_json::json!({ "message": text }),
        )])
        .await?;
        tx.enqueue(Job::new(
            RUN_CHAT_TURN,
            CHAT_QUEUE,
            serde_json::json!({ "chat_id": id.to_string() }),
        ))
        .await?;
        tx.commit().await?;
        Ok(())
    }

    pub async fn delete(&self, id: ChatId) -> DomainResult<()> {
        let chat = self.chat(id).await?;
        if chat.status == ChatStatus::Running {
            return Err(DomainError::precondition(
                "CHAT_TURN_RUNNING",
                "Stop the agent before deleting this chat.",
            ));
        }
        let mut tx = self.store.begin().await?;
        tx.delete_chat(id).await?;
        tx.append_events(&[Self::chat_event(
            "ChatDeleted",
            id,
            serde_json::json!({ "title": chat.title }),
        )])
        .await?;
        tx.commit().await?;
        Ok(())
    }
}

mod turn;
