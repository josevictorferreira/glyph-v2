//! Settings storage (`app_settings`) and `SettingsService` over gRPC.
mod common;
use std::sync::Arc;
use glyph_backend::features::settings::{SettingsStore, SettingsTx};
use glyph_backend::infrastructure::crypto::AesGcmCipher;
use glyph_backend::infrastructure::postgres::PgStore;
use sqlx::PgPool;

fn store(pool: &PgPool) -> PgStore {
    PgStore::new(pool.clone(), Arc::new(AesGcmCipher::dev()))
}

#[sqlx::test(migrator = "glyph_backend::infrastructure::postgres::migrate::MIGRATOR")]
async fn get_on_empty_table_returns_none(pool: PgPool) {
    let store = store(&pool);
    assert_eq!(store.get("chat_model_id").await.unwrap(), None);
}

#[sqlx::test(migrator = "glyph_backend::infrastructure::postgres::migrate::MIGRATOR")]
async fn set_then_get_round_trips(pool: PgPool) {
    let store = store(&pool);
    store.set("chat_model_id", "velox/gpt").await.unwrap();
    assert_eq!(
        store.get("chat_model_id").await.unwrap().as_deref(),
        Some("velox/gpt")
    );
}

#[sqlx::test(migrator = "glyph_backend::infrastructure::postgres::migrate::MIGRATOR")]
async fn set_twice_keeps_one_row(pool: PgPool) {
    let store = store(&pool);
    store.set("chat_model_id", "velox/one").await.unwrap();
    store.set("chat_model_id", "velox/two").await.unwrap();
    assert_eq!(
        store.get("chat_model_id").await.unwrap().as_deref(),
        Some("velox/two")
    );
    let rows: i64 = sqlx::query_scalar("SELECT count(*) FROM app_settings WHERE key = 'chat_model_id'")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(rows, 1);
}

#[sqlx::test(migrator = "glyph_backend::infrastructure::postgres::migrate::MIGRATOR")]
async fn clear_removes_the_setting(pool: PgPool) {
    let store = store(&pool);
    store.set("chat_model_id", "velox/one").await.unwrap();
    store.clear("chat_model_id").await.unwrap();
    assert_eq!(store.get("chat_model_id").await.unwrap(), None);
}

#[sqlx::test(migrator = "glyph_backend::infrastructure::postgres::migrate::MIGRATOR")]
async fn set_and_clear_work_inside_a_transaction(pool: PgPool) {
    let store = store(&pool);
    let mut tx: Box<dyn SettingsTx> = store.begin().await.unwrap();
    tx.set("chat_model_id", "velox/in-tx").await.unwrap();
    tx.commit().await.unwrap();
    assert_eq!(
        store.get("chat_model_id").await.unwrap().as_deref(),
        Some("velox/in-tx")
    );
}

// --- SettingsService over gRPC ---------------------------------------------

use glyph_backend::proto::pb;
use glyph_backend::proto::pb::settings_service_client::SettingsServiceClient;
use tonic::Code;
use tonic::transport::Channel;

type Client = SettingsServiceClient<Channel>;

async fn seed_model(pool: &PgPool, model_id: &str) {
    sqlx::query(
        "INSERT INTO available_models (provider, model_id, available, fetched_at)
         VALUES ('velox', $1, true, now())",
    )
    .bind(model_id)
    .execute(pool)
    .await
    .unwrap();
}

async fn events(pool: &PgPool, stream: &str) -> Vec<String> {
    sqlx::query_scalar("SELECT event_type FROM events WHERE stream = $1 ORDER BY id")
        .bind(stream)
        .fetch_all(pool)
        .await
        .unwrap()
}

#[sqlx::test(migrator = "glyph_backend::infrastructure::postgres::migrate::MIGRATOR")]
async fn get_settings_on_a_fresh_database_has_no_model(pool: PgPool) {
    let server = common::spawn(pool.clone()).await;
    let mut client = Client::new(server.channel().await);
    let settings = client.get_settings(pb::GetSettingsRequest {}).await.unwrap().into_inner();
    assert_eq!(settings.chat_model_id, None);
}

#[sqlx::test(migrator = "glyph_backend::infrastructure::postgres::migrate::MIGRATOR")]
async fn update_settings_stores_the_model_and_appends_an_event(pool: PgPool) {
    seed_model(&pool, "chat-model").await;
    let server = common::spawn(pool.clone()).await;
    let mut client = Client::new(server.channel().await);
    let settings = client
        .update_settings(pb::UpdateSettingsRequest {
            chat_model_id: Some("velox/chat-model".into()),
        })
        .await
        .unwrap()
        .into_inner();
    assert_eq!(settings.chat_model_id.as_deref(), Some("velox/chat-model"));
    assert_eq!(
        events(&pool, "Settings$app").await,
        vec!["SettingsUpdated".to_string()]
    );
    let again = client.get_settings(pb::GetSettingsRequest {}).await.unwrap().into_inner();
    assert_eq!(again.chat_model_id.as_deref(), Some("velox/chat-model"));
}

#[sqlx::test(migrator = "glyph_backend::infrastructure::postgres::migrate::MIGRATOR")]
async fn update_settings_rejects_an_unknown_model(pool: PgPool) {
    let server = common::spawn(pool.clone()).await;
    let mut client = Client::new(server.channel().await);
    let error = client
        .update_settings(pb::UpdateSettingsRequest {
            chat_model_id: Some("velox/ghost".into()),
        })
        .await
        .unwrap_err();
    assert_eq!(error.code(), Code::InvalidArgument);
    assert_eq!(
        error.message(),
        "\u{201c}velox/ghost\u{201d} is not an available model. Pick one from the list."
    );
    assert_eq!(events(&pool, "Settings$app").await, Vec::<String>::new());
}

#[sqlx::test(migrator = "glyph_backend::infrastructure::postgres::migrate::MIGRATOR")]
async fn update_settings_rejects_an_unavailable_model(pool: PgPool) {
    sqlx::query("INSERT INTO available_models (provider, model_id, available) VALUES ('velox', 'gone', false)")
        .execute(&pool)
        .await
        .unwrap();
    let server = common::spawn(pool).await;
    let mut client = Client::new(server.channel().await);
    let error = client
        .update_settings(pb::UpdateSettingsRequest {
            chat_model_id: Some("velox/gone".into()),
        })
        .await
        .unwrap_err();
    assert_eq!(error.code(), Code::InvalidArgument);
    assert!(error.message().contains("is not an available model"));
}

#[sqlx::test(migrator = "glyph_backend::infrastructure::postgres::migrate::MIGRATOR")]
async fn update_settings_with_an_empty_id_clears_the_setting(pool: PgPool) {
    seed_model(&pool, "chat-model").await;
    let server = common::spawn(pool).await;
    let mut client = Client::new(server.channel().await);
    client
        .update_settings(pb::UpdateSettingsRequest {
            chat_model_id: Some("velox/chat-model".into()),
        })
        .await
        .unwrap();
    let settings = client
        .update_settings(pb::UpdateSettingsRequest { chat_model_id: Some(String::new()) })
        .await
        .unwrap()
        .into_inner();
    assert_eq!(settings.chat_model_id, None);
}
