//! Step output download and HTML preview (Rails `WorkflowRunsController`).

use axum::extract::{Path, State};
use axum::http::{HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use base64::Engine;

use crate::app::state::AppState;
use crate::features::runs::domain::model::StepRunStatus;
use crate::features::workflows::model::StepKind;
use crate::shared::ids::{RunId, StepRunId, WorkflowId};
use crate::shared::output_format::OutputFileFormat;

/// Agent HTML is untrusted. `sandbox` forces the preview into an opaque
/// origin (works for top-level navigations too, not just iframes), so scripts
/// can never touch the app's cookies, storage or same-origin gRPC API, and
/// `default-src 'none'` blocks all outbound fetch/XHR/beacon traffic.
/// `allow-scripts`/`allow-forms` re-enable just execution and form controls:
/// pages rendered purely by JavaScript display, remote scripts/styles/fonts
/// (CDN-dependent agent HTML) load, while no ambient authority is granted —
/// remote code is attacker-authored exactly like the inline code it replaces.
pub const PREVIEW_CSP: &str = "default-src 'none'; script-src 'unsafe-inline' https:; style-src 'unsafe-inline' https:; img-src data: https:; font-src data: https:; sandbox allow-scripts allow-forms";

fn not_found() -> Response {
    (StatusCode::NOT_FOUND, "Not found").into_response()
}

/// Strips path separators and non-printables; blank → "output".
pub fn safe_filename(name: Option<&str>, extension: &str) -> String {
    let base = name
        .map(str::trim)
        .filter(|n| !n.is_empty())
        .unwrap_or("output");
    let sanitized: String = base
        .chars()
        .map(|c| if c == '/' || c == '\\' { '_' } else { c })
        .filter(|c| !c.is_control())
        .collect();
    let sanitized = sanitized.trim();
    let sanitized = if sanitized.is_empty() {
        "output"
    } else {
        sanitized
    };
    format!("{sanitized}.{extension}")
}

fn content_disposition(kind: &str, filename: &str) -> HeaderValue {
    let ascii: String = filename
        .chars()
        .map(|c| if c.is_ascii() && c != '"' { c } else { '_' })
        .collect();
    let encoded: String = filename
        .bytes()
        .map(|b| {
            if b.is_ascii_alphanumeric() || b"-._~".contains(&b) {
                (b as char).to_string()
            } else {
                format!("%{b:02X}")
            }
        })
        .collect();
    HeaderValue::from_str(&format!(
        "{kind}; filename=\"{ascii}\"; filename*=UTF-8''{encoded}"
    ))
    .unwrap_or_else(|_| HeaderValue::from_static("attachment"))
}

type Ids = Path<(String, String, String)>;

fn parse(ids: (String, String, String)) -> Option<(WorkflowId, RunId, StepRunId)> {
    Some((
        ids.0.parse().ok()?,
        ids.1.parse().ok()?,
        ids.2.parse().ok()?,
    ))
}

pub async fn download(State(state): State<AppState>, Path(ids): Ids) -> Response {
    let Some((workflow, run, step_run)) = parse(ids) else {
        return not_found();
    };
    let Ok((_, s)) = state.runs.get_step_run(workflow, run, step_run).await else {
        return not_found();
    };
    let (body, mime, filename) = if s.step_kind == StepKind::Helper {
        let Some(output) = s.output.as_ref().filter(|o| !o.is_null()) else {
            return not_found();
        };
        let empty = output.as_object().is_some_and(|o| o.is_empty());
        if empty {
            return not_found();
        }
        (
            serde_json::to_vec_pretty(output).unwrap_or_default(),
            "application/json; charset=utf-8",
            safe_filename(s.output_name.as_deref(), "json"),
        )
    } else {
        let Some(text) = s
            .output_text
            .as_ref()
            .filter(|t| !t.is_empty() && s.status == StepRunStatus::Succeeded)
        else {
            return not_found();
        };
        let format = s.output_file_format;
        let body = if format == OutputFileFormat::Zip {
            match base64::engine::general_purpose::STANDARD.decode(text.trim()) {
                Ok(bytes) => bytes,
                Err(_) => return not_found(),
            }
        } else {
            text.clone().into_bytes()
        };
        (
            body,
            format.mime_type(),
            safe_filename(s.output_name.as_deref(), format.extension()),
        )
    };
    (
        [
            (header::CONTENT_TYPE, HeaderValue::from_static(mime)),
            (
                header::CONTENT_DISPOSITION,
                content_disposition("attachment", &filename),
            ),
            (
                header::X_CONTENT_TYPE_OPTIONS,
                HeaderValue::from_static("nosniff"),
            ),
        ],
        body,
    )
        .into_response()
}

pub async fn preview(State(state): State<AppState>, Path(ids): Ids) -> Response {
    let Some((workflow, run, step_run)) = parse(ids) else {
        return not_found();
    };
    let Ok((_, s)) = state.runs.get_step_run(workflow, run, step_run).await else {
        return not_found();
    };
    if s.status != StepRunStatus::Succeeded || s.output_file_format != OutputFileFormat::Html {
        return not_found();
    }
    let Some(text) = s.output_text.filter(|t| !t.is_empty()) else {
        return not_found();
    };
    (
        [
            (
                header::CONTENT_TYPE,
                HeaderValue::from_static("text/html; charset=utf-8"),
            ),
            (
                header::CONTENT_SECURITY_POLICY,
                HeaderValue::from_static(PREVIEW_CSP),
            ),
            (
                header::X_CONTENT_TYPE_OPTIONS,
                HeaderValue::from_static("nosniff"),
            ),
            (
                header::CONTENT_DISPOSITION,
                HeaderValue::from_static("inline"),
            ),
        ],
        text,
    )
        .into_response()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn filenames() {
        assert_eq!(safe_filename(Some("result"), "md"), "result.md");
        assert_eq!(safe_filename(Some("a/b\\c"), "zip"), "a_b_c.zip");
        assert_eq!(safe_filename(Some("  "), "json"), "output.json");
        assert_eq!(safe_filename(None, "html"), "output.html");
        assert_eq!(safe_filename(Some("x\u{7}y"), "md"), "xy.md");
    }
}
