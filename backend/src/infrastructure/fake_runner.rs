//! Deterministic stand-in for the Pi agent (`GLYPH_STEP_RUNNER=fake`).
//! Behaviour is picked by markers in the prompt:
//! `FAKE_FAIL` → model error, `FAKE_SLEEP:<ms>` → delay, otherwise success
//! with an output matching the step's file format.

use std::sync::Arc;
use std::time::{Duration, Instant};

use async_trait::async_trait;
use serde_json::{Value, json};

use crate::features::runs::{OutcomeStatus, ProgressSink, StepRunContext, StepRunOutcome, StepRunner};
use crate::shared::output_format::OutputFileFormat;

#[derive(Debug, Default, Clone)]
pub struct FakeStepRunner;

fn sleep_ms(prompt: &str) -> Option<u64> {
    let rest = prompt.split("FAKE_SLEEP:").nth(1)?;
    rest.chars().take_while(|c| c.is_ascii_digit()).collect::<String>().parse().ok()
}

#[async_trait]
impl StepRunner for FakeStepRunner {
    async fn run(&self, ctx: StepRunContext, progress: Arc<dyn ProgressSink>) -> StepRunOutcome {
        let started = Instant::now();
        let prompt = ctx.prompt.clone().unwrap_or_default();
        let session = json!({ "type": "session", "fake": true, "step": ctx.step_name }).to_string();
        progress.report(session.clone()).await;
        if let Some(ms) = sleep_ms(&prompt) {
            tokio::time::sleep(Duration::from_millis(ms)).await;
        }
        let elapsed_ms = started.elapsed().as_millis() as i64;
        if prompt.contains("FAKE_FAIL") {
            return StepRunOutcome {
                status: OutcomeStatus::ModelError,
                output_text: None,
                output: None,
                messages: Some(json!([{ "role": "assistant", "text": "", "tool_calls": 0, "stop_reason": "error", "error": "fake failure" }])),
                session_content: Some(session),
                usage: None,
                exit_status: Some(0),
                human_error: Some("The selected model or provider could not complete the step.".into()),
                technical_error: Some("fake failure".into()),
                elapsed_ms,
            };
        }
        let summary = if ctx.inputs.is_empty() {
            String::new()
        } else {
            format!(" with inputs {}", Value::Object(ctx.inputs.clone()))
        };
        let (text, output) = match ctx.output_file_format {
            OutputFileFormat::Html => (
                format!("<!doctype html><html><body><h1>{}</h1></body></html>", ctx.step_name),
                None,
            ),
            OutputFileFormat::Json => {
                let v = json!({ "step": ctx.step_name, "inputs": Value::Object(ctx.inputs.clone()) });
                (v.to_string(), Some(v))
            }
            _ => (format!("Fake output from {}{summary}", ctx.step_name), None),
        };
        StepRunOutcome {
            status: OutcomeStatus::Success,
            messages: Some(json!([{ "role": "assistant", "text": text, "tool_calls": 0 }])),
            output_text: Some(text),
            output,
            session_content: Some(session),
            usage: Some(json!({})),
            exit_status: Some(0),
            human_error: None,
            technical_error: None,
            elapsed_ms,
        }
    }
}
