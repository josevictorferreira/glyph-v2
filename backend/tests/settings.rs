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
