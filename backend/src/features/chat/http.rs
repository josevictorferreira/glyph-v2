//! Agent tool routes (spec 0024): JSON over HTTP for the Pi extension on
//! loopback, backed by the same application services as the gRPC handlers.
//! The frontend nginx does not proxy the `/agent/v1` prefix.
use crate::features::catalog::ListModels;
use crate::features::definition::DefinitionService;
use crate::features::runs::RunService;
use crate::features::workflows::WorkflowService;
use crate::features::workflows::{ListFilter, MAX_LIST_LIMIT};
use crate::shared::error::DomainError;
use crate::shared::ids::WorkflowId;
use axum::Json;
use axum::Router;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use serde_json::{Value, json};
use std::sync::Arc;

/// The ten Glyph tools, in this order everywhere (plan: Names).
pub const AGENT_TOOLS: [&str; 10] = [
    "list_workflows",
    "get_workflow_yaml",
    "validate_yaml",
    "update_workflow",
    "create_workflow",
    "set_workflow_state",
    "start_run",
    "get_run",
    "list_models",
    "list_tools",
];

/// Routes every agent tool shares; construct in `app::bootstrap`.
#[derive(Clone)]
pub struct AgentApi {
    workflows: Arc<WorkflowService>,
    definitions: Arc<DefinitionService>,
    catalog: Arc<ListModels>,
    /// Write tools (4.2) call runs; kept so bootstrap wiring is final.
    #[allow(dead_code)]
    runs: Arc<RunService>,
}

impl AgentApi {
    pub fn new(
        workflows: WorkflowService,
        definitions: DefinitionService,
        catalog: ListModels,
        runs: RunService,
    ) -> Self {
        Self {
            workflows: Arc::new(workflows),
            definitions: Arc::new(definitions),
            catalog: Arc::new(catalog),
            runs: Arc::new(runs),
        }
    }
}

/// `POST /agent/v1/{tool}` for every tool name.
pub fn routes(api: AgentApi) -> Router {
    Router::new().route("/{tool}", post(tool)).with_state(api)
}

/// A tool result: the model-facing text plus details Pi reports without
/// sending them to the model.
struct ToolOk {
    text: String,
    details: Value,
}

impl From<String> for ToolOk {
    fn from(text: String) -> Self {
        Self {
            text,
            details: json!({}),
        }
    }
}

impl From<&str> for ToolOk {
    fn from(text: &str) -> Self {
        Self {
            text: text.into(),
            details: json!({}),
        }
    }
}

impl IntoResponse for ToolOk {
    fn into_response(self) -> Response {
        Json(json!({ "text": self.text, "details": self.details })).into_response()
    }
}

/// `DomainError` → HTTP with the same message its gRPC twin returns
/// (`proto::status`), so the agent can act on the words. Refusals carry
/// their blocking issues in `details` so the model can fix them.
fn error_response(error: DomainError) -> Response {
    let (status, message, details): (StatusCode, String, Option<Value>) = match error {
        DomainError::NotFound(what) => {
            (StatusCode::NOT_FOUND, format!("{what} not found"), None)
        }
        DomainError::Invalid(message) => (StatusCode::UNPROCESSABLE_ENTITY, message, None),
        DomainError::Violations(violations) => {
            let message = violations
                .first()
                .map(|v| v.message.clone())
                .unwrap_or_else(|| "The document is invalid.".into());
            (StatusCode::UNPROCESSABLE_ENTITY, message, None)
        }
        DomainError::Precondition { reason, issues, .. } => (
            StatusCode::CONFLICT,
            reason,
            Some(json!({ "issues": issues_json(&issues) })),
        ),
        DomainError::Conflict => (
            StatusCode::CONFLICT,
            "The workflow changed since you exported it. Call get_workflow_yaml again and reapply your edit."
                .into(),
            None,
        ),
        DomainError::Internal(error) => {
            tracing::error!(error = %format!("{error:#}"), "internal error");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                "Something went wrong. Try again.".into(),
                None,
            )
        }
    };
    let body = match details {
        Some(details) => json!({ "error": message, "details": details }),
        None => json!({ "error": message }),
    };
    (status, Json(body)).into_response()
}

/// Issues as the agent sees them: message, location and blockingness.
fn issues_json(issues: &[crate::shared::issue::Issue]) -> Vec<Value> {
    issues
        .iter()
        .map(|issue| {
            json!({
                "message": issue.message,
                "entity": format!("{}:{}", entity_kind(issue.entity_type), issue.entity_id),
                "field": issue.field,
                "blocking": issue.blocking(),
            })
        })
        .collect()
}

fn entity_kind(entity: crate::shared::issue::EntityType) -> &'static str {
    use crate::shared::issue::EntityType as E;
    match entity {
        E::Workflow => "workflow",
        E::WorkflowStep => "step",
        E::StepInput => "step_input",
        E::WorkflowInput => "workflow_input",
        E::WorkflowConnection => "connection",
        E::WorkflowSchedule => "schedule",
    }
}

fn workflow_id(params: &Value) -> Result<WorkflowId, DomainError> {
    params["workflow_id"]
        .as_str()
        .and_then(|raw| raw.parse().ok())
        .ok_or_else(|| DomainError::invalid("workflow_id is required."))
}

/// Dispatches `POST /agent/v1/{tool}`.
pub async fn tool(
    axum::extract::State(api): axum::extract::State<AgentApi>,
    axum::extract::Path(tool): axum::extract::Path<String>,
    Json(params): Json<Value>,
) -> Response {
    if !AGENT_TOOLS.contains(&tool.as_str()) {
        return (
            StatusCode::NOT_FOUND,
            Json(json!({ "error": format!("unknown tool: {tool}") })),
        )
            .into_response();
    }
    run(&api, &tool, &params)
        .await
        .map(IntoResponse::into_response)
        .unwrap_or_else(error_response)
}

async fn run(api: &AgentApi, tool: &str, params: &Value) -> Result<ToolOk, DomainError> {
    match tool {
        "list_workflows" => {
            let workflows = api
                .workflows
                .list(ListFilter {
                    query: String::new(),
                    status: None,
                    limit: MAX_LIST_LIMIT,
                })
                .await?;
            let mut text = String::new();
            for workflow in &workflows {
                text.push_str(&format!(
                    "{} ({}, {})\n",
                    workflow.name,
                    workflow.id.as_uuid(),
                    workflow.status.as_str(),
                ));
            }
            Ok(ToolOk {
                text: if text.is_empty() {
                    "No workflows yet.".into()
                } else {
                    text
                },
                details: json!({ "workflows": workflows
                    .iter()
                    .map(|w| json!({
                        "id": w.id.as_uuid().to_string(),
                        "name": w.name,
                        "status": w.status.as_str(),
                    }))
                    .collect::<Vec<_>>() }),
            })
        }
        "get_workflow_yaml" => {
            let id = workflow_id(params)?;
            let export = api.definitions.export(id).await?;
            let text = format!("{}\n\n# fingerprint: {}", export.yaml, export.fingerprint);
            let name = exporter_name(&export.yaml);
            Ok(ToolOk {
                text,
                details: json!({
                    "workflow_id": id.as_uuid().to_string(),
                    "workflow_name": name,
                    "fingerprint": export.fingerprint,
                }),
            })
        }
        "validate_yaml" => {
            let yaml = params["yaml"]
                .as_str()
                .ok_or_else(|| DomainError::invalid("yaml is required."))?;
            let id = match params["workflow_id"].as_str() {
                Some(raw) if !raw.is_empty() => Some(
                    raw.parse()
                        .map_err(|_| DomainError::invalid("workflow_id is invalid."))?,
                ),
                _ => None,
            };
            let errors = api.definitions.parse(id, yaml).await?;
            if errors.is_empty() {
                return Ok("The document is valid.".into());
            }
            let mut text = String::new();
            for error in &errors {
                let location = error.line.map(|l| format!("{l}:")).unwrap_or_default();
                text.push_str(&format!(
                    "line {location}{}: {}\n",
                    error.path.clone().unwrap_or_default(),
                    error.message,
                ));
            }
            Ok(ToolOk {
                text,
                details: json!({ "errors": errors
                    .iter()
                    .map(|e| json!({
                        "path": e.path,
                        "line": e.line,
                        "message": e.message,
                    }))
                    .collect::<Vec<_>>() }),
            })
        }
        "list_models" => {
            let list = api.catalog.models(false).await?;
            let mut text = String::new();
            for model in &list.models {
                text.push_str(&model.full_id());
                text.push('\n');
            }
            Ok(ToolOk {
                text,
                details: json!({ "stale": list.stale }),
            })
        }
        "list_tools" => {
            let tools = api.catalog.tools().await?;
            let mut text = String::new();
            for tool in &tools {
                text.push_str(&format!("{}\n", tool.key));
            }
            Ok(ToolOk {
                text,
                details: json!({ "tools": tools
                    .iter()
                    .map(|t| json!({
                        "key": t.key,
                        "name": t.display_name,
                        "description": t.description,
                        "enabled": t.enabled,
                    }))
                    .collect::<Vec<_>>() }),
            })
        }
        "update_workflow" => {
            let id = workflow_id(params)?;
            let fingerprint = params["fingerprint"].as_str().unwrap_or("");
            if fingerprint.is_empty() {
                return Err(DomainError::invalid(
                    "update_workflow needs the fingerprint from get_workflow_yaml.",
                ));
            }
            let yaml = params["yaml"]
                .as_str()
                .ok_or_else(|| DomainError::invalid("yaml is required."))?;
            let previous = api.definitions.export(id).await?;
            let mutation = api.definitions.apply(id, yaml, Some(fingerprint)).await?;
            Ok(ToolOk {
                text: format!(
                    "Updated {} ({}).",
                    mutation.workflow.name,
                    mutation.workflow.status.as_str()
                ),
                details: json!({
                    "workflow_id": id.as_uuid().to_string(),
                    "workflow_name": mutation.workflow.name,
                    "fingerprint": mutation.value,
                    "previous_yaml": previous.yaml,
                    "summary": "Edited the definition.",
                    "issues": issues_json(&mutation.issues),
                }),
            })
        }
        "create_workflow" => {
            let yaml = params["yaml"]
                .as_str()
                .ok_or_else(|| DomainError::invalid("yaml is required."))?;
            let mutation = api.definitions.import(yaml).await?;
            Ok(ToolOk {
                text: format!(
                    "Created {} ({}).",
                    mutation.workflow.name,
                    mutation.workflow.status.as_str()
                ),
                details: json!({
                    "workflow_id": mutation.workflow.id.as_uuid().to_string(),
                    "workflow_name": mutation.workflow.name,
                    "issues": issues_json(&mutation.issues),
                }),
            })
        }
        "set_workflow_state" => {
            let id = workflow_id(params)?;
            let action = params["action"]
                .as_str()
                .ok_or_else(|| DomainError::invalid("action is required."))?;
            let (text, status, issues) = match action {
                "activate" => {
                    let mutation = api.workflows.activate(id).await?;
                    (
                        format!("Activated {}.", mutation.workflow.name),
                        mutation.workflow.status.as_str(),
                        mutation.issues,
                    )
                }
                "pause" => {
                    let mutation = api.workflows.pause(id).await?;
                    (
                        format!("Paused {}.", mutation.workflow.name),
                        mutation.workflow.status.as_str(),
                        mutation.issues,
                    )
                }
                "resume" => {
                    let mutation = api.workflows.resume(id).await?;
                    let resumed = mutation.value;
                    let name = mutation.workflow.name.clone();
                    (
                        if resumed {
                            format!("Resumed {name}.")
                        } else {
                            format!("{name} has unresolved issues and needs attention.")
                        },
                        mutation.workflow.status.as_str(),
                        mutation.issues,
                    )
                }
                other => {
                    return Err(DomainError::invalid(format!(
                        "action must be activate, pause or resume, not {other}."
                    )));
                }
            };
            Ok(ToolOk {
                text,
                details: json!({
                    "workflow_id": id.as_uuid().to_string(),
                    "status": status,
                    "issues": issues_json(&issues),
                }),
            })
        }
        "start_run" => {
            let id = workflow_id(params)?;
            let mut values = serde_json::Map::new();
            if let Some(object) = params["values"].as_object() {
                for (name, value) in object {
                    let text = match value {
                        Value::String(s) => s.clone(),
                        other => other.to_string(),
                    };
                    if !text.trim().is_empty() {
                        values.insert(name.clone(), Value::String(text));
                    }
                }
            }
            let run = api.runs.start_run(id, values).await?;
            Ok(ToolOk {
                text: format!("Run {} is {}.", run.id.as_uuid(), run.status.as_str()),
                details: json!({
                    "workflow_id": id.as_uuid().to_string(),
                    "run_id": run.id.as_uuid().to_string(),
                    "status": run.status.as_str(),
                }),
            })
        }
        "get_run" => {
            let id = workflow_id(params)?;
            let run_id = params["run_id"]
                .as_str()
                .and_then(|raw| raw.parse().ok())
                .ok_or_else(|| DomainError::invalid("run_id is required."))?;
            let (run, step_runs) = api.runs.get_run(id, run_id).await?;
            let mut text = format!("Run {} is {}.\n", run.id.as_uuid(), run.status.as_str());
            for step in &step_runs {
                text.push_str(&format!("- {}: {}\n", step.step_name, step.status.as_str()));
            }
            Ok(ToolOk {
                text,
                details: json!({
                    "workflow_id": id.as_uuid().to_string(),
                    "run_id": run.id.as_uuid().to_string(),
                    "status": run.status.as_str(),
                    "steps": step_runs
                        .iter()
                        .map(|s| json!({
                            "id": s.id.as_uuid().to_string(),
                            "name": s.step_name,
                            "status": s.status.as_str(),
                            "error": s.human_error,
                        }))
                        .collect::<Vec<_>>(),
                }),
            })
        }
        _ => Err(DomainError::invalid("unknown tool.")),
    }
}

/// The workflow name from the document's `name:` line (best effort).
fn exporter_name(yaml: &str) -> String {
    yaml.lines()
        .find_map(|line| line.strip_prefix("name: "))
        .unwrap_or_default()
        .trim()
        .to_string()
}
