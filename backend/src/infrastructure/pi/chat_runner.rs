//! The Pi chat runner (spec 0024, task 4.6): one child Pi per turn, JSONL
//! events parsed into `AgentEvent`s. Session files restore per turn (the
//! working directory is fresh), so later turns resume the conversation.
//! Safety-critical parts are shared with the step runner in `process.rs`.
use std::path::{Path, PathBuf};
use std::time::Duration;

use async_trait::async_trait;
use secrecy::SecretString;
use tokio::io::AsyncReadExt;
use tokio::process::Child;
use tokio::sync::mpsc;

use crate::features::chat::domain::pi_events::{self, Parsed};
use crate::features::chat::http::AGENT_TOOLS;
use crate::features::chat::ports::{
    AgentEvent, ChatRunner, SessionFile, Turn, TurnEnd, TurnError,
};
use crate::infrastructure::pi::process;
use crate::shared::redactor::Redactor;

/// The extension and prompts, compiled into the binary (design: the agent
/// dir never changes with configuration).
const GLYPH_TOOLS_TS: &str = include_str!("../../../agent/glyph-tools.ts");
const SYSTEM_PROMPT: &str = include_str!("../../../agent/system-prompt.md");
const WORKFLOW_GUIDE: &str = include_str!("../../../agent/workflow-guide.md");

#[derive(Clone)]
pub struct PiChatConfig {
    pub pi_bin: String,
    pub timeout: Duration,
    pub velox_base_url: String,
    pub velox_api_key: Option<SecretString>,
    /// Loopback agent API base, passed as `GLYPH_AGENT_API_URL`.
    pub agent_api_url: String,
}

pub struct PiChatRunner {
    config: PiChatConfig,
    redactor: Redactor,
}

impl PiChatRunner {
    pub fn new(config: PiChatConfig, redactor: Redactor) -> Self {
        Self { config, redactor }
    }

    fn write_agent_dir(&self, home: &Path) -> Result<PathBuf, String> {
        let agent_dir = home.join(".pi").join("agent");
        std::fs::create_dir_all(&agent_dir).map_err(|e| e.to_string())?;
        std::fs::write(agent_dir.join("glyph-tools.ts"), GLYPH_TOOLS_TS)
            .and_then(|_| std::fs::write(agent_dir.join("system-prompt.md"), SYSTEM_PROMPT))
            .and_then(|_| std::fs::write(agent_dir.join("workflow-guide.md"), WORKFLOW_GUIDE))
            .map_err(|e| e.to_string())?;
        Ok(agent_dir)
    }

    fn argv(&self, turn: &Turn, agent_dir: &Path, sessions: &Path, message: &Path, api_key: String) -> Vec<String> {
        let target = process::target(&turn.model_id, None);
        let mut args: Vec<String> = vec![
            "--print".into(),
            "--mode".into(),
            "json".into(),
            "--provider".into(),
            target.provider,
            "--model".into(),
            target.model,
            "--api-key".into(),
            api_key,
            "--session-dir".into(),
            sessions.display().to_string(),
        ];
        match &turn.session {
            // Later turns restore the stored file.
            Some(session) => args.extend(["--session".into(), session_dir_file(sessions, session)]),
            // The first turn creates the session named after the chat.
            None => args.extend(["--session-id".into(), turn.chat_id.to_string()]),
        }
        args.extend([
            "--tools".into(),
            AGENT_TOOLS.join(","),
            "--no-extensions".into(),
            "-e".into(),
            agent_dir.join("glyph-tools.ts").display().to_string(),
            "--no-skills".into(),
            "--no-context-files".into(),
            "--offline".into(),
            "--system-prompt".into(),
            SYSTEM_PROMPT.into(),
            "--append-system-prompt".into(),
            agent_dir.join("workflow-guide.md").display().to_string(),
        ]);
        args.push(format!("@{}", message.display()));
        args
    }
}

/// `<session-dir>/<relative-path>`: sessions are grouped by working dir.
fn session_dir_file(sessions: &Path, session: &SessionFile) -> String {
    sessions.join(&session.relative_path).display().to_string()
}

struct Captured {
    stdout: String,
    stderr: String,
    timed_out: bool,
    exit_ok: bool,
}

#[async_trait]
impl ChatRunner for PiChatRunner {
    async fn run(
        &self,
        turn: Turn,
        events: mpsc::Sender<AgentEvent>,
        cancel: tokio_util::sync::CancellationToken,
    ) -> TurnEnd {
        match self.drive(&turn, &events, cancel).await {
            Ok((captured, session)) => {
                let mut error = None;
                for line in captured.stdout.lines() {
                    match pi_events::parse_line(line) {
                        Parsed::Delta(delta) => {
                            let _ = events.send(AgentEvent::TextDelta(delta)).await;
                        }
                        Parsed::ToolStarted { call_id, name } => {
                            let _ = events
                                .send(AgentEvent::ToolStarted { call_id, name })
                                .await;
                        }
                        Parsed::ToolFinished { call_id, name, text, details, is_error } => {
                            let _ = events
                                .send(AgentEvent::ToolFinished {
                                    call_id,
                                    name,
                                    text,
                                    details,
                                    is_error,
                                })
                                .await;
                        }
                        Parsed::ProviderError(technical) => {
                            error = Some(TurnError {
                                human: "The agent could not complete this reply.".into(),
                                technical: self.redactor.redact(&technical),
                            });
                        }
                        Parsed::Ignored => {}
                    }
                }
                // Timeouts carry their own message; other failures the
                // generic one.
                if error.is_none() && !captured.exit_ok {
                    error = Some(if captured.timed_out {
                        TurnError {
                            human: format!(
                                "The agent took longer than {} seconds and was stopped.",
                                self.config.timeout.as_secs()
                            ),
                            technical: self.redactor.redact(
                                "pi timed out and was terminated",
                            ),
                        }
                    } else {
                        TurnError {
                            human: "The agent could not complete this reply.".into(),
                            technical: self.redactor.redact(&format!(
                                "pi exited with: {}",
                                captured.stderr
                            )),
                        }
                    });
                }
                TurnEnd {
                    session,
                    error,
                }
            }
            Err(failed) => TurnEnd {
                session: None,
                error: Some(failed),
            },
        }
    }
}

impl PiChatRunner {
    async fn drive(
        &self,
        turn: &Turn,
        events: &mpsc::Sender<AgentEvent>,
        cancel: tokio_util::sync::CancellationToken,
    ) -> Result<(Captured, Option<SessionFile>), TurnError> {
        let fail = |human: &str, technical: String| {
            Some(TurnError {
                human: human.into(),
                technical: self.redactor.redact(&technical),
            })
        };
        let target = process::target(&turn.model_id, None);
        let (base_url, api_key) = process::provider_settings(
            &target.provider,
            &self.config.velox_base_url,
            &self.config.velox_api_key,
        )
        .map_err(|technical| fail("The agent could not complete this reply.", technical).unwrap())?;

        let workdir = tempfile::Builder::new()
            .prefix("glyph-chat-turn-")
            .tempdir()
            .map_err(|e| fail("The agent could not complete this reply.", e.to_string()).unwrap())?;
        let home = workdir.path().join("home");
        let sessions = workdir.path().join("sessions");
        let work = workdir.path().join("work");
        std::fs::create_dir_all(&home)
            .and_then(|_| std::fs::create_dir_all(&sessions))
            .and_then(|_| std::fs::create_dir_all(&work))
            .map_err(|e| fail("The agent could not complete this reply.", e.to_string()).unwrap())?;
        let agent_dir = self
            .write_agent_dir(&home)
            .map_err(|technical| fail("The agent could not complete this reply.", technical).unwrap())?;
        process::write_models_json(&agent_dir, &target, &base_url)
            .map_err(|technical| fail("The agent could not complete this reply.", technical).unwrap())?;
        // Restore the stored session at its relative path.
        if let Some(session) = &turn.session {
            let file = sessions.join(&session.relative_path);
            std::fs::create_dir_all(file.parent().unwrap())
                .and_then(|_| std::fs::write(&file, &session.bytes))
                .map_err(|e| fail("The agent could not complete this reply.", e.to_string()).unwrap())?;
        }
        let message = workdir.path().join("message.md");
        std::fs::write(&message, &turn.message)
            .map_err(|e| fail("The agent could not complete this reply.", e.to_string()).unwrap())?;

        let argv = self.argv(turn, &agent_dir, &sessions, &message, api_key);
        let extra = vec![(
            "GLYPH_AGENT_API_URL".to_string(),
            self.config.agent_api_url.clone(),
        )];
        let _ = events; // deltas stream from stdout below
        let mut child = process::spawn(&self.config.pi_bin, &argv, &home, &work, &extra)
            .map_err(|technical| fail("The agent could not complete this reply.", technical).unwrap())?;
        let captured = capture(&mut child, self.config.timeout, cancel).await;
        // Whatever the script wrote under the session dir comes back.
        let session = latest_session(&sessions);
        drop(workdir);
        Ok((captured, session))
    }
}

/// Reads stdout to the end under a timeout, watching cancellation; on either
/// one the child is terminated. Delta events were already sent while
/// streaming in a previous design; here they are parsed after the fact
/// (chat turns are short-lived and ordering is all that matters).
async fn capture(
    child: &mut Child,
    timeout: Duration,
    cancel: tokio_util::sync::CancellationToken,
) -> Captured {
    let mut stdout = child.stdout.take().expect("stdout pipe");
    let mut stderr = child.stderr.take().expect("stderr pipe");
    let mut out = String::new();
    let mut err = String::new();
    let deadline = tokio::time::Instant::now() + timeout;
    let mut timed_out = false;
    let mut cancelled = false;
    loop {
        tokio::select! {
            read = stdout.read_to_string(&mut out) => {
                let _ = read;
                break;
            }
            read = stderr.read_to_string(&mut err) => {
                let _ = read;
            }
            _ = tokio::time::sleep_until(deadline) => {
                timed_out = true;
                break;
            }
            _ = cancel.cancelled() => {
                cancelled = true;
                break;
            }
        }
    }
    if timed_out || cancelled {
        process::terminate(child).await;
    }
    let exit_ok = !timed_out && !cancelled && matches!(child.wait().await, Ok(status) if status.success());
    Captured {
        stdout: out,
        stderr: err,
        timed_out,
        exit_ok: exit_ok && !cancelled,
    }
}

/// The newest `.jsonl` under the session dir, as a `SessionFile`.
fn latest_session(sessions: &Path) -> Option<SessionFile> {
    std::fs::read_dir(sessions)
        .ok()?
        .flatten()
        .flat_map(|entry| walk_jsonl(entry.path()))
        .filter_map(|path| {
            let bytes = std::fs::read(&path).ok()?;
            // Sessions group by working directory on disk; the stored
            // relative path is the file name only, so next turn's restore
            // writes it back the same way.
            let relative = path
                .file_name()?
                .to_str()?
                .to_string();
            Some((path, SessionFile { relative_path: relative, bytes }))
        })
        .max_by_key(|(path, _)| {
            path.metadata()
                .and_then(|m| m.modified())
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        })
        .map(|(_, session)| session)
}

fn walk_jsonl(dir: PathBuf) -> Vec<PathBuf> {
    let mut found = Vec::new();
    if let Ok(entries) = std::fs::read_dir(&dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                found.extend(walk_jsonl(path));
            } else if path.extension().is_some_and(|e| e == "jsonl") {
                found.push(path);
            }
        }
    }
    found
}
