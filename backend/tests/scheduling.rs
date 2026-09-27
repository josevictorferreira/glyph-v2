//! Scheduled dispatch (ports schedule_dispatcher_spec) + recurring ticker.
mod common;

use std::sync::Arc;

use common::engine::{Builder, ScriptedRunner};
use glyph_backend::features::runs::RunService;
use glyph_backend::features::scheduling::DispatchDueWorkflows;
use glyph_backend::infrastructure::crypto::AesGcmCipher;
use glyph_backend::infrastructure::jobs::recurring;
use glyph_backend::infrastructure::postgres::PgStore;
use glyph_backend::proto::pb;
use glyph_backend::shared::time::{SystemClock, Timestamp};
use sqlx::PgPool;

fn at(s: &str) -> Timestamp {
    s.parse().unwrap()
}

const NOW: &str = "2026-08-04T09:00:30Z";
const DUE: &str = "2026-08-04T09:00:00Z";

fn dispatcher(pool: &PgPool) -> DispatchDueWorkflows {
    let store = Arc::new(PgStore::new(pool.clone(), Arc::new(AesGcmCipher::dev())));
    let runs = RunService::new(
        store.clone(),
        store.clone(),
        ScriptedRunner::new(&[]),
        Arc::new(SystemClock),
    );
    DispatchDueWorkflows::new(store, runs)
}

/// An active workflow with an enabled daily 09:00 UTC schedule due at DUE.
async fn scheduled(server: &common::TestServer) -> Builder {
    let mut b = Builder::new(server, "Scheduled", false).await;
    b.pi("A").await;
    b.client
        .activate_workflow(pb::ActivateWorkflowRequest { id: b.id.clone() })
        .await
        .unwrap();
    b.client
        .save_schedule(pb::SaveScheduleRequest {
            workflow_id: b.id.clone(),
            recurrence: Some(pb::save_schedule_request::Recurrence::Daily(
                pb::ScheduleDaily { hour: 9, minute: 0 },
            )),
            timezone: "UTC".into(),
            enabled: true,
        })
        .await
        .unwrap();
    make_due(&server.pool, &b.id).await;
    b
}

async fn make_due(pool: &PgPool, workflow: &str) {
    sqlx::query("UPDATE workflow_schedules SET next_run_at = $2 WHERE workflow_id = $1::uuid")
        .bind(workflow)
        .bind(at(DUE))
        .execute(pool)
        .await
        .unwrap();
}

async fn run_count(pool: &PgPool, workflow: &str) -> i64 {
    sqlx::query_scalar("SELECT count(*) FROM workflow_runs WHERE workflow_id = $1::uuid")
        .bind(workflow)
        .fetch_one(pool)
        .await
        .unwrap()
}

async fn status(pool: &PgPool, workflow: &str) -> String {
    sqlx::query_scalar("SELECT status FROM workflows WHERE id = $1::uuid")
        .bind(workflow)
        .fetch_one(pool)
        .await
        .unwrap()
}

async fn setup(pool: PgPool) -> common::TestServer {
    common::engine::seed_model(&pool).await;
    common::spawn(pool).await
}

#[sqlx::test(migrator = "glyph_backend::infrastructure::postgres::migrate::MIGRATOR")]
async fn dispatches_a_due_workflow_and_advances(pool: PgPool) {
    let server = setup(pool).await;
    let b = scheduled(&server).await;
    let d = dispatcher(&server.pool);

    assert_eq!(d.dispatch(at(NOW)).await.unwrap(), 1);
    let (trigger, key, draft): (String, String, bool) = sqlx::query_as(
        "SELECT trigger, schedule_occurrence_key, draft_test FROM workflow_runs WHERE workflow_id = $1::uuid",
    )
    .bind(&b.id)
    .fetch_one(&server.pool)
    .await
    .unwrap();
    assert_eq!(trigger, "scheduled");
    assert_eq!(key, format!("{}:2026-08-04T09:00:00Z", b.id));
    assert!(!draft);

    let (next, last, wf_next): (Timestamp, Timestamp, Timestamp) = sqlx::query_as(
        "SELECT s.next_run_at, s.last_dispatched_at, w.next_run_at
         FROM workflow_schedules s JOIN workflows w ON w.id = s.workflow_id WHERE w.id = $1::uuid",
    )
    .bind(&b.id)
    .fetch_one(&server.pool)
    .await
    .unwrap();
    assert_eq!(next, at("2026-08-05T09:00:00Z"));
    assert_eq!(last, at(NOW));
    assert_eq!(wf_next, next);

    // The run is queued with its execution job in the outbox.
    let jobs: i64 =
        sqlx::query_scalar("SELECT count(*) FROM jobs WHERE kind = 'execute_workflow_run'")
            .fetch_one(&server.pool)
            .await
            .unwrap();
    assert_eq!(jobs, 1);
}

#[sqlx::test(migrator = "glyph_backend::infrastructure::postgres::migrate::MIGRATOR")]
async fn supplies_scheduled_values_by_name(pool: PgPool) {
    let server = setup(pool).await;
    let mut b = scheduled(&server).await;
    let topic = b.workflow_input("topic", true).await;
    let step = b
        .client
        .get_workflow(pb::GetWorkflowRequest { id: b.id.clone() })
        .await
        .unwrap()
        .into_inner()
        .workflow
        .unwrap()
        .steps[0]
        .id
        .clone();
    b.map(&step, "topic", &topic).await;
    b.client
        .set_schedule_value(pb::SetScheduleValueRequest {
            workflow_id: b.id.clone(),
            workflow_input_id: topic,
            value: "nix".into(),
        })
        .await
        .unwrap();
    // Adding a required input parked it; the value fixes it, resume re-activates.
    b.client
        .resume_workflow(pb::ResumeWorkflowRequest { id: b.id.clone() })
        .await
        .unwrap();
    make_due(&server.pool, &b.id).await;

    assert_eq!(dispatcher(&server.pool).dispatch(at(NOW)).await.unwrap(), 1);
    let run = common::engine::runs_client(&server)
        .await
        .list_runs(pb::ListRunsRequest {
            workflow_id: b.id.clone(),
            limit: 1,
            before: None,
        })
        .await
        .unwrap()
        .into_inner()
        .runs
        .remove(0);
    assert_eq!(run.supplied_values["topic"], "nix");
    assert_eq!(run.trigger(), pb::RunTrigger::Scheduled);
}

#[sqlx::test(migrator = "glyph_backend::infrastructure::postgres::migrate::MIGRATOR")]
async fn idempotent_per_occurrence(pool: PgPool) {
    let server = setup(pool).await;
    let b = scheduled(&server).await;
    let d = dispatcher(&server.pool);
    assert_eq!(d.dispatch(at(NOW)).await.unwrap(), 1);
    assert_eq!(d.dispatch(at(NOW)).await.unwrap(), 0);
    // Even if the schedule failed to advance, the occurrence key holds.
    make_due(&server.pool, &b.id).await;
    assert_eq!(d.dispatch(at(NOW)).await.unwrap(), 0);
    assert_eq!(run_count(&server.pool, &b.id).await, 1);
}

#[sqlx::test(migrator = "glyph_backend::infrastructure::postgres::migrate::MIGRATOR")]
async fn skips_inactive_and_not_due(pool: PgPool) {
    let server = setup(pool).await;
    let b = scheduled(&server).await;
    let d = dispatcher(&server.pool);
    for s in ["paused", "needs_attention", "draft"] {
        sqlx::query("UPDATE workflows SET status = $2 WHERE id = $1::uuid")
            .bind(&b.id)
            .bind(s)
            .execute(&server.pool)
            .await
            .unwrap();
        assert_eq!(d.dispatch(at(NOW)).await.unwrap(), 0, "{s}");
    }
    sqlx::query("UPDATE workflows SET status = 'active' WHERE id = $1::uuid")
        .bind(&b.id)
        .execute(&server.pool)
        .await
        .unwrap();
    sqlx::query("UPDATE workflow_schedules SET next_run_at = $2 WHERE workflow_id = $1::uuid")
        .bind(&b.id)
        .bind(at("2026-08-04T10:00:00Z"))
        .execute(&server.pool)
        .await
        .unwrap();
    assert_eq!(d.dispatch(at(NOW)).await.unwrap(), 0);
    assert_eq!(run_count(&server.pool, &b.id).await, 0);
}

#[sqlx::test(migrator = "glyph_backend::infrastructure::postgres::migrate::MIGRATOR")]
async fn invalid_workflows_need_attention(pool: PgPool) {
    let server = setup(pool).await;
    let b = scheduled(&server).await;
    // The model vanishes behind the editor's back.
    sqlx::query("UPDATE available_models SET available = false")
        .execute(&server.pool)
        .await
        .unwrap();
    assert_eq!(dispatcher(&server.pool).dispatch(at(NOW)).await.unwrap(), 0);
    assert_eq!(run_count(&server.pool, &b.id).await, 0);
    assert_eq!(status(&server.pool, &b.id).await, "needs_attention");
    let next: Option<Timestamp> =
        sqlx::query_scalar("SELECT next_run_at FROM workflows WHERE id = $1::uuid")
            .bind(&b.id)
            .fetch_one(&server.pool)
            .await
            .unwrap();
    assert!(next.is_none());
    let issues: serde_json::Value = sqlx::query_scalar(
        "SELECT data->'issues' FROM events WHERE stream = $1 AND event_type = 'WorkflowNeedsAttention'",
    )
    .bind(format!("Workflow${}", b.id))
    .fetch_one(&server.pool)
    .await
    .unwrap();
    assert!(
        issues[0]
            .as_str()
            .unwrap()
            .contains("is no longer available")
    );
}

#[sqlx::test(migrator = "glyph_backend::infrastructure::postgres::migrate::MIGRATOR")]
async fn missing_scheduled_values_need_attention(pool: PgPool) {
    let server = setup(pool).await;
    let b = scheduled(&server).await;
    // A required input without a scheduled value, added directly.
    sqlx::query("INSERT INTO workflow_inputs (workflow_id, name, required) VALUES ($1::uuid, 'topic', true)")
        .bind(&b.id)
        .execute(&server.pool)
        .await
        .unwrap();
    assert_eq!(dispatcher(&server.pool).dispatch(at(NOW)).await.unwrap(), 0);
    assert_eq!(status(&server.pool, &b.id).await, "needs_attention");
}

#[sqlx::test(migrator = "glyph_backend::infrastructure::postgres::migrate::MIGRATOR")]
async fn concurrent_dispatchers_create_one_run(pool: PgPool) {
    let server = setup(pool).await;
    let b = scheduled(&server).await;
    let (d1, d2) = (dispatcher(&server.pool), dispatcher(&server.pool));
    for i in 0..100 {
        sqlx::query("DELETE FROM workflow_runs WHERE workflow_id = $1::uuid")
            .bind(&b.id)
            .execute(&server.pool)
            .await
            .unwrap();
        make_due(&server.pool, &b.id).await;
        let (a, c) = tokio::join!(d1.dispatch(at(NOW)), d2.dispatch(at(NOW)));
        assert_eq!(a.unwrap() + c.unwrap(), 1, "iteration {i}");
        assert_eq!(run_count(&server.pool, &b.id).await, 1, "iteration {i}");
    }
}

#[sqlx::test(migrator = "glyph_backend::infrastructure::postgres::migrate::MIGRATOR")]
async fn recurring_ticks_dedupe(pool: PgPool) {
    let (a, b) = tokio::join!(
        recurring::tick(&pool, "dispatch_due_workflows", "scheduling"),
        recurring::tick(&pool, "dispatch_due_workflows", "scheduling"),
    );
    assert_eq!(u8::from(a.unwrap()) + u8::from(b.unwrap()), 1);
    assert!(
        !recurring::tick(&pool, "dispatch_due_workflows", "scheduling")
            .await
            .unwrap(),
        "pending blocks"
    );
    sqlx::query("UPDATE jobs SET finished_at = now()")
        .execute(&pool)
        .await
        .unwrap();
    assert!(
        recurring::tick(&pool, "dispatch_due_workflows", "scheduling")
            .await
            .unwrap()
    );
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM jobs")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(count, 2);
}

#[sqlx::test(migrator = "glyph_backend::infrastructure::postgres::migrate::MIGRATOR")]
async fn two_tickers_enqueue_once_per_interval(pool: PgPool) {
    use tokio_util::sync::CancellationToken;
    let stop = CancellationToken::new();
    let every = std::time::Duration::from_millis(300);
    let spec = || recurring::Recurring {
        kind: "tick".into(),
        queue: "q".into(),
        every,
    };
    let t1 = recurring::spawn(pool.clone(), spec(), stop.clone());
    let t2 = recurring::spawn(pool.clone(), spec(), stop.clone());
    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    // Nobody works the queue: every later tick sees the pending job.
    tokio::time::sleep(every * 3).await;
    stop.cancel();
    let _ = tokio::join!(t1, t2);
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM jobs WHERE kind = 'tick'")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(count, 1);
}
