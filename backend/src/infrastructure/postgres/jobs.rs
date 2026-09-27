//! Job queue table access: claim with `FOR UPDATE SKIP LOCKED`, finish once.

use serde_json::Value;
use sqlx::PgPool;

pub const WAKE_CHANNEL: &str = "glyph_jobs";

#[derive(Debug, Clone)]
pub struct ClaimedJob {
    pub id: i64,
    pub kind: String,
    pub payload: Value,
}

pub async fn claim(pool: &PgPool, queue: &str, worker: &str) -> Result<Option<ClaimedJob>, sqlx::Error> {
    let row = sqlx::query!(
        "UPDATE jobs SET locked_at = now(), locked_by = $2
         WHERE id = (
           SELECT id FROM jobs
           WHERE queue = $1 AND finished_at IS NULL AND locked_at IS NULL AND run_at <= now()
           ORDER BY run_at, id
           FOR UPDATE SKIP LOCKED
           LIMIT 1
         )
         RETURNING id, kind, payload",
        queue,
        worker,
    )
    .fetch_optional(pool)
    .await?;
    Ok(row.map(|r| ClaimedJob {
        id: r.id,
        kind: r.kind,
        payload: r.payload,
    }))
}

pub async fn finish(pool: &PgPool, id: i64, error: Option<&str>) -> Result<(), sqlx::Error> {
    sqlx::query!(
        "UPDATE jobs SET finished_at = now(), error = $2 WHERE id = $1 AND finished_at IS NULL",
        id,
        error,
    )
    .execute(pool)
    .await?;
    Ok(())
}

/// Whether an unfinished job of `kind` exists (recurring-job dedupe).
pub async fn pending(pool: &PgPool, kind: &str) -> Result<bool, sqlx::Error> {
    Ok(sqlx::query_scalar!(
        "SELECT EXISTS (SELECT 1 FROM jobs WHERE kind = $1 AND finished_at IS NULL)",
        kind
    )
    .fetch_one(pool)
    .await?
    .unwrap_or(false))
}
