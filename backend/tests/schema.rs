//! Database constraints translated from the Rails schema.
use glyph_backend::infrastructure::postgres::migrate;
use sqlx::PgPool;
use uuid::Uuid;

async fn workflow(pool: &PgPool) -> Uuid {
    sqlx::query_scalar("INSERT INTO workflows (name) VALUES ('w') RETURNING id")
        .fetch_one(pool)
        .await
        .unwrap()
}

async fn step(pool: &PgPool, wf: Uuid) -> Uuid {
    sqlx::query_scalar("INSERT INTO workflow_steps (workflow_id) VALUES ($1) RETURNING id")
        .bind(wf)
        .fetch_one(pool)
        .await
        .unwrap()
}

async fn step_input(pool: &PgPool, step: Uuid, name: &str) -> Result<Uuid, sqlx::Error> {
    sqlx::query_scalar(
        "INSERT INTO step_inputs (workflow_step_id, name) VALUES ($1, $2) RETURNING id",
    )
    .bind(step)
    .bind(name)
    .fetch_one(pool)
    .await
}

#[sqlx::test(migrator = "glyph_backend::infrastructure::postgres::migrate::MIGRATOR")]
async fn migrations_are_idempotent(pool: PgPool) {
    migrate::run(&pool).await.unwrap();
    let tools: i64 = sqlx::query_scalar("SELECT count(*) FROM tool_definitions WHERE enabled")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(tools, 4);
}

#[sqlx::test(migrator = "glyph_backend::infrastructure::postgres::migrate::MIGRATOR")]
async fn connections_reject_self_edges(pool: PgPool) {
    let wf = workflow(&pool).await;
    let s = step(&pool, wf).await;
    let input = step_input(&pool, s, "x").await.unwrap();
    let err = sqlx::query(
        "INSERT INTO workflow_connections (workflow_id, source_step_id, source_output_name, destination_step_id, destination_input_id)
         VALUES ($1, $2, 'out', $2, $3)",
    )
    .bind(wf)
    .bind(s)
    .bind(input)
    .execute(&pool)
    .await
    .unwrap_err();
    assert!(
        err.to_string()
            .contains("workflow_connections_no_self_edge"),
        "{err}"
    );
}

#[sqlx::test(migrator = "glyph_backend::infrastructure::postgres::migrate::MIGRATOR")]
async fn step_input_names_are_unique_case_insensitively(pool: PgPool) {
    let wf = workflow(&pool).await;
    let s = step(&pool, wf).await;
    step_input(&pool, s, "Topic").await.unwrap();
    let err = step_input(&pool, s, "topic").await.unwrap_err();
    assert!(err.to_string().contains("lower_name"), "{err}");
}

#[sqlx::test(migrator = "glyph_backend::infrastructure::postgres::migrate::MIGRATOR")]
async fn workflow_input_names_are_unique_case_insensitively(pool: PgPool) {
    let wf = workflow(&pool).await;
    let insert = |name: &'static str| {
        sqlx::query("INSERT INTO workflow_inputs (workflow_id, name) VALUES ($1, $2)")
            .bind(wf)
            .bind(name)
            .execute(&pool)
    };
    insert("Topic").await.unwrap();
    assert!(insert("TOPIC").await.is_err());
}

#[sqlx::test(migrator = "glyph_backend::infrastructure::postgres::migrate::MIGRATOR")]
async fn occurrence_keys_are_unique(pool: PgPool) {
    let wf = workflow(&pool).await;
    let insert = || {
        sqlx::query(
            "INSERT INTO workflow_runs (workflow_id, trigger, snapshot, schedule_occurrence_key)
             VALUES ($1, 'scheduled', '{}', 'k')",
        )
        .bind(wf)
        .execute(&pool)
    };
    insert().await.unwrap();
    let err = insert().await.unwrap_err();
    assert!(err.to_string().contains("schedule_occurrence_key"), "{err}");
    // NULL keys (manual runs) never collide.
    for _ in 0..2 {
        sqlx::query("INSERT INTO workflow_runs (workflow_id, trigger, snapshot) VALUES ($1, 'manual', '{}')")
            .bind(wf)
            .execute(&pool)
            .await
            .unwrap();
    }
}

#[sqlx::test(migrator = "glyph_backend::infrastructure::postgres::migrate::MIGRATOR")]
async fn run_with_first_failed_step_run_deletes_cleanly(pool: PgPool) {
    let wf = workflow(&pool).await;
    let run: Uuid = sqlx::query_scalar(
        "INSERT INTO workflow_runs (workflow_id, trigger, snapshot) VALUES ($1, 'manual', '{}') RETURNING id",
    )
    .bind(wf)
    .fetch_one(&pool)
    .await
    .unwrap();
    let step_run: Uuid = sqlx::query_scalar(
        "INSERT INTO step_runs (workflow_run_id, snapshot_step_id) VALUES ($1, gen_random_uuid()) RETURNING id",
    )
    .bind(run)
    .fetch_one(&pool)
    .await
    .unwrap();
    sqlx::query("UPDATE workflow_runs SET first_failed_step_run_id = $1 WHERE id = $2")
        .bind(step_run)
        .bind(run)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("DELETE FROM workflow_runs WHERE id = $1")
        .bind(run)
        .execute(&pool)
        .await
        .unwrap();
    let left: i64 = sqlx::query_scalar("SELECT count(*) FROM step_runs")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(left, 0);
}
