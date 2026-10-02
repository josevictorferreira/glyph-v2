//! Run engine end-to-end through the real job worker (ports engine_spec,
//! run_creator_spec, run_stop_spec, step_retry_spec, workflow_runs request spec).
mod common;

use axum::body::Body;
use base64::Engine;
use common::engine::*;
use glyph_backend::proto::pb;
use glyph_backend::proto::status::{error_info, validation_issues};
use http_body_util::BodyExt;
use serde_json::json;
use sqlx::PgPool;
use tonic::Code;
use tower::ServiceExt;

#[sqlx::test(migrator = "glyph_backend::infrastructure::postgres::migrate::MIGRATOR")]
async fn linear_chain_passes_output_downstream(pool: PgPool) {
    let runner = ScriptedRunner::new(&[("A", ok("alpha output")), ("B", ok("beta output"))]);
    let server = server(pool, runner.clone()).await;
    let mut b = Builder::new(&server, "Linear", false).await;
    let a = b.pi("A").await;
    let bb = b.pi("B").await;
    b.connect(&a, &bb, "in").await;

    let queued = start(&server, &b.id, &[]).await;
    assert_eq!(queued.status(), pb::RunStatus::Queued);
    assert!(queued.draft_test, "manual runs of a draft are tests");
    assert_eq!(queued.step_runs.len(), 2);

    let run = settle(&server, &b.id, &queued.id).await;
    assert_eq!(run.status(), pb::RunStatus::Succeeded);
    assert!(run.ended_at.is_some() && run.elapsed_ms.is_some());
    assert_eq!(step(&run, "A").status(), pb::StepRunStatus::Succeeded);
    assert_eq!(runner.calls_for("B")[0]["in"], json!("alpha output"));
    let detail = step_detail(&server, &run, "B").await;
    let input = &detail.resolved_inputs[0];
    assert_eq!(input.name, "in");
    assert_eq!(input.source.as_ref().unwrap().label, "Output from A");
    assert_eq!(detail.output_text.as_deref(), Some("beta output"));
    assert_eq!(detail.messages[0].text, "beta output");
    assert!(detail.download_path.ends_with("/download"));

    // Events: full lifecycle, all correlated to the run.
    let types = run_events(&server.pool, &run.id).await;
    assert_eq!(
        &types[..3],
        &["StepRunQueued", "StepRunQueued", "WorkflowRunQueued"]
    );
    for t in [
        "WorkflowRunStarted",
        "StepRunStarted",
        "StepRunSucceeded",
        "WorkflowRunSucceeded",
    ] {
        assert!(types.contains(&t.to_string()), "{t} missing in {types:?}");
    }
    let uncorrelated: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM events WHERE stream = $1 AND correlation_id IS DISTINCT FROM $2::uuid",
    )
    .bind(format!("WorkflowRun${}", run.id))
    .bind(run.id.parse::<uuid::Uuid>().unwrap())
    .fetch_one(&server.pool)
    .await
    .unwrap();
    assert_eq!(uncorrelated, 0);

    // Workflow last-run pointers follow the run.
    let (status, at): (Option<String>, Option<chrono::DateTime<chrono::Utc>>) =
        sqlx::query_as("SELECT last_run_status, last_run_at FROM workflows WHERE id = $1::uuid")
            .bind(&b.id)
            .fetch_one(&server.pool)
            .await
            .unwrap();
    assert_eq!(status.as_deref(), Some("succeeded"));
    assert!(at.is_some());

    // Every job ran exactly once.
    let unfinished: i64 = sqlx::query_scalar("SELECT count(*) FROM jobs WHERE finished_at IS NULL")
        .fetch_one(&server.pool)
        .await
        .unwrap();
    assert_eq!(unfinished, 0);
    let errored: Vec<Option<String>> =
        sqlx::query_scalar("SELECT error FROM jobs WHERE error IS NOT NULL")
            .fetch_all(&server.pool)
            .await
            .unwrap();
    assert!(errored.is_empty(), "{errored:?}");
}

#[sqlx::test(migrator = "glyph_backend::infrastructure::postgres::migrate::MIGRATOR")]
async fn diamond_and_fan_out(pool: PgPool) {
    let runner = ScriptedRunner::new(&[]);
    let server = server(pool, runner.clone()).await;
    let mut b = Builder::new(&server, "Diamond", false).await;
    let ctx = b.pi("Context").await;
    let g1 = b.pi("Gen1").await;
    let g2 = b.pi("Gen2").await;
    let g3 = b.pi("Gen3").await;
    let join = b.pi("Join").await;
    for g in [&g1, &g2, &g3] {
        b.connect(&ctx, g, "ctx").await;
    }
    b.connect(&g1, &join, "one").await;
    b.connect(&g2, &join, "two").await;
    b.connect(&g3, &join, "three").await;

    let run = settle(&server, &b.id, &start(&server, &b.id, &[]).await.id).await;
    assert_eq!(run.status(), pb::RunStatus::Succeeded);
    assert!(
        run.step_runs
            .iter()
            .all(|s| s.status() == pb::StepRunStatus::Succeeded)
    );
    assert_eq!(runner.call_count(), 5);
    let join_inputs = &runner.calls_for("Join")[0];
    assert_eq!(join_inputs["one"], json!("Gen1 output"));
    assert_eq!(join_inputs["three"], json!("Gen3 output"));
}

#[sqlx::test(migrator = "glyph_backend::infrastructure::postgres::migrate::MIGRATOR")]
async fn failure_skips_only_descendants(pool: PgPool) {
    let runner = ScriptedRunner::new(&[("A", Script::Fail), ("X", ok("independent"))]);
    let server = server(pool, runner.clone()).await;
    let mut b = Builder::new(&server, "Failing", false).await;
    let a = b.pi("A").await;
    let c = b.pi("C").await;
    let d = b.pi("D").await;
    b.pi("X").await;
    b.connect(&a, &c, "in").await;
    b.connect(&c, &d, "in").await;

    let run = settle(&server, &b.id, &start(&server, &b.id, &[]).await.id).await;
    assert_eq!(run.status(), pb::RunStatus::Failed);
    assert_eq!(
        run.first_failed_step_run_id.as_deref(),
        Some(step(&run, "A").id.as_str())
    );
    assert_eq!(
        run.failure_summary.as_deref(),
        Some(
            "The A step could not complete: The selected model or provider could not complete the step."
        )
    );
    for name in ["C", "D"] {
        let s = step(&run, name);
        assert_eq!(s.status(), pb::StepRunStatus::Skipped);
        assert_eq!(
            s.skipped_reason.as_deref(),
            Some("Did not run because “A” did not complete.")
        );
    }
    assert_eq!(step(&run, "X").status(), pb::StepRunStatus::Succeeded);
    let failed = step_detail(&server, &run, "A").await;
    assert_eq!(failed.technical_error.as_deref(), Some("provider said no"));
    assert_eq!(failed.summary.unwrap().elapsed_ms, Some(42));
    assert!(runner.calls_for("C").is_empty());

    let types = run_events(&server.pool, &run.id).await;
    for t in ["StepRunFailed", "StepRunSkipped", "WorkflowRunFailed"] {
        assert!(types.contains(&t.to_string()), "{t} missing");
    }
}

#[sqlx::test(migrator = "glyph_backend::infrastructure::postgres::migrate::MIGRATOR")]
async fn allow_failure_unblocks_dependents(pool: PgPool) {
    let runner = ScriptedRunner::new(&[("A", Script::Fail), ("B", ok("made it anyway"))]);
    let server = server(pool, runner.clone()).await;
    let mut b = Builder::new(&server, "Tolerant", false).await;
    let a = b.pi("A").await;
    b.allow_failure(&a, "A").await;
    let bb = b.pi("B").await;
    b.connect(&a, &bb, "in").await;

    let run = settle(&server, &b.id, &start(&server, &b.id, &[]).await.id).await;
    assert_eq!(run.status(), pb::RunStatus::Succeeded);
    assert_eq!(step(&run, "A").status(), pb::StepRunStatus::Failed);
    assert!(step(&run, "A").allow_failure);
    assert_eq!(runner.calls_for("B")[0]["in"], serde_json::Value::Null);
    let detail = step_detail(&server, &run, "B").await;
    assert!(
        detail.resolved_inputs[0]
            .source
            .as_ref()
            .unwrap()
            .label
            .contains("failed — continuing without it")
    );
}

#[sqlx::test(migrator = "glyph_backend::infrastructure::postgres::migrate::MIGRATOR")]
async fn optional_failure_plus_real_failure_fails_the_run(pool: PgPool) {
    let runner = ScriptedRunner::new(&[("A", Script::Fail), ("X", Script::SlowFail(50))]);
    let server = server(pool, runner.clone()).await;
    let mut b = Builder::new(&server, "Mixed", false).await;
    let a = b.pi("A").await;
    b.allow_failure(&a, "A").await;
    b.pi("X").await;
    let run = settle(&server, &b.id, &start(&server, &b.id, &[]).await.id).await;
    assert_eq!(run.status(), pb::RunStatus::Failed);
    assert_eq!(
        run.first_failed_step_run_id.as_deref(),
        Some(step(&run, "X").id.as_str())
    );
}

#[sqlx::test(migrator = "glyph_backend::infrastructure::postgres::migrate::MIGRATOR")]
async fn fail_fast_cancels_and_late_results_do_not_overwrite(pool: PgPool) {
    let runner = ScriptedRunner::new(&[
        ("A", Script::SlowFail(150)),
        ("B", Script::Slow(600, "late".into())),
    ]);
    let server = server(pool, runner.clone()).await;
    let mut b = Builder::new(&server, "FailFast", true).await;
    let a = b.pi("A").await;
    b.pi("B").await;
    let c = b.pi("C").await;
    b.connect(&a, &c, "in").await;

    let run = settle(&server, &b.id, &start(&server, &b.id, &[]).await.id).await;
    // B was running when A failed: cancelled, and its late success is discarded.
    tokio::time::sleep(std::time::Duration::from_millis(700)).await;
    let run = get(&server, &b.id, &run.id).await;
    assert_eq!(run.status(), pb::RunStatus::Failed);
    assert_eq!(step(&run, "A").status(), pb::StepRunStatus::Failed);
    assert_eq!(step(&run, "B").status(), pb::StepRunStatus::Cancelled);
    assert_eq!(step(&run, "C").status(), pb::StepRunStatus::Cancelled);
    let detail = step_detail(&server, &run, "B").await;
    assert!(detail.output_text.is_none());
    let reason: String = sqlx::query_scalar(
        "SELECT data->>'reason' FROM events WHERE event_type = 'StepRunCancelled' LIMIT 1",
    )
    .fetch_one(&server.pool)
    .await
    .unwrap();
    assert_eq!(reason, "Cancelled because “A” failed.");
}

#[sqlx::test(migrator = "glyph_backend::infrastructure::postgres::migrate::MIGRATOR")]
async fn helpers_fan_out_values_without_pi(pool: PgPool) {
    let runner = ScriptedRunner::new(&[]);
    let server = server(pool, runner.clone()).await;
    let mut b = Builder::new(&server, "Helpers", false).await;
    let topic = b.workflow_input("topic", true).await;
    let audience = b.workflow_input("audience", true).await;
    let gather = b.helper("Gather").await;
    b.map(&gather, "topic", &topic).await;
    b.map(&gather, "audience", &audience).await;
    let pb_ = b.pi("B").await;
    let pc = b.pi("C").await;
    b.connect(&gather, &pb_, "ctx").await;
    b.connect(&gather, &pc, "ctx").await;

    let run = start(
        &server,
        &b.id,
        &[("topic", "Nix"), ("audience", "Rails developers")],
    )
    .await;
    let run = settle(&server, &b.id, &run.id).await;
    assert_eq!(run.status(), pb::RunStatus::Succeeded);
    let expected = json!({ "topic": "Nix", "audience": "Rails developers" });
    assert_eq!(
        serde_json::Value::Object(runner.calls_for("B")[0]["ctx"].as_object().unwrap().clone()),
        expected
    );
    assert_eq!(runner.calls_for("C")[0]["ctx"], expected);
    assert_eq!(runner.call_count(), 2, "pi never runs for the helper");

    let helper = step_detail(&server, &run, "Gather").await;
    let s = helper.summary.as_ref().unwrap();
    assert_eq!(s.step_kind(), pb::StepKind::Helper);
    assert!(s.has_output && s.started_at.is_some() && s.elapsed_ms.is_some());
    assert!(
        helper.output_text.is_none()
            && helper.messages.is_empty()
            && helper.technical_error.is_none()
    );
    let source = helper.resolved_inputs[0].source.as_ref().unwrap();
    assert_eq!(source.kind(), pb::InputSourceKind::WorkflowValue);
    assert_eq!(source.label, "Workflow value “topic”");

    // Download: helper output as pretty JSON.
    let response = server
        .router
        .clone()
        .oneshot(
            axum::http::Request::get(&helper.download_path)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    assert_eq!(
        response.headers()["content-type"],
        "application/json; charset=utf-8"
    );
    assert!(
        response.headers()["content-disposition"]
            .to_str()
            .unwrap()
            .contains("filename=\"gather.json\"")
    );
    let body = response.into_body().collect().await.unwrap().to_bytes();
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&body).unwrap(),
        expected
    );

    // Supplied values are encrypted at rest.
    let raw: Vec<u8> = sqlx::query_scalar("SELECT supplied_values FROM workflow_runs")
        .fetch_one(&server.pool)
        .await
        .unwrap();
    assert!(!String::from_utf8_lossy(&raw).contains("Rails developers"));
    assert_eq!(run.supplied_values["topic"], "Nix");
}

#[sqlx::test(migrator = "glyph_backend::infrastructure::postgres::migrate::MIGRATOR")]
async fn helper_skipped_when_upstream_fails(pool: PgPool) {
    let runner = ScriptedRunner::new(&[("A", Script::Fail)]);
    let server = server(pool, runner.clone()).await;
    let mut b = Builder::new(&server, "HelperSkip", false).await;
    let a = b.pi("A").await;
    b.pi("X").await;
    let gather = b.helper("Gather").await;
    b.connect(&a, &gather, "facts").await;
    let d = b.pi("D").await;
    b.connect(&gather, &d, "ctx").await;
    let run = settle(&server, &b.id, &start(&server, &b.id, &[]).await.id).await;
    assert_eq!(run.status(), pb::RunStatus::Failed);
    assert_eq!(step(&run, "Gather").status(), pb::StepRunStatus::Skipped);
    assert_eq!(step(&run, "D").status(), pb::StepRunStatus::Skipped);
    assert_eq!(step(&run, "X").status(), pb::StepRunStatus::Succeeded);
    assert_eq!(runner.call_count(), 2);
}

#[sqlx::test(migrator = "glyph_backend::infrastructure::postgres::migrate::MIGRATOR")]
async fn missing_required_input_skips_the_step(pool: PgPool) {
    let runner = ScriptedRunner::new(&[]);
    let server = server(pool, runner.clone()).await;
    let mut b = Builder::new(&server, "Missing", false).await;
    let optional = b.workflow_input("notes", false).await;
    let a = b.pi("A").await;
    b.map(&a, "notes", &optional).await;
    let run = settle(&server, &b.id, &start(&server, &b.id, &[]).await.id).await;
    let a = step(&run, "A");
    assert_eq!(a.status(), pb::StepRunStatus::Skipped);
    assert_eq!(
        a.skipped_reason.as_deref(),
        Some("A required input was unavailable: Required input “notes” has no value")
    );
    assert_eq!(run.status(), pb::RunStatus::Succeeded);
    assert_eq!(runner.call_count(), 0);
}

#[sqlx::test(migrator = "glyph_backend::infrastructure::postgres::migrate::MIGRATOR")]
async fn start_run_preconditions(pool: PgPool) {
    let runner = ScriptedRunner::new(&[]);
    let server = server(pool, runner).await;
    let mut b = Builder::new(&server, "Pre", false).await;
    let mut client = runs_client(&server).await;

    // Invalid workflow.
    let err = client
        .start_run(pb::StartRunRequest {
            workflow_id: b.id.clone(),
            values: Default::default(),
        })
        .await
        .unwrap_err();
    assert_eq!(err.code(), Code::FailedPrecondition);
    assert_eq!(error_info(&err).unwrap().reason, "VALIDATION_FAILED");
    assert_eq!(
        err.message(),
        "This workflow cannot run yet: Add at least one step before the workflow can run."
    );

    // Missing values.
    let a = b.pi("A").await;
    let topic = b.workflow_input("topic", true).await;
    b.map(&a, "topic", &topic).await;
    let err = client
        .start_run(pb::StartRunRequest {
            workflow_id: b.id.clone(),
            values: Default::default(),
        })
        .await
        .unwrap_err();
    assert_eq!(error_info(&err).unwrap().reason, "MISSING_VALUES");
    assert!(
        validation_issues(&err)
            .iter()
            .any(|i| i.message == "Provide a value for “topic” to start the run.")
    );
    let blank = client
        .start_run(pb::StartRunRequest {
            workflow_id: b.id.clone(),
            values: [("topic".to_string(), "  ".to_string())].into(),
        })
        .await
        .unwrap_err();
    assert_eq!(error_info(&blank).unwrap().reason, "MISSING_VALUES");

    // Nothing was written by the refused attempts: no runs, no jobs.
    let (runs, jobs): (i64, i64) = sqlx::query_as(
        "SELECT (SELECT count(*) FROM workflow_runs), (SELECT count(*) FROM jobs WHERE kind LIKE 'execute_%')",
    )
        .fetch_one(&server.pool)
        .await
        .unwrap();
    assert_eq!((runs, jobs), (0, 0));

    let run = start(&server, &b.id, &[("topic", "# FEATURES\n\nBuild a thing.")]).await;
    assert_eq!(run.supplied_values["topic"], "# FEATURES\n\nBuild a thing.");
    assert_eq!(run.trigger(), pb::RunTrigger::Manual);
    let snapshot = run.snapshot.unwrap();
    assert_eq!(snapshot.version, 3);
    assert_eq!(snapshot.steps[0].name, "A");
}

#[sqlx::test(migrator = "glyph_backend::infrastructure::postgres::migrate::MIGRATOR")]
async fn snapshot_is_immutable(pool: PgPool) {
    let runner = ScriptedRunner::new(&[("A", Script::Slow(200, "x".into()))]);
    let server = server(pool, runner).await;
    let mut b = Builder::new(&server, "Frozen", false).await;
    let a = b.pi("A").await;
    let run = start(&server, &b.id, &[]).await;
    b.client
        .update_step_details(pb::UpdateStepDetailsRequest {
            workflow_id: b.id.clone(),
            step_id: a,
            name: "Edited".into(),
            description: None,
            allow_failure: false,
        })
        .await
        .unwrap();
    let run = settle(&server, &b.id, &run.id).await;
    assert_eq!(run.snapshot.as_ref().unwrap().steps[0].name, "A");
    assert_eq!(step(&run, "A").step_name, "A");
}

#[sqlx::test(migrator = "glyph_backend::infrastructure::postgres::migrate::MIGRATOR")]
async fn stop_retry_delete(pool: PgPool) {
    let runner = ScriptedRunner::new(&[("A", Script::Slow(300, "a".into()))]);
    let server = server(pool, runner.clone()).await;
    let mut b = Builder::new(&server, "Ops", false).await;
    let a = b.pi("A").await;
    let bb = b.pi("B").await;
    b.connect(&a, &bb, "in").await;
    let mut client = runs_client(&server).await;

    // Stop while A is running: B skipped, A finishes with its real outcome.
    let run = start(&server, &b.id, &[]).await;
    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    let stopped = client
        .stop_run(pb::StopRunRequest {
            workflow_id: b.id.clone(),
            run_id: run.id.clone(),
        })
        .await
        .unwrap()
        .into_inner()
        .run
        .unwrap();
    assert_eq!(stopped.status(), pb::RunStatus::Cancelled);
    assert!(stopped.ended_at.is_some() && stopped.elapsed_ms.is_some());
    assert_eq!(step(&stopped, "B").status(), pb::StepRunStatus::Skipped);
    assert_eq!(
        step(&stopped, "B").skipped_reason.as_deref(),
        Some("Cancelled by user.")
    );
    let run = settle(&server, &b.id, &run.id).await;
    assert_eq!(
        run.status(),
        pb::RunStatus::Cancelled,
        "a late step never revives a stopped run"
    );
    assert_eq!(step(&run, "A").status(), pb::StepRunStatus::Succeeded);
    let err = client
        .stop_run(pb::StopRunRequest {
            workflow_id: b.id.clone(),
            run_id: run.id.clone(),
        })
        .await
        .unwrap_err();
    assert_eq!(err.message(), "The run has already finished.");
    assert!(
        run_events(&server.pool, &run.id)
            .await
            .contains(&"WorkflowRunCancelled".to_string())
    );

    // Retry: a failed FA is requeued with its skipped FB; the run revives.
    let mut f = Builder::new(&server, "Retry", false).await;
    let fa = f.pi("FA").await;
    let fb = f.pi("FB").await;
    f.pi("FX").await;
    f.connect(&fa, &fb, "in").await;
    // Run once, then rewrite the outcome as "FA failed, FB skipped".
    let run = settle(&server, &f.id, &start(&server, &f.id, &[]).await.id).await;
    assert_eq!(run.status(), pb::RunStatus::Succeeded);
    let fa_run = step(&run, "FA").id.clone();
    let not_failed = client
        .retry_step(pb::RetryStepRequest {
            workflow_id: f.id.clone(),
            run_id: run.id.clone(),
            step_run_id: fa_run.clone(),
        })
        .await
        .unwrap_err();
    assert_eq!(not_failed.message(), "Only failed steps can be retried.");
    sqlx::query("UPDATE step_runs SET status = 'failed', human_error = 'Model error', technical_error = NULL WHERE id = $1::uuid")
        .bind(&fa_run)
        .execute(&server.pool)
        .await
        .unwrap();
    sqlx::query(
        "UPDATE step_runs SET status = 'skipped', skipped_reason = 'x' WHERE id = $1::uuid",
    )
    .bind(&step(&run, "FB").id)
    .execute(&server.pool)
    .await
    .unwrap();
    sqlx::query("UPDATE workflow_runs SET status = 'failed', first_failed_step_run_id = $2::uuid, failure_summary = 'FA failed' WHERE id = $1::uuid")
        .bind(&run.id)
        .bind(&fa_run)
        .execute(&server.pool)
        .await
        .unwrap();
    let missing = client
        .retry_step(pb::RetryStepRequest {
            workflow_id: f.id.clone(),
            run_id: run.id.clone(),
            step_run_id: uuid::Uuid::new_v4().to_string(),
        })
        .await
        .unwrap_err();
    assert_eq!(missing.message(), "Step run not found.");
    let retried = client
        .retry_step(pb::RetryStepRequest {
            workflow_id: f.id.clone(),
            run_id: run.id.clone(),
            step_run_id: fa_run.clone(),
        })
        .await
        .unwrap()
        .into_inner()
        .run
        .unwrap();
    assert!(retried.failure_summary.is_none() && retried.first_failed_step_run_id.is_none());
    let run = settle(&server, &f.id, &run.id).await;
    assert_eq!(run.status(), pb::RunStatus::Succeeded);
    assert_eq!(step(&run, "FB").status(), pb::StepRunStatus::Succeeded);
    assert_eq!(runner.calls_for("FA").len(), 2);

    // Retry refused while the run is live.
    let slow = start(&server, &b.id, &[]).await;
    sqlx::query("UPDATE step_runs SET status = 'failed' WHERE workflow_run_id = $1::uuid AND step_name = 'B'")
        .bind(&slow.id)
        .execute(&server.pool)
        .await
        .unwrap();
    let live = client
        .retry_step(pb::RetryStepRequest {
            workflow_id: b.id.clone(),
            run_id: slow.id.clone(),
            step_run_id: step(&slow, "B").id.clone(),
        })
        .await
        .unwrap_err();
    assert_eq!(
        live.message(),
        "The run must be finished before retrying a step."
    );
    settle(&server, &b.id, &slow.id).await;

    // Delete (with first_failed_step_run_id set) cascades.
    sqlx::query("UPDATE workflow_runs SET first_failed_step_run_id = (SELECT id FROM step_runs WHERE workflow_run_id = $1::uuid LIMIT 1) WHERE id = $1::uuid")
        .bind(&run.id)
        .execute(&server.pool)
        .await
        .unwrap();
    client
        .delete_run(pb::DeleteRunRequest {
            workflow_id: f.id.clone(),
            run_id: run.id.clone(),
        })
        .await
        .unwrap();
    let left: i64 =
        sqlx::query_scalar("SELECT count(*) FROM step_runs WHERE workflow_run_id = $1::uuid")
            .bind(&run.id)
            .fetch_one(&server.pool)
            .await
            .unwrap();
    assert_eq!(left, 0);
    let gone = client
        .get_run(pb::GetRunRequest {
            workflow_id: f.id.clone(),
            run_id: run.id.clone(),
        })
        .await
        .unwrap_err();
    assert_eq!(gone.code(), Code::NotFound);

    // ListRuns newest first.
    let listed = client
        .list_runs(pb::ListRunsRequest {
            workflow_id: b.id.clone(),
            limit: 0,
            before: None,
        })
        .await
        .unwrap()
        .into_inner()
        .runs;
    assert_eq!(listed.len(), 2);
    assert!(
        listed[0].created_at.as_ref().unwrap().seconds
            >= listed[1].created_at.as_ref().unwrap().seconds
    );
    assert!(listed[0].step_runs.is_empty());
}

async fn http(server: &common::TestServer, path: &str) -> axum::response::Response {
    server
        .router
        .clone()
        .oneshot(axum::http::Request::get(path).body(Body::empty()).unwrap())
        .await
        .unwrap()
}

#[sqlx::test(migrator = "glyph_backend::infrastructure::postgres::migrate::MIGRATOR")]
async fn downloads_and_preview(pool: PgPool) {
    let runner = ScriptedRunner::new(&[
        ("Page", ok("<html><body>Hi</body></html>")),
        ("Data", ok("{\"a\":1}")),
        (
            "Archive",
            ok(&base64::engine::general_purpose::STANDARD.encode(b"PK\x03\x04\0\0\0\0")),
        ),
        ("Broken", ok("not base64!!")),
        ("Notes", ok("# Hello")),
    ]);
    let server = server(pool, runner).await;
    let mut b = Builder::new(&server, "Files", false).await;
    let page = b.pi("Page").await;
    b.format(&page, "Page", pb::OutputFileFormat::Html).await;
    let data = b.pi("Data").await;
    b.format(&data, "Data", pb::OutputFileFormat::Json).await;
    let archive = b.pi("Archive").await;
    b.format(&archive, "Archive", pb::OutputFileFormat::Zip)
        .await;
    let broken = b.pi("Broken").await;
    b.format(&broken, "Broken", pb::OutputFileFormat::Zip).await;
    b.pi("Notes").await;
    let run = settle(&server, &b.id, &start(&server, &b.id, &[]).await.id).await;

    let path = |name: &str, action: &str| {
        format!(
            "/workflows/{}/runs/{}/step_runs/{}/{action}",
            b.id,
            run.id,
            step(&run, name).id
        )
    };

    let r = http(&server, &path("Notes", "download")).await;
    assert_eq!(r.status(), 200);
    assert_eq!(r.headers()["content-type"], "text/markdown; charset=utf-8");
    assert!(
        r.headers()["content-disposition"]
            .to_str()
            .unwrap()
            .contains("attachment; filename=\"notes.md\"")
    );
    assert_eq!(r.headers()["x-content-type-options"], "nosniff");
    assert_eq!(
        &r.into_body().collect().await.unwrap().to_bytes()[..],
        b"# Hello"
    );

    let r = http(&server, &path("Page", "download")).await;
    assert_eq!(r.headers()["content-type"], "text/html; charset=utf-8");
    let r = http(&server, &path("Data", "download")).await;
    assert_eq!(
        r.headers()["content-type"],
        "application/json; charset=utf-8"
    );
    let r = http(&server, &path("Archive", "download")).await;
    assert_eq!(r.headers()["content-type"], "application/zip");
    assert!(
        r.headers()["content-disposition"]
            .to_str()
            .unwrap()
            .contains("archive.zip")
    );
    assert_eq!(
        &r.into_body().collect().await.unwrap().to_bytes()[..],
        b"PK\x03\x04\0\0\0\0"
    );
    assert_eq!(
        http(&server, &path("Broken", "download")).await.status(),
        404
    );

    let r = http(&server, &path("Page", "preview")).await;
    assert_eq!(r.status(), 200);
    assert_eq!(r.headers()["content-type"], "text/html; charset=utf-8");
    assert!(
        r.headers()["content-security-policy"]
            .to_str()
            .unwrap()
            .contains("default-src 'none'")
    );
    assert_eq!(r.headers()["x-content-type-options"], "nosniff");
    assert_eq!(http(&server, &path("Data", "preview")).await.status(), 404);

    // Step run from another run / unknown ids → 404.
    let other = format!(
        "/workflows/{}/runs/{}/step_runs/{}/download",
        b.id,
        uuid::Uuid::new_v4(),
        step(&run, "Notes").id
    );
    assert_eq!(http(&server, &other).await.status(), 404);
    assert_eq!(
        http(&server, "/workflows/x/runs/y/step_runs/z/download")
            .await
            .status(),
        404
    );

    // Evidence is encrypted at rest.
    let raw: Vec<u8> =
        sqlx::query_scalar("SELECT output_text FROM step_runs WHERE step_name = 'Notes'")
            .fetch_one(&server.pool)
            .await
            .unwrap();
    assert!(!String::from_utf8_lossy(&raw).contains("# Hello"));
}

#[sqlx::test(migrator = "glyph_backend::infrastructure::postgres::migrate::MIGRATOR")]
async fn duplicate_deliveries_are_no_ops(pool: PgPool) {
    use glyph_backend::features::runs::RunService;
    use glyph_backend::infrastructure::crypto::AesGcmCipher;
    use glyph_backend::infrastructure::postgres::PgStore;
    use glyph_backend::shared::time::SystemClock;
    use std::sync::Arc;

    let runner = ScriptedRunner::new(&[]);
    let server = server(pool.clone(), runner.clone()).await;
    let mut b = Builder::new(&server, "Once", false).await;
    b.pi("A").await;
    let run = settle(&server, &b.id, &start(&server, &b.id, &[]).await.id).await;
    assert_eq!(runner.call_count(), 1);

    let store = Arc::new(PgStore::new(pool, Arc::new(AesGcmCipher::dev())));
    let service = RunService::new(store.clone(), store, runner.clone(), Arc::new(SystemClock));
    service
        .execute_step(step(&run, "A").id.parse().unwrap())
        .await
        .unwrap();
    service.execute_run(run.id.parse().unwrap()).await.unwrap();
    assert_eq!(runner.call_count(), 1);
    let succeeded = run_events(&server.pool, &run.id)
        .await
        .iter()
        .filter(|t| *t == "StepRunSucceeded")
        .count();
    assert_eq!(succeeded, 1);
}

#[derive(Clone, Default)]
struct LogBuffer(std::sync::Arc<std::sync::Mutex<Vec<u8>>>);

impl std::io::Write for LogBuffer {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        self.0.lock().unwrap().extend_from_slice(buf);
        Ok(buf.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

#[sqlx::test(migrator = "glyph_backend::infrastructure::postgres::migrate::MIGRATOR")]
async fn engine_runs_real_pi_runner_without_leaking_keys(pool: PgPool) {
    use glyph_backend::app::bootstrap::Overrides;
    use glyph_backend::infrastructure::crypto::AesGcmCipher;
    use glyph_backend::infrastructure::pi::runner::{PiConfig, PiStepRunner};
    use glyph_backend::infrastructure::postgres::PgStore;
    use glyph_backend::shared::redactor::Redactor;
    use secrecy::SecretString;
    use std::sync::Arc;

    let key = "sk-live-9f8e7d6c5b4a3210";
    let buffer = LogBuffer::default();
    let writer = buffer.clone();
    let subscriber = tracing_subscriber::fmt()
        .with_max_level(tracing::Level::TRACE)
        .with_writer(move || writer.clone())
        .finish();
    let _guard = tracing::subscriber::set_default(subscriber);

    sqlx::query("INSERT INTO available_models (provider, model_id, available, fetched_at) VALUES ('velox', 'tools-model', true, now())")
        .execute(&pool)
        .await
        .unwrap();
    let store = PgStore::new(pool.clone(), Arc::new(AesGcmCipher::dev()));
    let pi = PiStepRunner::new(
        PiConfig {
            pi_bin: concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/fake_pi.sh").into(),
            timeout: std::time::Duration::from_secs(10),
            velox_base_url: "https://velox.test/v1".into(),
            omniroute_base_url: "https://omniroute.test/v1".into(),
            velox_api_key: Some(SecretString::from(key.to_string())),
            omniroute_api_key: None,
        },
        Arc::new(store),
        Redactor::new([key.to_string()]),
    );
    common::engine::seed_model(&pool).await;
    let server = common::spawn_with(
        pool,
        common::test_config(),
        Overrides {
            step_runner: Some(Arc::new(pi)),
            gateways: Some(Vec::new()),
            background: Some(true),
            ..Overrides::default()
        },
    )
    .await;
    let mut b = Builder::new(&server, "Real runner", false).await;
    let a = b.pi("A").await;
    b.client
        .update_step_model(pb::UpdateStepModelRequest {
            workflow_id: b.id.clone(),
            step_id: a,
            model_id: "velox/tools-model".into(),
            temperature: None,
        })
        .await
        .unwrap();
    let run = settle(&server, &b.id, &start(&server, &b.id, &[]).await.id).await;
    assert_eq!(run.status(), pb::RunStatus::Succeeded);
    let detail = step_detail(&server, &run, "A").await;
    assert_eq!(detail.output_text.as_deref(), Some("listed"));
    use pb::transcript_block::Block;
    let kinds: Vec<_> = detail
        .transcript
        .iter()
        .map(|b| match b.block.as_ref().unwrap() {
            Block::Text(t) => format!("text:{}", t.text),
            Block::Thinking(_) => "thinking".into(),
            Block::Tool(t) => format!("tool:{}:{}", t.name, t.summary),
        })
        .collect();
    assert_eq!(kinds, vec!["tool:bash:ls -la", "text:listed"]);

    let logs = String::from_utf8(buffer.0.lock().unwrap().clone()).unwrap();
    assert!(!logs.contains(key), "API key leaked into logs");
    let evidence: Vec<Option<Vec<u8>>> =
        sqlx::query_scalar("SELECT session_content FROM step_runs")
            .fetch_all(&server.pool)
            .await
            .unwrap();
    assert!(
        evidence
            .iter()
            .flatten()
            .all(|b| !String::from_utf8_lossy(b).contains(key))
    );
}

// Audit ticket 4: retrying a day-old failed run must report active execution
// time, not wall-clock from the original start (the "Duration 14h 05m" bug).
#[sqlx::test(migrator = "glyph_backend::infrastructure::postgres::migrate::MIGRATOR")]
async fn retry_duration_excludes_dead_time(pool: PgPool) {
    let runner = ScriptedRunner::new(&[("A", Script::Fail)]);
    let server = server(pool, runner.clone()).await;
    let mut b = Builder::new(&server, "RetryClock", false).await;
    b.pi("A").await;
    let mut client = runs_client(&server).await;

    // First run fails quickly.
    let run = settle(&server, &b.id, &start(&server, &b.id, &[]).await.id).await;
    assert_eq!(run.status(), pb::RunStatus::Failed);
    let a_run = step(&run, "A").id.clone();

    // Backdate: pretend the failure happened 14 hours ago.
    sqlx::query(
        "UPDATE workflow_runs SET started_at = now() - interval '14 hours',
                ended_at = now() - interval '14 hours' + interval '1 second',
                elapsed_ms = 1000
         WHERE id = $1::uuid",
    )
    .bind(&run.id)
    .execute(&server.pool)
    .await
    .unwrap();

    // Retry after the (simulated) long gap, with the step now succeeding.
    runner.set_script("A", ok("retried"));
    let retried = client
        .retry_step(pb::RetryStepRequest {
            workflow_id: b.id.clone(),
            run_id: run.id.clone(),
            step_run_id: a_run.clone(),
        })
        .await
        .unwrap()
        .into_inner()
        .run
        .unwrap();
    assert_eq!(retried.status(), pb::RunStatus::Running);
    assert!(retried.resumed_at.is_some(), "the clock reopened at retry");
    assert_eq!(retried.active_ms, Some(1000), "the 1s window was frozen");

    let finished = settle(&server, &b.id, &run.id).await;
    assert_eq!(finished.status(), pb::RunStatus::Succeeded);
    let elapsed = finished.elapsed_ms.expect("final duration stored");
    assert!(
        elapsed < 60_000,
        "duration must measure execution, not the 14h gap (got {elapsed}ms)"
    );
    assert!(
        elapsed >= 1000,
        "the original 1s of work stays in the total (got {elapsed}ms)"
    );
    // The requeued step's queue time restarted at the retry, not the backdate.
    let queued = step(&finished, "A").queued_at.as_ref().unwrap();
    assert!(queued.seconds > 0);
}

#[sqlx::test(migrator = "glyph_backend::infrastructure::postgres::migrate::MIGRATOR")]
async fn shared_text_vars_interpolate_at_run_time(pool: PgPool) {
    let runner = ScriptedRunner::new(&[]);
    let server = server(pool, runner.clone()).await;
    let mut b = Builder::new(&server, "Shared text", false).await;
    let src = b.pi("Src").await;
    let design = b.pi("Gen").await;
    b.connect(&src, &design, "brief").await;

    // A shared text with a var the ref does not fill.
    let text = b
        .client
        .add_shared_text(pb::AddSharedTextRequest {
            workflow_id: b.id.clone(),
            key: "designer_brief".into(),
            description: None,
            body: "Design for {{judge}}, from {{brief}}.".into(),
        })
        .await
        .unwrap()
        .into_inner()
        .new_text_id;
    b.client
        .set_step_text_ref(pb::SetStepTextRefRequest {
            workflow_id: b.id.clone(),
            step_id: design.clone(),
            field: pb::TextField::Prompt as i32,
            r#ref: Some(pb::TextRef {
                text_id: text.clone(),
                vars: [("judge".to_string(), "Sauron".to_string())].into(),
            }),
        })
        .await
        .unwrap();

    let run = settle(&server, &b.id, &start(&server, &b.id, &[]).await.id).await;
    assert_eq!(run.status(), pb::RunStatus::Succeeded);

    // The snapshot froze the rendered text: judge filled by vars, brief left
    // for run time.
    assert_eq!(
        runner.prompt_for("Gen").as_deref(),
        Some("Design for Sauron, from {{brief}}.")
    );
    // At run time the remaining token is filled by the step input, exactly as
    // the Pi runner builds the user prompt.
    let inputs = runner.calls_for("Gen")[0].clone();
    assert_eq!(inputs["brief"], json!("Src output"));
    let final_prompt = glyph_backend::features::runs::domain::prompt::user_prompt(
        runner.prompt_for("Gen").as_deref(),
        None,
        &inputs,
        &serde_json::Map::new(),
    );
    assert!(
        final_prompt.contains("Design for Sauron, from Src output."),
        "{final_prompt}"
    );
    let _ = text;
}
