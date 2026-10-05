//! Live updates: LISTEN/NOTIFY → broadcast → WatchWorkflow.
mod common;

use std::time::Duration;

use axum::body::Body;
use chrono::Utc;
use common::engine::*;
use futures_util::StreamExt;
use glyph_backend::features::live::domain::{LiveEvent, LiveKind};
use glyph_backend::features::live::grpc::watch;
use glyph_backend::infrastructure::postgres::listener::LiveHub;
use glyph_backend::proto::pb;
use glyph_backend::proto::pb::live_service_client::LiveServiceClient;
use glyph_backend::shared::ids::WorkflowId;
use http_body_util::BodyExt;
use prost::Message;
use sqlx::PgPool;
use tokio_util::sync::CancellationToken;
use tower::ServiceExt;

async fn next_event(stream: &mut tonic::Streaming<pb::WatchWorkflowResponse>) -> pb::WorkflowEvent {
    tokio::time::timeout(Duration::from_secs(5), stream.message())
        .await
        .expect("event within 5s")
        .unwrap()
        .expect("stream open")
        .event
        .unwrap()
}

#[sqlx::test(migrator = "glyph_backend::infrastructure::postgres::migrate::MIGRATOR")]
async fn listener_delivers_after_commit_and_resyncs_on_reconnect(pool: PgPool) {
    let hub = LiveHub::new(64);
    let stop = CancellationToken::new();
    let task = hub.clone().spawn_listener(pool.clone(), stop.clone());
    let mut rx = glyph_backend::features::live::LiveBus::subscribe(&hub);
    tokio::time::sleep(Duration::from_millis(200)).await;

    let payload = |id: &str| {
        serde_json::to_string(&LiveEvent {
            kind: LiveKind::WorkflowUpdated,
            workflow_id: id.into(),
            run_id: None,
            step_run_id: None,
            occurred_at: Utc::now(),
        })
        .unwrap()
    };
    // Uncommitted NOTIFYs are never delivered.
    let mut tx = pool.begin().await.unwrap();
    sqlx::query("SELECT pg_notify('glyph_events', $1)")
        .bind(payload("rolled-back"))
        .execute(&mut *tx)
        .await
        .unwrap();
    tx.rollback().await.unwrap();
    sqlx::query("SELECT pg_notify('glyph_events', $1)")
        .bind(payload("w1"))
        .execute(&pool)
        .await
        .unwrap();
    let e = tokio::time::timeout(Duration::from_secs(5), rx.recv())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(e.workflow_id, "w1");

    // Kill the LISTEN connection: the hub reconnects and broadcasts RESYNC.
    sqlx::query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE query ILIKE 'LISTEN%' AND pid <> pg_backend_pid()")
        .execute(&pool)
        .await
        .unwrap();
    let e = tokio::time::timeout(Duration::from_secs(5), rx.recv())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(e.kind, LiveKind::Resync);
    assert!(e.workflow_id.is_empty());
    tokio::time::sleep(Duration::from_millis(200)).await;
    sqlx::query("SELECT pg_notify('glyph_events', $1)")
        .bind(payload("w2"))
        .execute(&pool)
        .await
        .unwrap();
    let e = tokio::time::timeout(Duration::from_secs(5), rx.recv())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(e.workflow_id, "w2");
    stop.cancel();
    task.await.unwrap();
}

#[sqlx::test(migrator = "glyph_backend::infrastructure::postgres::migrate::MIGRATOR")]
async fn watch_workflow_streams_a_run(pool: PgPool) {
    let runner = ScriptedRunner::new(&[]);
    let server = server(pool, runner).await;
    let mut b = Builder::new(&server, "Watched", false).await;
    let a = b.pi("A").await;
    let bb = b.pi("B").await;
    b.connect(&a, &bb, "in").await;
    let mut other = Builder::new(&server, "Other", false).await;
    other.pi("X").await;

    let mut live = LiveServiceClient::new(server.channel().await);
    let mut stream = live
        .watch_workflow(pb::WatchWorkflowRequest {
            workflow_id: b.id.clone(),
        })
        .await
        .unwrap()
        .into_inner();
    tokio::time::sleep(Duration::from_millis(100)).await;

    // Noise from another workflow must be filtered out.
    start(&server, &other.id, &[]).await;
    let run = start(&server, &b.id, &[]).await;

    let mut seen = Vec::new();
    loop {
        let e = next_event(&mut stream).await;
        assert_eq!(e.workflow_id, b.id);
        // The stream opens with a greeting HEARTBEAT (no run id).
        if e.r#type() == pb::EventType::Heartbeat {
            continue;
        }
        assert_eq!(e.run_id.as_deref(), Some(run.id.as_str()), "{e:?}");
        let t = e.r#type();
        seen.push(t);
        if t == pb::EventType::RunSucceeded {
            break;
        }
    }
    use pb::EventType::*;
    let pos = |t: pb::EventType| {
        seen.iter()
            .position(|s| *s == t)
            .unwrap_or_else(|| panic!("{t:?} missing in {seen:?}"))
    };
    assert!(pos(StepRunQueued) < pos(RunQueued));
    assert!(pos(RunQueued) < pos(RunStarted));
    assert!(pos(RunStarted) < pos(StepRunStarted));
    assert!(pos(StepRunStarted) < pos(StepRunProgress));
    assert!(pos(StepRunProgress) < pos(StepRunSucceeded));
    assert_eq!(seen.iter().filter(|t| **t == StepRunSucceeded).count(), 2);
    assert_eq!(*seen.last().unwrap(), RunSucceeded);

    // Editor mutations surface as WORKFLOW_UPDATED.
    b.pi("C").await;
    let e = next_event(&mut stream).await;
    assert_eq!(e.r#type(), WorkflowUpdated);
}

#[tokio::test]
async fn lagging_subscribers_get_a_resync_and_heartbeats_flow() {
    let hub = LiveHub::new(2);
    let workflow = WorkflowId::new();
    let mut stream = watch(&hub, workflow, None, CancellationToken::new());
    for _ in 0..10 {
        hub.publish(LiveEvent {
            kind: LiveKind::RunQueued,
            workflow_id: workflow.to_string(),
            run_id: None,
            step_run_id: None,
            occurred_at: Utc::now(),
        });
    }
    // Every stream opens with a greeting HEARTBEAT (connection liveness for
    // quiet workflows), then the events flow.
    let open = stream.next().await.unwrap().unwrap().event.unwrap();
    assert_eq!(open.r#type(), pb::EventType::Heartbeat);
    let first = stream.next().await.unwrap().unwrap().event.unwrap();
    assert_eq!(first.r#type(), pb::EventType::Resync);

    let mut beating = watch(
        &hub,
        workflow,
        Some(Duration::from_millis(100)),
        CancellationToken::new(),
    );
    let beat = tokio::time::timeout(Duration::from_millis(500), beating.next())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert_eq!(beat.event.unwrap().r#type(), pb::EventType::Heartbeat);

    // Shutdown ends open streams (the greeting heartbeats arrive first).
    let stop = CancellationToken::new();
    let mut ending = watch(&hub, workflow, None, stop.clone());
    let open = ending.next().await.unwrap().unwrap().event.unwrap();
    assert_eq!(open.r#type(), pb::EventType::Heartbeat);
    stop.cancel();
    assert!(
        tokio::time::timeout(Duration::from_secs(1), ending.next())
            .await
            .unwrap()
            .is_none()
    );
}

#[sqlx::test(migrator = "glyph_backend::infrastructure::postgres::migrate::MIGRATOR")]
async fn grpc_web_streaming(pool: PgPool) {
    let runner = ScriptedRunner::new(&[]);
    let server = server(pool, runner).await;
    let mut b = Builder::new(&server, "Web", false).await;
    let request = pb::WatchWorkflowRequest {
        workflow_id: b.id.clone(),
    }
    .encode_to_vec();
    let mut frame = vec![0u8];
    frame.extend_from_slice(&(request.len() as u32).to_be_bytes());
    frame.extend_from_slice(&request);
    let response = server
        .router
        .clone()
        .oneshot(
            axum::http::Request::post("/glyph.v1.LiveService/WatchWorkflow")
                .header("content-type", "application/grpc-web+proto")
                .header("x-grpc-web", "1")
                .body(Body::from(frame))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    let mut body = response.into_body();
    tokio::time::sleep(Duration::from_millis(100)).await;
    b.pi("Trigger").await;

    let mut buf = Vec::new();
    let event = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            // Drain buffered frames first: the greeting HEARTBEAT and the
            // trigger event may arrive in one chunk. Keep reading until a
            // non-heartbeat frame shows up.
            while buf.len() >= 5 {
                let len = u32::from_be_bytes(buf[1..5].try_into().unwrap()) as usize;
                if buf.len() < 5 + len {
                    break;
                }
                let event = pb::WatchWorkflowResponse::decode(&buf[5..5 + len]).unwrap();
                buf.drain(..5 + len);
                if event.event.as_ref().unwrap().r#type() != pb::EventType::Heartbeat {
                    return event;
                }
            }
            let frame = body.frame().await.unwrap().unwrap();
            if let Ok(data) = frame.into_data() {
                buf.extend_from_slice(&data);
            }
        }
    })
    .await
    .unwrap();
    assert_eq!(
        event.event.unwrap().r#type(),
        pb::EventType::WorkflowUpdated
    );
}
