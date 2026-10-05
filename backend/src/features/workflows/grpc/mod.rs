mod convert;

pub use convert::workflow as workflow_to_pb;

use tonic::{Request, Response, Status};

use crate::features::workflows::application::WorkflowService;
use crate::features::workflows::domain::schedule_calculator::{IntervalUnit, Recurrence};
use crate::features::workflows::domain::workflow::WorkflowInputFields;
use crate::features::workflows::ports::repository::ListFilter;
use crate::proto::convert::{issues, parse_id, parse_opt_id};
use crate::proto::pb;
use crate::proto::pb::save_schedule_request::Recurrence as PbRecurrence;
use crate::proto::pb::workflow_service_server::WorkflowService as Rpc;

#[derive(Clone)]
pub struct WorkflowGrpc {
    service: WorkflowService,
}

impl WorkflowGrpc {
    pub fn new(service: WorkflowService) -> Self {
        Self { service }
    }
}

type Rsp<T> = Result<Response<T>, Status>;

/// Builds `{workflow, issues, ..extra}` mutation responses.
macro_rules! mutation {
    ($ty:ident, $m:expr) => {{
        let m = $m;
        Ok(Response::new(pb::$ty {
            workflow: Some(convert::workflow(&m.workflow)),
            issues: issues(&m.issues),
        }))
    }};
    ($ty:ident, $m:expr, |$v:ident| { $($field:ident: $value:expr),* $(,)? }) => {{
        let m = $m;
        let $v = &m.value;
        Ok(Response::new(pb::$ty {
            workflow: Some(convert::workflow(&m.workflow)),
            issues: issues(&m.issues),
            $($field: $value),*
        }))
    }};
}

fn input_fields(
    name: String,
    description: Option<String>,
    required: bool,
    value: Option<String>,
    ask_at_run_time: bool,
) -> WorkflowInputFields {
    WorkflowInputFields {
        name,
        description,
        required,
        value,
        ask_at_run_time,
    }
}

fn recurrence(raw: Option<PbRecurrence>) -> Result<Option<Recurrence>, Status> {
    Ok(match raw {
        None => {
            return Err(Status::invalid_argument(
                "Unable to save — the recurrence or timezone is invalid.",
            ));
        }
        Some(PbRecurrence::None(_)) => None,
        Some(PbRecurrence::Interval(i)) => Some(Recurrence::Interval {
            every: i.every,
            unit: match pb::IntervalUnit::try_from(i.unit) {
                Ok(pb::IntervalUnit::Hours) => IntervalUnit::Hours,
                Ok(pb::IntervalUnit::Minutes) => IntervalUnit::Minutes,
                _ => {
                    return Err(Status::invalid_argument(
                        "Unable to save — the recurrence or timezone is invalid.",
                    ));
                }
            },
        }),
        Some(PbRecurrence::Daily(d)) => Some(Recurrence::Daily {
            hour: d.hour,
            minute: d.minute,
        }),
        Some(PbRecurrence::Weekly(w)) => Some(Recurrence::Weekly {
            weekday: w.weekday,
            hour: w.hour,
            minute: w.minute,
        }),
        Some(PbRecurrence::Monthly(m)) => Some(Recurrence::Monthly {
            day: m.day,
            hour: m.hour,
            minute: m.minute,
        }),
        Some(PbRecurrence::Cron(c)) => Some(Recurrence::Cron {
            expression: c.expression,
        }),
    })
}

#[tonic::async_trait]
impl Rpc for WorkflowGrpc {
    async fn list_workflows(
        &self,
        r: Request<pb::ListWorkflowsRequest>,
    ) -> Rsp<pb::ListWorkflowsResponse> {
        let r = r.into_inner();
        let status = match r.status {
            None => None,
            Some(raw) => Some(
                convert::status_from_pb(raw)
                    .ok_or_else(|| Status::invalid_argument("status is invalid"))?,
            ),
        };
        let workflows = self
            .service
            .list(ListFilter {
                query: r.query,
                status,
                limit: i64::from(r.limit),
            })
            .await?;
        Ok(Response::new(pb::ListWorkflowsResponse {
            workflows: workflows.iter().map(convert::summary).collect(),
        }))
    }

    async fn get_workflow(
        &self,
        r: Request<pb::GetWorkflowRequest>,
    ) -> Rsp<pb::GetWorkflowResponse> {
        let (workflow, found) = self.service.get(parse_id(&r.get_ref().id, "id")?).await?;
        Ok(Response::new(pb::GetWorkflowResponse {
            workflow: Some(convert::workflow(&workflow)),
            issues: issues(&found),
        }))
    }

    async fn create_workflow(
        &self,
        r: Request<pb::CreateWorkflowRequest>,
    ) -> Rsp<pb::CreateWorkflowResponse> {
        let r = r.into_inner();
        mutation!(
            CreateWorkflowResponse,
            self.service
                .create(&r.name, r.description, r.fail_fast)
                .await?
        )
    }

    async fn update_workflow(
        &self,
        r: Request<pb::UpdateWorkflowRequest>,
    ) -> Rsp<pb::UpdateWorkflowResponse> {
        let r = r.into_inner();
        let id = parse_id(&r.id, "id")?;
        mutation!(
            UpdateWorkflowResponse,
            self.service
                .update(id, r.name, r.description, r.fail_fast)
                .await?
        )
    }

    async fn delete_workflow(
        &self,
        r: Request<pb::DeleteWorkflowRequest>,
    ) -> Rsp<pb::DeleteWorkflowResponse> {
        self.service
            .delete(parse_id(&r.get_ref().id, "id")?)
            .await?;
        Ok(Response::new(pb::DeleteWorkflowResponse {}))
    }

    async fn validate_workflow(
        &self,
        r: Request<pb::ValidateWorkflowRequest>,
    ) -> Rsp<pb::ValidateWorkflowResponse> {
        let found = self
            .service
            .validate(parse_id(&r.get_ref().id, "id")?)
            .await?;
        Ok(Response::new(pb::ValidateWorkflowResponse {
            issues: issues(&found),
        }))
    }

    async fn add_step(&self, r: Request<pb::AddStepRequest>) -> Rsp<pb::AddStepResponse> {
        let r = r.into_inner();
        let id = parse_id(&r.workflow_id, "workflow_id")?;
        let position = r.canvas_x.zip(r.canvas_y);
        let m = self
            .service
            .add_step(id, convert::kind_from_pb(r.kind), position)
            .await?;
        mutation!(AddStepResponse, m, |v| { new_step_id: v.to_string() })
    }

    async fn duplicate_step(
        &self,
        r: Request<pb::DuplicateStepRequest>,
    ) -> Rsp<pb::DuplicateStepResponse> {
        let r = r.into_inner();
        let m = self
            .service
            .duplicate_step(
                parse_id(&r.workflow_id, "workflow_id")?,
                parse_id(&r.step_id, "step_id")?,
            )
            .await?;
        mutation!(DuplicateStepResponse, m, |v| { new_step_id: v.to_string() })
    }

    async fn update_step_details(
        &self,
        r: Request<pb::UpdateStepDetailsRequest>,
    ) -> Rsp<pb::UpdateStepDetailsResponse> {
        let r = r.into_inner();
        let m = self
            .service
            .update_step_details(
                parse_id(&r.workflow_id, "workflow_id")?,
                parse_id(&r.step_id, "step_id")?,
                r.name,
                r.description,
                r.allow_failure,
            )
            .await?;
        mutation!(UpdateStepDetailsResponse, m)
    }

    async fn update_step_prompt(
        &self,
        r: Request<pb::UpdateStepPromptRequest>,
    ) -> Rsp<pb::UpdateStepPromptResponse> {
        let r = r.into_inner();
        let m = self
            .service
            .update_step_prompt(
                parse_id(&r.workflow_id, "workflow_id")?,
                parse_id(&r.step_id, "step_id")?,
                r.prompt,
                r.additional_context,
            )
            .await?;
        mutation!(UpdateStepPromptResponse, m)
    }

    async fn update_step_output(
        &self,
        r: Request<pb::UpdateStepOutputRequest>,
    ) -> Rsp<pb::UpdateStepOutputResponse> {
        let r = r.into_inner();
        let m = self
            .service
            .update_step_output(
                parse_id(&r.workflow_id, "workflow_id")?,
                parse_id(&r.step_id, "step_id")?,
                r.output_name,
                r.output_description,
                r.expected_output,
                convert::format_from_pb(r.output_file_format),
            )
            .await?;
        mutation!(UpdateStepOutputResponse, m)
    }

    async fn update_step_model(
        &self,
        r: Request<pb::UpdateStepModelRequest>,
    ) -> Rsp<pb::UpdateStepModelResponse> {
        let r = r.into_inner();
        let m = self
            .service
            .update_step_model(
                parse_id(&r.workflow_id, "workflow_id")?,
                parse_id(&r.step_id, "step_id")?,
                r.model_id,
                r.temperature,
            )
            .await?;
        mutation!(UpdateStepModelResponse, m)
    }

    async fn toggle_step_tool(
        &self,
        r: Request<pb::ToggleStepToolRequest>,
    ) -> Rsp<pb::ToggleStepToolResponse> {
        let r = r.into_inner();
        let m = self
            .service
            .toggle_step_tool(
                parse_id(&r.workflow_id, "workflow_id")?,
                parse_id(&r.step_id, "step_id")?,
                r.tool_key,
            )
            .await?;
        mutation!(ToggleStepToolResponse, m)
    }

    async fn move_step(&self, r: Request<pb::MoveStepRequest>) -> Rsp<pb::MoveStepResponse> {
        let r = r.into_inner();
        let m = self
            .service
            .move_step(
                parse_id(&r.workflow_id, "workflow_id")?,
                parse_id(&r.step_id, "step_id")?,
                r.canvas_x,
                r.canvas_y,
            )
            .await?;
        mutation!(MoveStepResponse, m)
    }

    async fn delete_step(&self, r: Request<pb::DeleteStepRequest>) -> Rsp<pb::DeleteStepResponse> {
        let r = r.into_inner();
        let m = self
            .service
            .delete_step(
                parse_id(&r.workflow_id, "workflow_id")?,
                parse_id(&r.step_id, "step_id")?,
            )
            .await?;
        mutation!(DeleteStepResponse, m)
    }

    async fn add_step_input(
        &self,
        r: Request<pb::AddStepInputRequest>,
    ) -> Rsp<pb::AddStepInputResponse> {
        let r = r.into_inner();
        let m = self
            .service
            .add_step_input(
                parse_id(&r.workflow_id, "workflow_id")?,
                parse_id(&r.step_id, "step_id")?,
                r.name,
                r.required,
            )
            .await?;
        mutation!(AddStepInputResponse, m, |v| { new_input_id: v.to_string() })
    }

    async fn remove_step_input(
        &self,
        r: Request<pb::RemoveStepInputRequest>,
    ) -> Rsp<pb::RemoveStepInputResponse> {
        let r = r.into_inner();
        let m = self
            .service
            .remove_step_input(
                parse_id(&r.workflow_id, "workflow_id")?,
                parse_id(&r.input_id, "input_id")?,
            )
            .await?;
        mutation!(RemoveStepInputResponse, m)
    }

    async fn map_step_input(
        &self,
        r: Request<pb::MapStepInputRequest>,
    ) -> Rsp<pb::MapStepInputResponse> {
        let r = r.into_inner();
        let m = self
            .service
            .map_step_input(
                parse_id(&r.workflow_id, "workflow_id")?,
                parse_id(&r.input_id, "input_id")?,
                parse_opt_id(r.workflow_input_id.as_deref(), "workflow_input_id")?,
            )
            .await?;
        mutation!(MapStepInputResponse, m)
    }

    async fn add_shared_text(
        &self,
        r: Request<pb::AddSharedTextRequest>,
    ) -> Rsp<pb::AddSharedTextResponse> {
        let r = r.into_inner();
        let m = self
            .service
            .add_shared_text(
                parse_id(&r.workflow_id, "workflow_id")?,
                r.key,
                r.description,
                r.body,
            )
            .await?;
        mutation!(AddSharedTextResponse, m, |v| { new_text_id: v.to_string() })
    }

    async fn update_shared_text(
        &self,
        r: Request<pb::UpdateSharedTextRequest>,
    ) -> Rsp<pb::UpdateSharedTextResponse> {
        let r = r.into_inner();
        let m = self
            .service
            .update_shared_text(
                parse_id(&r.workflow_id, "workflow_id")?,
                parse_id(&r.text_id, "text_id")?,
                r.key,
                r.description,
                r.body,
            )
            .await?;
        mutation!(UpdateSharedTextResponse, m)
    }

    async fn remove_shared_text(
        &self,
        r: Request<pb::RemoveSharedTextRequest>,
    ) -> Rsp<pb::RemoveSharedTextResponse> {
        let r = r.into_inner();
        let m = self
            .service
            .remove_shared_text(
                parse_id(&r.workflow_id, "workflow_id")?,
                parse_id(&r.text_id, "text_id")?,
            )
            .await?;
        mutation!(RemoveSharedTextResponse, m)
    }

    async fn set_step_text_ref(
        &self,
        r: Request<pb::SetStepTextRefRequest>,
    ) -> Rsp<pb::SetStepTextRefResponse> {
        let r = r.into_inner();
        let field = convert::text_field_from_pb(r.field)?;
        let text_ref = r
            .r#ref
            .map(
                |r| -> Result<crate::features::workflows::domain::model::TextRef, Status> {
                    let mut vars = std::collections::BTreeMap::new();
                    for (k, v) in r.vars {
                        vars.insert(k, v);
                    }
                    Ok(crate::features::workflows::domain::model::TextRef {
                        text_id: parse_id(&r.text_id, "text_id")?,
                        vars,
                    })
                },
            )
            .transpose()?;
        let m = self
            .service
            .set_step_text_ref(
                parse_id(&r.workflow_id, "workflow_id")?,
                parse_id(&r.step_id, "step_id")?,
                field,
                text_ref,
            )
            .await?;
        mutation!(SetStepTextRefResponse, m)
    }

    async fn extract_shared_text(
        &self,
        r: Request<pb::ExtractSharedTextRequest>,
    ) -> Rsp<pb::ExtractSharedTextResponse> {
        let r = r.into_inner();
        let field = convert::text_field_from_pb(r.field)?;
        let m = self
            .service
            .extract_shared_text(
                parse_id(&r.workflow_id, "workflow_id")?,
                parse_id(&r.step_id, "step_id")?,
                field,
                r.key,
            )
            .await?;
        mutation!(ExtractSharedTextResponse, m, |v| { new_text_id: v.to_string() })
    }

    async fn add_workflow_input(
        &self,
        r: Request<pb::AddWorkflowInputRequest>,
    ) -> Rsp<pb::AddWorkflowInputResponse> {
        let r = r.into_inner();
        let m = self
            .service
            .add_workflow_input(
                parse_id(&r.workflow_id, "workflow_id")?,
                input_fields(
                    r.name,
                    r.description,
                    r.required,
                    r.value,
                    r.ask_at_run_time,
                ),
            )
            .await?;
        mutation!(AddWorkflowInputResponse, m, |v| { new_input_id: v.to_string() })
    }

    async fn update_workflow_input(
        &self,
        r: Request<pb::UpdateWorkflowInputRequest>,
    ) -> Rsp<pb::UpdateWorkflowInputResponse> {
        let r = r.into_inner();
        let m = self
            .service
            .update_workflow_input(
                parse_id(&r.workflow_id, "workflow_id")?,
                parse_id(&r.input_id, "input_id")?,
                input_fields(
                    r.name,
                    r.description,
                    r.required,
                    r.value,
                    r.ask_at_run_time,
                ),
            )
            .await?;
        mutation!(UpdateWorkflowInputResponse, m)
    }

    async fn remove_workflow_input(
        &self,
        r: Request<pb::RemoveWorkflowInputRequest>,
    ) -> Rsp<pb::RemoveWorkflowInputResponse> {
        let r = r.into_inner();
        let m = self
            .service
            .remove_workflow_input(
                parse_id(&r.workflow_id, "workflow_id")?,
                parse_id(&r.input_id, "input_id")?,
            )
            .await?;
        mutation!(RemoveWorkflowInputResponse, m)
    }

    async fn create_connection(
        &self,
        r: Request<pb::CreateConnectionRequest>,
    ) -> Rsp<pb::CreateConnectionResponse> {
        let r = r.into_inner();
        let m = self
            .service
            .create_connection(
                parse_id(&r.workflow_id, "workflow_id")?,
                parse_id(&r.source_step_id, "source_step_id")?,
                parse_id(&r.destination_input_id, "destination_input_id")?,
                r.replace_existing,
            )
            .await?;
        mutation!(CreateConnectionResponse, m, |v| { connection_id: v.to_string() })
    }

    async fn connect_output_to_step(
        &self,
        r: Request<pb::ConnectOutputToStepRequest>,
    ) -> Rsp<pb::ConnectOutputToStepResponse> {
        let r = r.into_inner();
        let m = self
            .service
            .connect_output_to_step(
                parse_id(&r.workflow_id, "workflow_id")?,
                parse_id(&r.source_step_id, "source_step_id")?,
                parse_id(&r.target_step_id, "target_step_id")?,
            )
            .await?;
        mutation!(ConnectOutputToStepResponse, m, |v| {
            connection_id: v.0.to_string(),
            new_input_id: v.1.to_string(),
        })
    }

    async fn remove_connection(
        &self,
        r: Request<pb::RemoveConnectionRequest>,
    ) -> Rsp<pb::RemoveConnectionResponse> {
        let r = r.into_inner();
        let m = self
            .service
            .remove_connection(
                parse_id(&r.workflow_id, "workflow_id")?,
                parse_id(&r.connection_id, "connection_id")?,
            )
            .await?;
        mutation!(RemoveConnectionResponse, m)
    }

    async fn save_schedule(
        &self,
        r: Request<pb::SaveScheduleRequest>,
    ) -> Rsp<pb::SaveScheduleResponse> {
        let r = r.into_inner();
        let id = parse_id(&r.workflow_id, "workflow_id")?;
        let m = self
            .service
            .save_schedule(id, recurrence(r.recurrence)?, r.timezone, r.enabled)
            .await?;
        mutation!(SaveScheduleResponse, m)
    }

    async fn set_schedule_value(
        &self,
        r: Request<pb::SetScheduleValueRequest>,
    ) -> Rsp<pb::SetScheduleValueResponse> {
        let r = r.into_inner();
        let m = self
            .service
            .set_schedule_value(
                parse_id(&r.workflow_id, "workflow_id")?,
                parse_id(&r.workflow_input_id, "workflow_input_id")?,
                r.value,
            )
            .await?;
        mutation!(SetScheduleValueResponse, m)
    }

    async fn activate_workflow(
        &self,
        r: Request<pb::ActivateWorkflowRequest>,
    ) -> Rsp<pb::ActivateWorkflowResponse> {
        mutation!(
            ActivateWorkflowResponse,
            self.service
                .activate(parse_id(&r.get_ref().id, "id")?)
                .await?
        )
    }

    async fn pause_workflow(
        &self,
        r: Request<pb::PauseWorkflowRequest>,
    ) -> Rsp<pb::PauseWorkflowResponse> {
        mutation!(
            PauseWorkflowResponse,
            self.service.pause(parse_id(&r.get_ref().id, "id")?).await?
        )
    }

    async fn resume_workflow(
        &self,
        r: Request<pb::ResumeWorkflowRequest>,
    ) -> Rsp<pb::ResumeWorkflowResponse> {
        let m = self
            .service
            .resume(parse_id(&r.get_ref().id, "id")?)
            .await?;
        mutation!(ResumeWorkflowResponse, m, |v| { resumed: *v })
    }
}
