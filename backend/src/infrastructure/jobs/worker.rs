//! In-process job worker: one claim loop per queue with bounded concurrency.
//! Claims use `FOR UPDATE SKIP LOCKED`; every claimed job is finished exactly
//! once, with its error recorded — never retried. A heartbeat proves the
//! worker alive, so jobs left by a dead one can be recovered (`recovery`).

use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;

use serde_json::Value;
use sqlx::PgPool;
use sqlx::postgres::PgListener;
use tokio::sync::{Notify, Semaphore};
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;
use tokio_util::task::TaskTracker;
use tracing::Instrument;

use crate::infrastructure::postgres::jobs::{self, ClaimedJob, WAKE_CHANNEL};

pub type JobFuture = Pin<Box<dyn Future<Output = anyhow::Result<()>> + Send>>;
pub type Handler = Arc<dyn Fn(Value) -> JobFuture + Send + Sync>;

const IDLE_POLL: Duration = Duration::from_secs(1);
pub const HEARTBEAT_EVERY: Duration = Duration::from_secs(10);

#[derive(Clone)]
pub struct Worker {
    pool: PgPool,
    handlers: HashMap<String, Handler>,
    queues: Vec<(String, usize)>,
    id: String,
}

impl Worker {
    pub fn new(pool: PgPool) -> Self {
        let host = std::env::var("HOSTNAME").unwrap_or_else(|_| "localhost".into());
        Self {
            pool,
            handlers: HashMap::new(),
            queues: Vec::new(),
            // The nonce tells restarts apart: a restarted container keeps its
            // hostname and usually its pid (1).
            id: format!(
                "{host}:{}:{}",
                std::process::id(),
                &uuid::Uuid::new_v4().simple().to_string()[..8]
            ),
        }
    }

    pub fn handle<F, Fut>(mut self, kind: &str, f: F) -> Self
    where
        F: Fn(Value) -> Fut + Send + Sync + 'static,
        Fut: Future<Output = anyhow::Result<()>> + Send + 'static,
    {
        self.handlers.insert(
            kind.to_string(),
            Arc::new(move |payload| Box::pin(f(payload))),
        );
        self
    }

    pub fn queue(mut self, name: &str, concurrency: usize) -> Self {
        self.queues.push((name.to_string(), concurrency.max(1)));
        self
    }

    /// Runs until `stop`; then waits up to `grace` for in-flight jobs and
    /// aborts the rest (their rows stay locked, unfinished — diagnostic).
    pub fn spawn(self, stop: CancellationToken, grace: Duration) -> JoinHandle<()> {
        tokio::spawn(async move { self.run(stop, grace).await })
    }

    async fn run(self, stop: CancellationToken, grace: Duration) {
        if let Err(error) = jobs::heartbeat(&self.pool, &self.id).await {
            tracing::warn!(%error, "worker heartbeat failed");
        }
        let heartbeat = tokio::spawn(beat(self.pool.clone(), self.id.clone()));
        let wake = Arc::new(Notify::new());
        let listener = tokio::spawn(listen(self.pool.clone(), wake.clone(), stop.clone()));
        let tracker = TaskTracker::new();
        let this = Arc::new(self);
        let loops: Vec<_> = this
            .queues
            .clone()
            .into_iter()
            .map(|(queue, concurrency)| {
                let this = this.clone();
                let stop = stop.clone();
                let wake = wake.clone();
                let tracker = tracker.clone();
                tokio::spawn(async move {
                    this.claim_loop(&queue, concurrency, stop, wake, tracker)
                        .await
                })
            })
            .collect();
        for l in loops {
            let _ = l.await;
        }
        tracker.close();
        if tokio::time::timeout(grace, tracker.wait()).await.is_err() {
            tracing::warn!(
                ?grace,
                "jobs still running after the shutdown grace period; aborting them"
            );
        }
        listener.abort();
        heartbeat.abort();
        if let Err(error) = jobs::retire(&this.pool, &this.id).await {
            tracing::warn!(%error, "retiring the worker failed");
        }
    }

    async fn claim_loop(
        self: Arc<Self>,
        queue: &str,
        concurrency: usize,
        stop: CancellationToken,
        wake: Arc<Notify>,
        tracker: TaskTracker,
    ) {
        let slots = Arc::new(Semaphore::new(concurrency));
        loop {
            let permit = tokio::select! {
                _ = stop.cancelled() => return,
                permit = slots.clone().acquire_owned() => permit.expect("semaphore is never closed"),
            };
            let job = match jobs::claim(&self.pool, queue, &self.id).await {
                Ok(job) => job,
                Err(error) => {
                    tracing::warn!(%error, queue, "claiming a job failed");
                    None
                }
            };
            let Some(job) = job else {
                drop(permit);
                tokio::select! {
                    _ = stop.cancelled() => return,
                    _ = wake.notified() => {},
                    _ = tokio::time::sleep(IDLE_POLL) => {},
                }
                continue;
            };
            let this = self.clone();
            tracker.spawn(async move {
                this.execute(job).await;
                drop(permit);
            });
        }
    }

    async fn execute(&self, job: ClaimedJob) {
        let span =
            tracing::info_span!("job", id = job.id, kind = %job.kind, payload = %job.payload);
        let result = async {
            let Some(handler) = self.handlers.get(&job.kind).cloned() else {
                return Err(format!("unknown job kind {}", job.kind));
            };
            // A panicking handler must still finish its job row.
            match tokio::spawn(handler(job.payload.clone())).await {
                Ok(Ok(())) => Ok(()),
                Ok(Err(error)) => Err(format!("{error:#}")),
                Err(join) => Err(format!("job panicked: {join}")),
            }
        }
        .instrument(span.clone())
        .await;
        let _enter = span.enter();
        if let Err(error) = &result {
            tracing::warn!(%error, "job failed");
        }
        if let Err(error) = jobs::finish(&self.pool, job.id, result.err().as_deref()).await {
            tracing::error!(%error, "recording job completion failed");
        }
    }
}

async fn beat(pool: PgPool, id: String) {
    let mut interval = tokio::time::interval(HEARTBEAT_EVERY);
    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        interval.tick().await;
        if let Err(error) = jobs::heartbeat(&pool, &id).await {
            tracing::warn!(%error, "worker heartbeat failed");
        }
    }
}

async fn listen(pool: PgPool, wake: Arc<Notify>, stop: CancellationToken) {
    let pool = crate::infrastructure::postgres::pool::listener_pool(&pool);
    loop {
        let mut listener = match PgListener::connect_with(&pool).await {
            Ok(l) => l,
            Err(error) => {
                tracing::warn!(%error, "job listener connect failed");
                tokio::select! {
                    _ = stop.cancelled() => return,
                    _ = tokio::time::sleep(Duration::from_secs(1)) => continue,
                }
            }
        };
        if listener.listen(WAKE_CHANNEL).await.is_err() {
            continue;
        }
        loop {
            tokio::select! {
                _ = stop.cancelled() => return,
                n = listener.recv() => match n {
                    Ok(_) => wake.notify_waiters(),
                    Err(_) => break,
                },
            }
        }
    }
}
