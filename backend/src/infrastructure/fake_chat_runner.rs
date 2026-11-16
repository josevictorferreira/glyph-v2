//! Deterministic chat runner for tests and `GLYPH_STEP_RUNNER=fake`.
//! The default reply is `Fake reply to: <message>` emitted word by word;
//! a message starting `FAKE_FAIL` fails; `FAKE_SLEEP:<ms>` stalls first.
//! `scripted` emits a fixed event list instead (tests drive edge cases).
use std::time::Duration;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;
use crate::features::chat::ports::{AgentEvent, ChatRunner, SessionFile, Turn, TurnEnd, TurnError};

enum Mode {
    Marker,
    Scripted(Vec<Script>),
}

pub enum Script {
    Delta(String),
    Fail(String),
    Sleep(u64),
}

pub struct FakeChatRunner {
    mode: Mode,
}

impl FakeChatRunner {
    pub fn new() -> Self {
        Self { mode: Mode::Marker }
    }
    pub fn scripted(scripts: Vec<Script>) -> Self {
        Self { mode: Mode::Scripted(scripts) }
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

#[async_trait::async_trait]
impl ChatRunner for FakeChatRunner {
    async fn run(&self, turn: Turn, events: mpsc::Sender<AgentEvent>, cancel: CancellationToken) -> TurnEnd {
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
                let reply = fake_reply(&turn.message);
                let words: Vec<&str> = reply.split(' ').collect();
                for (i, word) in words.iter().enumerate() {
                    if cancel.is_cancelled() {
                        break;
                    }
                    let glue = if i + 1 == words.len() { "" } else { " " };
                    let _ = events.send(AgentEvent::TextDelta(format!("{word}{glue}"))).await;
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
