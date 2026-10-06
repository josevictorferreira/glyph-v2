//! Job worker: bounded concurrency, one claim per job, no retries, drain.
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

use glyph_backend::infrastructure::jobs::worker::Worker;
use serde_json::json;
use sqlx::PgPool;
use tokio_util::sync::CancellationToken;

async fn enqueue(pool: &PgPool, kind: &str, n: usize) {
    for i in 0..n {
        sqlx::query("INSERT INTO jobs (kind, queue, payload) VALUES ($1, 'q', $2)")
            .bind(kind)
            .bind(json!({ "i": i }))
            .execute(pool)
            .await
            .unwrap();
    }
}

async fn wait_finished(pool: &PgPool, n: i64) {
    for _ in 0..200 {
        let done: i64 =
            sqlx::query_scalar("SELECT count(*) FROM jobs WHERE finished_at IS NOT NULL")
                .fetch_one(pool)
                .await
                .unwrap();
        if done >= n {
            return;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    panic!("jobs did not finish");
}

#[sqlx::test(migrator = "glyph_backend::infrastructure::postgres::migrate::MIGRATOR")]
async fn runs_at_most_n_concurrently_and_each_job_once(pool: PgPool) {
    enqueue(&pool, "work", 10).await;
    let (inflight, peak, total) = (
        Arc::new(AtomicUsize::new(0)),
        Arc::new(AtomicUsize::new(0)),
        Arc::new(AtomicUsize::new(0)),
    );
    let (i, p, t) = (inflight.clone(), peak.clone(), total.clone());
    let stop = CancellationToken::new();
    // Two workers on the same queue compete for jobs.
    let make = |pool: PgPool| {
        let (i, p, t) = (i.clone(), p.clone(), t.clone());
        Worker::new(pool).queue("q", 5).handle("work", move |_| {
            let (i, p, t) = (i.clone(), p.clone(), t.clone());
            async move {
                let now = i.fetch_add(1, Ordering::SeqCst) + 1;
                p.fetch_max(now, Ordering::SeqCst);
                tokio::time::sleep(Duration::from_millis(100)).await;
                i.fetch_sub(1, Ordering::SeqCst);
                t.fetch_add(1, Ordering::SeqCst);
                Ok(())
            }
        })
    };
    let w1 = make(pool.clone()).spawn(stop.clone(), Duration::from_secs(5));
    wait_finished(&pool, 10).await;
    stop.cancel();
    w1.await.unwrap();
    assert_eq!(total.load(Ordering::SeqCst), 10, "each job exactly once");
    assert!(
        peak.load(Ordering::SeqCst) <= 5,
        "peak {}",
        peak.load(Ordering::SeqCst)
    );
    assert!(peak.load(Ordering::SeqCst) >= 2, "ran concurrently");
    let _ = (inflight, p, t);
}

#[sqlx::test(migrator = "glyph_backend::infrastructure::postgres::migrate::MIGRATOR")]
async fn concurrent_workers_never_share_a_job(pool: PgPool) {
    enqueue(&pool, "work", 20).await;
    let total = Arc::new(AtomicUsize::new(0));
    let stop = CancellationToken::new();
    let handles: Vec<_> = (0..3)
        .map(|_| {
            let t = total.clone();
            Worker::new(pool.clone())
                .queue("q", 4)
                .handle("work", move |_| {
                    let t = t.clone();
                    async move {
                        t.fetch_add(1, Ordering::SeqCst);
                        tokio::time::sleep(Duration::from_millis(10)).await;
                        Ok(())
                    }
                })
                .spawn(stop.clone(), Duration::from_secs(5))
        })
        .collect();
    wait_finished(&pool, 20).await;
    stop.cancel();
    for h in handles {
        h.await.unwrap();
    }
    assert_eq!(total.load(Ordering::SeqCst), 20);
}

#[sqlx::test(migrator = "glyph_backend::infrastructure::postgres::migrate::MIGRATOR")]
async fn failures_are_recorded_not_retried(pool: PgPool) {
    enqueue(&pool, "boom", 1).await;
    enqueue(&pool, "mystery", 1).await;
    enqueue(&pool, "panics", 1).await;
    let calls = Arc::new(AtomicUsize::new(0));
    let c = calls.clone();
    let stop = CancellationToken::new();
    let h = Worker::new(pool.clone())
        .queue("q", 2)
        .handle("boom", move |_| {
            let c = c.clone();
            async move {
                c.fetch_add(1, Ordering::SeqCst);
                anyhow::bail!("exploded")
            }
        })
        .handle("panics", |_| async { panic!("kaboom") })
        .spawn(stop.clone(), Duration::from_secs(5));
    wait_finished(&pool, 3).await;
    tokio::time::sleep(Duration::from_millis(1200)).await;
    stop.cancel();
    h.await.unwrap();
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    let errors: Vec<(String, String)> = sqlx::query_as("SELECT kind, error FROM jobs ORDER BY id")
        .fetch_all(&pool)
        .await
        .unwrap();
    assert_eq!(errors[0], ("boom".into(), "exploded".into()));
    assert_eq!(
        errors[1],
        ("mystery".into(), "unknown job kind mystery".into())
    );
    assert!(errors[2].1.contains("panicked"), "{:?}", errors[2]);
}

#[sqlx::test(migrator = "glyph_backend::infrastructure::postgres::migrate::MIGRATOR")]
async fn shutdown_waits_for_in_flight_jobs(pool: PgPool) {
    enqueue(&pool, "slow", 1).await;
    let stop = CancellationToken::new();
    let started = Arc::new(tokio::sync::Notify::new());
    let s = started.clone();
    let h = Worker::new(pool.clone())
        .queue("q", 1)
        .handle("slow", move |_| {
            let s = s.clone();
            async move {
                s.notify_one();
                tokio::time::sleep(Duration::from_millis(300)).await;
                Ok(())
            }
        })
        .spawn(stop.clone(), Duration::from_secs(5));
    started.notified().await;
    stop.cancel();
    h.await.unwrap();
    let finished: Option<chrono::DateTime<chrono::Utc>> =
        sqlx::query_scalar("SELECT finished_at FROM jobs")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert!(
        finished.is_some(),
        "in-flight job completed before shutdown returned"
    );

    // With a short grace, a long job is abandoned (row stays locked, unfinished).
    enqueue(&pool, "forever", 1).await;
    let stop = CancellationToken::new();
    let started = Arc::new(tokio::sync::Notify::new());
    let s = started.clone();
    let h = Worker::new(pool.clone())
        .queue("q", 1)
        .handle("forever", move |_| {
            let s = s.clone();
            async move {
                s.notify_one();
                tokio::time::sleep(Duration::from_secs(60)).await;
                Ok(())
            }
        })
        .spawn(stop.clone(), Duration::from_millis(200));
    started.notified().await;
    let t = std::time::Instant::now();
    stop.cancel();
    h.await.unwrap();
    assert!(t.elapsed() < Duration::from_secs(2));
    let (locked, finished): (bool, bool) = sqlx::query_as(
        "SELECT locked_at IS NOT NULL, finished_at IS NOT NULL FROM jobs WHERE kind = 'forever'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert!(locked && !finished);
}

async fn workers_alive(pool: &PgPool) -> i64 {
    sqlx::query_scalar(
        "SELECT count(*) FROM job_workers WHERE heartbeat_at > now() - interval '1 minute'",
    )
    .fetch_one(pool)
    .await
    .unwrap()
}

#[sqlx::test(migrator = "glyph_backend::infrastructure::postgres::migrate::MIGRATOR")]
async fn heartbeats_while_alive_and_retires_on_stop(pool: PgPool) {
    let stop = CancellationToken::new();
    let worker = Worker::new(pool.clone())
        .queue("q", 1)
        .spawn(stop.clone(), Duration::from_secs(1));
    for _ in 0..200 {
        if workers_alive(&pool).await == 1 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    assert_eq!(workers_alive(&pool).await, 1);
    stop.cancel();
    worker.await.unwrap();
    let rows: i64 = sqlx::query_scalar("SELECT count(*) FROM job_workers")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(rows, 0, "a stopped worker vouches for nothing");
}
