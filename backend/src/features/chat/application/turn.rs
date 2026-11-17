//! One chat turn: consume `AgentEvent`s from a runner, publish redacted
//! deltas, persist published text, watch cancellation, finalise in one
//! transaction. Runners never touch storage.
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::mpsc;
use crate::features::chat::application::ChatService;
use crate::features::chat::domain::events::{ChatEvent, ChatEventKind};
use crate::features::chat::domain::model::*;
use crate::features::chat::domain::stream::StreamBuffer;
use crate::features::chat::ports::{AgentEvent, ChatPublisher, ChatRunner, NewMessage, Turn};
use crate::shared::error::{DomainError, DomainResult};
use crate::shared::ids::{ChatId, ChatMessageId};
use crate::shared::redactor::Redactor;

/// Deltas are coalesced before publishing/persisting.
const COALESCE: Duration = Duration::from_millis(75);
/// How often `cancel_requested` is re-read from the store.
const POLL_CANCEL: Duration = Duration::from_secs(1);

impl ChatService {
    /// The `run_chat_turn` job body: runs one turn to completion.
    pub async fn run_turn(
        &self,
        chat_id: ChatId,
        runner: Arc<dyn ChatRunner>,
        publisher: Arc<dyn ChatPublisher>,
        redactor: Redactor,
    ) -> DomainResult<()> {
        let (_, messages) = self
            .store
            .find(chat_id)
            .await?
            .ok_or(DomainError::NotFound("chat"))?;
        let assistant = assistant_of(&messages)?;
        let Some(model_id) = self.settings.chat_model_id().await? else {
            let mut tx = self.store.begin().await?;
            tx.set_message_status(assistant, MessageStatus::Failed, Some("Pick a model for the agent in Settings first."))
                .await?;
            tx.end_turn(chat_id, ChatStatus::Idle).await?;
            tx.commit().await?;
            return Ok(());
        };
        let user_text = messages
            .iter()
            .rev()
            .find(|m| m.kind == MessageKind::User)
            .and_then(|m| m.text.clone())
            .unwrap_or_default();
        let session = {
            let mut tx = self.store.begin().await?;
            tx.load_session(chat_id).await?
        };
        let cancel = tokio_util::sync::CancellationToken::new();
        let (tx_events, mut rx_events) = mpsc::channel::<AgentEvent>(64);
        let turn = Turn { chat_id, model_id, message: user_text, session };
        let drive = tokio::spawn(async move { runner.run(turn, tx_events, cancel.clone()).await });

        let mut buffer = StreamBuffer::new(redactor.clone());
        let mut published = String::new();
        let mut open_tool: Option<ToolCall> = None;
        let mut pending = String::new();
        let mut since_publish = tokio::time::Instant::now();
        let mut final_event = "ChatTurnFinished";
        let mut failed_text: Option<String> = None;
        loop {
            let poll = tokio::time::sleep(POLL_CANCEL);
            tokio::select! {
                event = rx_events.recv() => match event {
                    Some(AgentEvent::TextDelta(delta)) => {
                        // Coalesce: accumulate and advance the buffer only
                        // when the flush interval elapses, so every published
                        // event is emitted, none silently swallowed.
                        pending.push_str(&delta);
                        if since_publish.elapsed() >= COALESCE {
                            if let Some(d) = buffer.push(&pending) {
                                pending.clear();
                                self.publish_delta(&d, &publisher, chat_id, assistant).await?;
                                published = buffer.published().to_string();
                                let mut tx = self.store.begin().await?;
                                tx.update_message_text(assistant, &published, MessageStatus::Streaming).await?;
                                tx.commit().await?;
                            } else {
                                pending.clear();
                            }
                            since_publish = tokio::time::Instant::now();
                        }
                    }
                    Some(AgentEvent::ToolStarted { call_id: _, name }) => {
                        if let Some(open) = open_tool.take() {
                            let mut tx = self.store.begin().await?;
                            tx.insert_message(&NewMessage {
                                chat_id,
                                kind: MessageKind::Tool,
                                status: MessageStatus::Done,
                                text: None,
                                tool: Some(open),
                            }).await?;
                            tx.commit().await?;
                        }
                        let summary = format!("Calling {name}…");
                        open_tool = Some(ToolCall {
                            name,
                            summary,
                            is_error: false,
                            workflow_id: None,
                            workflow_name: None,
                            run_id: None,
                            detail: None,
                            revert: None,
                            reverted: false,
                        });
                    }
                    Some(AgentEvent::ToolFinished { call_id: _, name, text, details: _, is_error }) => {
                        open_tool = Some(ToolCall {
                            name,
                            summary: text,
                            is_error,
                            workflow_id: None,
                            workflow_name: None,
                            run_id: None,
                            detail: None,
                            revert: None,
                            reverted: false,
                        });
                    }
                    None => break,
                },
                _ = poll => {
                    let mut tx = self.store.begin().await?;
                    let requested = tx.cancel_requested(chat_id).await?;
                    tx.commit().await?;
                    if requested {
                        drive.abort();
                        final_event = "ChatTurnFailed";
                        failed_text = Some("Cancelled.".into());
                        break;
                    }
                },
            }
        }
        let end = if failed_text.is_some() {
            None
        } else {
            drive.await.ok()
        };
        // Flush whatever the coalescing window never emitted.
        if let Some(d) = (!pending.is_empty()).then(|| buffer.push(&pending)).flatten() {
            self.publish_delta(&d, &publisher, chat_id, assistant).await?;
        }
        let end = end.unwrap_or(crate::features::chat::ports::TurnEnd { session: None, error: None });
        if let Some(delta) = buffer.finish() {
            self.publish_delta(&delta, &publisher, chat_id, assistant).await?;
            published = buffer.published().to_string();
        }
        let (status, error) = match (&end.error, &failed_text) {
            (_, Some(cancelled)) => (MessageStatus::Failed, Some(cancelled.clone())),
            (Some(e), None) => {
                final_event = "ChatTurnFailed";
                (MessageStatus::Failed, Some(e.human.clone()))
            }
            (None, None) => (MessageStatus::Done, None),
        };
        let mut tx = self.store.begin().await?;
        match status {
            MessageStatus::Done => {
                tx.update_message_text(assistant, &published, MessageStatus::Done).await?;
            }
            MessageStatus::Failed => {
                tx.update_message_text(assistant, &published, MessageStatus::Failed).await?;
                tx.set_message_status(assistant, MessageStatus::Failed, error.as_deref()).await?;
            }
            MessageStatus::Streaming => unreachable!(),
        }
        if let Some(open) = open_tool.take() {
            tx.insert_message(&NewMessage {
                chat_id,
                kind: MessageKind::Tool,
                status: MessageStatus::Done,
                text: None,
                tool: Some(open),
            }).await?;
        }
        tx.save_session(chat_id, end.session.as_ref()).await?;
        tx.end_turn(chat_id, ChatStatus::Idle).await?;
        tx.append_events(&[Self::chat_event(
            final_event,
            chat_id,
            serde_json::json!({}),
        )]).await?;
        tx.commit().await?;
        // Bus notifications for the streaming client: the message (status,
        // text) and then the chat (idle) changed.
        publisher.publish(&ChatEvent {
            kind: ChatEventKind::MessageUpdated,
            chat_id: chat_id.to_string(),
            offset: None,
            text: None,
            message_id: Some(assistant.to_string()),
            occurred_at: chrono::Utc::now(),
        });
        publisher.publish(&ChatEvent {
            kind: ChatEventKind::ChatUpdated,
            chat_id: chat_id.to_string(),
            offset: None,
            text: None,
            message_id: None,
            occurred_at: chrono::Utc::now(),
        });
        Ok(())
    }

    async fn publish_delta(
        &self,
        delta: &crate::features::chat::domain::stream::Delta,
        publisher: &Arc<dyn ChatPublisher>,
        chat_id: ChatId,
        assistant: ChatMessageId,
    ) -> DomainResult<()> {
        for part in crate::features::chat::domain::events::split_oversized(&ChatEvent {
            kind: ChatEventKind::TextDelta,
            chat_id: chat_id.to_string(),
            offset: Some(delta.offset),
            text: Some(delta.text.clone()),
            message_id: Some(assistant.to_string()),
            occurred_at: chrono::Utc::now(),
        }) {
            publisher.publish(&part);
        }
        Ok(())
    }
}

fn assistant_of(messages: &[Message]) -> DomainResult<ChatMessageId> {
    messages
        .iter()
        .rev()
        .find(|m| m.kind == MessageKind::Assistant)
        .map(|m| m.id)
        .ok_or_else(|| DomainError::internal(anyhow::anyhow!("no streaming assistant message")))
}
