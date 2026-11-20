//! The real Pi CLI (GLYPH_PI_BIN) against an OpenAI-compatible model mock
//! and an agent-route mock: verifies the tools offered to the model are
//! exactly the ten Glyph tools, that extension tool calls reach the agent
//! API with their details, session resume across turns, and tool errors
//! surfacing as `is_error` (spec 0024, task 4.7). Skipped when
//! `GLYPH_PI_BIN` is unset.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::Json;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::routing::post;
use glyph_backend::features::chat::http::AGENT_TOOLS;
use glyph_backend::features::chat::ports::{AgentEvent, ChatRunner, SessionFile, Turn, TurnEnd};
use glyph_backend::infrastructure::pi::chat_runner::{PiChatConfig, PiChatRunner};
use glyph_backend::shared::ids::ChatId;
use glyph_backend::shared::redactor::Redactor;
use secrecy::SecretString;
use serde_json::{Value, json};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

const KEY: &str = "sk-mockkey-1234567890abcd";

/// What the model mock answers for one completions request, in order.
enum Step {
    Tool { name: String, args: String },
    Text(Vec<String>),
}

#[derive(Clone, Default)]
struct ModelCalls(Arc<Mutex<Vec<Value>>>);

#[derive(Clone, Default)]
struct AgentCalls(Arc<Mutex<Vec<(String, Value)>>>);

/// When set, every agent route answers this error instead of success.
#[derive(Clone, Default)]
struct AgentError(Arc<Mutex<Option<String>>>);

fn chunk(model: &Value, delta: Value, finish: Value) -> String {
    format!(
        "data: {}\n\n",
        json!({
            "id": "c1", "object": "chat.completion.chunk", "created": 0, "model": model,
            "choices": [{ "index": 0, "delta": delta, "finish_reason": finish }],
        })
    )
}

async fn completions(
    State((seen, script)): State<(ModelCalls, Arc<Mutex<Vec<Step>>>)>,
    Json(body): Json<Value>,
) -> impl IntoResponse {
    seen.0.lock().unwrap().push(body.clone());
    let model = body["model"].clone();
    // Keep the final scripted step as the steady-state answer so the
    // agent loop can keep requesting after the last scripted exchange.
    let step = {
        let mut script = script.lock().unwrap();
        if script.len() > 1 {
            Some(script.remove(0))
        } else {
            script.first().map(|s| match s {
                Step::Tool { name, args } => Step::Tool { name: name.clone(), args: args.clone() },
                Step::Text(d) => Step::Text(d.clone()),
            })
        }
    };
    let stream = match step {
        Some(Step::Tool { name, args }) => [
            chunk(
                &model,
                json!({
                    "role": "assistant",
                    "tool_calls": [{
                        "index": 0, "id": "call_1", "type": "function",
                        "function": { "name": name, "arguments": args }
                    }]
                }),
                Value::Null,
            ),
            chunk(&model, json!({}), json!("tool_calls")),
            "data: [DONE]\n\n".to_string(),
        ]
        .concat(),
        Some(Step::Text(deltas)) => deltas
            .iter()
            .map(|d| chunk(&model, json!({ "content": d }), Value::Null))
            .chain([chunk(&model, json!({}), json!("stop"))])
            .chain(["data: [DONE]\n\n".to_string()])
            .collect(),
        None => [
            chunk(&model, json!({ "content": "…" }), Value::Null),
            chunk(&model, json!({}), json!("stop")),
            "data: [DONE]\n\n".to_string(),
        ]
        .concat(),
    };
    ([("content-type", "text/event-stream")], stream)
}

async fn agent_route(
    State((seen, error)): State<(AgentCalls, AgentError)>,
    Path(tool): Path<String>,
) -> impl IntoResponse {
    seen.0.lock().unwrap().push((tool.clone(), json!({})));
    if let Some(message) = error.0.lock().unwrap().clone() {
        return (StatusCode::UNPROCESSABLE_ENTITY, Json(json!({ "error": message })));
    }
    (
        StatusCode::OK,
        Json(json!({ "text": "1 workflow", "details": { "count": 1 } })),
    )
}

async fn spawn(app: axum::Router) -> std::net::SocketAddr {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    addr
}

async fn drive(runner: &PiChatRunner, turn: Turn) -> (Vec<AgentEvent>, TurnEnd) {
    let (tx, mut rx) = mpsc::channel(256);
    let cancel = CancellationToken::new();
    let end = runner.run(turn, tx, cancel).await;
    let mut events = Vec::new();
    while let Some(event) = rx.recv().await {
        events.push(event);
    }
    (events, end)
}

fn runner(pi_bin: &str, model: std::net::SocketAddr, agent: std::net::SocketAddr) -> PiChatRunner {
    PiChatRunner::new(
        PiChatConfig {
            pi_bin: pi_bin.into(),
            timeout: Duration::from_secs(60),
            velox_base_url: format!("http://{model}/v1"),
            velox_api_key: Some(SecretString::from(KEY.to_string())),
            agent_api_url: format!("http://{agent}"),
        },
        Redactor::new([KEY.to_string()]),
    )
}

fn turn(chat_id: ChatId, message: &str, session: Option<SessionFile>) -> Turn {
    Turn {
        chat_id,
        model_id: "velox/mock-model".into(),
        message: message.into(),
        session,
    }
}

fn deltas(events: &[AgentEvent]) -> Vec<String> {
    events
        .iter()
        .filter_map(|e| match e {
            AgentEvent::TextDelta(d) => Some(d.clone()),
            _ => None,
        })
        .collect()
}

#[tokio::test]
async fn real_pi_offers_the_ten_tools_and_round_trips_a_call() {
    let Some(pi_bin) = std::env::var("GLYPH_PI_BIN")
        .ok()
        .filter(|p| std::path::Path::new(p).exists())
    else {
        eprintln!("GLYPH_PI_BIN not set; skipping the real Pi chat contract test");
        return;
    };
    let model_calls = ModelCalls::default();
    let agent_calls = AgentCalls::default();
    let script = Arc::new(Mutex::new(vec![
        Step::Tool { name: "list_workflows".into(), args: "{}".into() },
        Step::Text(vec!["Hello ".into(), "there.".into()]),
    ]));
    let model_addr = spawn(
        axum::Router::new()
            .route("/v1/chat/completions", post(completions))
            .with_state((model_calls.clone(), script)),
    )
    .await;
    let agent_addr = spawn(
        axum::Router::new()
            .route("/agent/v1/{tool}", post(agent_route))
            .with_state((agent_calls.clone(), AgentError::default())),
    )
    .await;
    let runner = runner(&pi_bin, model_addr, agent_addr);

    let (events, end) = drive(&runner, turn(ChatId::new(), "list them", None)).await;
    assert!(end.error.is_none(), "{:?}", end.error.map(|e| e.technical));

    // The tools offered to the model are exactly the Glyph tools.
    let requests = model_calls.0.lock().unwrap().clone();
    assert!(!requests.is_empty());
    let offered: Vec<String> = requests[0]["tools"]
        .as_array()
        .expect("tools in request")
        .iter()
        .map(|t| t["function"]["name"].as_str().unwrap_or_default().to_string())
        .collect();
    let mut expected = AGENT_TOOLS.to_vec();
    expected.sort();
    let mut offered = offered;
    offered.sort();
    assert_eq!(offered, expected);

    // The mocked tool call reached the agent API and its details came back.
    let calls = agent_calls.0.lock().unwrap().clone();
    assert_eq!(calls.len(), 1, "{calls:?}");
    assert_eq!(calls[0].0, "list_workflows");
    let finished = events.iter().find_map(|e| match e {
        AgentEvent::ToolFinished { name, text, details, is_error, .. } if name == "list_workflows" => {
            Some((text.clone(), details.clone(), *is_error))
        }
        _ => None,
    });
    let (text, details, is_error) = finished.expect("tool finished");
    assert!(!is_error);
    assert_eq!(text, "1 workflow");
    assert_eq!(details, json!({ "count": 1 }));
    assert!(events.iter().any(|e| matches!(
        e,
        AgentEvent::ToolStarted { name, .. } if name == "list_workflows"
    )));

    // Text arrived as several deltas.
    assert_eq!(deltas(&events), ["Hello ", "there."]);
}

#[tokio::test]
async fn turn_two_resumes_turn_one_session() {
    let Some(pi_bin) = std::env::var("GLYPH_PI_BIN")
        .ok()
        .filter(|p| std::path::Path::new(p).exists())
    else {
        eprintln!("GLYPH_PI_BIN not set; skipping the real Pi chat contract test");
        return;
    };
    let model_calls = ModelCalls::default();
    let script = Arc::new(Mutex::new(vec![
        Step::Text(vec!["One.".into()]),
        Step::Text(vec!["Two.".into()]),
    ]));
    let model_addr = spawn(
        axum::Router::new()
            .route("/v1/chat/completions", post(completions))
            .with_state((model_calls.clone(), script)),
    )
    .await;
    let agent_addr = spawn(
        axum::Router::new()
            .route("/agent/v1/{tool}", post(agent_route))
            .with_state((AgentCalls::default(), AgentError::default())),
    )
    .await;
    let runner = runner(&pi_bin, model_addr, agent_addr);

    let (events, end) = drive(&runner, turn(ChatId::new(), "first message", None)).await;
    assert!(end.error.is_none(), "{:?}", end.error.map(|e| e.technical));
    assert_eq!(deltas(&events), ["One."]);
    let session = end.session.expect("session written after turn one");

    let (events, end) = drive(
        &runner,
        turn(ChatId::new(), "second message", Some(session)),
    )
    .await;
    assert!(end.error.is_none(), "{:?}", end.error.map(|e| e.technical));
    assert_eq!(deltas(&events), ["Two."]);

    // Turn two's request carried turn one's messages to the model.
    let requests = model_calls.0.lock().unwrap().clone();
    let last = requests.last().unwrap();
    let transcript = last["messages"].to_string();
    assert!(transcript.contains("first message"), "{transcript}");
    assert!(transcript.contains("One."), "{transcript}");
}

#[tokio::test]
async fn a_tool_route_error_becomes_is_error() {
    let Some(pi_bin) = std::env::var("GLYPH_PI_BIN")
        .ok()
        .filter(|p| std::path::Path::new(p).exists())
    else {
        eprintln!("GLYPH_PI_BIN not set; skipping the real Pi chat contract test");
        return;
    };
    let model_calls = ModelCalls::default();
    let script = Arc::new(Mutex::new(vec![
        Step::Tool { name: "list_workflows".into(), args: "{}".into() },
        Step::Text(vec!["Recovered.".into()]),
    ]));
    let model_addr = spawn(
        axum::Router::new()
            .route("/v1/chat/completions", post(completions))
            .with_state((model_calls.clone(), script)),
    )
    .await;
    let agent_error = AgentError::default();
    *agent_error.0.lock().unwrap() = Some("Validation failed".into());
    let agent_addr = spawn(
        axum::Router::new()
            .route("/agent/v1/{tool}", post(agent_route))
            .with_state((AgentCalls::default(), agent_error)),
    )
    .await;
    let runner = runner(&pi_bin, model_addr, agent_addr);

    let (events, end) = drive(&runner, turn(ChatId::new(), "list them", None)).await;
    assert!(end.error.is_none(), "{:?}", end.error.map(|e| e.technical));
    let finished = events.iter().find_map(|e| match e {
        AgentEvent::ToolFinished { name, text, is_error, .. } if name == "list_workflows" => {
            Some((text.clone(), *is_error))
        }
        _ => None,
    });
    let (text, is_error) = finished.expect("tool finished");
    assert!(is_error, "text: {text}");
    assert!(text.contains("Validation failed"), "text: {text}");
}
