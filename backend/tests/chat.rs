//! Chat storage and (later) ChatService over gRPC (spec 0024).
mod common;
use std::sync::Arc;
use glyph_backend::features::chat::domain::model::*;
use glyph_backend::shared::ids::ChatId;
use glyph_backend::features::chat::ports::{ChatStore, ChatTx, NewMessage};
use glyph_backend::infrastructure::crypto::AesGcmCipher;
use glyph_backend::infrastructure::postgres::PgStore;
use sqlx::PgPool;
use uuid::Uuid;

fn store(pool: &PgPool) -> PgStore {
    PgStore::new(pool.clone(), Arc::new(AesGcmCipher::dev()))
}

async fn new_chat(pool: &PgPool) -> Chat {
    let store = store(pool);
    let chat = Chat {
        id: ChatId::new(),
        title: String::new(),
        status: ChatStatus::Idle,
        cancel_requested: false,
        created_at: Utc::now(),
        updated_at: Utc::now(),
    };
    let mut tx = store.begin().await.unwrap();
    tx.create_chat(&chat).await.unwrap();
    tx.commit().await.unwrap();
    chat
}

use chrono::Utc;

async fn insert(pool: &PgPool, chat: ChatId, kind: MessageKind, text: &str) -> Uuid {
    let store = store(pool);
    let mut tx = store.begin().await.unwrap();
    let id = tx
        .insert_message(&NewMessage {
            chat_id: chat,
            kind,
            status: MessageStatus::Done,
            text: Some(text.into()),
            tool: None,
        })
        .await
        .unwrap();
    tx.commit().await.unwrap();
    id.into()
}

#[sqlx::test(migrator = "glyph_backend::infrastructure::postgres::migrate::MIGRATOR")]
async fn create_list_rename_delete(pool: PgPool) {
    let store = store(&pool);
    let a = new_chat(&pool).await;
    tokio::time::sleep(std::time::Duration::from_millis(5)).await;
    let b = new_chat(&pool).await;

    let list = store.list().await.unwrap();
    assert_eq!(list.len(), 2);
    // newest first
    assert_eq!(list[0].id, b.id);
    assert_eq!(list[1].id, a.id);

    let mut tx = store.begin().await.unwrap();
    tx.rename_chat(a.id, "Renamed").await.unwrap();
    tx.commit().await.unwrap();
    assert_eq!(store.find(a.id).await.unwrap().unwrap().0.title, "Renamed");

    // delete cascades messages
    insert(&pool, a.id, MessageKind::User, "hi").await;
    let messages: i64 = sqlx::query_scalar("SELECT count(*) FROM chat_messages")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(messages, 1);
    let mut tx = store.begin().await.unwrap();
    tx.delete_chat(a.id).await.unwrap();
    tx.commit().await.unwrap();
    let messages: i64 = sqlx::query_scalar("SELECT count(*) FROM chat_messages")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(messages, 0);
    assert!(store.find(a.id).await.unwrap().is_none());
}

#[sqlx::test(migrator = "glyph_backend::infrastructure::postgres::migrate::MIGRATOR")]
async fn content_is_encrypted_at_rest(pool: PgPool) {
    let chat = new_chat(&pool).await;
    insert(&pool, chat.id, MessageKind::User, "top secret message").await;

    let raw: Vec<u8> = sqlx::query_scalar("SELECT content FROM chat_messages")
        .fetch_one(&pool)
        .await
        .unwrap();
    let text = String::from_utf8_lossy(&raw);
    assert!(!text.contains("top secret message"), "content is plaintext");

    let mut tx = store(&pool).begin().await.unwrap();
    tx.save_session(
        chat.id,
        Some(&glyph_backend::features::chat::ports::SessionFile {
            relative_path: "sessions/abc.jsonl".into(),
            bytes: b"session secret line".to_vec(),
        }),
    )
    .await
    .unwrap();
    tx.commit().await.unwrap();
    let raw: Option<Vec<u8>> = sqlx::query_scalar("SELECT pi_session FROM chats WHERE id = $1")
        .bind(chat.id.as_uuid())
        .fetch_one(&pool)
        .await
        .unwrap();
    let session_raw = raw.unwrap();
    let text = String::from_utf8_lossy(&session_raw);
    assert!(!text.contains("session secret"), "session is plaintext");
}

#[sqlx::test(migrator = "glyph_backend::infrastructure::postgres::migrate::MIGRATOR")]
async fn begin_turn_is_compare_and_set(pool: PgPool) {
    let chat = new_chat(&pool).await;
    let store = store(&pool);
    let mut tx = store.begin().await.unwrap();
    assert!(tx.begin_turn(chat.id).await.unwrap());
    tx.commit().await.unwrap();
    let mut tx = store.begin().await.unwrap();
    assert!(!tx.begin_turn(chat.id).await.unwrap());
    tx.commit().await.unwrap();

    // end_turn returns to idle, and begin works again
    let mut tx = store.begin().await.unwrap();
    tx.end_turn(chat.id, ChatStatus::Idle).await.unwrap();
    assert!(tx.begin_turn(chat.id).await.unwrap());
    tx.request_cancel(chat.id).await.unwrap();
    assert!(tx.cancel_requested(chat.id).await.unwrap());
    tx.commit().await.unwrap();
    // a new begin_turn clears cancel_requested
    let mut tx = store.begin().await.unwrap();
    tx.end_turn(chat.id, ChatStatus::Idle).await.unwrap();
    assert!(tx.begin_turn(chat.id).await.unwrap());
    assert!(!tx.cancel_requested(chat.id).await.unwrap());
    tx.commit().await.unwrap();
}

#[sqlx::test(migrator = "glyph_backend::infrastructure::postgres::migrate::MIGRATOR")]
async fn seq_is_gap_free_per_chat(pool: PgPool) {
    let a = new_chat(&pool).await;
    let b = new_chat(&pool).await;
    for chat in [a.id, b.id] {
        for i in 0..3 {
            insert(&pool, chat, MessageKind::User, &format!("m{i}")).await;
        }
    }
    let (_, messages) = store(&pool).find(a.id).await.unwrap().unwrap();
    let seqs: Vec<i32> = messages.iter().map(|m| m.seq).collect();
    assert_eq!(seqs, vec![1, 2, 3]);
}

#[sqlx::test(migrator = "glyph_backend::infrastructure::postgres::migrate::MIGRATOR")]
async fn session_round_trips(pool: PgPool) {
    let chat = new_chat(&pool).await;
    let mut tx = store(&pool).begin().await.unwrap();
    tx.save_session(
        chat.id,
        Some(&glyph_backend::features::chat::ports::SessionFile {
            relative_path: "group/abc.jsonl".into(),
            bytes: b"line1\nline2\n".to_vec(),
        }),
    )
    .await
    .unwrap();
    let loaded = tx.load_session(chat.id).await.unwrap().unwrap();
    tx.commit().await.unwrap();
    assert_eq!(loaded.relative_path, "group/abc.jsonl");
    assert_eq!(loaded.bytes, b"line1\nline2\n");
}

// --- ChatService CRUD over gRPC --------------------------------------------

use glyph_backend::proto::pb;
use glyph_backend::proto::pb::chat_service_client::ChatServiceClient;
use tonic::Code;
use tonic::transport::Channel;

type Grpc = ChatServiceClient<Channel>;

#[sqlx::test(migrator = "glyph_backend::infrastructure::postgres::migrate::MIGRATOR")]
async fn crud_round_trip(pool: PgPool) {
    let server = common::spawn(pool).await;
    let mut client = Grpc::new(server.channel().await);

    let created = client
        .create_chat(pb::CreateChatRequest {})
        .await
        .unwrap()
        .into_inner()
        .chat
        .unwrap();
    assert_eq!(created.title, "");
    assert_eq!(created.status, pb::ChatStatus::Idle as i32);

    let listed = client.list_chats(pb::ListChatsRequest {}).await.unwrap().into_inner();
    assert_eq!(listed.chats.len(), 1);
    assert_eq!(listed.chats[0].id, created.id);

    let renamed = client
        .rename_chat(pb::RenameChatRequest {
            chat_id: created.id.clone(),
            title: "  My plan  ".into(),
        })
        .await
        .unwrap()
        .into_inner()
        .chat
        .unwrap();
    assert_eq!(renamed.title, "My plan");

    let chat = client
        .get_chat(pb::GetChatRequest { chat_id: created.id.clone() })
        .await
        .unwrap()
        .into_inner();
    assert_eq!(chat.chat.unwrap().title, "My plan");
    assert!(chat.messages.is_empty());

    client
        .delete_chat(pb::DeleteChatRequest { chat_id: created.id })
        .await
        .unwrap();
    let listed = client.list_chats(pb::ListChatsRequest {}).await.unwrap().into_inner();
    assert!(listed.chats.is_empty());
}

#[sqlx::test(migrator = "glyph_backend::infrastructure::postgres::migrate::MIGRATOR")]
async fn get_unknown_chat_is_not_found(pool: PgPool) {
    let server = common::spawn(pool).await;
    let mut client = Grpc::new(server.channel().await);
    let error = client
        .get_chat(pb::GetChatRequest {
            chat_id: ChatId::new().to_string(),
        })
        .await
        .unwrap_err();
    assert_eq!(error.code(), Code::NotFound);
}

#[sqlx::test(migrator = "glyph_backend::infrastructure::postgres::migrate::MIGRATOR")]
async fn delete_running_chat_is_refused(pool: PgPool) {
    let chat = new_chat(&pool).await;
    let mut tx = store(&pool).begin().await.unwrap();
    assert!(tx.begin_turn(chat.id).await.unwrap());
    tx.commit().await.unwrap();

    let server = common::spawn(pool).await;
    let mut client = Grpc::new(server.channel().await);
    let error = client
        .delete_chat(pb::DeleteChatRequest { chat_id: chat.id.to_string() })
        .await
        .unwrap_err();
    assert_eq!(error.code(), Code::FailedPrecondition);
    assert_eq!(error.message(), "Stop the agent before deleting this chat.");
}

#[sqlx::test(migrator = "glyph_backend::infrastructure::postgres::migrate::MIGRATOR")]
async fn message_length_counts_characters(pool: PgPool) {
    let chat = new_chat(&pool).await;
    insert(&pool, chat.id, MessageKind::User, "héllo wörld").await; // 11 chars
    let server = common::spawn(pool).await;
    let mut client = Grpc::new(server.channel().await);
    let response = client
        .get_chat(pb::GetChatRequest { chat_id: chat.id.to_string() })
        .await
        .unwrap()
        .into_inner();
    assert_eq!(response.messages.len(), 1);
    assert_eq!(response.messages[0].text, "héllo wörld");
    assert_eq!(response.messages[0].length, 11);
}
