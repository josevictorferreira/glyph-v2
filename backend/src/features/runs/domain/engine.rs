//! Pure run-engine rules (Rails `RunCreator`, `StepDispatcher`,
//! `RunFinalizer`, `RunStop`, `StepRetry` decision logic).

use std::collections::HashSet;

use serde_json::{Map, Value};

use crate::features::runs::domain::model::*;
use crate::features::workflows::model::{StepKind, Workflow};
use crate::features::workflows::snapshot::Snapshot;
use crate::shared::ids::{RunId, StepRunId};
use crate::shared::issue::{EntityType, Issue};
use crate::shared::time::Timestamp;

/// `required ∧ ask_at_run_time ∧ no supplied ∧ no stored value`.
pub fn missing_value_issues(workflow: &Workflow, supplied: &Map<String, Value>) -> Vec<Issue> {
    workflow
        .inputs
        .iter()
        .filter(|i| i.required && i.ask_at_run_time)
        .filter(|i| {
            let given = supplied
                .get(&i.name)
                .is_some_and(|v| v.as_str().map_or(!v.is_null(), |s| !s.trim().is_empty()));
            let stored = i.value.as_deref().is_some_and(|v| !v.trim().is_empty());
            !given && !stored
        })
        .map(|i| {
            Issue::error(
                EntityType::WorkflowInput,
                i.id,
                "value",
                format!("Provide a value for “{}” to start the run.", i.name),
            )
        })
        .collect()
}

pub struct NewRun {
    pub trigger: RunTrigger,
    pub supplied_values: Map<String, Value>,
    pub draft_test: bool,
    pub schedule_occurrence_key: Option<String>,
}

/// A queued run and one queued step run per snapshot step.
pub fn build_run(
    workflow: &Workflow,
    snapshot: Snapshot,
    new: NewRun,
    now: Timestamp,
) -> (Run, Vec<StepRun>) {
    let run = Run {
        id: RunId::new(),
        workflow_id: workflow.id,
        status: RunStatus::Queued,
        trigger: new.trigger,
        draft_test: new.draft_test,
        supplied_values: new.supplied_values,
        schedule_occurrence_key: new.schedule_occurrence_key,
        queued_at: Some(now),
        started_at: None,
        ended_at: None,
        elapsed_ms: None,
        failure_summary: None,
        first_failed_step_run_id: None,
        created_at: now,
        snapshot,
    };
    let step_runs = run
        .snapshot
        .steps
        .iter()
        .map(|s| StepRun {
            id: StepRunId::new(),
            run_id: run.id,
            snapshot_step_id: s.id.to_string(),
            step_name: s.name.clone(),
            step_kind: s.kind(),
            status: StepRunStatus::Queued,
            position: s.position,
            allow_failure: s.allow_failure,
            prompt: s.prompt.clone(),
            additional_context: s.additional_context.clone(),
            expected_output: s.expected_output.clone(),
            model_id: s.model_id.clone(),
            model_settings: s.model_settings.clone(),
            enabled_tools: s.enabled_tools.clone(),
            output_name: s.output_name.clone(),
            output_file_format: s.output_file_format,
            resolved_inputs: None,
            output: None,
            output_text: None,
            messages: None,
            session_content: None,
            technical_error: None,
            human_error: None,
            skipped_reason: None,
            queued_at: Some(now),
            started_at: None,
            ended_at: None,
            elapsed_ms: None,
            created_at: now,
        })
        .collect();
    (run, step_runs)
}

/// Queued step runs whose upstreams are all completed (succeeded, or failed
/// with allow_failure), in snapshot order.
pub fn ready_to_dispatch(snapshot: &Snapshot, states: &[StepRunState]) -> Vec<StepRunId> {
    let completed: HashSet<String> = states
        .iter()
        .filter(|s| {
            s.status == StepRunStatus::Succeeded
                || (s.status == StepRunStatus::Failed && s.allow_failure)
        })
        .map(|s| s.snapshot_step_id.clone())
        .collect();
    let inflight: HashSet<String> = states
        .iter()
        .filter(|s| s.status != StepRunStatus::Queued)
        .map(|s| s.snapshot_step_id.clone())
        .collect();
    snapshot
        .dag()
        .ready_ids(&completed, &inflight)
        .into_iter()
        .filter_map(|id| {
            states
                .iter()
                .find(|s| s.snapshot_step_id == id && s.status == StepRunStatus::Queued)
                .map(|s| s.id)
        })
        .collect()
}

/// Queued transitive descendants of `failed` — skipped after a failure.
pub fn blocked_descendants(
    snapshot: &Snapshot,
    states: &[StepRunState],
    failed: &StepRunState,
) -> Vec<StepRunId> {
    let blocked = snapshot
        .dag()
        .transitive_downstream(&failed.snapshot_step_id);
    states
        .iter()
        .filter(|s| s.status == StepRunStatus::Queued && blocked.contains(&s.snapshot_step_id))
        .map(|s| s.id)
        .collect()
}

/// fail_fast: every queued or running step run except the failed one.
pub fn to_cancel(states: &[StepRunState], failed: StepRunId) -> Vec<StepRunId> {
    states
        .iter()
        .filter(|s| {
            s.id != failed && matches!(s.status, StepRunStatus::Queued | StepRunStatus::Running)
        })
        .map(|s| s.id)
        .collect()
}

pub fn skipped_reason(failed_step_name: &str) -> String {
    format!("Did not run because “{failed_step_name}” did not complete.")
}

pub fn cancelled_reason(failed_step_name: &str) -> String {
    format!("Cancelled because “{failed_step_name}” failed.")
}

pub const STOPPED_REASON: &str = "Cancelled by user.";

#[derive(Debug, Clone, PartialEq)]
pub struct Finalization {
    pub status: RunStatus,
    pub failure_summary: Option<String>,
    pub first_failed: Option<StepRunId>,
}

/// Terminal state once every step run is terminal; `None` otherwise.
pub fn finalization(run: &Run, states: &[StepRunState]) -> Option<Finalization> {
    if run.status.terminal() || states.is_empty() || !states.iter().all(|s| s.status.terminal()) {
        return None;
    }
    let first_failed = states
        .iter()
        .filter(|s| s.status == StepRunStatus::Failed && !s.allow_failure)
        .min_by_key(|s| s.started_at.unwrap_or(s.created_at));
    Some(match first_failed {
        Some(f) => Finalization {
            status: RunStatus::Failed,
            failure_summary: Some(format!(
                "The {} step could not complete: {}",
                f.step_name,
                f.human_error.clone().unwrap_or_default()
            )),
            first_failed: Some(f.id),
        },
        None => Finalization {
            status: RunStatus::Succeeded,
            failure_summary: None,
            first_failed: None,
        },
    })
}

/// Retry resets the failed step plus its skipped/cancelled descendants.
pub fn retry_targets(
    snapshot: &Snapshot,
    states: &[StepRunState],
    failed: &StepRunState,
) -> Vec<StepRunId> {
    let blocked = snapshot
        .dag()
        .transitive_downstream(&failed.snapshot_step_id);
    states
        .iter()
        .filter(|s| {
            matches!(s.status, StepRunStatus::Skipped | StepRunStatus::Cancelled)
                && blocked.contains(&s.snapshot_step_id)
        })
        .map(|s| s.id)
        .collect()
}

pub fn is_helper(kind: StepKind) -> bool {
    kind == StepKind::Helper
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::features::workflows::catalog_view::CatalogView;
    use crate::features::workflows::snapshot;
    use chrono::Utc;

    /// A → C, B independent.
    fn setup() -> (Snapshot, Vec<StepRunState>) {
        let now = Utc::now();
        let (mut wf, _) = Workflow::create("W", None, false, now);
        let mut ids = Vec::new();
        for name in ["A", "B", "C"] {
            let (id, _) = wf.add_step(StepKind::Pi, None, now);
            wf.step_mut(id).unwrap().name = name.into();
            wf.step_mut(id).unwrap().output_name = Some(name.to_lowercase());
            ids.push(id);
        }
        wf.connect_output_to_step(ids[0], ids[2], now).unwrap();
        let snap = snapshot::build(&wf, &CatalogView::default(), now);
        let states = snap
            .steps
            .iter()
            .map(|s| StepRunState {
                id: StepRunId::new(),
                snapshot_step_id: s.id.to_string(),
                step_name: s.name.clone(),
                status: StepRunStatus::Queued,
                allow_failure: false,
                human_error: None,
                started_at: None,
                created_at: now,
            })
            .collect();
        (snap, states)
    }

    #[test]
    fn dispatches_roots_then_dependents() {
        let (snap, mut states) = setup();
        assert_eq!(
            ready_to_dispatch(&snap, &states),
            vec![states[0].id, states[1].id]
        );
        states[0].status = StepRunStatus::Running;
        assert_eq!(ready_to_dispatch(&snap, &states), vec![states[1].id]);
        states[0].status = StepRunStatus::Succeeded;
        states[1].status = StepRunStatus::Running;
        assert_eq!(ready_to_dispatch(&snap, &states), vec![states[2].id]);
        states[0].status = StepRunStatus::Failed;
        assert!(ready_to_dispatch(&snap, &states).is_empty());
        states[0].allow_failure = true;
        assert_eq!(ready_to_dispatch(&snap, &states), vec![states[2].id]);
    }

    #[test]
    fn skip_and_cancel_sets() {
        let (snap, mut states) = setup();
        states[0].status = StepRunStatus::Failed;
        states[1].status = StepRunStatus::Running;
        assert_eq!(
            blocked_descendants(&snap, &states, &states[0]),
            vec![states[2].id]
        );
        assert_eq!(
            to_cancel(&states, states[0].id),
            vec![states[1].id, states[2].id]
        );
    }

    #[test]
    fn finalization_rules() {
        let (snap, mut states) = setup();
        let (wf, _) = Workflow::create("W", None, false, Utc::now());
        let (run, _) = build_run(
            &wf,
            snap,
            NewRun {
                trigger: RunTrigger::Manual,
                supplied_values: Map::new(),
                draft_test: false,
                schedule_occurrence_key: None,
            },
            Utc::now(),
        );
        assert!(finalization(&run, &states).is_none());
        for s in &mut states {
            s.status = StepRunStatus::Succeeded;
        }
        assert_eq!(
            finalization(&run, &states).unwrap().status,
            RunStatus::Succeeded
        );
        states[1].status = StepRunStatus::Failed;
        states[1].human_error = Some("boom".into());
        let f = finalization(&run, &states).unwrap();
        assert_eq!(f.status, RunStatus::Failed);
        assert_eq!(
            f.failure_summary.as_deref(),
            Some("The B step could not complete: boom")
        );
        assert_eq!(f.first_failed, Some(states[1].id));
        states[1].allow_failure = true;
        assert_eq!(
            finalization(&run, &states).unwrap().status,
            RunStatus::Succeeded
        );
        assert!(finalization(&run, &[]).is_none());
    }
}
