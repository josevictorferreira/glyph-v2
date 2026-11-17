//! Chat storage and (later) ChatService over gRPC (spec 0024).
mod common;
use std::sync::Arc;
use glyph_backend::features::chat::domain::model::*;
use glyph_backend::shared::ids::ChatId;
use glyph_backend::features::chat::ports::{ChatStore, NewMessage};
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

// --- chat events and hub (3.2) ----------------------------------------------

use glyph_backend::features::chat::domain::events::{ChatEvent, ChatEventKind};
use glyph_backend::features::chat::ports::ChatBus;
use glyph_backend::infrastructure::postgres::listener::ChatHub;

#[test]
fn oversized_text_delta_splits_on_character_boundary() {
    let event = ChatEvent {
        kind: ChatEventKind::TextDelta,
        chat_id: "c1".into(),
        offset: Some(0),
        text: Some("é".repeat(1500)),
        message_id: Some("m1".into()),
        occurred_at: Utc::now(),
    };
    let parts = glyph_backend::features::chat::domain::events::split_oversized(&event);
    assert!(parts.len() > 1, "2000-byte delta must split");
    for p in &parts {
        assert!(serde_json::to_string(&p).unwrap().len() <= 2048, "part fits");
    }
    let joined: String = parts.iter().map(|p| p.text.clone().unwrap()).collect();
    assert_eq!(joined.chars().count(), 1500);
    let mut offset = 0;
    for p in &parts {
        assert_eq!(p.offset.unwrap(), offset);
        offset += p.text.as_ref().unwrap().chars().count();
    }
}

#[sqlx::test(migrator = "glyph_backend::infrastructure::postgres::migrate::MIGRATOR")]
async fn publish_and_subscribe_round_trip(pool: PgPool) {
    let hub = ChatHub::new(64);
    let stop = tokio_util::sync::CancellationToken::new();
    let task = hub.clone().spawn_listener(pool.clone(), stop.clone());
    let mut rx = ChatBus::subscribe(&hub);
    tokio::time::sleep(std::time::Duration::from_millis(300)).await;

    let event = ChatEvent {
        kind: ChatEventKind::TextDelta,
        chat_id: "c1".into(),
        offset: Some(3),
        text: Some("hello".into()),
        message_id: Some("m1".into()),
        occurred_at: Utc::now(),
    };
    let payload = serde_json::to_string(&event).unwrap();
    sqlx::query("SELECT pg_notify('glyph_chat', $1)")
        .bind(&payload)
        .execute(&pool)
        .await
        .unwrap();
    let received = tokio::time::timeout(std::time::Duration::from_secs(5), rx.recv())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(received.chat_id, "c1");
    assert_eq!(received.text.as_deref(), Some("hello"));

    // Kill the LISTEN connection: the hub reconnects and broadcasts RESYNC.
    sqlx::query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE query ILIKE 'LISTEN%' AND pid <> pg_backend_pid()")
        .execute(&pool)
        .await
        .unwrap();
    let e = tokio::time::timeout(std::time::Duration::from_secs(5), rx.recv())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(e.kind, ChatEventKind::Resync);
    stop.cancel();
    let _ = task.await;
}

// --- SendMessage (3.3) -------------------------------------------------------

mod send {
    use super::*;
    pub(super) use glyph_backend::proto::pb::chat_service_client::ChatServiceClient as Client;

    async fn client(pool: &PgPool) -> (common::TestServer, Client<tonic::transport::Channel>) {
        let server = common::spawn(pool.clone()).await;
        let client = Client::new(server.channel().await);
        (server, client)
    }

    #[sqlx::test(migrator = "glyph_backend::infrastructure::postgres::migrate::MIGRATOR")]
    pub(super) async fn send_persists_messages_flips_running_and_enqueues_one_job(pool: PgPool) {
        common::engine::seed_model(&pool).await;
        let server = common::spawn(pool.clone()).await;
        let mut sc = glyph_backend::proto::pb::settings_service_client::SettingsServiceClient::new(
            server.channel().await,
        );
        sc.update_settings(glyph_backend::proto::pb::UpdateSettingsRequest {
            chat_model_id: Some("velox/test-model".into()),
        })
        .await
        .unwrap();
        let chat = new_chat(&pool).await;
        let mut cc = Client::new(server.channel().await);
        cc.send_message(glyph_backend::proto::pb::SendMessageRequest {
            chat_id: chat.id.to_string(),
            text: " hello ".into(),
        })
        .await
        .unwrap();
        let (stored, messages) = store(&pool).find(chat.id).await.unwrap().unwrap();
        assert_eq!(stored.status, ChatStatus::Running);
        assert_eq!(stored.title, "hello");
        assert_eq!(messages.len(), 2);
        assert_eq!(messages[0].kind, MessageKind::User);
        assert_eq!(messages[0].text.as_deref(), Some("hello"));
        assert_eq!(messages[1].kind, MessageKind::Assistant);
        assert_eq!(messages[1].status, MessageStatus::Streaming);
        let jobs: Vec<(String, serde_json::Value)> = sqlx::query_as(
            "SELECT kind, payload FROM jobs WHERE finished_at IS NULL",
        )
        .fetch_all(&pool)
        .await
        .unwrap();
        assert_eq!(jobs.len(), 1, "exactly one job: {jobs:?}");
        assert_eq!(jobs[0].0, "run_chat_turn");
        assert_eq!(
            jobs[0].1,
            serde_json::json!({ "chat_id": chat.id.to_string() })
        );
        let events: Vec<String> = sqlx::query_scalar(
            "SELECT event_type FROM events WHERE stream = $1 ORDER BY id",
        )
        .bind(format!("Chat${}", chat.id))
        .fetch_all(&pool)
        .await
        .unwrap();
        assert!(events.contains(&"ChatTurnStarted".to_string()), "{events:?}");
    }

    #[sqlx::test(migrator = "glyph_backend::infrastructure::postgres::migrate::MIGRATOR")]
    async fn second_send_while_running_is_rejected_and_writes_nothing(pool: PgPool) {
        common::engine::seed_model(&pool).await;
        let server = common::spawn(pool.clone()).await;
        let mut sc = glyph_backend::proto::pb::settings_service_client::SettingsServiceClient::new(
            server.channel().await,
        );
        sc.update_settings(glyph_backend::proto::pb::UpdateSettingsRequest {
            chat_model_id: Some("velox/test-model".into()),
        })
        .await
        .unwrap();
        let chat = new_chat(&pool).await;
        let mut cc = Client::new(server.channel().await);
        cc.send_message(glyph_backend::proto::pb::SendMessageRequest {
            chat_id: chat.id.to_string(),
            text: "one".into(),
        })
        .await
        .unwrap();
        let error = cc
            .send_message(glyph_backend::proto::pb::SendMessageRequest {
                chat_id: chat.id.to_string(),
                text: "two".into(),
            })
            .await
            .unwrap_err();
        assert_eq!(error.code(), tonic::Code::FailedPrecondition);
        let info = glyph_backend::proto::status::error_info(&error).unwrap();
        assert_eq!(info.reason, "CHAT_TURN_RUNNING");
        let (_, messages) = store(&pool).find(chat.id).await.unwrap().unwrap();
        assert_eq!(messages.len(), 2, "no extra writes: {messages:?}");
        let jobs: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM jobs WHERE kind = 'run_chat_turn' AND finished_at IS NULL",
        )
        .fetch_all(&pool)
        .await
        .unwrap()
        .pop()
        .unwrap();
        assert_eq!(jobs, 1);
    }

    #[sqlx::test(migrator = "glyph_backend::infrastructure::postgres::migrate::MIGRATOR")]
    pub(super) async fn send_without_a_model_writes_nothing(pool: PgPool) {
        let chat = new_chat(&pool).await;
        let (_server, mut cc) = client(&pool).await;
        let error = cc
            .send_message(glyph_backend::proto::pb::SendMessageRequest {
                chat_id: chat.id.to_string(),
                text: "hello".into(),
            })
            .await
            .unwrap_err();
        assert_eq!(error.code(), tonic::Code::FailedPrecondition);
        let info = glyph_backend::proto::status::error_info(&error).unwrap();
        assert_eq!(info.reason, "CHAT_MODEL_MISSING");
        let (stored, messages) = store(&pool).find(chat.id).await.unwrap().unwrap();
        assert_eq!(stored.status, ChatStatus::Idle);
        assert!(messages.is_empty());
        let jobs: i64 = sqlx::query_scalar("SELECT count(*) FROM jobs")
            .fetch_all(&pool)
            .await
            .unwrap()
            .pop()
            .unwrap();
        assert_eq!(jobs, 0);
    }

    #[sqlx::test(migrator = "glyph_backend::infrastructure::postgres::migrate::MIGRATOR")]
    async fn blank_send_is_invalid_argument(pool: PgPool) {
        let chat = new_chat(&pool).await;
        let (_server, mut cc) = client(&pool).await;
        let error = cc
            .send_message(glyph_backend::proto::pb::SendMessageRequest {
                chat_id: chat.id.to_string(),
                text: "  ".into(),
            })
            .await
            .unwrap_err();
        assert_eq!(error.code(), tonic::Code::InvalidArgument, "{}", error);
    }
}

// --- Turn loop and fake runner (3.4) -----------------------------------------

mod turn {
    use super::*;
    use glyph_backend::features::chat::domain::events::ChatEventKind;
    use glyph_backend::infrastructure::fake_chat_runner::FakeChatRunner;
    pub(super) use glyph_backend::proto::pb::chat_service_client::ChatServiceClient as Client;
    use glyph_backend::proto::pb;
    use std::time::Duration;

    pub(super) async fn seeded(pool: &PgPool) -> common::TestServer {
        runner_server(pool, Arc::new(FakeChatRunner::new())).await
    }

    pub(super) async fn runner_server(pool: &PgPool, runner: Arc<dyn glyph_backend::features::chat::ports::ChatRunner>) -> common::TestServer {
        common::engine::seed_model(pool).await;
        common::spawn_with(
            pool.clone(),
            common::test_config(),
            glyph_backend::app::bootstrap::Overrides {
                chat_runner: Some(runner),
                background: Some(true),
                ..Default::default()
            },
        )
        .await
    }

    pub(super) async fn send(server: &common::TestServer, chat: ChatId, text: &str) {
        let mut cc = Client::new(server.channel().await);
        cc.send_message(pb::SendMessageRequest {
            chat_id: chat.to_string(),
            text: text.into(),
        })
        .await
        .unwrap();
    }

    pub(super) async fn set_model(server: &common::TestServer) {
        let mut sc = glyph_backend::proto::pb::settings_service_client::SettingsServiceClient::new(
            server.channel().await,
        );
        sc.update_settings(pb::UpdateSettingsRequest {
            chat_model_id: Some("velox/test-model".into()),
        })
        .await
        .unwrap();
    }

    pub(super) async fn events_for(pool: &PgPool, chat: ChatId) -> Vec<String> {
        sqlx::query_scalar("SELECT event_type FROM events WHERE stream = $1 ORDER BY id")
            .bind(format!("Chat${}", chat))
            .fetch_all(pool)
            .await
            .unwrap()
    }

    pub(super) async fn wait_idle(pool: &PgPool, chat: ChatId) {
        for _ in 0..100 {
            let (stored, _) = store(pool).find(chat).await.unwrap().unwrap();
            if stored.status == ChatStatus::Idle {
                return;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        panic!("chat never went idle");
    }

    #[sqlx::test(migrator = "glyph_backend::infrastructure::postgres::migrate::MIGRATOR")]
    async fn happy_turn_persists_done_message_and_session(pool: PgPool) {
        let server = seeded(&pool).await;
        set_model(&server).await;
        let chat = new_chat(&pool).await;
        send(&server, chat.id, "hello").await;
        wait_idle(&pool, chat.id).await;
        let (stored, messages) = store(&pool).find(chat.id).await.unwrap().unwrap();
        assert_eq!(stored.status, ChatStatus::Idle);
        assert_eq!(messages.len(), 2);
        assert_eq!(messages[1].kind, MessageKind::Assistant);
        assert_eq!(messages[1].status, MessageStatus::Done);
        assert_eq!(
            messages[1].text.as_deref(),
            Some("Fake reply to: hello")
        );
        let events = events_for(&pool, chat.id).await;
        assert!(events.contains(&"ChatTurnFinished".to_string()), "{events:?}");
        let session: Option<i32> = sqlx::query_scalar(
            "SELECT octet_length(pi_session) FROM chats WHERE id = $1",
        )
        .bind(chat.id.as_uuid())
        .fetch_one(&pool)
        .await
        .unwrap();
        assert!(session.unwrap_or(0) > 0, "session blob saved");
    }

    #[sqlx::test(migrator = "glyph_backend::infrastructure::postgres::migrate::MIGRATOR")]
    async fn deltas_concatenate_with_contiguous_offsets(pool: PgPool) {
        use glyph_backend::features::chat::ports::ChatBus;
        use glyph_backend::infrastructure::postgres::listener::ChatHub;
        let server = seeded(&pool).await;
        set_model(&server).await;
        let hub = ChatHub::new(64);
        let stop = tokio_util::sync::CancellationToken::new();
        let task = hub.clone().spawn_listener(pool.clone(), stop.clone());
        let mut rx = ChatBus::subscribe(&hub);
        tokio::time::sleep(Duration::from_millis(200)).await;
        let chat = new_chat(&pool).await;
        send(&server, chat.id, "one two three").await;
        let mut got = String::new();
        let mut expect_offset = 0usize;
        for _ in 0..200 {
            let event = match tokio::time::timeout(Duration::from_millis(500), rx.recv()).await {
                Ok(Ok(event)) => event,
                _ => break,
            };
            if event.kind != ChatEventKind::TextDelta { continue; }
            assert_eq!(event.offset, Some(expect_offset), "contiguous offsets");
            expect_offset += event.text.clone().unwrap_or_default().chars().count();
            got.push_str(&event.text.unwrap_or_default());
            if got.chars().count() >= "Fake reply to: one two three".chars().count() {
                break;
            }
        }
        assert_eq!(got, "Fake reply to: one two three");
        stop.cancel();
        let _ = task.await;
    }

    #[sqlx::test(migrator = "glyph_backend::infrastructure::postgres::migrate::MIGRATOR")]
    async fn mid_turn_getchat_shows_streaming_and_matching_length(pool: PgPool) {
        use glyph_backend::infrastructure::fake_chat_runner::Script;
        let server = runner_server(&pool, Arc::new(FakeChatRunner::scripted(vec![
            Script::Delta("word ".repeat(40)),
            Script::Sleep(2000),
            Script::Delta(" done".into()),
        ]))).await;
        set_model(&server).await;
        let chat = new_chat(&pool).await;
        send(&server, chat.id, "hello").await;
        let mut cc = Client::new(server.channel().await);
        let mut streaming_seen = false;
        for _ in 0..100 {
            let (stored, messages) = store(&pool).find(chat.id).await.unwrap().unwrap();
            if stored.status == ChatStatus::Running {
                let assistant = messages.iter().find(|m| m.kind == MessageKind::Assistant).unwrap();
                if assistant.status == MessageStatus::Streaming {
                    let response = cc
                        .get_chat(pb::GetChatRequest { chat_id: chat.id.to_string() })
                        .await
                        .unwrap()
                        .into_inner();
                    let m = response.messages.last().unwrap();
                    assert_eq!(m.status, pb::ChatMessageStatus::Streaming as i32);
                    assert_eq!(m.length as usize, assistant.text.as_deref().map(|t| t.chars().count()).unwrap_or(0));
                    streaming_seen = true;
                    break;
                }
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        assert!(streaming_seen, "never observed a streaming assistant message");
        wait_idle(&pool, chat.id).await;
    }

    #[sqlx::test(migrator = "glyph_backend::infrastructure::postgres::migrate::MIGRATOR")]
    async fn scripted_secret_never_publishes_nor_stores(pool: PgPool) {
        use glyph_backend::features::chat::ports::ChatBus;
        use glyph_backend::infrastructure::fake_chat_runner::Script;
        use glyph_backend::infrastructure::postgres::listener::ChatHub;
        let server = runner_server(&pool, Arc::new(FakeChatRunner::scripted(vec![
            Script::Delta("The key is sk-live-abcdef123456".into()),
            Script::Sleep(100),
        ]))).await;
        set_model(&server).await;
        let hub = ChatHub::new(64);
        let stop = tokio_util::sync::CancellationToken::new();
        let task = hub.clone().spawn_listener(pool.clone(), stop.clone());
        let mut rx = ChatBus::subscribe(&hub);
        tokio::time::sleep(Duration::from_millis(200)).await;
        let chat = new_chat(&pool).await;
        send(&server, chat.id, "leak").await;
        let mut published = String::new();
        loop {
            let event = match tokio::time::timeout(Duration::from_millis(300), rx.recv()).await {
                Ok(Ok(event)) => event,
                _ => break,
            };
            if event.kind == ChatEventKind::TextDelta {
                published.push_str(&event.text.unwrap_or_default());
            }
        }
        assert!(!published.contains("sk-live-abcdef123456"), "secret leaked in a delta: {published:?}");
        wait_idle(&pool, chat.id).await;
        let (_, messages) = store(&pool).find(chat.id).await.unwrap().unwrap();
        let assistant = messages.iter().find(|m| m.kind == MessageKind::Assistant).unwrap();
        assert!(!assistant.text.as_deref().unwrap_or("").contains("sk-live-abcdef123456"));
        stop.cancel();
        let _ = task.await;
    }

    #[sqlx::test(migrator = "glyph_backend::infrastructure::postgres::migrate::MIGRATOR")]
    async fn runner_error_fails_message_keeps_partial_text(pool: PgPool) {
        use glyph_backend::infrastructure::fake_chat_runner::Script;
        let server = runner_server(&pool, Arc::new(FakeChatRunner::scripted(vec![
            Script::Delta("partial answer ".into()),
            Script::Fail("The agent failed to answer.".into()),
        ]))).await;
        set_model(&server).await;
        let chat = new_chat(&pool).await;
        send(&server, chat.id, "hello").await;
        wait_idle(&pool, chat.id).await;
        let (stored, messages) = store(&pool).find(chat.id).await.unwrap().unwrap();
        assert_eq!(stored.status, ChatStatus::Idle);
        let assistant = messages.iter().find(|m| m.kind == MessageKind::Assistant).unwrap();
        assert_eq!(assistant.status, MessageStatus::Failed);
        assert_eq!(assistant.error.as_deref(), Some("The agent failed to answer."));
        assert!(assistant.text.as_deref().unwrap_or("").starts_with("partial answer"));
        let events = events_for(&pool, chat.id).await;
        assert!(events.contains(&"ChatTurnFailed".to_string()), "{events:?}");
    }
}

// --- Cancel and recovery (3.5) -----------------------------------------------

mod cancel {
    use super::turn::{runner_server, seeded, send, set_model, wait_idle, Client};
    use super::*;
    use glyph_backend::infrastructure::fake_chat_runner::FakeChatRunner;
    use std::time::Duration;
    use glyph_backend::infrastructure::fake_chat_runner::Script;

    async fn sleep_server(pool: &PgPool) -> common::TestServer {
        runner_server(pool, Arc::new(FakeChatRunner::scripted(vec![
            Script::Delta("thinking ".into()),
            Script::Sleep(600_000),
        ]))).await
    }

    async fn recovery_server(pool: &PgPool) -> common::TestServer {
        common::engine::seed_model(pool).await;
        common::spawn_with(
            pool.clone(),
            common::config_with(&[("GLYPH_RECOVERY_SWEEP_SECONDS", "1")]),
            glyph_backend::app::bootstrap::Overrides {
                chat_runner: Some(Arc::new(FakeChatRunner::scripted(vec![
                    Script::Delta("thinking ".into()),
                    Script::Sleep(600_000),
                ]))),
                background: Some(true),
                ..Default::default()
            },
        )
        .await
    }

    #[sqlx::test(migrator = "glyph_backend::infrastructure::postgres::migrate::MIGRATOR")]
    async fn cancel_during_sleep_fails_within_two_seconds(pool: PgPool) {
        let server = sleep_server(&pool).await;
        set_model(&server).await;
        let chat = new_chat(&pool).await;
        send(&server, chat.id, "long").await;
        tokio::time::sleep(Duration::from_millis(300)).await;
        let mut cc = Client::new(server.channel().await);
        cc.cancel_turn(glyph_backend::proto::pb::CancelTurnRequest {
            chat_id: chat.id.to_string(),
        })
        .await
        .unwrap();
        let started = std::time::Instant::now();
        wait_idle(&pool, chat.id).await;
        assert!(started.elapsed() < Duration::from_secs(2), "cancel took {:?}", started.elapsed());
        let (stored, messages) = store(&pool).find(chat.id).await.unwrap().unwrap();
        assert_eq!(stored.status, ChatStatus::Idle);
        let assistant = messages.iter().find(|m| m.kind == MessageKind::Assistant).unwrap();
        assert_eq!(assistant.status, MessageStatus::Failed);
        assert_eq!(assistant.error.as_deref(), Some("Cancelled."));
    }

    #[sqlx::test(migrator = "glyph_backend::infrastructure::postgres::migrate::MIGRATOR")]
    async fn cancel_on_idle_chat_is_a_noop(pool: PgPool) {
        let server = seeded(&pool).await;
        let chat = new_chat(&pool).await;
        let mut cc = Client::new(server.channel().await);
        cc.cancel_turn(glyph_backend::proto::pb::CancelTurnRequest {
            chat_id: chat.id.to_string(),
        })
        .await
        .unwrap();
        let (stored, _) = store(&pool).find(chat.id).await.unwrap().unwrap();
        assert_eq!(stored.status, ChatStatus::Idle);
    }

    #[sqlx::test(migrator = "glyph_backend::infrastructure::postgres::migrate::MIGRATOR")]
    async fn abandoned_job_is_recovered_as_interrupted(pool: PgPool) {
        let server = recovery_server(&pool).await;
        set_model(&server).await;
        let chat = new_chat(&pool).await;
        send(&server, chat.id, "long").await;
        tokio::time::sleep(Duration::from_millis(300)).await;
        // Simulate a dead worker: stale lock, no heartbeat.
        sqlx::query("UPDATE jobs SET locked_at = now() - interval '10 minutes', locked_by = 'dead-worker'")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("DELETE FROM job_workers")
            .execute(&pool)
            .await
            .unwrap();
        let started = std::time::Instant::now();
        loop {
            let (stored, messages) = store(&pool).find(chat.id).await.unwrap().unwrap();
            let assistant = messages.iter().find(|m| m.kind == MessageKind::Assistant);
            if stored.status == ChatStatus::Idle
                && assistant
                    .and_then(|m| m.error.clone())
                    .as_deref()
                    == Some("The turn was interrupted before it finished.")
            {
                break;
            }
            assert!(started.elapsed() < Duration::from_secs(120), "not recovered in time");
            tokio::time::sleep(Duration::from_millis(200)).await;
        }
    }

    #[sqlx::test(migrator = "glyph_backend::infrastructure::postgres::migrate::MIGRATOR")]
    async fn running_chat_without_job_is_recovered(pool: PgPool) {
        recovery_server(&pool).await;
        let chat = new_chat(&pool).await;
        let mut tx = store(&pool).begin().await.unwrap();
        assert!(tx.begin_turn(chat.id).await.unwrap());
        tx.insert_message(&glyph_backend::features::chat::ports::NewMessage {
            chat_id: chat.id,
            kind: MessageKind::Assistant,
            status: MessageStatus::Streaming,
            text: None,
            tool: None,
        })
        .await
        .unwrap();
        tx.commit().await.unwrap();
        let started = std::time::Instant::now();
        loop {
            let (stored, _) = store(&pool).find(chat.id).await.unwrap().unwrap();
            if stored.status == ChatStatus::Idle {
                let assistant_error: Option<String> = sqlx::query_scalar(
                    "SELECT m.error FROM chat_messages m WHERE m.chat_id = $1 AND m.kind = 'assistant' ORDER BY m.seq DESC LIMIT 1",
                )
                .bind(chat.id.as_uuid())
                .fetch_one(&pool)
                .await
                .unwrap();
                assert_eq!(
                    assistant_error.as_deref(),
                    Some("The turn was interrupted before it finished.")
                );
                break;
            }
            assert!(started.elapsed() < Duration::from_secs(120), "not recovered in time");
            tokio::time::sleep(Duration::from_millis(200)).await;
        }
    }
}

// --- WatchChat (3.6) ----------------------------------------------------------

mod watch {
    use super::*;
    use glyph_backend::features::chat::domain::events::ChatEventKind;
    use glyph_backend::proto::pb;
    use http_body_util::BodyExt;
    use prost::Message;
    use std::time::Duration;
    use tower::util::ServiceExt;

    /// One decoded gRPC-Web frame from the response body.
    async fn frame(body: &mut axum::body::Body, buf: &mut Vec<u8>) -> Option<pb::WatchChatResponse> {
        loop {
            while buf.len() >= 5 {
                let len = u32::from_be_bytes(buf[1..5].try_into().unwrap()) as usize;
                if buf.len() < 5 + len {
                    break;
                }
                let event = pb::WatchChatResponse::decode(&buf[5..5 + len]).unwrap();
                buf.drain(..5 + len);
                return Some(event);
            }
            let frame = body.frame().await?.ok()?;
            if let Ok(data) = frame.into_data() {
                buf.extend_from_slice(&data);
            }
        }
    }

    async fn open(server: &common::TestServer, chat: ChatId) -> (axum::body::Body, Vec<u8>) {
        let request = pb::WatchChatRequest { chat_id: chat.to_string() }.encode_to_vec();
        let mut wire = vec![0u8];
        wire.extend_from_slice(&(request.len() as u32).to_be_bytes());
        wire.extend_from_slice(&request);
        let response = server
            .router
            .clone()
            .oneshot(
                axum::http::Request::post("/glyph.v1.ChatService/WatchChat")
                    .header("content-type", "application/grpc-web+proto")
                    .header("x-grpc-web", "1")
                    .body(axum::body::Body::from(wire))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), 200);
        (response.into_body(), Vec::new())
    }

    fn kind(event: &pb::WatchChatResponse) -> pb::ChatEventType {
        event.event.as_ref().unwrap().r#type()
    }

    async fn notify(pool: &PgPool, kind: ChatEventKind, chat: ChatId, text: &str) {
        sqlx::query("SELECT pg_notify('glyph_chat', $1)")
            .bind(
                serde_json::to_string(&glyph_backend::features::chat::domain::events::ChatEvent {
                    kind,
                    chat_id: chat.to_string(),
                    offset: Some(0),
                    text: Some(text.into()),
                    message_id: None,
                    occurred_at: chrono::Utc::now(),
                })
                .unwrap(),
            )
            .execute(pool)
            .await
            .unwrap();
    }

    #[sqlx::test(migrator = "glyph_backend::infrastructure::postgres::migrate::MIGRATOR")]
    async fn stream_opens_with_heartbeat_and_delivers_deltas_and_updates(pool: PgPool) {
        let server = super::turn::runner_server(
            &pool,
            Arc::new(glyph_backend::infrastructure::fake_chat_runner::FakeChatRunner::scripted(vec![
                glyph_backend::infrastructure::fake_chat_runner::Script::Delta(
                    "The quick brown fox jumps over the lazy dog again and again".into(),
                ),
            ])),
        )
        .await;
        super::turn::set_model(&server).await;
        let chat = new_chat(&pool).await;
        let (mut body, mut buf) = open(&server, chat.id).await;
        let first = tokio::time::timeout(Duration::from_secs(5), frame(&mut body, &mut buf))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(kind(&first), pb::ChatEventType::Heartbeat);
        super::turn::send(&server, chat.id, "hi").await;
        let mut saw_delta = false;
        let event = tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                let event = frame(&mut body, &mut buf).await.expect("stream ended");
                match kind(&event) {
                    pb::ChatEventType::TextDelta => {
                        let e = event.event.as_ref().unwrap();
                        assert_eq!(e.chat_id, chat.id.to_string());
                        saw_delta = true;
                    }
                    pb::ChatEventType::ChatUpdated | pb::ChatEventType::MessageUpdated if saw_delta => {
                        return event;
                    }
                    _ => {}
                }
            }
        })
        .await
        .unwrap();
        assert!(matches!(
            kind(&event),
            pb::ChatEventType::ChatUpdated | pb::ChatEventType::MessageUpdated
        ));
    }

    #[sqlx::test(migrator = "glyph_backend::infrastructure::postgres::migrate::MIGRATOR")]
    async fn idle_yields_heartbeats_and_other_chats_are_filtered(pool: PgPool) {
        let server = common::spawn_with(
            pool.clone(),
            common::config_with(&[("GLYPH_LIVE_HEARTBEAT_SECONDS", "1")]),
            glyph_backend::app::bootstrap::Overrides {
                background: Some(true),
                ..Default::default()
            },
        )
        .await;
        let watched = new_chat(&pool).await;
        let other = new_chat(&pool).await;
        let (mut body, mut buf) = open(&server, watched.id).await;
        // Give the listener a moment, then publish another chat's delta.
        tokio::time::sleep(Duration::from_millis(500)).await;
        notify(&pool, ChatEventKind::TextDelta, other.id, "noise").await;
        let event = tokio::time::timeout(Duration::from_secs(5), async {
            let _ = frame(&mut body, &mut buf).await; // greeting heartbeat
            loop {
                let event = frame(&mut body, &mut buf).await.expect("stream ended");
                if kind(&event) == pb::ChatEventType::Heartbeat {
                    return event;
                }
                assert_ne!(
                    event.event.as_ref().unwrap().chat_id,
                    other.id.to_string(),
                    "another chat's delta leaked"
                );
            }
        })
        .await
        .unwrap();
        assert_eq!(kind(&event), pb::ChatEventType::Heartbeat);
    }
}
