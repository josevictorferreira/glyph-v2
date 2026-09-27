use crate::shared::issue::Issue;

/// A located problem in a user-supplied document (YAML definition).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Violation {
    pub path: Option<String>,
    pub line: Option<i32>,
    pub message: String,
}

/// The single error type crossing feature boundaries. Mapped to gRPC/HTTP
/// status codes only at the edge (`app::errors`).
#[derive(Debug, thiserror::Error)]
pub enum DomainError {
    #[error("{0} not found")]
    NotFound(&'static str),
    /// User-fixable input → INVALID_ARGUMENT / 422.
    #[error("{0}")]
    Invalid(String),
    /// Invalid document with located errors → INVALID_ARGUMENT + details.
    #[error("the document is invalid")]
    Violations(Vec<Violation>),
    /// A flow the UI must confirm or fix first → FAILED_PRECONDITION + ErrorInfo.
    #[error("{reason}")]
    Precondition {
        code: &'static str,
        reason: String,
        meta: Vec<(String, String)>,
        issues: Vec<Issue>,
    },
    /// Optimistic concurrency failure → ABORTED / 409.
    #[error("conflict")]
    Conflict,
    /// Anything unexpected → INTERNAL; the message is logged, never returned.
    #[error(transparent)]
    Internal(#[from] anyhow::Error),
}

impl DomainError {
    pub fn invalid(message: impl Into<String>) -> Self {
        Self::Invalid(message.into())
    }

    pub fn precondition(code: &'static str, reason: impl Into<String>) -> Self {
        Self::Precondition {
            code,
            reason: reason.into(),
            meta: Vec::new(),
            issues: Vec::new(),
        }
    }

    pub fn internal(error: impl Into<anyhow::Error>) -> Self {
        Self::Internal(error.into())
    }
}

pub type DomainResult<T> = Result<T, DomainError>;
