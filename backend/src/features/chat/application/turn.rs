//! One chat turn: consume `AgentEvent`s from a runner, publish redacted
//! deltas, persist published text, watch cancellation, finalise in one
//! transaction. Runners never touch storage.
//!
//! Tool calls split the reply into segments: `ToolStarted` closes the
//! streaming assistant segment (deleting it when no text ever arrived),
//! `ToolFinished` stores the tool card, and the next delta opens a fresh
//! segment. Offsets are per segment and restart at zero.
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

        // The open assistant segment, if any: `SendMessage` created one.
        let mut current: Option<ChatMessageId> = Some(assistant);
        let mut buffer = StreamBuffer::new(redactor.clone());
        let mut published = String::new();
        let mut pending = String::new();
        let mut since_publish = tokio::time::Instant::now();
        let mut final_event = "ChatTurnFinished";
        let mut failed_text: Option<String> = None;
        loop {
            let poll = tokio::time::sleep(POLL_CANCEL);
            tokio::select! {
                event = rx_events.recv() => match event {
                    Some(AgentEvent::TextDelta(delta)) => {
                        if current.is_none() {
                            // First delta after a tool call: a new segment.
                            let mut tx = self.store.begin().await?;
                            current = Some(tx.insert_message(&NewMessage {
                                chat_id,
                                kind: MessageKind::Assistant,
                                status: MessageStatus::Streaming,
                                text: None,
                                tool: None,
                            }).await?);
                            tx.commit().await?;
                        }
                        // Coalesce: accumulate and advance the buffer only
                        // when the flush interval elapses, so every published
                        // event is emitted, none silently swallowed.
                        pending.push_str(&delta);
                        if since_publish.elapsed() >= COALESCE {
                            if let Some(d) = buffer.push(&pending) {
                                pending.clear();
                                self.publish_delta(&d, &publisher, chat_id, current.unwrap()).await?;
                                published = buffer.published().to_string();
                                let mut tx = self.store.begin().await?;
                                tx.update_message_text(current.unwrap(), &published, MessageStatus::Streaming).await?;
                                tx.commit().await?;
                            } else {
                                pending.clear();
                            }
                            since_publish = tokio::time::Instant::now();
                        }
                    }
                    Some(AgentEvent::ToolStarted { call_id: _, name: _ }) => {
                        // Close the open segment: keep it when text was
                        // published, delete the placeholder when none was.
                        self.close_segment(
                            chat_id,
                            current.take(),
                            &mut buffer,
                            &mut published,
                            &mut pending,
                            &publisher,
                        )
                        .await?;
                    }
                    Some(AgentEvent::ToolFinished { call_id: _, name, text, details, is_error }) => {
                        let call = tool_call_from(&name, &text, &details, is_error, &redactor);
                        let mut tx = self.store.begin().await?;
                        tx.insert_message(&NewMessage {
                            chat_id,
                            kind: MessageKind::Tool,
                            status: MessageStatus::Done,
                            text: None,
                            tool: Some(call),
                        }).await?;
                        tx.commit().await?;
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
            self.publish_delta(&d, &publisher, chat_id, current.unwrap_or(assistant)).await?;
        }
        let end = end.unwrap_or(crate::features::chat::ports::TurnEnd { session: None, error: None });
        if let Some(delta) = buffer.finish() {
            self.publish_delta(&delta, &publisher, chat_id, current.unwrap_or(assistant)).await?;
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
        if let Some(open) = current {
            match status {
                MessageStatus::Done => {
                    tx.update_message_text(open, &published, MessageStatus::Done).await?;
                }
                MessageStatus::Failed => {
                    tx.update_message_text(open, &published, MessageStatus::Failed).await?;
                    tx.set_message_status(open, MessageStatus::Failed, error.as_deref()).await?;
                }
                MessageStatus::Streaming => unreachable!(),
            }
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
        if let Some(open) = current {
            publisher.publish(&ChatEvent {
                kind: ChatEventKind::MessageUpdated,
                chat_id: chat_id.to_string(),
                offset: None,
                text: None,
                message_id: Some(open.to_string()),
                occurred_at: chrono::Utc::now(),
            });
        }
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

    /// Closes the streaming assistant segment before a tool card: flush the
    /// tail, mark it done (or delete the never-written placeholder) and
    /// reset the per-segment streaming state.
    #[allow(clippy::too_many_arguments)]
    async fn close_segment(
        &self,
        chat_id: ChatId,
        current: Option<ChatMessageId>,
        buffer: &mut StreamBuffer,
        published: &mut String,
        pending: &mut String,
        publisher: &Arc<dyn ChatPublisher>,
    ) -> DomainResult<()> {
        let Some(message) = current else {
            return Ok(());
        };
        if !pending.is_empty() {
            if let Some(d) = buffer.push(pending) {
                self.publish_delta(&d, publisher, chat_id, message).await?;
            }
            pending.clear();
        }
        if let Some(delta) = buffer.finish() {
            self.publish_delta(&delta, publisher, chat_id, message).await?;
            *published = buffer.published().to_string();
        }
        let mut tx = self.store.begin().await?;
        if published.is_empty() {
            tx.delete_message(message).await?;
        } else {
            tx.update_message_text(message, published, MessageStatus::Done).await?;
        }
        tx.commit().await?;
        publisher.publish(&ChatEvent {
            kind: ChatEventKind::MessageUpdated,
            chat_id: chat_id.to_string(),
            offset: None,
            text: None,
            message_id: Some(message.to_string()),
            occurred_at: chrono::Utc::now(),
        });
        *buffer = StreamBuffer::new(buffer.redactor().clone());
        published.clear();
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

/// The stored tool card: what the proto exposes, plus the revert data the
/// proto never carries. Every model-facing string is redacted.
fn tool_call_from(
    name: &str,
    text: &str,
    details: &serde_json::Value,
    is_error: bool,
    redactor: &Redactor,
) -> ToolCall {
    let summary = details
        .get("summary")
        .and_then(serde_json::Value::as_str)
        .unwrap_or(text);
    let detail = details
        .get("detail")
        .and_then(serde_json::Value::as_str)
        .map(|d| redactor.redact(d))
        .or_else(|| issues_detail(details, redactor));
    // `previous_yaml` is Glyph's own stored export, not agent text: revert
    // needs the exact bytes, so it is kept verbatim.
    let revert = if name == "update_workflow" && !is_error {
        details
            .get("previous_yaml")
            .and_then(serde_json::Value::as_str)
            .zip(details.get("fingerprint").and_then(serde_json::Value::as_str))
            .map(|(previous_yaml, fingerprint)| Revert {
                previous_yaml: previous_yaml.to_string(),
                fingerprint: fingerprint.to_string(),
            })
    } else {
        None
    };
    ToolCall {
        name: name.to_string(),
        summary: redactor.redact(summary),
        is_error,
        workflow_id: details
            .get("workflow_id")
            .and_then(serde_json::Value::as_str)
            .map(str::to_string),
        workflow_name: details
            .get("workflow_name")
            .and_then(serde_json::Value::as_str)
            .map(|n| redactor.redact(n)),
        run_id: details
            .get("run_id")
            .and_then(serde_json::Value::as_str)
            .map(str::to_string),
        detail,
        revert,
        reverted: false,
    }
}

/// Blocking issues become the expandable body of the card.
fn issues_detail(details: &serde_json::Value, redactor: &Redactor) -> Option<String> {
    let issues = details.get("issues")?.as_array()?;
    let lines: Vec<String> = issues
        .iter()
        .filter_map(|issue| issue.get("message").and_then(serde_json::Value::as_str))
        .map(|message| redactor.redact(message))
        .collect();
    (!lines.is_empty()).then(|| lines.join("\n"))
}
