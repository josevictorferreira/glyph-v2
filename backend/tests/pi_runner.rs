//! PiStepRunner process handling against tests/fixtures/fake_pi.sh.
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use async_trait::async_trait;
use glyph_backend::features::runs::{
    OutcomeStatus, ProgressSink, StepRunContext, StepRunOutcome, StepRunner,
};
use glyph_backend::features::workflows::catalog_view::CatalogModel;
use glyph_backend::features::workflows::snapshot::SnapshotTool;
use glyph_backend::features::workflows::{CatalogReader, CatalogView};
use glyph_backend::infrastructure::pi::runner::{PI_MAX_OUTPUT_TOKENS, PiConfig, PiStepRunner};
use glyph_backend::shared::error::DomainResult;
use glyph_backend::shared::ids::{RunId, StepRunId, WorkflowId};
use glyph_backend::shared::output_format::OutputFileFormat;
use glyph_backend::shared::redactor::Redactor;
use secrecy::SecretString;
use serde_json::{Map, Value, json};

const KEY: &str = "test-key-123-abcdef";

struct Catalog;

#[async_trait]
impl CatalogReader for Catalog {
    async fn view(&self) -> DomainResult<CatalogView> {
        Ok(CatalogView {
            models: vec![CatalogModel {
                provider: "velox".into(),
                model_id: "velox-only".into(),
                available: true,
                capabilities: Map::new(),
            }],
            tools: vec![],
        })
    }
}

#[derive(Default)]
struct Progress(Mutex<Vec<String>>);

#[async_trait]
impl ProgressSink for Progress {
    async fn report(&self, content: String) {
        self.0.lock().unwrap().push(content);
    }
}

fn runner(timeout: Duration) -> PiStepRunner {
    PiStepRunner::new(
        PiConfig {
            pi_bin: concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/fake_pi.sh").into(),
            timeout,
            velox_base_url: "https://velox.test/v1".into(),
            velox_api_key: Some(SecretString::from(KEY.to_string())),
        },
        Arc::new(Catalog),
        Redactor::new([KEY.to_string()]),
    )
}

fn context(model: &str, format: OutputFileFormat) -> StepRunContext {
    StepRunContext {
        workflow_id: WorkflowId::new(),
        run_id: RunId::new(),
        step_run_id: StepRunId::new(),
        step_name: "Step".into(),
        prompt: Some("Do it for {{topic}}".into()),
        additional_context: None,
        expected_output: Some("A result".into()),
        model_id: Some(model.into()),
        model_settings: Map::new(),
        enabled_tools: vec![],
        output_file_format: format,
        inputs: json!({ "topic": "nix" }).as_object().unwrap().clone(),
        workflow_values: Map::new(),
    }
}

async fn run(model: &str, format: OutputFileFormat) -> StepRunOutcome {
    runner(Duration::from_secs(10))
        .run(context(model, format), Arc::new(Progress::default()))
        .await
}

fn md() -> OutputFileFormat {
    OutputFileFormat::FreeTextMarkdown
}

#[tokio::test]
async fn success_and_evidence() {
    let o = run("velox/ok-model", md()).await;
    assert_eq!(o.status, OutcomeStatus::Success, "{o:?}");
    assert_eq!(o.output_text.as_deref(), Some("the answer"));
    assert_eq!(o.messages.as_ref().unwrap().as_array().unwrap().len(), 2);
    assert!(
        o.session_content
            .as_deref()
            .unwrap()
            .contains("agent_start")
    );
    assert!(
        o.session_content
            .as_deref()
            .unwrap()
            .contains("\"env_has_key\":\"\""),
        "key not in env"
    );
    assert_eq!(o.usage, Some(json!({ "totalTokens": 12 })));
    assert_eq!(o.exit_status, Some(0));
}

#[tokio::test]
async fn outcome_branches() {
    let o = run("error-model", md()).await;
    assert_eq!(o.status, OutcomeStatus::ModelError);
    assert!(o.technical_error.unwrap().contains("no such model"));
    assert_eq!(
        run("garbage-model", md()).await.status,
        OutcomeStatus::MalformedOutput
    );
    let o = run("exit-model", md()).await;
    assert_eq!(o.status, OutcomeStatus::ExitError);
    assert!(o.technical_error.unwrap().contains("boom happened"));
    let o = run("empty-model", md()).await;
    assert_eq!(
        o.human_error.as_deref(),
        Some("The agent finished without producing any output.")
    );
    let o = run("utf8-model", md()).await;
    assert_eq!(o.output_text.as_deref(), Some("café → 日本語"));
}

#[tokio::test]
async fn output_formats() {
    let o = run("json-model", OutputFileFormat::Json).await;
    assert_eq!(o.output, Some(json!({ "key": "value" })));
    let o = run("bad-json-model", OutputFileFormat::Json).await;
    assert_eq!(
        o.human_error.as_deref(),
        Some("The agent did not produce valid JSON.")
    );
    assert!(!o.technical_error.unwrap().contains("not json at all"));
    assert_eq!(
        run("html-model", OutputFileFormat::Html).await.status,
        OutcomeStatus::Success
    );
    let o = run("fenced-html-model", OutputFileFormat::Html).await;
    assert_eq!(
        o.output_text.as_deref(),
        Some("<!doctype html>\n<html><body>Hi</body></html>")
    );
    let o = run("fragment-model", OutputFileFormat::Html).await;
    assert_eq!(
        o.human_error.as_deref(),
        Some("The agent did not produce a complete HTML document.")
    );
    assert_eq!(
        run("zip-model", OutputFileFormat::Zip).await.status,
        OutcomeStatus::Success
    );
    let o = run("bad-zip-model", OutputFileFormat::Zip).await;
    assert_eq!(
        o.human_error.as_deref(),
        Some("The agent did not produce valid base64 ZIP data.")
    );
}

#[tokio::test]
async fn argv_env_models_json_and_cleanup() {
    let capture = tempfile::tempdir().unwrap();
    let mut ctx = context("velox/ok-model", OutputFileFormat::Html);
    ctx.prompt = Some(format!(
        "Follow {{{{style}}}} for {{{{topic}}}}.\nCAPTURE_DIR={}",
        capture.path().display()
    ));
    ctx.inputs.insert("style".into(), json!("the guide"));
    ctx.additional_context = Some("Style: {{style}}".into());
    ctx.enabled_tools = vec![
        SnapshotTool {
            key: "read".into(),
            display_name: "Read".into(),
            pi_tool_name: "read".into(),
        },
        SnapshotTool {
            key: "bash".into(),
            display_name: "Bash".into(),
            pi_tool_name: "bash".into(),
        },
    ];
    let o = runner(Duration::from_secs(10))
        .run(ctx, Arc::new(Progress::default()))
        .await;
    // HTML was requested (to check the directive) but the fake answers prose.
    assert_eq!(o.status, OutcomeStatus::MalformedOutput, "{o:?}");

    let read = |f: &str| std::fs::read_to_string(capture.path().join(f)).unwrap();
    let argv: Vec<String> = read("argv")
        .split('\0')
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .collect();
    let workdir = PathBuf::from(read("workdir"));
    assert_eq!(
        &argv[..9],
        &[
            "--print",
            "--mode",
            "json",
            "--provider",
            "velox",
            "--model",
            "ok-model",
            "--api-key",
            KEY
        ]
    );
    assert_eq!(&argv[9..11], &["--tools", "read,bash"]);
    assert_eq!(
        &argv[11..16],
        &[
            "--no-session",
            "--no-extensions",
            "--no-skills",
            "--no-context-files",
            "--system-prompt"
        ]
    );
    assert!(argv[16].starts_with("You are executing one step of an automated workflow."));
    assert!(argv[16].contains("single complete HTML document"));
    assert_eq!(argv[17], format!("@{}/prompt.md", workdir.display()));
    assert_eq!(argv.len(), 18);

    // `export -p` lines: `declare -x NAME="value"` (or `declare -x NAME`).
    let names: Vec<String> = read("env")
        .lines()
        .filter_map(|l| l.strip_prefix("declare -x "))
        .map(|l| l.split('=').next().unwrap().to_string())
        .collect();
    let allowed = [
        "HOME",
        "PATH",
        "TZ",
        "SSL_CERT_FILE",
        "SSL_CERT_DIR",
        "NODE_EXTRA_CA_CERTS",
        "PWD",
        "SHLVL",
        "OLDPWD",
        "_",
    ];
    for name in &names {
        assert!(
            allowed.contains(&name.as_str()),
            "unexpected env var {name}"
        );
    }
    assert!(names.contains(&"HOME".to_string()) && names.contains(&"PATH".to_string()));
    assert_eq!(read("cwd"), workdir.join("work").display().to_string());

    let models: Value = serde_json::from_str(&read("models.json")).unwrap();
    assert_eq!(
        models,
        json!({ "providers": { "velox": {
            "api": "openai-completions",
            "apiKey": "supplied-via-cli-flag",
            "baseUrl": "https://velox.test/v1",
            "models": [{ "id": "ok-model", "name": "ok-model", "maxTokens": PI_MAX_OUTPUT_TOKENS }]
        }}})
    );
    let prompt = read("prompt.md");
    assert!(prompt.starts_with("Step instructions:\nFollow the guide for nix."));
    assert!(prompt.contains("Additional context:\nStyle: the guide"));
    assert!(prompt.contains("Inputs:\ntopic:\nnix"));
    assert!(!workdir.exists(), "temp dir removed after the run");
}

#[tokio::test]
async fn no_tools_flag_provider_resolution_and_missing_keys() {
    let capture = tempfile::tempdir().unwrap();
    let mut ctx = context("ok-model", md());
    ctx.prompt = Some(format!("x\nCAPTURE_DIR={}", capture.path().display()));
    runner(Duration::from_secs(10))
        .run(ctx, Arc::new(Progress::default()))
        .await;
    let argv = std::fs::read_to_string(capture.path().join("argv")).unwrap();
    assert!(argv.contains("\0--no-tools\0"));
    assert!(
        argv.contains("--provider\0velox\0"),
        "bare ids default to velox"
    );

    // A bare id the catalog knows resolves to its provider.
    let capture = tempfile::tempdir().unwrap();
    let mut ctx = context("velox-only", md());
    ctx.prompt = Some(format!("x\nCAPTURE_DIR={}", capture.path().display()));
    let o = runner(Duration::from_secs(10))
        .run(ctx, Arc::new(Progress::default()))
        .await;
    let argv = std::fs::read_to_string(capture.path().join("argv")).unwrap();
    assert!(
        argv.contains("--provider\0velox\0"),
        "a catalog-known bare id resolves to velox"
    );
    assert!(
        o.status == OutcomeStatus::Success || o.status == OutcomeStatus::ModelError,
        "{o:?}"
    );

    let o = run("openai/gpt-5", md()).await;
    assert_eq!(
        o.technical_error.as_deref(),
        Some("Runner internal error: OPENAI_API_KEY is not configured")
    );
}

#[tokio::test]
async fn secrets_are_redacted() {
    let o = run("secret-model", md()).await;
    assert_eq!(o.output_text.as_deref(), Some("the key is [redacted]"));
    assert!(!o.session_content.unwrap().contains(KEY));
    assert!(!serde_json::to_string(&o.messages).unwrap().contains(KEY));
}

#[tokio::test]
async fn huge_prompts_travel_as_a_file() {
    let mut ctx = context("ok-model", md());
    ctx.inputs.insert(
        "documents".into(),
        json!(["x".repeat(70_000), "y".repeat(70_000), "z".repeat(70_000)]),
    );
    let o = runner(Duration::from_secs(10))
        .run(ctx, Arc::new(Progress::default()))
        .await;
    assert_eq!(o.status, OutcomeStatus::Success, "{:?}", o.technical_error);
}

#[tokio::test]
async fn tool_calls_and_progress() {
    let progress = Arc::new(Progress::default());
    let o = runner(Duration::from_secs(10))
        .run(context("tools-model", md()), progress.clone())
        .await;
    assert_eq!(o.output_text.as_deref(), Some("listed"));
    let messages = o.messages.unwrap();
    assert_eq!(messages[1]["tool_calls"], 1);
    assert!(!progress.0.lock().unwrap().is_empty());

    let progress = Arc::new(Progress::default());
    let o = runner(Duration::from_secs(10))
        .run(context("slow-model", md()), progress.clone())
        .await;
    assert_eq!(o.output_text.as_deref(), Some("slow answer"));
    let reports = progress.0.lock().unwrap().clone();
    assert!(reports.len() >= 2, "{reports:?}");
    assert!(reports[0].contains("agent_start"));
    assert!(reports.last().unwrap().contains("slow answer"));
}

/// A progress write that never returns (a stalled database).
struct StuckProgress;

#[async_trait]
impl ProgressSink for StuckProgress {
    async fn report(&self, _: String) {
        std::future::pending::<()>().await;
    }
}

#[tokio::test]
async fn a_stuck_progress_write_does_not_stall_the_agent() {
    let started = Instant::now();
    let o = runner(Duration::from_secs(30))
        .run(context("chatty-model", md()), Arc::new(StuckProgress))
        .await;
    assert_eq!(o.status, OutcomeStatus::Success, "{:?}", o.technical_error);
    assert_eq!(o.output_text.as_deref(), Some("chatty answer"));
    assert!(
        started.elapsed() < Duration::from_secs(15),
        "{:?}",
        started.elapsed()
    );
}

#[tokio::test]
async fn token_deltas_are_not_persisted_one_by_one() {
    let progress = Arc::new(Progress::default());
    let o = runner(Duration::from_secs(30))
        .run(context("chatty-model", md()), progress.clone())
        .await;
    assert_eq!(o.status, OutcomeStatus::Success, "{:?}", o.technical_error);
    let session = o.session_content.unwrap();
    assert!(session.len() < 10_000, "{} bytes", session.len());
    assert!(session.contains("chatty answer"));
    for report in progress.0.lock().unwrap().iter() {
        // The in-flight message is one record (~0.86 MB of text at most),
        // never the ~2.4 MB delta stream.
        assert!(report.len() < 1_000_000, "{} bytes", report.len());
    }
}

#[tokio::test]
async fn timeouts_terminate_then_kill() {
    let started = Instant::now();
    let o = runner(Duration::from_secs(1))
        .run(context("hang-model", md()), Arc::new(Progress::default()))
        .await;
    assert_eq!(o.status, OutcomeStatus::Timeout);
    assert_eq!(
        o.human_error.as_deref(),
        Some("The agent did not finish within 1 seconds.")
    );
    assert!(
        o.technical_error
            .unwrap()
            .starts_with("Process timed out. Partial output:")
    );
    assert!(o.session_content.unwrap().contains("agent_start"));
    assert!(
        started.elapsed() < Duration::from_secs(3),
        "SIGTERM ends it promptly"
    );

    // A process ignoring SIGTERM is killed after the 3s grace.
    let started = Instant::now();
    let o = runner(Duration::from_secs(1))
        .run(
            context("stubborn-model", md()),
            Arc::new(Progress::default()),
        )
        .await;
    assert_eq!(o.status, OutcomeStatus::Timeout);
    let elapsed = started.elapsed();
    assert!(
        elapsed >= Duration::from_secs(4) && elapsed < Duration::from_secs(7),
        "{elapsed:?}"
    );
}
