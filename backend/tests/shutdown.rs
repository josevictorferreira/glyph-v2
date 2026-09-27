//! Graceful shutdown of the real binary: SIGTERM drains in-flight steps
//! within GLYPH_SHUTDOWN_GRACE; past the grace the step is left running.
mod common;

use std::process::Stdio;
use std::time::{Duration, Instant};

use common::engine::{Builder, seed_model};
use glyph_backend::proto::pb;
use glyph_backend::proto::pb::run_service_client::RunServiceClient;
use sqlx::PgPool;
use tokio::process::{Child, Command};
use tonic::transport::Channel;

fn database_url(pool: &PgPool) -> String {
    let base = std::env::var("DATABASE_URL").expect("DATABASE_URL for tests");
    let db = pool.connect_options().get_database().unwrap().to_string();
    let (prefix, _) = base.rsplit_once('/').unwrap();
    format!("{prefix}/{db}")
}

fn free_port() -> u16 {
    std::net::TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port()
}

async fn boot(pool: &PgPool, grace_secs: u64) -> (Child, Channel) {
    let port = free_port();
    let child = Command::new(env!("CARGO_BIN_EXE_glyph"))
        .env_clear()
        .env("PATH", std::env::var("PATH").unwrap_or_default())
        .env("DATABASE_URL", database_url(pool))
        .env("GLYPH_LISTEN_ADDR", format!("127.0.0.1:{port}"))
        .env("GLYPH_STEP_RUNNER", "fake")
        .env("GLYPH_SCHEDULER_ENABLED", "false")
        .env("GLYPH_SHUTDOWN_GRACE", grace_secs.to_string())
        .env("RUST_LOG", "warn")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    let url = format!("http://127.0.0.1:{port}");
    for _ in 0..200 {
        if let Ok(channel) = Channel::from_shared(url.clone()).unwrap().connect().await {
            return (child, channel);
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    panic!("server did not start");
}

async fn step_status(pool: &PgPool, run: &str) -> String {
    sqlx::query_scalar("SELECT status FROM step_runs WHERE workflow_run_id = $1::uuid")
        .bind(run)
        .fetch_one(pool)
        .await
        .unwrap()
}

async fn start_sleeping_run(pool: &PgPool, channel: Channel, sleep_ms: u64) -> String {
    let mut b = Builder::with_channel(channel.clone(), "Sleepy", false).await;
    let step = b.pi("Sleep").await;
    b.set_prompt(&step, &format!("FAKE_SLEEP:{sleep_ms}")).await;
    let run = RunServiceClient::new(channel)
        .start_run(pb::StartRunRequest {
            workflow_id: b.id.clone(),
            values: Default::default(),
        })
        .await
        .unwrap()
        .into_inner()
        .run
        .unwrap();
    for _ in 0..200 {
        if step_status(pool, &run.id).await == "running" {
            return run.id;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    panic!("step never started");
}

fn sigterm(child: &Child) {
    nix::sys::signal::kill(
        nix::unistd::Pid::from_raw(child.id().unwrap() as i32),
        nix::sys::signal::Signal::SIGTERM,
    )
    .unwrap();
}

#[sqlx::test(migrator = "glyph_backend::infrastructure::postgres::migrate::MIGRATOR")]
async fn sigterm_drains_in_flight_steps(pool: PgPool) {
    seed_model(&pool).await;
    let (mut child, channel) = boot(&pool, 10).await;
    let run = start_sleeping_run(&pool, channel, 1500).await;
    sigterm(&child);
    let status = tokio::time::timeout(Duration::from_secs(15), child.wait())
        .await
        .unwrap()
        .unwrap();
    assert!(status.success(), "{status:?}");
    assert_eq!(step_status(&pool, &run).await, "succeeded");
}

#[sqlx::test(migrator = "glyph_backend::infrastructure::postgres::migrate::MIGRATOR")]
async fn sigterm_abandons_steps_past_the_grace(pool: PgPool) {
    seed_model(&pool).await;
    let (mut child, channel) = boot(&pool, 1).await;
    let run = start_sleeping_run(&pool, channel, 60_000).await;
    let t = Instant::now();
    sigterm(&child);
    let status = tokio::time::timeout(Duration::from_secs(15), child.wait())
        .await
        .unwrap()
        .unwrap();
    assert!(status.success(), "{status:?}");
    assert!(t.elapsed() < Duration::from_secs(8), "{:?}", t.elapsed());
    // Diagnostic, as in Rails: the step stays running, never silently retried.
    assert_eq!(step_status(&pool, &run).await, "running");
}
