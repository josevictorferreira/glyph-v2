//! Recurring job ticker (Rails `config/recurring.yml`): every `every`, enqueue
//! `kind` unless one is already pending. A transaction-scoped advisory lock
//! elects one ticker across replicas per tick.

use std::time::Duration;

use serde_json::json;
use sqlx::PgPool;
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;

use crate::infrastructure::postgres::jobs::WAKE_CHANNEL;

/// Arbitrary constant: `hashtext('glyph.recurring')` equivalent key.
const LOCK_KEY: i64 = 0x676c_7970_6872_6563;

#[derive(Debug, Clone)]
pub struct Recurring {
    pub kind: String,
    pub queue: String,
    pub every: Duration,
}

/// Enqueues `kind` unless an unfinished one exists; returns whether it did.
pub async fn tick(pool: &PgPool, kind: &str, queue: &str) -> Result<bool, sqlx::Error> {
    let mut tx = pool.begin().await?;
    let leader: bool = sqlx::query_scalar!("SELECT pg_try_advisory_xact_lock($1)", LOCK_KEY)
        .fetch_one(&mut *tx)
        .await?
        .unwrap_or(false);
    if !leader {
        return Ok(false);
    }
    let pending = sqlx::query_scalar!(
        "SELECT EXISTS (SELECT 1 FROM jobs WHERE kind = $1 AND finished_at IS NULL)",
        kind
    )
    .fetch_one(&mut *tx)
    .await?
    .unwrap_or(false);
    if pending {
        return Ok(false);
    }
    sqlx::query!(
        "INSERT INTO jobs (kind, queue, payload) VALUES ($1, $2, $3)",
        kind,
        queue,
        json!({})
    )
    .execute(&mut *tx)
    .await?;
    sqlx::query!("SELECT pg_notify($1, $2)", WAKE_CHANNEL, queue)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(true)
}

pub fn spawn(pool: PgPool, recurring: Recurring, stop: CancellationToken) -> JoinHandle<()> {
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(recurring.every);
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            tokio::select! {
                _ = stop.cancelled() => return,
                _ = interval.tick() => {
                    if let Err(error) = tick(&pool, &recurring.kind, &recurring.queue).await {
                        tracing::warn!(%error, kind = %recurring.kind, "recurring tick failed");
                    }
                }
            }
        }
    })
}
