use crate::features::runs::domain::model::*;
use crate::features::workflows::model::StepKind;
use crate::features::workflows::snapshot::Snapshot;
use crate::proto::convert::{json_to_value, opt_timestamp, timestamp};
use crate::proto::pb;
use crate::shared::output_format::OutputFileFormat;

pub fn run_status(s: RunStatus) -> pb::RunStatus {
    match s {
        RunStatus::Queued => pb::RunStatus::Queued,
        RunStatus::Running => pb::RunStatus::Running,
        RunStatus::Succeeded => pb::RunStatus::Succeeded,
        RunStatus::Failed => pb::RunStatus::Failed,
        RunStatus::Cancelled => pb::RunStatus::Cancelled,
    }
}

pub fn step_status(s: StepRunStatus) -> pb::StepRunStatus {
    match s {
        StepRunStatus::Queued => pb::StepRunStatus::Queued,
        StepRunStatus::Running => pb::StepRunStatus::Running,
        StepRunStatus::Succeeded => pb::StepRunStatus::Succeeded,
        StepRunStatus::Failed => pb::StepRunStatus::Failed,
        StepRunStatus::Skipped => pb::StepRunStatus::Skipped,
        StepRunStatus::Cancelled => pb::StepRunStatus::Cancelled,
    }
}

fn kind(k: StepKind) -> pb::StepKind {
    match k {
        StepKind::Pi => pb::StepKind::Pi,
        StepKind::Helper => pb::StepKind::Helper,
    }
}

fn format(f: OutputFileFormat) -> pb::OutputFileFormat {
    match f {
        OutputFileFormat::FreeTextMarkdown => pb::OutputFileFormat::FreeTextMarkdown,
        OutputFileFormat::Html => pb::OutputFileFormat::Html,
        OutputFileFormat::Json => pb::OutputFileFormat::Json,
        OutputFileFormat::Zip => pb::OutputFileFormat::Zip,
    }
}

fn workflow_status(raw: &str) -> pb::WorkflowStatus {
    match raw {
        "draft" => pb::WorkflowStatus::Draft,
        "active" => pb::WorkflowStatus::Active,
        "paused" => pb::WorkflowStatus::Paused,
        "needs_attention" => pb::WorkflowStatus::NeedsAttention,
        _ => pb::WorkflowStatus::Unspecified,
    }
}

pub fn snapshot(s: &Snapshot, with_steps: bool) -> pb::RunSnapshot {
    pb::RunSnapshot {
        version: s.version,
        captured_at: chrono::DateTime::parse_from_rfc3339(&s.captured_at)
            .ok()
            .map(|t| timestamp(t.to_utc())),
        workflow: Some(pb::SnapshotWorkflow {
            id: s.workflow.id.to_string(),
            name: s.workflow.name.clone(),
            description: s.workflow.description.clone(),
            status: workflow_status(&s.workflow.status) as i32,
            schedule: s.workflow.schedule.as_ref().map(|sc| pb::SnapshotSchedule {
                enabled: sc.enabled,
                cron_expression: sc.cron_expression.clone(),
                timezone: sc.timezone.clone(),
                human_description: sc.human_description.clone(),
            }),
            fail_fast: s.workflow.fail_fast,
        }),
        inputs: s
            .inputs
            .iter()
            .map(|i| pb::SnapshotInput {
                id: i.id.to_string(),
                name: i.name.clone(),
                description: i.description.clone(),
                required: i.required,
                position: i.position,
                value: i.value.clone(),
                ask_at_run_time: i.ask_at_run_time,
            })
            .collect(),
        steps: if !with_steps {
            Vec::new()
        } else {
            s.steps
                .iter()
                .map(|st| pb::SnapshotStep {
                    id: st.id.to_string(),
                    kind: kind(st.kind()) as i32,
                    allow_failure: st.allow_failure,
                    name: st.name.clone(),
                    description: st.description.clone(),
                    prompt: st.prompt.clone(),
                    additional_context: st.additional_context.clone(),
                    output_name: st.output_name.clone(),
                    output_description: st.output_description.clone(),
                    expected_output: st.expected_output.clone(),
                    output_file_format: format(st.output_file_format) as i32,
                    model_id: st.model_id.clone(),
                    temperature: st.temperature(),
                    enabled_tools: st
                        .enabled_tools
                        .iter()
                        .map(|t| pb::SnapshotTool {
                            key: t.key.clone(),
                            display_name: t.display_name.clone(),
                            pi_tool_name: t.pi_tool_name.clone(),
                        })
                        .collect(),
                    canvas_x: st.canvas_x,
                    canvas_y: st.canvas_y,
                    position: st.position,
                    inputs: st
                        .inputs
                        .iter()
                        .map(|i| pb::SnapshotStepInput {
                            id: i.id.to_string(),
                            name: i.name.clone(),
                            description: i.description.clone(),
                            required: i.required,
                            position: i.position,
                            workflow_input_id: i.workflow_input_id.map(|w| w.to_string()),
                            workflow_input_name: i.workflow_input_name.clone(),
                        })
                        .collect(),
                })
                .collect()
        },
        connections: if !with_steps {
            Vec::new()
        } else {
            s.connections
                .iter()
                .map(|c| pb::SnapshotConnection {
                    source_step_id: c.source_step_id.to_string(),
                    source_output_name: c.source_output_name.clone(),
                    destination_step_id: c.destination_step_id.to_string(),
                    destination_input_id: c.destination_input_id.to_string(),
                    destination_input_name: c.destination_input_name.clone(),
                })
                .collect()
        },
    }
}

pub fn step_summary(s: &StepRun) -> pb::StepRunSummary {
    pb::StepRunSummary {
        id: s.id.to_string(),
        snapshot_step_id: s.snapshot_step_id.clone(),
        step_name: s.step_name.clone(),
        step_kind: kind(s.step_kind) as i32,
        status: step_status(s.status) as i32,
        position: s.position,
        allow_failure: s.allow_failure,
        queued_at: opt_timestamp(s.queued_at),
        started_at: opt_timestamp(s.started_at),
        ended_at: opt_timestamp(s.ended_at),
        elapsed_ms: s.elapsed_ms,
        human_error: s.human_error.clone(),
        skipped_reason: s.skipped_reason.clone(),
        output_name: s.output_name.clone(),
        output_file_format: format(s.output_file_format) as i32,
        has_output: s.has_output(),
    }
}

pub fn run(r: &Run, step_runs: &[StepRun], full: bool) -> pb::Run {
    pb::Run {
        id: r.id.to_string(),
        workflow_id: r.workflow_id.to_string(),
        status: run_status(r.status) as i32,
        trigger: match r.trigger {
            RunTrigger::Manual => pb::RunTrigger::Manual,
            RunTrigger::Scheduled => pb::RunTrigger::Scheduled,
        } as i32,
        draft_test: r.draft_test,
        queued_at: opt_timestamp(r.queued_at),
        started_at: opt_timestamp(r.started_at),
        ended_at: opt_timestamp(r.ended_at),
        elapsed_ms: r.elapsed_ms,
        failure_summary: r.failure_summary.clone(),
        first_failed_step_run_id: r.first_failed_step_run_id.map(|i| i.to_string()),
        schedule_occurrence_key: r.schedule_occurrence_key.clone(),
        supplied_values: r
            .supplied_values
            .iter()
            .map(|(k, v)| (k.clone(), v.as_str().map(str::to_string).unwrap_or_else(|| v.to_string())))
            .collect(),
        snapshot: Some(snapshot(&r.snapshot, full)),
        step_runs: step_runs.iter().map(step_summary).collect(),
        created_at: Some(timestamp(r.created_at)),
    }
}

fn source_kind(raw: Option<&str>) -> pb::InputSourceKind {
    match raw {
        Some("step_output") => pb::InputSourceKind::StepOutput,
        Some("workflow_value") => pb::InputSourceKind::WorkflowValue,
        Some("constant") => pb::InputSourceKind::Constant,
        Some("none") => pb::InputSourceKind::None,
        _ => pb::InputSourceKind::Unspecified,
    }
}

pub fn resolved_inputs(value: Option<&serde_json::Value>) -> Vec<pb::ResolvedInput> {
    let Some(serde_json::Value::Object(map)) = value else {
        return Vec::new();
    };
    map.iter()
        .map(|(name, entry)| {
            let source = entry.get("source");
            let str_of = |k: &str| source.and_then(|s| s.get(k)).and_then(|v| v.as_str()).map(str::to_string);
            pb::ResolvedInput {
                name: name.clone(),
                value: entry.get("value").filter(|v| !v.is_null()).map(json_to_value),
                source: Some(pb::InputSource {
                    kind: source_kind(source.and_then(|s| s.get("kind")).and_then(|v| v.as_str())) as i32,
                    step_run_id: str_of("step_run_id"),
                    workflow_input_id: str_of("workflow_input_id"),
                    label: str_of("label").unwrap_or_default(),
                }),
            }
        })
        .collect()
}

pub fn messages(value: Option<&serde_json::Value>) -> Vec<pb::AgentMessage> {
    value
        .and_then(|v| v.as_array())
        .map(|items| {
            items
                .iter()
                .map(|m| pb::AgentMessage {
                    role: m.get("role").and_then(|v| v.as_str()).unwrap_or_default().into(),
                    text: m.get("text").and_then(|v| v.as_str()).unwrap_or_default().into(),
                    tool_calls: m.get("tool_calls").and_then(|v| v.as_i64()).unwrap_or(0) as i32,
                    stop_reason: m.get("stop_reason").and_then(|v| v.as_str()).map(str::to_string),
                    error: m.get("error").and_then(|v| v.as_str()).map(str::to_string),
                })
                .collect()
        })
        .unwrap_or_default()
}
