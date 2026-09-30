//! Run-engine test harness: a scripted step runner, a gRPC workflow builder
//! and helpers that wait for runs to settle.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use glyph_backend::app::bootstrap::Overrides;
use glyph_backend::features::runs::{
    OutcomeStatus, ProgressSink, StepRunContext, StepRunOutcome, StepRunner,
};
use glyph_backend::proto::pb;
use glyph_backend::proto::pb::run_service_client::RunServiceClient;
use glyph_backend::proto::pb::workflow_service_client::WorkflowServiceClient;
use serde_json::{Value, json};
use sqlx::PgPool;
use tonic::transport::Channel;

use super::TestServer;

#[derive(Clone)]
pub enum Script {
    Succeed(String),
    Fail,
    /// Waits, then succeeds.
    Slow(u64, String),
    /// Waits, then fails.
    SlowFail(u64),
}

pub fn ok(text: &str) -> Script {
    Script::Succeed(text.into())
}

#[derive(Default)]
pub struct ScriptedRunner {
    scripts: Mutex<HashMap<String, Script>>,
    pub calls: Mutex<Vec<(String, serde_json::Map<String, Value>)>>,
}

impl ScriptedRunner {
    pub fn new(scripts: &[(&str, Script)]) -> Arc<Self> {
        let runner = Self::default();
        *runner.scripts.lock().unwrap() = scripts
            .iter()
            .map(|(k, v)| (k.to_string(), v.clone()))
            .collect();
        Arc::new(runner)
    }
    /// Replaces the script for one step (retries run a different outcome).
    pub fn set_script(&self, step: &str, script: Script) {
        self.scripts
            .lock()
            .unwrap()
            .insert(step.to_string(), script);
    }

    pub fn calls_for(&self, step: &str) -> Vec<serde_json::Map<String, Value>> {
        self.calls
            .lock()
            .unwrap()
            .iter()
            .filter(|(s, _)| s == step)
            .map(|(_, i)| i.clone())
            .collect()
    }

    pub fn call_count(&self) -> usize {
        self.calls.lock().unwrap().len()
    }
}

pub fn success(text: &str) -> StepRunOutcome {
    StepRunOutcome {
        status: OutcomeStatus::Success,
        output_text: Some(text.into()),
        output: None,
        messages: Some(json!([{ "role": "assistant", "text": text, "tool_calls": 0 }])),
        session_content: Some(r#"{"type":"session"}"#.into()),
        usage: Some(json!({})),
        exit_status: Some(0),
        human_error: None,
        technical_error: None,
        elapsed_ms: 42,
    }
}

pub fn failure() -> StepRunOutcome {
    StepRunOutcome {
        status: OutcomeStatus::ModelError,
        output_text: None,
        output: None,
        messages: Some(json!([{ "role": "assistant", "text": "", "tool_calls": 0 }])),
        session_content: None,
        usage: None,
        exit_status: Some(0),
        human_error: Some("The selected model or provider could not complete the step.".into()),
        technical_error: Some("provider said no".into()),
        elapsed_ms: 42,
    }
}

#[async_trait]
impl StepRunner for ScriptedRunner {
    async fn run(&self, ctx: StepRunContext, progress: Arc<dyn ProgressSink>) -> StepRunOutcome {
        self.calls
            .lock()
            .unwrap()
            .push((ctx.step_name.clone(), ctx.inputs.clone()));
        progress.report("{\"progress\":true}".into()).await;
        let script = self
            .scripts
            .lock()
            .unwrap()
            .get(&ctx.step_name)
            .cloned()
            .unwrap_or(Script::Succeed(format!("{} output", ctx.step_name)));
        match script {
            Script::Succeed(text) => success(&text),
            Script::Fail => failure(),
            Script::Slow(ms, text) => {
                tokio::time::sleep(Duration::from_millis(ms)).await;
                success(&text)
            }
            Script::SlowFail(ms) => {
                tokio::time::sleep(Duration::from_millis(ms)).await;
                failure()
            }
        }
    }
}

pub async fn seed_model(pool: &PgPool) {
    sqlx::query(
        "INSERT INTO available_models (provider, model_id, available, capabilities, fetched_at)
         VALUES ('omniroute', 'test-model', true, '{\"temperature\": true}', now())
         ON CONFLICT DO NOTHING",
    )
    .execute(pool)
    .await
    .unwrap();
}

/// A server running the real job worker with `runner` as the step runner.
pub async fn server(pool: PgPool, runner: Arc<ScriptedRunner>) -> TestServer {
    seed_model(&pool).await;
    super::spawn_with(
        pool,
        super::test_config(),
        Overrides {
            step_runner: Some(runner),
            gateways: Some(Vec::new()),
            background: Some(true),
            ..Overrides::default()
        },
    )
    .await
}

pub struct Builder {
    pub client: WorkflowServiceClient<Channel>,
    pub id: String,
}

impl Builder {
    pub async fn new(server: &TestServer, name: &str, fail_fast: bool) -> Self {
        Self::with_channel(server.channel().await, name, fail_fast).await
    }

    pub async fn with_channel(channel: Channel, name: &str, fail_fast: bool) -> Self {
        let mut client = WorkflowServiceClient::new(channel);
        let wf = client
            .create_workflow(pb::CreateWorkflowRequest {
                name: name.into(),
                description: None,
                fail_fast,
            })
            .await
            .unwrap()
            .into_inner()
            .workflow
            .unwrap();
        Self {
            client,
            id: wf.summary.unwrap().id,
        }
    }

    /// A configured pi step; output name = lower-cased step name.
    pub async fn pi(&mut self, name: &str) -> String {
        self.step(name, pb::StepKind::Pi).await
    }

    pub async fn helper(&mut self, name: &str) -> String {
        self.step(name, pb::StepKind::Helper).await
    }

    async fn step(&mut self, name: &str, kind: pb::StepKind) -> String {
        let id = self
            .client
            .add_step(pb::AddStepRequest {
                workflow_id: self.id.clone(),
                kind: kind as i32,
                canvas_x: None,
                canvas_y: None,
            })
            .await
            .unwrap()
            .into_inner()
            .new_step_id;
        self.client
            .update_step_details(pb::UpdateStepDetailsRequest {
                workflow_id: self.id.clone(),
                step_id: id.clone(),
                name: name.into(),
                description: None,
                allow_failure: false,
            })
            .await
            .unwrap();
        self.client
            .update_step_output(pb::UpdateStepOutputRequest {
                workflow_id: self.id.clone(),
                step_id: id.clone(),
                output_name: name.to_lowercase(),
                output_description: None,
                expected_output: Some("The result".into()),
                output_file_format: pb::OutputFileFormat::FreeTextMarkdown as i32,
            })
            .await
            .unwrap();
        if kind == pb::StepKind::Pi {
            self.client
                .update_step_prompt(pb::UpdateStepPromptRequest {
                    workflow_id: self.id.clone(),
                    step_id: id.clone(),
                    prompt: Some("Do the thing".into()),
                    additional_context: None,
                })
                .await
                .unwrap();
            self.client
                .update_step_model(pb::UpdateStepModelRequest {
                    workflow_id: self.id.clone(),
                    step_id: id.clone(),
                    model_id: "omniroute/test-model".into(),
                    temperature: None,
                })
                .await
                .unwrap();
        }
        id
    }

    pub async fn allow_failure(&mut self, step: &str, name: &str) {
        self.client
            .update_step_details(pb::UpdateStepDetailsRequest {
                workflow_id: self.id.clone(),
                step_id: step.into(),
                name: name.into(),
                description: None,
                allow_failure: true,
            })
            .await
            .unwrap();
    }

    pub async fn format(&mut self, step: &str, name: &str, format: pb::OutputFileFormat) {
        self.client
            .update_step_output(pb::UpdateStepOutputRequest {
                workflow_id: self.id.clone(),
                step_id: step.into(),
                output_name: name.to_lowercase(),
                output_description: None,
                expected_output: Some("The result".into()),
                output_file_format: format as i32,
            })
            .await
            .unwrap();
    }

    /// Adds a required input named `input` on `target` fed by `source`.
    pub async fn connect(&mut self, source: &str, target: &str, input: &str) -> String {
        let input_id = self
            .client
            .add_step_input(pb::AddStepInputRequest {
                workflow_id: self.id.clone(),
                step_id: target.into(),
                name: input.into(),
                required: true,
            })
            .await
            .unwrap()
            .into_inner()
            .new_input_id;
        self.client
            .create_connection(pb::CreateConnectionRequest {
                workflow_id: self.id.clone(),
                source_step_id: source.into(),
                destination_input_id: input_id.clone(),
                replace_existing: false,
            })
            .await
            .unwrap();
        input_id
    }

    pub async fn workflow_input(&mut self, name: &str, required: bool) -> String {
        self.client
            .add_workflow_input(pb::AddWorkflowInputRequest {
                workflow_id: self.id.clone(),
                name: name.into(),
                description: None,
                required,
                value: None,
                ask_at_run_time: true,
            })
            .await
            .unwrap()
            .into_inner()
            .new_input_id
    }

    pub async fn set_prompt(&mut self, step: &str, prompt: &str) {
        self.client
            .update_step_prompt(pb::UpdateStepPromptRequest {
                workflow_id: self.id.clone(),
                step_id: step.into(),
                prompt: Some(prompt.into()),
                additional_context: None,
            })
            .await
            .unwrap();
    }

    /// Adds a required step input mapped to a workflow input.
    pub async fn map(&mut self, step: &str, input: &str, workflow_input: &str) {
        let input_id = self
            .client
            .add_step_input(pb::AddStepInputRequest {
                workflow_id: self.id.clone(),
                step_id: step.into(),
                name: input.into(),
                required: true,
            })
            .await
            .unwrap()
            .into_inner()
            .new_input_id;
        self.client
            .map_step_input(pb::MapStepInputRequest {
                workflow_id: self.id.clone(),
                input_id,
                workflow_input_id: Some(workflow_input.into()),
            })
            .await
            .unwrap();
    }
}

pub async fn runs_client(server: &TestServer) -> RunServiceClient<Channel> {
    RunServiceClient::new(server.channel().await)
}

pub async fn start(server: &TestServer, workflow: &str, values: &[(&str, &str)]) -> pb::Run {
    runs_client(server)
        .await
        .start_run(pb::StartRunRequest {
            workflow_id: workflow.into(),
            values: values
                .iter()
                .map(|(k, v)| (k.to_string(), v.to_string()))
                .collect(),
        })
        .await
        .unwrap()
        .into_inner()
        .run
        .unwrap()
}

pub async fn get(server: &TestServer, workflow: &str, run: &str) -> pb::Run {
    runs_client(server)
        .await
        .get_run(pb::GetRunRequest {
            workflow_id: workflow.into(),
            run_id: run.into(),
        })
        .await
        .unwrap()
        .into_inner()
        .run
        .unwrap()
}

fn terminal(run: &pb::Run) -> bool {
    matches!(
        run.status(),
        pb::RunStatus::Succeeded | pb::RunStatus::Failed | pb::RunStatus::Cancelled
    )
}

/// Polls until the run is terminal and no step run is still running.
pub async fn settle(server: &TestServer, workflow: &str, run: &str) -> pb::Run {
    for _ in 0..400 {
        let r = get(server, workflow, run).await;
        let busy = r
            .step_runs
            .iter()
            .any(|s| s.status() == pb::StepRunStatus::Running);
        if terminal(&r) && !busy {
            // Let trailing jobs (duplicate dispatches) drain.
            tokio::time::sleep(Duration::from_millis(50)).await;
            return get(server, workflow, run).await;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    panic!(
        "run {run} did not settle: {:?}",
        get(server, workflow, run).await
    );
}

pub fn step<'a>(run: &'a pb::Run, name: &str) -> &'a pb::StepRunSummary {
    run.step_runs
        .iter()
        .find(|s| s.step_name == name)
        .unwrap_or_else(|| panic!("no step run {name}"))
}

pub async fn step_detail(server: &TestServer, run: &pb::Run, name: &str) -> pb::StepRun {
    runs_client(server)
        .await
        .get_step_run(pb::GetStepRunRequest {
            workflow_id: run.workflow_id.clone(),
            run_id: run.id.clone(),
            step_run_id: step(run, name).id.clone(),
        })
        .await
        .unwrap()
        .into_inner()
        .step_run
        .unwrap()
}

pub async fn run_events(pool: &PgPool, run: &str) -> Vec<String> {
    sqlx::query_scalar("SELECT event_type FROM events WHERE stream = $1 ORDER BY id")
        .bind(format!("WorkflowRun${run}"))
        .fetch_all(pool)
        .await
        .unwrap()
}
