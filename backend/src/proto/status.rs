//! `DomainError` → `tonic::Status` at the gRPC edge, with rich details in
//! `grpc-status-details-bin` (google.rpc.Status).

use prost::Message;
use prost_types::Any;
use tonic::{Code, Status};
use tonic_types::pb as rpc;

use crate::proto::{convert, pb};
use crate::shared::error::DomainError;

pub const ERROR_DOMAIN: &str = "glyph";

fn any<M: Message>(type_name: &str, message: &M) -> Any {
    Any {
        type_url: format!("type.googleapis.com/{type_name}"),
        value: message.encode_to_vec(),
    }
}

fn with_details(code: Code, message: String, details: Vec<Any>) -> Status {
    let status = rpc::Status {
        code: code as i32,
        message: message.clone(),
        details,
    };
    Status::with_details(code, message, status.encode_to_vec().into())
}

impl From<DomainError> for Status {
    fn from(error: DomainError) -> Self {
        match error {
            DomainError::NotFound(what) => Status::not_found(format!("{what} not found")),
            DomainError::Invalid(message) => Status::invalid_argument(message),
            DomainError::Violations(violations) => {
                let message = violations
                    .first()
                    .map(|v| v.message.clone())
                    .unwrap_or_else(|| "The document is invalid.".into());
                let detail = pb::DefinitionErrors {
                    errors: violations.iter().map(convert::violation).collect(),
                };
                with_details(
                    Code::InvalidArgument,
                    message,
                    vec![any("glyph.v1.DefinitionErrors", &detail)],
                )
            }
            DomainError::Precondition {
                code,
                reason,
                meta,
                issues,
            } => {
                let info = rpc::ErrorInfo {
                    reason: code.to_string(),
                    domain: ERROR_DOMAIN.to_string(),
                    metadata: meta.into_iter().collect(),
                };
                let mut details = vec![any("google.rpc.ErrorInfo", &info)];
                if !issues.is_empty() {
                    let detail = pb::ValidationIssues {
                        issues: convert::issues(&issues),
                    };
                    details.push(any("glyph.v1.ValidationIssues", &detail));
                }
                with_details(Code::FailedPrecondition, reason, details)
            }
            DomainError::Conflict => Status::aborted(
                "The workflow changed since this definition was loaded. Reload and try again.",
            ),
            DomainError::Internal(error) => {
                tracing::error!(error = %format!("{error:#}"), "internal error");
                Status::internal("Something went wrong. Try again.")
            }
        }
    }
}

/// Decodes the details of a status produced above (tests and clients).
pub fn decode_details(status: &Status) -> Option<rpc::Status> {
    rpc::Status::decode(status.details()).ok()
}

pub fn error_info(status: &Status) -> Option<rpc::ErrorInfo> {
    decode_details(status)?
        .details
        .iter()
        .find(|a| a.type_url.ends_with("google.rpc.ErrorInfo"))
        .and_then(|a| rpc::ErrorInfo::decode(a.value.as_slice()).ok())
}

pub fn validation_issues(status: &Status) -> Vec<pb::Issue> {
    decode_details(status)
        .into_iter()
        .flat_map(|s| s.details)
        .filter(|a| a.type_url.ends_with("glyph.v1.ValidationIssues"))
        .filter_map(|a| pb::ValidationIssues::decode(a.value.as_slice()).ok())
        .flat_map(|v| v.issues)
        .collect()
}

pub fn definition_errors(status: &Status) -> Vec<pb::DefinitionError> {
    decode_details(status)
        .into_iter()
        .flat_map(|s| s.details)
        .filter(|a| a.type_url.ends_with("glyph.v1.DefinitionErrors"))
        .filter_map(|a| pb::DefinitionErrors::decode(a.value.as_slice()).ok())
        .flat_map(|v| v.errors)
        .collect()
}
