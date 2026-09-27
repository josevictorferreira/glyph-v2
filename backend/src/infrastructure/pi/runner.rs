//! The Pi coding agent as a child process (Rails `PiAgentRunner`).
//! Safety-critical: argv only (never a shell), `env_clear()` with an
//! allow-list, a throwaway HOME, stdin closed, a hard timeout with
//! SIGTERM → SIGKILL, and every captured byte redacted before it leaves.
//!
//! Contract (verified against Pi 0.83):
//!   pi --print --mode json --provider P --model M --api-key K
//!      (--no-tools | --tools a,b) --no-session --no-extensions --no-skills
//!      --no-context-files --system-prompt S @<workdir>/prompt.md

use std::path::Path;
use std::process::Stdio;
use std::sync::Arc;
use std::time::{Duration, Instant};

use async_trait::async_trait;
use secrecy::{ExposeSecret, SecretString};
use serde_json::json;
use tokio::io::AsyncReadExt;
use tokio::process::{Child, Command};

use crate::features::catalog::Provider;
use crate::features::runs::domain::{pi_events, prompt};
use crate::features::runs::{
    OutcomeStatus, ProgressSink, StepRunContext, StepRunOutcome, StepRunner,
};
use crate::features::workflows::CatalogReader;
use crate::shared::redactor::Redactor;

/// Pi's fallback output budget (16k) is exhausted by reasoning models.
pub const PI_MAX_OUTPUT_TOKENS: u32 = 131_072;
pub const PROGRESS_INTERVAL: Duration = Duration::from_secs(3);
pub const KILL_GRACE: Duration = Duration::from_secs(3);

#[derive(Clone)]
pub struct PiConfig {
    pub pi_bin: String,
    pub timeout: Duration,
    pub velox_base_url: String,
    pub omniroute_base_url: String,
    pub velox_api_key: Option<SecretString>,
    pub omniroute_api_key: Option<SecretString>,
}

pub struct PiStepRunner {
    config: PiConfig,
    catalog: Arc<dyn CatalogReader>,
    redactor: Redactor,
}

struct Target {
    provider: String,
    model: String,
}

struct Captured {
    stdout: String,
    stderr: String,
    exit_code: Option<i32>,
    timed_out: bool,
}

impl PiStepRunner {
    pub fn new(config: PiConfig, catalog: Arc<dyn CatalogReader>, redactor: Redactor) -> Self {
        Self {
            config,
            catalog,
            redactor,
        }
    }

    /// `provider/model` → catalog lookup else the prefix; bare → catalog
    /// lookup by model id else the default provider (velox).
    async fn target(&self, model_id: &str) -> Target {
        let view = self.catalog.view().await.ok();
        match model_id.split_once('/') {
            Some((provider, model)) => Target {
                provider: provider.to_string(),
                model: model.to_string(),
            },
            None => Target {
                provider: view
                    .as_ref()
                    .and_then(|v| v.models.iter().find(|m| m.model_id == model_id))
                    .map(|m| m.provider.clone())
                    .unwrap_or_else(|| Provider::DEFAULT.as_str().to_string()),
                model: model_id.to_string(),
            },
        }
    }

    fn provider_settings(&self, provider: &str) -> Result<(String, String), String> {
        let (base, key) = match Provider::parse(provider) {
            Some(Provider::Velox) => (&self.config.velox_base_url, &self.config.velox_api_key),
            Some(Provider::Omniroute) => (
                &self.config.omniroute_base_url,
                &self.config.omniroute_api_key,
            ),
            None => {
                return Err(format!(
                    "{}_API_KEY is not configured",
                    provider.to_uppercase()
                ));
            }
        };
        let key = key
            .as_ref()
            .map(|k| k.expose_secret().trim().to_string())
            .filter(|k| !k.is_empty())
            .ok_or_else(|| format!("{}_API_KEY is not configured", provider.to_uppercase()))?;
        Ok((base.clone(), key))
    }

    async fn execute(
        &self,
        ctx: &StepRunContext,
        progress: &Arc<dyn ProgressSink>,
        started: Instant,
    ) -> Result<StepRunOutcome, String> {
        let target = self.target(ctx.model_id.as_deref().unwrap_or("")).await;
        let (base_url, api_key) = self.provider_settings(&target.provider)?;

        let workdir = tempfile::Builder::new()
            .prefix("glyph-step-run-")
            .tempdir()
            .map_err(|e| e.to_string())?;
        let home = workdir.path().join("home");
        let agent_dir = home.join(".pi").join("agent");
        let work = workdir.path().join("work");
        std::fs::create_dir_all(&agent_dir).map_err(|e| e.to_string())?;
        std::fs::create_dir_all(&work).map_err(|e| e.to_string())?;
        let models = json!({
            "providers": {
                target.provider.clone(): {
                    "api": "openai-completions",
                    "apiKey": "supplied-via-cli-flag",
                    "baseUrl": base_url,
                    "models": [{ "id": target.model, "name": target.model, "maxTokens": PI_MAX_OUTPUT_TOKENS }],
                }
            }
        });
        std::fs::write(
            agent_dir.join("models.json"),
            serde_json::to_vec_pretty(&models).map_err(|e| e.to_string())?,
        )
        .map_err(|e| e.to_string())?;
        // Prompts with resolved inputs can exceed the per-argument limit
        // (MAX_ARG_STRLEN): they travel as an @file.
        let prompt_path = workdir.path().join("prompt.md");
        std::fs::write(
            &prompt_path,
            prompt::user_prompt(
                ctx.prompt.as_deref(),
                ctx.additional_context.as_deref(),
                &ctx.inputs,
                &ctx.workflow_values,
            ),
        )
        .map_err(|e| e.to_string())?;

        let tools: Vec<&str> = ctx
            .enabled_tools
            .iter()
            .map(|t| t.pi_tool_name.as_str())
            .collect();
        let mut args: Vec<String> = vec![
            "--print".into(),
            "--mode".into(),
            "json".into(),
            "--provider".into(),
            target.provider.clone(),
            "--model".into(),
            target.model.clone(),
            "--api-key".into(),
            api_key,
        ];
        if tools.is_empty() {
            args.push("--no-tools".into());
        } else {
            args.push("--tools".into());
            args.push(tools.join(","));
        }
        args.extend(
            [
                "--no-session",
                "--no-extensions",
                "--no-skills",
                "--no-context-files",
                "--system-prompt",
            ]
            .map(String::from),
        );
        args.push(prompt::system_prompt(
            ctx.expected_output.as_deref(),
            ctx.output_file_format,
        ));
        args.push(format!("@{}", prompt_path.display()));

        let captured = self.spawn(&args, &home, &work, progress).await?;
        let elapsed_ms = started.elapsed().as_millis() as i64;
        let outcome = pi_events::normalize(
            pi_events::Finished {
                stdout: &captured.stdout,
                stderr: &captured.stderr,
                exit_code: captured.exit_code,
                timed_out: captured.timed_out,
                timeout_seconds: self.config.timeout.as_secs(),
                format: ctx.output_file_format,
                elapsed_ms,
            },
            &self.redactor,
        );
        drop(workdir);
        Ok(outcome)
    }

    fn child_env(home: &Path) -> Vec<(String, String)> {
        let mut env = vec![
            ("HOME".to_string(), home.display().to_string()),
            (
                "PATH".to_string(),
                std::env::var("PATH").unwrap_or_default(),
            ),
            (
                "TZ".to_string(),
                std::env::var("TZ")
                    .ok()
                    .filter(|v| !v.is_empty())
                    .unwrap_or_else(|| "UTC".into()),
            ),
        ];
        // CA bundles pass through only when set: an empty value breaks TLS defaults.
        for key in ["SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS"] {
            if let Ok(v) = std::env::var(key)
                && !v.is_empty()
            {
                env.push((key.to_string(), v));
            }
        }
        env
    }

    async fn spawn(
        &self,
        args: &[String],
        home: &Path,
        work: &Path,
        progress: &Arc<dyn ProgressSink>,
    ) -> Result<Captured, String> {
        let mut child = Command::new(&self.config.pi_bin)
            .args(args)
            .env_clear()
            .envs(Self::child_env(home))
            .current_dir(work)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .map_err(|e| format!("spawning {}: {e}", self.config.pi_bin))?;

        let mut stdout = child.stdout.take().ok_or("no stdout pipe")?;
        let mut stderr = child.stderr.take().ok_or("no stderr pipe")?;
        let stderr_task = tokio::spawn(async move {
            let mut buf = Vec::new();
            let _ = stderr.read_to_end(&mut buf).await;
            buf
        });

        let deadline = tokio::time::Instant::now() + self.config.timeout;
        let mut out = Vec::new();
        let mut chunk = vec![0u8; 65_536];
        let mut last_progress: Option<Instant> = None;
        let mut timed_out = false;
        loop {
            tokio::select! {
                read = stdout.read(&mut chunk) => match read {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        out.extend_from_slice(&chunk[..n]);
                        if last_progress.is_none_or(|t| t.elapsed() >= PROGRESS_INTERVAL) {
                            last_progress = Some(Instant::now());
                            progress.report(self.redactor.redact(&String::from_utf8_lossy(&out))).await;
                        }
                    }
                },
                _ = tokio::time::sleep_until(deadline) => {
                    timed_out = true;
                    break;
                }
            }
        }
        let mut status = None;
        if !timed_out {
            // stdout closed; the process must still exit before the deadline.
            match tokio::time::timeout_at(deadline, child.wait()).await {
                Ok(result) => status = result.ok(),
                Err(_) => timed_out = true,
            }
        }
        if timed_out {
            terminate(&mut child).await;
        }
        progress
            .report(self.redactor.redact(&String::from_utf8_lossy(&out)))
            .await;
        let err = tokio::time::timeout(Duration::from_secs(5), stderr_task)
            .await
            .ok()
            .and_then(Result::ok)
            .unwrap_or_default();
        Ok(Captured {
            stdout: String::from_utf8_lossy(&out).into_owned(),
            stderr: String::from_utf8_lossy(&err).into_owned(),
            exit_code: status.and_then(|s| s.code()),
            timed_out,
        })
    }
}

/// SIGTERM, then SIGKILL if the process is still alive after the grace.
async fn terminate(child: &mut Child) {
    if let Some(pid) = child.id() {
        let _ = nix::sys::signal::kill(
            nix::unistd::Pid::from_raw(pid as i32),
            nix::sys::signal::Signal::SIGTERM,
        );
    }
    if tokio::time::timeout(KILL_GRACE, child.wait())
        .await
        .is_err()
    {
        let _ = child.kill().await;
    }
}

#[async_trait]
impl StepRunner for PiStepRunner {
    async fn run(&self, ctx: StepRunContext, progress: Arc<dyn ProgressSink>) -> StepRunOutcome {
        let started = Instant::now();
        match self.execute(&ctx, &progress, started).await {
            Ok(outcome) => outcome,
            Err(error) => pi_events::failure(
                OutcomeStatus::InternalError,
                "The step could not be executed.",
                format!("Runner internal error: {}", self.redactor.redact(&error)),
                None,
                None,
                started.elapsed().as_millis() as i64,
            ),
        }
    }
}
