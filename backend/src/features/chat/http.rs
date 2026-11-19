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
/// (`proto::status`), so the agent can act on the words.
fn error_response(error: DomainError) -> Response {
    let (status, message): (StatusCode, String) = match error {
        DomainError::NotFound(what) => (StatusCode::NOT_FOUND, format!("{what} not found")),
        DomainError::Invalid(message) => (StatusCode::UNPROCESSABLE_ENTITY, message),
        DomainError::Violations(violations) => {
            let message = violations
                .first()
                .map(|v| v.message.clone())
                .unwrap_or_else(|| "The document is invalid.".into());
            (StatusCode::UNPROCESSABLE_ENTITY, message)
        }
        DomainError::Precondition { reason, .. } => (StatusCode::CONFLICT, reason),
        DomainError::Conflict => (
            StatusCode::CONFLICT,
            "The workflow changed since this definition was loaded. Reload and try again.".into(),
        ),
        DomainError::Internal(error) => {
            tracing::error!(error = %format!("{error:#}"), "internal error");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                "Something went wrong. Try again.".into(),
            )
        }
    };
    (status, Json(json!({ "error": message }))).into_response()
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
        // Write tools land with task 4.2; reaching one is a programming
        // error on the extension side, not a missing route.
        "update_workflow" | "create_workflow" | "set_workflow_state" | "start_run" | "get_run" => {
            Err(DomainError::invalid("this tool is not implemented yet."))
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
