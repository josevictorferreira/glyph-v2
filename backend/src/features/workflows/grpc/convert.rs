use crate::features::workflows::domain::model::*;
use crate::proto::convert::{opt_timestamp, timestamp};
use crate::proto::pb;
use crate::shared::output_format::OutputFileFormat;

pub fn status(s: WorkflowStatus) -> pb::WorkflowStatus {
    match s {
        WorkflowStatus::Draft => pb::WorkflowStatus::Draft,
        WorkflowStatus::Active => pb::WorkflowStatus::Active,
        WorkflowStatus::Paused => pb::WorkflowStatus::Paused,
        WorkflowStatus::NeedsAttention => pb::WorkflowStatus::NeedsAttention,
    }
}

pub fn status_from_pb(raw: i32) -> Option<WorkflowStatus> {
    match pb::WorkflowStatus::try_from(raw).ok()? {
        pb::WorkflowStatus::Draft => Some(WorkflowStatus::Draft),
        pb::WorkflowStatus::Active => Some(WorkflowStatus::Active),
        pb::WorkflowStatus::Paused => Some(WorkflowStatus::Paused),
        pb::WorkflowStatus::NeedsAttention => Some(WorkflowStatus::NeedsAttention),
        pb::WorkflowStatus::Unspecified => None,
    }
}

pub fn kind(k: StepKind) -> pb::StepKind {
    match k {
        StepKind::Pi => pb::StepKind::Pi,
        StepKind::Helper => pb::StepKind::Helper,
    }
}

pub fn kind_from_pb(raw: i32) -> StepKind {
    match pb::StepKind::try_from(raw) {
        Ok(pb::StepKind::Helper) => StepKind::Helper,
        _ => StepKind::Pi,
    }
}

pub fn format(f: OutputFileFormat) -> pb::OutputFileFormat {
    match f {
        OutputFileFormat::FreeTextMarkdown => pb::OutputFileFormat::FreeTextMarkdown,
        OutputFileFormat::Html => pb::OutputFileFormat::Html,
        OutputFileFormat::Json => pb::OutputFileFormat::Json,
        OutputFileFormat::Zip => pb::OutputFileFormat::Zip,
    }
}

pub fn format_from_pb(raw: i32) -> OutputFileFormat {
    match pb::OutputFileFormat::try_from(raw) {
        Ok(pb::OutputFileFormat::Html) => OutputFileFormat::Html,
        Ok(pb::OutputFileFormat::Json) => OutputFileFormat::Json,
        Ok(pb::OutputFileFormat::Zip) => OutputFileFormat::Zip,
        _ => OutputFileFormat::FreeTextMarkdown,
    }
}

pub fn run_status_from_str(raw: &str) -> Option<pb::RunStatus> {
    Some(match raw {
        "queued" => pb::RunStatus::Queued,
        "running" => pb::RunStatus::Running,
        "succeeded" => pb::RunStatus::Succeeded,
        "failed" => pb::RunStatus::Failed,
        "cancelled" => pb::RunStatus::Cancelled,
        _ => return None,
    })
}

pub fn summary(s: &WorkflowSummary) -> pb::WorkflowSummary {
    pb::WorkflowSummary {
        id: s.id.to_string(),
        name: s.name.clone(),
        description: s.description.clone(),
        status: status(s.status) as i32,
        fail_fast: s.fail_fast,
        last_run_at: opt_timestamp(s.last_run_at),
        last_run_status: s
            .last_run_status
            .as_deref()
            .and_then(run_status_from_str)
            .map(|s| s as i32),
        next_run_at: opt_timestamp(s.next_run_at),
        schedule_summary: s.schedule_summary.clone(),
        created_at: Some(timestamp(s.created_at)),
        updated_at: Some(timestamp(s.updated_at)),
    }
}

pub fn workflow(wf: &Workflow) -> pb::Workflow {
    pb::Workflow {
        summary: Some(summary(&WorkflowSummary::of(wf))),
        inputs: wf
            .inputs
            .iter()
            .map(|i| pb::WorkflowInput {
                id: i.id.to_string(),
                name: i.name.clone(),
                description: i.description.clone(),
                required: i.required,
                ask_at_run_time: i.ask_at_run_time,
                value: i.value.clone(),
                position: i.position,
            })
            .collect(),
        steps: wf
            .steps
            .iter()
            .map(|s| pb::Step {
                id: s.id.to_string(),
                kind: kind(s.kind) as i32,
                name: s.name.clone(),
                description: s.description.clone(),
                prompt: s.prompt.clone(),
                additional_context: s.additional_context.clone(),
                expected_output: s.expected_output.clone(),
                output_name: s.output_name.clone(),
                output_description: s.output_description.clone(),
                output_file_format: format(s.output_file_format) as i32,
                model_id: s.model_id.clone(),
                temperature: s.temperature(),
                enabled_tool_keys: s.enabled_tool_ids.clone(),
                allow_failure: s.allow_failure,
                canvas_x: s.canvas_x,
                canvas_y: s.canvas_y,
                position: s.position,
                inputs: s
                    .inputs
                    .iter()
                    .map(|i| pb::StepInput {
                        id: i.id.to_string(),
                        name: i.name.clone(),
                        description: i.description.clone(),
                        required: i.required,
                        position: i.position,
                        workflow_input_id: i.workflow_input_id.map(|w| w.to_string()),
                        incoming_connection_id: wf
                            .incoming_connection(i.id)
                            .map(|c| c.id.to_string()),
                    })
                    .collect(),
                configured: s.configured(),
            })
            .collect(),
        connections: wf
            .connections
            .iter()
            .map(|c| pb::Connection {
                id: c.id.to_string(),
                source_step_id: c.source_step_id.to_string(),
                source_output_name: c.source_output_name.clone(),
                destination_step_id: c.destination_step_id.to_string(),
                destination_input_id: c.destination_input_id.to_string(),
            })
            .collect(),
        schedule: wf.schedule.as_ref().map(|s| pb::Schedule {
            id: s.id.to_string(),
            enabled: s.enabled,
            cron_expression: s.cron_expression.clone(),
            timezone: s.timezone.clone(),
            human_description: s.human_description.clone(),
            next_run_at: opt_timestamp(s.next_run_at),
            last_dispatched_at: opt_timestamp(s.last_dispatched_at),
            values: s
                .values
                .iter()
                .map(|v| pb::ScheduleValue {
                    workflow_input_id: v.workflow_input_id.to_string(),
                    value: v.value.clone().unwrap_or_default(),
                })
                .collect(),
        }),
    }
}
