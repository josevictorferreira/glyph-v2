//! Deterministic chat runner for tests and `GLYPH_STEP_RUNNER=fake`.
//! The default reply is `Fake reply to: <message>` emitted word by word;
//! a message starting `FAKE_FAIL` fails; `FAKE_SLEEP:<ms>` stalls first;
//! `FAKE_TOOL:<name> <json>` calls the real agent route in-process so
//! tests and `nix run .#web` exercise the actual routes with no network.
//! `scripted` emits a fixed event list instead (tests drive edge cases).
use crate::features::chat::ports::{AgentEvent, ChatRunner, SessionFile, Turn, TurnEnd, TurnError};
use std::sync::{Arc, OnceLock};
use std::time::Duration;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;
use tower::util::ServiceExt;

enum Mode {
    Marker,
    Scripted(Vec<Script>),
}

pub enum Script {
    Delta(String),
    Fail(String),
    Sleep(u64),
    /// A finished tool call, with the details an agent route would return.
    ToolResult {
        name: String,
        text: String,
        details: serde_json::Value,
        is_error: bool,
    },
}

pub struct FakeChatRunner {
    mode: Mode,
    /// The app's agent router, filled in by bootstrap after construction
    /// (the runner is already behind an `Arc` by then) so `FAKE_TOOL:`
    /// markers hit the real agent routes without a network.
    router: Arc<OnceLock<axum::Router>>,
}

impl FakeChatRunner {
    pub fn new() -> Self {
        Self {
            mode: Mode::Marker,
            router: Arc::new(OnceLock::new()),
        }
    }
    pub fn scripted(scripts: Vec<Script>) -> Self {
        Self {
            mode: Mode::Scripted(scripts),
            router: Arc::new(OnceLock::new()),
        }
    }
    /// The slot bootstrap fills with the agent router once it exists.
    pub fn router_slot(&self) -> Arc<OnceLock<axum::Router>> {
        self.router.clone()
    }
}

impl Default for FakeChatRunner {
    fn default() -> Self {
        Self::new()
    }
}

fn fake_reply(message: &str) -> String {
    format!("Fake reply to: {message}")
}

/// One in-process agent tool call through the real routes.
async fn call_tool(
    router: &axum::Router,
    name: &str,
    params: &str,
) -> (String, serde_json::Value, bool) {
    let body = if params.trim().is_empty() {
        serde_json::Value::Null
    } else {
        serde_json::from_str(params).unwrap_or(serde_json::Value::Null)
    };
    let response = router
        .clone()
        .oneshot(
            axum::http::Request::post(format!("/agent/v1/{name}"))
                .header("content-type", "application/json")
                .body(axum::body::Body::from(body.to_string()))
                .unwrap(),
        )
        .await
        .expect("agent route answered");
    let status = response.status();
    let bytes = axum::body::to_bytes(response.into_body(), 64 * 1024 * 1024)
        .await
        .expect("agent body");
    let value: serde_json::Value = if bytes.is_empty() {
        serde_json::Value::Null
    } else {
        serde_json::from_slice(&bytes).unwrap_or(serde_json::Value::Null)
    };
    if status.is_success() {
        (
            value["text"].as_str().unwrap_or_default().to_string(),
            value
                .get("details")
                .cloned()
                .unwrap_or(serde_json::Value::Null),
            false,
        )
    } else {
        (
            value["error"]
                .as_str()
                .unwrap_or("the tool call failed")
                .to_string(),
            value
                .get("details")
                .cloned()
                .unwrap_or(serde_json::Value::Null),
            true,
        )
    }
}

#[async_trait::async_trait]
impl ChatRunner for FakeChatRunner {
    async fn run(
        &self,
        turn: Turn,
        events: mpsc::Sender<AgentEvent>,
        cancel: CancellationToken,
    ) -> TurnEnd {
        match &self.mode {
            Mode::Marker => {
                if let Some(rest) = turn.message.strip_prefix("FAKE_FAIL") {
                    return TurnEnd {
                        session: Some(fake_session(&turn.chat_id.to_string())),
                        error: Some(TurnError {
                            human: rest.trim().to_string(),
                            technical: format!("fake failure for {}", turn.chat_id),
                        }),
                    };
                }
                if let Some(ms) = turn.message.strip_prefix("FAKE_SLEEP:") {
                    let _ = tokio::time::timeout(
                        Duration::from_millis(ms.parse().unwrap_or(1000)),
                        cancel.cancelled(),
                    )
                    .await;
                }
                if let Some(call) = turn.message.strip_prefix("FAKE_TOOL:") {
                    let (name, params) = match call.split_once(' ') {
                        Some((name, params)) => (name, params),
                        None => (call.trim(), ""),
                    };
                    let router = self
                        .router
                        .get()
                        .expect("FAKE_TOOL needs the app router; bootstrap must install it");
                    let _ = events
                        .send(AgentEvent::ToolStarted {
                            call_id: String::new(),
                            name: name.into(),
                        })
                        .await;
                    let (text, details, is_error) = call_tool(router, name, params).await;
                    let _ = events
                        .send(AgentEvent::ToolFinished {
                            call_id: String::new(),
                            name: name.into(),
                            text,
                            details,
                            is_error,
                        })
                        .await;
                    return TurnEnd {
                        session: Some(fake_session(&turn.chat_id.to_string())),
                        error: None,
                    };
                }
                let reply = fake_reply(&turn.message);
                let words: Vec<&str> = reply.split(' ').collect();
                for (i, word) in words.iter().enumerate() {
                    if cancel.is_cancelled() {
                        break;
                    }
                    let glue = if i + 1 == words.len() { "" } else { " " };
                    let _ = events
                        .send(AgentEvent::TextDelta(format!("{word}{glue}")))
                        .await;
                    tokio::time::sleep(Duration::from_millis(10)).await;
                }
                TurnEnd {
                    session: Some(fake_session(&turn.chat_id.to_string())),
                    error: None,
                }
            }
            Mode::Scripted(scripts) => {
                for script in scripts {
                    match script {
                        Script::Delta(text) => {
                            let _ = events.send(AgentEvent::TextDelta(text.clone())).await;
                        }
                        Script::Fail(human) => {
                            return TurnEnd {
                                session: Some(fake_session(&turn.chat_id.to_string())),
                                error: Some(TurnError {
                                    human: human.clone(),
                                    technical: format!("scripted failure for {}", turn.chat_id),
                                }),
                            };
                        }
                        Script::Sleep(ms) => {
                            let _ = tokio::time::timeout(
                                Duration::from_millis(*ms),
                                cancel.cancelled(),
                            )
                            .await;
                        }
                        Script::ToolResult {
                            name,
                            text,
                            details,
                            is_error,
                        } => {
                            let _ = events
                                .send(AgentEvent::ToolStarted {
                                    call_id: String::new(),
                                    name: name.clone(),
                                })
                                .await;
                            let _ = events
                                .send(AgentEvent::ToolFinished {
                                    call_id: String::new(),
                                    name: name.clone(),
                                    text: text.clone(),
                                    details: details.clone(),
                                    is_error: *is_error,
                                })
                                .await;
                        }
                    }
                }
                TurnEnd {
                    session: Some(fake_session(&turn.chat_id.to_string())),
                    error: None,
                }
            }
        }
    }
}

fn fake_session(chat: &str) -> SessionFile {
    SessionFile {
        relative_path: format!("chat-{chat}.jsonl"),
        bytes: format!("{{\"chat\":\"{chat}\"}}\n").into_bytes(),
    }
}
