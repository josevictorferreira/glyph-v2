//! Chat persistence. `content` and `pi_session` are AES-GCM encrypted
//! because they carry workflow YAML, tool results and the Pi session.
use async_trait::async_trait;
use crate::features::chat::domain::model::*;
use crate::features::chat::domain::events::{CHANNEL, ChatEvent};
use crate::features::chat::ports::{ChatPublisher, 
    ChatStore, ChatTx, NewMessage, SessionFile,
};
use crate::infrastructure::crypto::Cipher;
use crate::infrastructure::postgres::PgStore;
use crate::infrastructure::postgres::uow::{PgTx, db};
use crate::shared::error::{DomainError, DomainResult};
use crate::shared::ids::{ChatId, ChatMessageId};

fn enc(cipher: &dyn Cipher, value: &str) -> Vec<u8> {
    cipher.encrypt(value.as_bytes())
}

fn dec_text(cipher: &dyn Cipher, blob: Vec<u8>, what: &str) -> DomainResult<String> {
    cipher
        .decrypt(&blob)
        .map(|b| String::from_utf8_lossy(&b).into_owned())
        .map_err(|e| DomainError::Internal(anyhow::anyhow!("decrypting {what}: {e}")))
}

fn dec_tool(cipher: &dyn Cipher, blob: Vec<u8>) -> DomainResult<ToolCall> {
    let bytes = cipher
        .decrypt(&blob)
        .map_err(|e| DomainError::Internal(anyhow::anyhow!("decrypting tool call: {e}")))?;
    serde_json::from_slice(&bytes).map_err(DomainError::internal)
}

fn status(s: &str) -> ChatStatus {
    match s {
        "running" => ChatStatus::Running,
        _ => ChatStatus::Idle,
    }
}

fn kind(k: &str) -> MessageKind {
    match k {
        "user" => MessageKind::User,
        "tool" => MessageKind::Tool,
        _ => MessageKind::Assistant,
    }
}

fn message_status(s: &str) -> MessageStatus {
    match s {
        "done" => MessageStatus::Done,
        "failed" => MessageStatus::Failed,
        _ => MessageStatus::Streaming,
    }
}

#[async_trait]
impl ChatStore for PgStore {
    async fn list(&self) -> DomainResult<Vec<Chat>> {
        let rows = sqlx::query!(
            "SELECT id, title, status, cancel_requested, created_at, updated_at
             FROM chats ORDER BY updated_at DESC, id"
        )
        .fetch_all(&self.pool)
        .await
        .map_err(db)?;
        Ok(rows
            .into_iter()
            .map(|r| Chat {
                id: r.id.into(),
                title: r.title,
                status: status(&r.status),
                cancel_requested: r.cancel_requested,
                created_at: r.created_at,
                updated_at: r.updated_at,
            })
            .collect())
    }

    async fn find(&self, id: ChatId) -> DomainResult<Option<(Chat, Vec<Message>)>> {
        let chat = sqlx::query!(
            "SELECT id, title, status, cancel_requested, created_at, updated_at
             FROM chats WHERE id = $1",
            id.as_uuid()
        )
        .fetch_optional(&self.pool)
        .await
        .map_err(db)?;
        let Some(chat) = chat else {
            return Ok(None);
        };
        let rows = sqlx::query!(
            "SELECT id, chat_id, seq, kind, status, content, error, created_at
             FROM chat_messages WHERE chat_id = $1 ORDER BY seq",
            id.as_uuid()
        )
        .fetch_all(&self.pool)
        .await
        .map_err(db)?;
        let mut messages = Vec::new();
        for r in rows {
            let (text, tool) = match kind(&r.kind) {
                MessageKind::Tool => (
                    None,
                    Some(dec_tool(self.cipher.as_ref(), r.content)?),
                ),
                _ => (
                    Some(dec_text(self.cipher.as_ref(), r.content, "message")?),
                    None,
                ),
            };
            messages.push(Message {
                id: r.id.into(),
                chat_id: r.chat_id.into(),
                seq: r.seq,
                kind: kind(&r.kind),
                status: message_status(&r.status),
                text,
                tool,
                error: r.error,
                created_at: r.created_at,
            });
        }
        Ok(Some((
            Chat {
                id: chat.id.into(),
                title: chat.title,
                status: status(&chat.status),
                cancel_requested: chat.cancel_requested,
                created_at: chat.created_at,
                updated_at: chat.updated_at,
            },
            messages,
        )))
    }

    async fn begin(&self) -> DomainResult<Box<dyn ChatTx>> {
        Ok(Box::new(self.tx().await?))
    }
}

#[async_trait]
impl ChatTx for PgTx {
    async fn notify(&mut self, event: &ChatEvent) -> DomainResult<()> {
        let payload = serde_json::to_string(event).map_err(DomainError::internal)?;
        sqlx::query!("SELECT pg_notify($1, $2)", CHANNEL, payload)
            .execute(&mut *self.tx)
            .await
            .map_err(db)?;
        Ok(())
    }

    async fn create_chat(&mut self, chat: &Chat) -> DomainResult<()> {
        sqlx::query!(
            "INSERT INTO chats (id, title, status, cancel_requested, created_at, updated_at)
             VALUES ($1, $2, 'idle', false, $3, $3)",
            chat.id.as_uuid(),
            chat.title,
            chat.created_at,
        )
        .execute(&mut *self.tx)
        .await
        .map_err(db)?;
        Ok(())
    }

    async fn rename_chat(&mut self, id: ChatId, title: &str) -> DomainResult<()> {
        sqlx::query!(
            "UPDATE chats SET title = $2, updated_at = now() WHERE id = $1",
            id.as_uuid(),
            title,
        )
        .execute(&mut *self.tx)
        .await
        .map_err(db)?;
        Ok(())
    }

    async fn delete_chat(&mut self, id: ChatId) -> DomainResult<()> {
        sqlx::query!("DELETE FROM chats WHERE id = $1", id.as_uuid())
            .execute(&mut *self.tx)
            .await
            .map_err(db)?;
        Ok(())
    }

    async fn begin_turn(&mut self, id: ChatId) -> DomainResult<bool> {
        let updated = sqlx::query!(
            "UPDATE chats SET status = 'running', cancel_requested = false, updated_at = now()
             WHERE id = $1 AND status = 'idle'",
            id.as_uuid()
        )
        .execute(&mut *self.tx)
        .await
        .map_err(db)?;
        Ok(updated.rows_affected() == 1)
    }

    async fn end_turn(&mut self, id: ChatId, status: ChatStatus) -> DomainResult<()> {
        let status = match status {
            ChatStatus::Idle => "idle",
            ChatStatus::Running => "running",
        };
        sqlx::query!(
            "UPDATE chats SET status = $2, updated_at = now() WHERE id = $1",
            id.as_uuid(),
            status,
        )
        .execute(&mut *self.tx)
        .await
        .map_err(db)?;
        Ok(())
    }

    async fn request_cancel(&mut self, id: ChatId) -> DomainResult<()> {
        sqlx::query!(
            "UPDATE chats SET cancel_requested = true WHERE id = $1",
            id.as_uuid()
        )
        .execute(&mut *self.tx)
        .await
        .map_err(db)?;
        Ok(())
    }

    async fn cancel_requested(&mut self, id: ChatId) -> DomainResult<bool> {
        sqlx::query_scalar!("SELECT cancel_requested FROM chats WHERE id = $1", id.as_uuid())
            .fetch_optional(&mut *self.tx)
            .await
            .map_err(db)?
            .ok_or(DomainError::NotFound("chat"))
    }

    async fn insert_message(&mut self, m: &NewMessage) -> DomainResult<ChatMessageId> {
        let content = match (&m.text, &m.tool) {
            (Some(text), _) => enc(self.cipher.as_ref(), text),
            (None, Some(tool)) => {
                self.cipher
                    .encrypt(&serde_json::to_vec(tool).map_err(DomainError::internal)?)
            }
            (None, None) => enc(self.cipher.as_ref(), ""),
        };
        let kind = match m.kind {
            MessageKind::User => "user",
            MessageKind::Assistant => "assistant",
            MessageKind::Tool => "tool",
        };
        let status = match m.status {
            MessageStatus::Streaming => "streaming",
            MessageStatus::Done => "done",
            MessageStatus::Failed => "failed",
        };
        let id = sqlx::query_scalar!(
            "INSERT INTO chat_messages (chat_id, seq, kind, status, content)
             VALUES ($1, (SELECT coalesce(max(seq), 0) + 1 FROM chat_messages WHERE chat_id = $1),
                     $2, $3, $4)
             RETURNING id",
            m.chat_id.as_uuid(),
            kind,
            status,
            content,
        )
        .fetch_one(&mut *self.tx)
        .await
        .map_err(db)?;
        Ok(id.into())
    }

    async fn update_message_text(
        &mut self,
        id: ChatMessageId,
        text: &str,
        status: MessageStatus,
    ) -> DomainResult<()> {
        let status = match status {
            MessageStatus::Streaming => "streaming",
            MessageStatus::Done => "done",
            MessageStatus::Failed => "failed",
        };
        sqlx::query!(
            "UPDATE chat_messages SET content = $2, status = $3, updated_at = now()
             WHERE id = $1",
            id.as_uuid(),
            enc(self.cipher.as_ref(), text),
            status,
        )
        .execute(&mut *self.tx)
        .await
        .map_err(db)?;
        Ok(())
    }

    async fn set_message_status(
        &mut self,
        id: ChatMessageId,
        status: MessageStatus,
        error: Option<&str>,
    ) -> DomainResult<()> {
        let status = match status {
            MessageStatus::Streaming => "streaming",
            MessageStatus::Done => "done",
            MessageStatus::Failed => "failed",
        };
        sqlx::query!(
            "UPDATE chat_messages SET status = $2, error = $3, updated_at = now() WHERE id = $1",
            id.as_uuid(),
            status,
            error,
        )
        .execute(&mut *self.tx)
        .await
        .map_err(db)?;
        Ok(())
    }

    async fn delete_message(&mut self, id: ChatMessageId) -> DomainResult<()> {
        sqlx::query!("DELETE FROM chat_messages WHERE id = $1", id.as_uuid())
            .execute(&mut *self.tx)
            .await
            .map_err(db)?;
        Ok(())
    }
    async fn mark_message_reverted(&mut self, id: ChatMessageId) -> DomainResult<()> {
        let blob = sqlx::query_scalar!(
            "SELECT content FROM chat_messages WHERE id = $1 AND kind = 'tool'",
            id.as_uuid()
        )
        .fetch_optional(&mut *self.tx)
        .await
        .map_err(db)?
        .ok_or(DomainError::NotFound("message"))?;
        let mut tool = dec_tool(self.cipher.as_ref(), blob)?;
        tool.reverted = true;
        let content = self
            .cipher
            .encrypt(&serde_json::to_vec(&tool).map_err(DomainError::internal)?);
        sqlx::query!(
            "UPDATE chat_messages SET content = $2, updated_at = now() WHERE id = $1",
            id.as_uuid(),
            content,
        )
        .execute(&mut *self.tx)
        .await
        .map_err(db)?;
        Ok(())
    }

    async fn save_session(&mut self, id: ChatId, session: Option<&SessionFile>) -> DomainResult<()> {
        match session {
            Some(s) => {
                sqlx::query!(
                    "UPDATE chats SET pi_session = $2, pi_session_path = $3, updated_at = now()
                     WHERE id = $1",
                    id.as_uuid(),
                    self.cipher.encrypt(&s.bytes),
                    s.relative_path,
                )
                .execute(&mut *self.tx)
                .await
                .map_err(db)?;
            }
            None => {
                sqlx::query!(
                    "UPDATE chats SET pi_session = NULL, pi_session_path = NULL, updated_at = now()
                     WHERE id = $1",
                    id.as_uuid()
                )
                .execute(&mut *self.tx)
                .await
                .map_err(db)?;
            }
        }
        Ok(())
    }

    async fn load_session(&mut self, id: ChatId) -> DomainResult<Option<SessionFile>> {
        let row = sqlx::query!(
            "SELECT pi_session, pi_session_path FROM chats WHERE id = $1",
            id.as_uuid()
        )
        .fetch_optional(&mut *self.tx)
        .await
        .map_err(db)?
        .ok_or(DomainError::NotFound("chat"))?;
        match (row.pi_session, row.pi_session_path) {
            (Some(blob), Some(path)) => {
                let bytes = self
                    .cipher
                    .decrypt(&blob)
                    .map_err(|e| DomainError::Internal(anyhow::anyhow!("decrypting session: {e}")))?;
                Ok(Some(SessionFile {
                    relative_path: path,
                    bytes,
                }))
            }
            _ => Ok(None),
        }
    }
}

#[async_trait]
impl ChatPublisher for PgStore {
    fn publish(&self, event: &ChatEvent) {
        // Outside any transaction; fire-and-forget on a spawned task so the
        // caller never blocks on the pool.
        let pool = self.pool.clone();
        let event = event.clone();
        tokio::spawn(async move {
            let payload = match serde_json::to_string(&event) {
                Ok(p) => p,
                Err(e) => {
                    tracing::warn!(%e, "unreadable chat event");
                    return;
                }
            };
            if let Err(e) = sqlx::query("SELECT pg_notify($1, $2)")
                .bind(CHANNEL)
                .bind(&payload)
                .execute(&pool)
                .await
            {
                tracing::warn!(%e, "chat pg_notify failed");
            }
        });
    }
}
