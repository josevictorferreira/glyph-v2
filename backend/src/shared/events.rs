use serde_json::{Map, Value, json};
use uuid::Uuid;

/// A domain event appended to the `events` table in the same transaction as
/// the change it describes. `data` carries ids and status only — never
/// prompts, inputs, outputs or session payloads.
#[derive(Debug, Clone, PartialEq)]
pub struct DomainEvent {
    pub event_type: String,
    pub stream: String,
    pub correlation_id: Option<Uuid>,
    pub data: Value,
}

impl DomainEvent {
    /// Event on stream `Workflow${id}` with `{workflow_id, actor_id: null, ..extra}`.
    pub fn workflow(event_type: &str, workflow_id: impl ToString, extra: Value) -> Self {
        let workflow_id = workflow_id.to_string();
        let mut data = Map::new();
        data.insert("workflow_id".into(), json!(workflow_id));
        data.insert("actor_id".into(), Value::Null);
        merge(&mut data, extra);
        Self {
            event_type: event_type.to_string(),
            stream: format!("Workflow${workflow_id}"),
            correlation_id: None,
            data: Value::Object(data),
        }
    }

    /// Event on stream `WorkflowRun${run_id}`, correlated by run id.
    pub fn run(event_type: &str, workflow_id: impl ToString, run_id: Uuid, extra: Value) -> Self {
        let mut data = Map::new();
        data.insert("workflow_run_id".into(), json!(run_id.to_string()));
        data.insert("workflow_id".into(), json!(workflow_id.to_string()));
        merge(&mut data, extra);
        Self {
            event_type: event_type.to_string(),
            stream: format!("WorkflowRun${run_id}"),
            correlation_id: Some(run_id),
            data: Value::Object(data),
        }
    }

    pub fn str_field(&self, key: &str) -> Option<&str> {
        self.data.get(key).and_then(Value::as_str)
    }
}

fn merge(data: &mut Map<String, Value>, extra: Value) {
    if let Value::Object(extra) = extra {
        data.extend(extra);
    }
}

/// A unit of background work, enqueued in the same transaction as the state
/// change that requires it (transactional outbox). Never retried.
#[derive(Debug, Clone, PartialEq)]
pub struct Job {
    pub kind: String,
    pub queue: String,
    pub payload: Value,
}

impl Job {
    pub fn new(kind: &str, queue: &str, payload: Value) -> Self {
        Self {
            kind: kind.to_string(),
            queue: queue.to_string(),
            payload,
        }
    }
}
