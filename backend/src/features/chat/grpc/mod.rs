//! `ChatService` gRPC edge, including the `WatchChat` stream.
use crate::features::chat::application::ChatService;
use crate::features::chat::domain::events::{ChatEvent, ChatEventKind};
use crate::features::chat::domain::model::*;
use crate::features::chat::ports::ChatBus;
use crate::proto::convert::{parse_id, timestamp};
use crate::proto::pb;
use crate::proto::pb::chat_service_server::ChatService as Rpc;
use crate::shared::ids::ChatId;
use chrono::Utc;
use futures_core::Stream;
use futures_util::StreamExt;
use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::broadcast::error::RecvError;
use tokio_util::sync::CancellationToken;
use tonic::{Request, Response, Status};

#[derive(Clone)]
pub struct ChatGrpc {
    service: ChatService,
    bus: Arc<dyn ChatBus>,
    heartbeat: Option<Duration>,
    stop: CancellationToken,
}

impl ChatGrpc {
    pub fn new(
        service: ChatService,
        bus: Arc<dyn ChatBus>,
        heartbeat: Option<Duration>,
        stop: CancellationToken,
    ) -> Self {
        Self {
            service,
            bus,
            heartbeat,
            stop,
        }
    }
}

fn event_kind(k: ChatEventKind) -> pb::ChatEventType {
    match k {
        ChatEventKind::TextDelta => pb::ChatEventType::TextDelta,
        ChatEventKind::MessageUpdated => pb::ChatEventType::MessageUpdated,
        ChatEventKind::ChatUpdated => pb::ChatEventType::ChatUpdated,
        ChatEventKind::Resync => pb::ChatEventType::Resync,
        ChatEventKind::Heartbeat => pb::ChatEventType::Heartbeat,
    }
}

fn watch_message(chat: &str, event: &ChatEvent) -> pb::WatchChatResponse {
    pb::WatchChatResponse {
        event: Some(pb::ChatEvent {
            r#type: event_kind(event.kind) as i32,
            chat_id: chat.to_string(),
            message_id: event.message_id.clone().unwrap_or_default(),
            offset: event.offset.unwrap_or(0) as i32,
            text: event.text.clone().unwrap_or_default(),
            occurred_at: Some(crate::proto::convert::timestamp(event.occurred_at)),
        }),
    }
}

fn synthetic(k: ChatEventKind, chat: &str) -> ChatEvent {
    ChatEvent {
        kind: k,
        chat_id: chat.to_string(),
        offset: None,
        text: None,
        message_id: None,
        occurred_at: Utc::now(),
    }
}

pub type ChatEventStream =
    Pin<Box<dyn Stream<Item = Result<pb::WatchChatResponse, Status>> + Send>>;

struct State {
    rx: tokio::sync::broadcast::Receiver<ChatEvent>,
    chat: String,
    heartbeat: Option<tokio::time::Interval>,
    stop: CancellationToken,
}

/// Events for `chat` (and broadcast RESYNCs); a lagging subscriber gets a
/// RESYNC instead of the events it missed. Opens with a HEARTBEAT so clients
/// can mark the connection live without waiting for an event. Ends when the
/// bus closes or on server shutdown.
pub fn watch(
    bus: &dyn ChatBus,
    chat: ChatId,
    heartbeat: Option<Duration>,
    stop: CancellationToken,
) -> ChatEventStream {
    let greeting = watch_message(
        &chat.to_string(),
        &synthetic(ChatEventKind::Heartbeat, &chat.to_string()),
    );
    let state = State {
        rx: bus.subscribe(),
        chat: chat.to_string(),
        heartbeat: heartbeat.map(|every| {
            let mut i = tokio::time::interval_at(tokio::time::Instant::now() + every, every);
            i.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            i
        }),
        stop,
    };
    Box::pin(
        futures_util::stream::once(async move { Ok(greeting) }).chain(
            futures_util::stream::unfold(state, |mut s| async move {
                loop {
                    let beat = async {
                        match s.heartbeat.as_mut() {
                            Some(i) => i.tick().await,
                            None => std::future::pending::<tokio::time::Instant>().await,
                        }
                    };
                    let event = tokio::select! {
                        _ = s.stop.cancelled() => return None,
                        _ = beat => synthetic(ChatEventKind::Heartbeat, &s.chat),
                        received = s.rx.recv() => match received {
                            Ok(e) if e.chat_id == s.chat || (e.kind == ChatEventKind::Resync && e.chat_id.is_empty()) => e,
                            Ok(_) => continue,
                            Err(RecvError::Lagged(_)) => synthetic(ChatEventKind::Resync, &s.chat),
                            Err(RecvError::Closed) => return None,
                        },
                    };
                    let msg = watch_message(&s.chat, &event);
                    return Some((Ok(msg), s));
                }
            }),
        ),
    )
}

fn chat(c: &Chat) -> pb::Chat {
    pb::Chat {
        id: c.id.to_string(),
        title: c.title.clone(),
        status: match c.status {
            ChatStatus::Idle => pb::ChatStatus::Idle,
            ChatStatus::Running => pb::ChatStatus::Running,
        } as i32,
        created_at: Some(timestamp(c.created_at)),
        updated_at: Some(timestamp(c.updated_at)),
    }
}

fn kind(k: MessageKind) -> pb::ChatMessageKind {
    match k {
        MessageKind::User => pb::ChatMessageKind::User,
        MessageKind::Assistant => pb::ChatMessageKind::Assistant,
        MessageKind::Tool => pb::ChatMessageKind::Tool,
    }
}

fn status(s: MessageStatus) -> pb::ChatMessageStatus {
    match s {
        MessageStatus::Streaming => pb::ChatMessageStatus::Streaming,
        MessageStatus::Done => pb::ChatMessageStatus::Done,
        MessageStatus::Failed => pb::ChatMessageStatus::Failed,
    }
}

pub fn tool_call(t: &ToolCall) -> pb::ToolCall {
    pb::ToolCall {
        name: t.name.clone(),
        summary: t.summary.clone(),
        is_error: t.is_error,
        workflow_id: t.workflow_id.clone(),
        workflow_name: t.workflow_name.clone(),
        run_id: t.run_id.clone(),
        revertible: t.revertible(),
        reverted: t.reverted,
        detail: t.detail.clone(),
    }
}

pub fn message(m: &Message) -> pb::ChatMessage {
    let length = m.text.as_ref().map(|t| t.chars().count()).unwrap_or(0) as i32;
    let text = m.text.clone().unwrap_or_default();
    pb::ChatMessage {
        id: m.id.to_string(),
        chat_id: m.chat_id.to_string(),
        seq: m.seq,
        kind: kind(m.kind) as i32,
        status: status(m.status) as i32,
        text,
        // `length` is the character count of `text`.
        length,
        tool: m.tool.as_ref().map(tool_call),
        error: m.error.clone(),
        created_at: Some(timestamp(m.created_at)),
    }
}

type Rsp<T> = Result<Response<T>, Status>;

#[tonic::async_trait]
impl Rpc for ChatGrpc {
    async fn list_chats(&self, _r: Request<pb::ListChatsRequest>) -> Rsp<pb::ListChatsResponse> {
        let chats = self.service.list().await?;
        Ok(Response::new(pb::ListChatsResponse {
            chats: chats.iter().map(chat).collect(),
        }))
    }

    async fn get_chat(&self, r: Request<pb::GetChatRequest>) -> Rsp<pb::GetChatResponse> {
        let (c, messages) = self
            .service
            .get(parse_id(&r.get_ref().chat_id, "chat_id")?)
            .await?;
        Ok(Response::new(pb::GetChatResponse {
            chat: Some(chat(&c)),
            messages: messages.iter().map(message).collect(),
        }))
    }

    async fn create_chat(&self, _r: Request<pb::CreateChatRequest>) -> Rsp<pb::CreateChatResponse> {
        let c = self.service.create().await?;
        Ok(Response::new(pb::CreateChatResponse {
            chat: Some(chat(&c)),
        }))
    }

    async fn rename_chat(&self, r: Request<pb::RenameChatRequest>) -> Rsp<pb::RenameChatResponse> {
        let r = r.into_inner();
        let c = self
            .service
            .rename(parse_id(&r.chat_id, "chat_id")?, &r.title)
            .await?;
        Ok(Response::new(pb::RenameChatResponse {
            chat: Some(chat(&c)),
        }))
    }

    async fn delete_chat(&self, r: Request<pb::DeleteChatRequest>) -> Rsp<pb::DeleteChatResponse> {
        self.service
            .delete(parse_id(&r.get_ref().chat_id, "chat_id")?)
            .await?;
        Ok(Response::new(pb::DeleteChatResponse {}))
    }
    async fn send_message(
        &self,
        r: Request<pb::SendMessageRequest>,
    ) -> Rsp<pb::SendMessageResponse> {
        let r = r.into_inner();
        self.service
            .send(parse_id(&r.chat_id, "chat_id")?, &r.text)
            .await?;
        Ok(Response::new(pb::SendMessageResponse {}))
    }
    async fn revert_change(
        &self,
        r: Request<pb::RevertChangeRequest>,
    ) -> Rsp<pb::RevertChangeResponse> {
        let chat = parse_id(&r.get_ref().chat_id, "chat_id")?;
        let message = parse_id(&r.get_ref().message_id, "message_id")?;
        self.service.revert(chat, message).await.map_err(|e| {
            // A stale fingerprint means the workflow changed after the
            // agent's edit: the revert-specific message, nothing written.
            match e {
                crate::shared::error::DomainError::Conflict => Status::aborted(
                    "This workflow changed after the agent's edit, so it can't be reverted automatically.",
                ),
                other => other.into(),
            }
        })?;
        Ok(Response::new(pb::RevertChangeResponse {}))
    }
    async fn cancel_turn(&self, r: Request<pb::CancelTurnRequest>) -> Rsp<pb::CancelTurnResponse> {
        self.service
            .cancel_turn(parse_id(&r.get_ref().chat_id, "chat_id")?)
            .await?;
        Ok(Response::new(pb::CancelTurnResponse {}))
    }
    async fn watch_chat(
        &self,
        request: Request<pb::WatchChatRequest>,
    ) -> Result<Response<ChatEventStream>, Status> {
        let chat = parse_id(&request.get_ref().chat_id, "chat_id")?;
        Ok(Response::new(watch(
            self.bus.as_ref(),
            chat,
            self.heartbeat,
            self.stop.clone(),
        )))
    }
}
