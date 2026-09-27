//! The real Pi CLI (GLYPH_PI_BIN, set by the flake) against a local
//! OpenAI-compatible mock: verifies the argv contract, models.json, the
//! @prompt file and NDJSON parsing against the installed Pi version.
//! Skipped when GLYPH_PI_BIN is unset.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use axum::Json;
use axum::extract::State;
use axum::http::HeaderMap;
use axum::response::IntoResponse;
use axum::routing::post;
use glyph_backend::features::runs::{OutcomeStatus, ProgressSink, StepRunContext, StepRunner};
use glyph_backend::features::workflows::snapshot::SnapshotTool;
use glyph_backend::features::workflows::{CatalogReader, CatalogView};
use glyph_backend::infrastructure::pi::runner::{PiConfig, PiStepRunner};
use glyph_backend::shared::error::DomainResult;
use glyph_backend::shared::ids::{RunId, StepRunId, WorkflowId};
use glyph_backend::shared::output_format::OutputFileFormat;
use glyph_backend::shared::redactor::Redactor;
use secrecy::SecretString;
use serde_json::{Map, Value, json};

const KEY: &str = "sk-mockkey-1234567890abcd";

#[derive(Clone, Default)]
struct Seen(Arc<Mutex<Vec<(String, Value)>>>);

async fn completions(
    State(seen): State<Seen>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> impl IntoResponse {
    let auth = headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();
    seen.0.lock().unwrap().push((auth, body.clone()));
    let model = body["model"].clone();
    let chunk = |delta: Value, finish: Value, usage: Option<Value>| {
        let mut c = json!({
            "id": "c1", "object": "chat.completion.chunk", "created": 0, "model": model,
            "choices": [{ "index": 0, "delta": delta, "finish_reason": finish }],
        });
        if let Some(u) = usage {
            c["usage"] = u;
        }
        format!("data: {c}\n\n")
    };
    let stream = [
        chunk(
            json!({ "role": "assistant", "content": "{\"answer\": \"pong\"}" }),
            Value::Null,
            None,
        ),
        chunk(
            json!({}),
            json!("stop"),
            Some(json!({ "prompt_tokens": 3, "completion_tokens": 1, "total_tokens": 4 })),
        ),
        "data: [DONE]\n\n".to_string(),
    ]
    .concat();
    ([("content-type", "text/event-stream")], stream)
}

struct Catalog;

#[async_trait]
impl CatalogReader for Catalog {
    async fn view(&self) -> DomainResult<CatalogView> {
        Ok(CatalogView::default())
    }
}

struct NoProgress;

#[async_trait]
impl ProgressSink for NoProgress {
    async fn report(&self, _: String) {}
}

#[tokio::test]
async fn real_pi_accepts_the_contract() {
    let Some(pi_bin) = std::env::var("GLYPH_PI_BIN")
        .ok()
        .filter(|p| std::path::Path::new(p).exists())
    else {
        eprintln!("GLYPH_PI_BIN not set; skipping the real Pi contract test");
        return;
    };
    let seen = Seen::default();
    let app = axum::Router::new()
        .route("/v1/chat/completions", post(completions))
        .with_state(seen.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });

    let runner = PiStepRunner::new(
        PiConfig {
            pi_bin,
            timeout: Duration::from_secs(60),
            velox_base_url: format!("http://{addr}/v1"),
            omniroute_base_url: "http://unused".into(),
            velox_api_key: Some(SecretString::from(KEY.to_string())),
            omniroute_api_key: None,
        },
        Arc::new(Catalog),
        Redactor::new([KEY.to_string()]),
    );
    let outcome = runner
        .run(
            StepRunContext {
                workflow_id: WorkflowId::new(),
                run_id: RunId::new(),
                step_run_id: StepRunId::new(),
                step_name: "Pong".into(),
                prompt: Some("Answer {{question}} as JSON.".into()),
                additional_context: None,
                expected_output: Some("A JSON object".into()),
                model_id: Some("velox/mock-model".into()),
                model_settings: Map::new(),
                enabled_tools: vec![SnapshotTool {
                    key: "read".into(),
                    display_name: "Read".into(),
                    pi_tool_name: "read".into(),
                }],
                output_file_format: OutputFileFormat::Json,
                inputs: json!({ "question": "ping" }).as_object().unwrap().clone(),
                workflow_values: Map::new(),
            },
            Arc::new(NoProgress),
        )
        .await;

    assert_eq!(
        outcome.status,
        OutcomeStatus::Success,
        "{:?}",
        outcome.technical_error
    );
    assert_eq!(outcome.output, Some(json!({ "answer": "pong" })));
    assert!(
        !outcome
            .session_content
            .as_deref()
            .unwrap_or("")
            .contains(KEY)
    );

    let requests = seen.0.lock().unwrap().clone();
    let (auth, body) = requests.first().expect("pi called the provider");
    assert_eq!(auth, &format!("Bearer {KEY}"));
    assert_eq!(body["model"], "mock-model");
    let rendered = body.to_string();
    assert!(
        rendered.contains("You are executing one step of an automated workflow."),
        "system prompt"
    );
    assert!(
        rendered.contains("one valid JSON value only"),
        "format directive"
    );
    assert!(
        rendered.contains("Answer ping as JSON."),
        "prompt file content"
    );
    assert!(rendered.contains("\"read\""), "enabled tool offered");
}
