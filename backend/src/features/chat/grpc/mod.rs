//! `ChatService` gRPC edge.
use tonic::{Request, Response, Status};
use crate::features::chat::application::ChatService;
use crate::features::chat::domain::model::*;
use crate::proto::convert::{parse_id, timestamp};
use crate::proto::pb;
use crate::proto::pb::chat_service_server::ChatService as Rpc;

#[derive(Clone)]
pub struct ChatGrpc {
    service: ChatService,
}

impl ChatGrpc {
    pub fn new(service: ChatService) -> Self {
        Self { service }
    }
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
        Ok(Response::new(pb::CreateChatResponse { chat: Some(chat(&c)) }))
    }

    async fn rename_chat(&self, r: Request<pb::RenameChatRequest>) -> Rsp<pb::RenameChatResponse> {
        let r = r.into_inner();
        let c = self
            .service
            .rename(parse_id(&r.chat_id, "chat_id")?, &r.title)
            .await?;
        Ok(Response::new(pb::RenameChatResponse { chat: Some(chat(&c)) }))
    }

    async fn delete_chat(&self, r: Request<pb::DeleteChatRequest>) -> Rsp<pb::DeleteChatResponse> {
        self.service
            .delete(parse_id(&r.get_ref().chat_id, "chat_id")?)
            .await?;
        Ok(Response::new(pb::DeleteChatResponse {}))
    }
}
