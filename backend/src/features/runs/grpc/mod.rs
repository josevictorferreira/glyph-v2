pub mod convert;

use serde_json::{Map, Value};
use tonic::{Request, Response, Status};

use crate::features::runs::application::RunService;
use crate::features::runs::domain::model::{Run, StepRun};
use crate::features::runs::ports::repository::RunListFilter;
use crate::proto::convert::{from_timestamp, json_to_value, parse_id};
use crate::proto::pb;
use crate::proto::pb::run_service_server::RunService as Rpc;
use crate::shared::output_format::OutputFileFormat;

#[derive(Clone)]
pub struct RunGrpc {
    service: RunService,
}

impl RunGrpc {
    pub fn new(service: RunService) -> Self {
        Self { service }
    }
}

type Rsp<T> = Result<Response<T>, Status>;

pub fn download_path(run: &Run, step_run: &StepRun) -> String {
    format!(
        "/workflows/{}/runs/{}/step_runs/{}/download",
        run.workflow_id, run.id, step_run.id
    )
}

fn step_run_detail(run: &Run, s: &StepRun) -> pb::StepRun {
    let preview = (s.output_file_format == OutputFileFormat::Html && s.has_output()).then(|| {
        format!(
            "/workflows/{}/runs/{}/step_runs/{}/preview",
            run.workflow_id, run.id, s.id
        )
    });
    pb::StepRun {
        summary: Some(convert::step_summary(s)),
        prompt: s.prompt.clone(),
        additional_context: s.additional_context.clone(),
        expected_output: s.expected_output.clone(),
        model_id: s.model_id.clone(),
        temperature: s.model_settings.get("temperature").and_then(Value::as_f64),
        enabled_tool_names: s
            .enabled_tools
            .iter()
            .map(|t| t.pi_tool_name.clone())
            .collect(),
        resolved_inputs: convert::resolved_inputs(s.resolved_inputs.as_ref()),
        output_text: s.output_text.clone(),
        output_json: s.output.as_ref().map(json_to_value),
        messages: convert::messages(s.messages.as_ref()),
        transcript: crate::features::runs::transcript_blocks(s.session_content.as_deref()),
        technical_error: s.technical_error.clone(),
        download_path: download_path(run, s),
        preview_path: preview,
    }
}

#[tonic::async_trait]
impl Rpc for RunGrpc {
    async fn start_run(&self, r: Request<pb::StartRunRequest>) -> Rsp<pb::StartRunResponse> {
        let r = r.into_inner();
        let values: Map<String, Value> = r
            .values
            .into_iter()
            .map(|(k, v)| (k, Value::String(v)))
            .collect();
        let run = self
            .service
            .start_run(parse_id(&r.workflow_id, "workflow_id")?, values)
            .await?;
        let (run, step_runs) = self.service.get_run(run.workflow_id, run.id).await?;
        Ok(Response::new(pb::StartRunResponse {
            run: Some(convert::run(&run, &step_runs, true)),
        }))
    }

    async fn list_runs(&self, r: Request<pb::ListRunsRequest>) -> Rsp<pb::ListRunsResponse> {
        let r = r.into_inner();
        let runs = self
            .service
            .list_runs(
                parse_id(&r.workflow_id, "workflow_id")?,
                RunListFilter {
                    limit: i64::from(r.limit),
                    before: r.before.as_ref().and_then(from_timestamp),
                },
            )
            .await?;
        Ok(Response::new(pb::ListRunsResponse {
            runs: runs
                .iter()
                .map(|run| convert::run(run, &[], false))
                .collect(),
        }))
    }

    async fn get_run(&self, r: Request<pb::GetRunRequest>) -> Rsp<pb::GetRunResponse> {
        let r = r.into_inner();
        let (run, step_runs) = self
            .service
            .get_run(
                parse_id(&r.workflow_id, "workflow_id")?,
                parse_id(&r.run_id, "run_id")?,
            )
            .await?;
        Ok(Response::new(pb::GetRunResponse {
            run: Some(convert::run(&run, &step_runs, true)),
        }))
    }

    async fn get_step_run(&self, r: Request<pb::GetStepRunRequest>) -> Rsp<pb::GetStepRunResponse> {
        let r = r.into_inner();
        let (run, step_run) = self
            .service
            .get_step_run(
                parse_id(&r.workflow_id, "workflow_id")?,
                parse_id(&r.run_id, "run_id")?,
                parse_id(&r.step_run_id, "step_run_id")?,
            )
            .await?;
        Ok(Response::new(pb::GetStepRunResponse {
            step_run: Some(step_run_detail(&run, &step_run)),
        }))
    }

    async fn stop_run(&self, r: Request<pb::StopRunRequest>) -> Rsp<pb::StopRunResponse> {
        let r = r.into_inner();
        let workflow = parse_id(&r.workflow_id, "workflow_id")?;
        let run = self
            .service
            .stop_run(workflow, parse_id(&r.run_id, "run_id")?)
            .await?;
        let (run, step_runs) = self.service.get_run(workflow, run.id).await?;
        Ok(Response::new(pb::StopRunResponse {
            run: Some(convert::run(&run, &step_runs, true)),
        }))
    }

    async fn retry_step(&self, r: Request<pb::RetryStepRequest>) -> Rsp<pb::RetryStepResponse> {
        let r = r.into_inner();
        let workflow = parse_id(&r.workflow_id, "workflow_id")?;
        let run = self
            .service
            .retry_step(
                workflow,
                parse_id(&r.run_id, "run_id")?,
                parse_id(&r.step_run_id, "step_run_id")?,
            )
            .await?;
        let (run, step_runs) = self.service.get_run(workflow, run.id).await?;
        Ok(Response::new(pb::RetryStepResponse {
            run: Some(convert::run(&run, &step_runs, true)),
        }))
    }

    async fn delete_run(&self, r: Request<pb::DeleteRunRequest>) -> Rsp<pb::DeleteRunResponse> {
        let r = r.into_inner();
        self.service
            .delete_run(
                parse_id(&r.workflow_id, "workflow_id")?,
                parse_id(&r.run_id, "run_id")?,
            )
            .await?;
        Ok(Response::new(pb::DeleteRunResponse {}))
    }
}
