//! Job queue table access: claim with `FOR UPDATE SKIP LOCKED`, finish once.

use serde_json::Value;
use sqlx::PgPool;
use uuid::Uuid;

pub const WAKE_CHANNEL: &str = "glyph_jobs";

#[derive(Debug, Clone)]
pub struct ClaimedJob {
    pub id: i64,
    pub kind: String,
    pub payload: Value,
}

pub async fn claim(
    pool: &PgPool,
    queue: &str,
    worker: &str,
) -> Result<Option<ClaimedJob>, sqlx::Error> {
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

/// Records that `worker` is alive.
pub async fn heartbeat(pool: &PgPool, worker: &str) -> Result<(), sqlx::Error> {
    sqlx::query!(
        "INSERT INTO job_workers (id, heartbeat_at) VALUES ($1, now())
         ON CONFLICT (id) DO UPDATE SET heartbeat_at = now()",
        worker,
    )
    .execute(pool)
    .await?;
    Ok(())
}

/// A stopping worker forgets itself: jobs it left behind become recoverable
/// without waiting for its heartbeat to go stale.
pub async fn retire(pool: &PgPool, worker: &str) -> Result<(), sqlx::Error> {
    sqlx::query!("DELETE FROM job_workers WHERE id = $1", worker)
        .execute(pool)
        .await?;
    Ok(())
}

/// Finishes (with an error) every unfinished job locked for longer than
/// `stale_after` by a worker without a heartbeat as recent, and returns them.
/// Concurrent sweepers never return the same job.
pub async fn abandon_orphans(
    pool: &PgPool,
    stale_after: std::time::Duration,
) -> Result<Vec<ClaimedJob>, sqlx::Error> {
    let rows = sqlx::query!(
        "UPDATE jobs j
         SET finished_at = now(), error = 'abandoned: worker ' || j.locked_by || ' stopped'
         WHERE j.finished_at IS NULL
           AND j.locked_at < now() - make_interval(secs => $1)
           AND NOT EXISTS (
             SELECT 1 FROM job_workers w
             WHERE w.id = j.locked_by AND w.heartbeat_at > now() - make_interval(secs => $1)
           )
         RETURNING j.id, j.kind, j.payload",
        stale_after.as_secs_f64(),
    )
    .fetch_all(pool)
    .await?;
    Ok(rows
        .into_iter()
        .map(|r| ClaimedJob {
            id: r.id,
            kind: r.kind,
            payload: r.payload,
        })
        .collect())
}

/// Step runs still `running` with no unfinished `kind` job executing them
/// (their job errored after the step started, or was abandoned).
pub async fn orphaned_step_runs(pool: &PgPool, kind: &str) -> Result<Vec<Uuid>, sqlx::Error> {
    sqlx::query_scalar!(
        "SELECT s.id FROM step_runs s
         WHERE s.status = 'running'
           AND NOT EXISTS (
             SELECT 1 FROM jobs j
             WHERE j.kind = $1 AND j.finished_at IS NULL
               AND j.payload->>'step_run_id' = s.id::text
           )",
        kind,
    )
    .fetch_all(pool)
    .await
}
