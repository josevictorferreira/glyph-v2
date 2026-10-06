//! Crash recovery sweep. A worker that dies mid-job (OOM kill, node loss)
//! leaves its job locked and unfinished forever: the step it ran stays
//! `running`, and a recurring job of that kind is never enqueued again. Every
//! `every`, jobs abandoned by dead workers are finished with an error and
//! handed to `recover_job`; then `running` step runs that no unfinished job
//! executes are handed to `recover_step`. The sweep is not itself a job: a
//! dead sweep job would block its own recovery.

use std::sync::Arc;
use std::time::Duration;

use sqlx::PgPool;
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use crate::infrastructure::jobs::worker::JobFuture;
use crate::infrastructure::postgres::jobs::{self, ClaimedJob};

#[derive(Clone)]
pub struct Recovery {
    pub every: Duration,
    /// How long a worker may go without a heartbeat before its jobs count as
    /// abandoned. Generous: a struggling database delays heartbeats too.
    pub stale_after: Duration,
    /// Job kind that executes one step run (`payload.step_run_id`).
    pub step_kind: String,
    pub recover_job: Arc<dyn Fn(ClaimedJob) -> JobFuture + Send + Sync>,
    pub recover_step: Arc<dyn Fn(Uuid) -> JobFuture + Send + Sync>,
}

pub async fn sweep(pool: &PgPool, recovery: &Recovery) -> Result<(), sqlx::Error> {
    for job in jobs::abandon_orphans(pool, recovery.stale_after).await? {
        tracing::warn!(id = job.id, kind = %job.kind, "recovering a job abandoned by a dead worker");
        if let Err(error) = (recovery.recover_job)(job).await {
            tracing::warn!(error = %format!("{error:#}"), "job recovery failed");
        }
    }
    for id in jobs::orphaned_step_runs(pool, &recovery.step_kind).await? {
        tracing::warn!(step_run_id = %id, "recovering a running step run without a job");
        if let Err(error) = (recovery.recover_step)(id).await {
            tracing::warn!(error = %format!("{error:#}"), %id, "step run recovery failed");
        }
    }
    Ok(())
}

pub fn spawn(pool: PgPool, recovery: Recovery, stop: CancellationToken) -> JoinHandle<()> {
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(recovery.every);
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            tokio::select! {
                _ = stop.cancelled() => return,
                _ = interval.tick() => {
                    if let Err(error) = sweep(&pool, &recovery).await {
                        tracing::warn!(%error, "recovery sweep failed");
                    }
                }
            }
        }
    })
}
