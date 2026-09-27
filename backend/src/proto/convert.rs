//! Conversions for shared types used by every feature's gRPC edge.

use std::str::FromStr;

use prost_types::Timestamp as PbTimestamp;
use tonic::Status;

use crate::proto::pb;
use crate::shared::error::Violation;
use crate::shared::issue::{EntityType, Issue, Severity};
use crate::shared::time::Timestamp;

pub fn timestamp(at: Timestamp) -> PbTimestamp {
    PbTimestamp {
        seconds: at.timestamp(),
        nanos: at.timestamp_subsec_nanos() as i32,
    }
}

pub fn opt_timestamp(at: Option<Timestamp>) -> Option<PbTimestamp> {
    at.map(timestamp)
}

pub fn from_timestamp(ts: &PbTimestamp) -> Option<Timestamp> {
    chrono::DateTime::from_timestamp(ts.seconds, ts.nanos.max(0) as u32)
}

pub fn issue(issue: &Issue) -> pb::Issue {
    pb::Issue {
        severity: match issue.severity {
            Severity::Error => pb::IssueSeverity::Error as i32,
        },
        entity_type: entity_type(issue.entity_type) as i32,
        entity_id: issue.entity_id.clone(),
        field: issue.field.clone(),
        message: issue.message.clone(),
    }
}

pub fn issues(issues: &[Issue]) -> Vec<pb::Issue> {
    issues.iter().map(issue).collect()
}

fn entity_type(t: EntityType) -> pb::IssueEntityType {
    match t {
        EntityType::Workflow => pb::IssueEntityType::Workflow,
        EntityType::WorkflowStep => pb::IssueEntityType::WorkflowStep,
        EntityType::StepInput => pb::IssueEntityType::StepInput,
        EntityType::WorkflowInput => pb::IssueEntityType::WorkflowInput,
        EntityType::WorkflowConnection => pb::IssueEntityType::WorkflowConnection,
        EntityType::WorkflowSchedule => pb::IssueEntityType::WorkflowSchedule,
    }
}

pub fn violation(v: &Violation) -> pb::DefinitionError {
    pb::DefinitionError {
        path: v.path.clone(),
        line: v.line,
        message: v.message.clone(),
    }
}

/// Parses a request id field, mapping failures to INVALID_ARGUMENT.
pub fn parse_id<T: FromStr>(raw: &str, field: &str) -> Result<T, Status> {
    raw.parse()
        .map_err(|_| Status::invalid_argument(format!("{field} is not a valid id")))
}

pub fn parse_opt_id<T: FromStr>(raw: Option<&str>, field: &str) -> Result<Option<T>, Status> {
    match raw.map(str::trim).filter(|s| !s.is_empty()) {
        None => Ok(None),
        Some(s) => parse_id(s, field).map(Some),
    }
}

pub fn json_to_value(json: &serde_json::Value) -> prost_types::Value {
    use prost_types::value::Kind;
    let kind = match json {
        serde_json::Value::Null => Kind::NullValue(0),
        serde_json::Value::Bool(b) => Kind::BoolValue(*b),
        serde_json::Value::Number(n) => Kind::NumberValue(n.as_f64().unwrap_or_default()),
        serde_json::Value::String(s) => Kind::StringValue(s.clone()),
        serde_json::Value::Array(items) => Kind::ListValue(prost_types::ListValue {
            values: items.iter().map(json_to_value).collect(),
        }),
        serde_json::Value::Object(map) => Kind::StructValue(prost_types::Struct {
            fields: map
                .iter()
                .map(|(k, v)| (k.clone(), json_to_value(v)))
                .collect(),
        }),
    };
    prost_types::Value { kind: Some(kind) }
}
