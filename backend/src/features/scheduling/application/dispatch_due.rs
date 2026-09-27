//! Minute dispatcher. Each due workflow is handled under `SELECT … FOR
//! UPDATE`: re-check, validate, create the scheduled run and advance the
//! next occurrence in one transaction. The unique occurrence key makes
//! duplicate dispatchers create at most one run per occurrence.

use std::sync::Arc;

use chrono::SecondsFormat;
use serde_json::{Map, Value};

use crate::features::runs::{NewRun, RunService, RunTrigger};
use crate::features::scheduling::ports::SchedulingStore;
use crate::features::workflows::{CatalogView, WorkflowStatus, schedule_calculator, validator};
use crate::shared::error::{DomainError, DomainResult};
use crate::shared::ids::WorkflowId;
use crate::shared::issue::{any_blocking, blocking_messages};
use crate::shared::time::Timestamp;

pub const DISPATCH_DUE: &str = "dispatch_due_workflows";
pub const SCHEDULING_QUEUE: &str = "scheduling";
/// Precondition code the run store raises for a taken occurrence key.
pub const OCCURRENCE_TAKEN: &str = "OCCURRENCE_ALREADY_DISPATCHED";

/// `{workflow_id}:{next_run_at UTC, RFC 3339 seconds}` (Rails format).
pub fn occurrence_key(workflow: WorkflowId, at: Timestamp) -> String {
    format!(
        "{workflow}:{}",
        at.to_rfc3339_opts(SecondsFormat::Secs, true)
    )
}

#[derive(Clone)]
pub struct DispatchDueWorkflows {
    store: Arc<dyn SchedulingStore>,
    runs: RunService,
}

impl DispatchDueWorkflows {
    pub fn new(store: Arc<dyn SchedulingStore>, runs: RunService) -> Self {
        Self { store, runs }
    }

    /// Returns how many runs were created. Per-workflow failures are logged
    /// and never stop the sweep.
    pub async fn dispatch(&self, now: Timestamp) -> DomainResult<usize> {
        let catalog = self.runs.catalog_view().await?;
        let mut dispatched = 0;
        for id in self.store.due_workflow_ids(now).await? {
            match self.dispatch_one(id, &catalog, now).await {
                Ok(true) => dispatched += 1,
                Ok(false) => {}
                Err(DomainError::Precondition {
                    code: OCCURRENCE_TAKEN,
                    ..
                }) => {
                    // Another dispatcher already created this occurrence's run.
                }
                Err(error) => {
                    tracing::error!(workflow_id = %id, %error, "scheduled dispatch failed")
                }
            }
        }
        Ok(dispatched)
    }

    async fn dispatch_one(
        &self,
        id: WorkflowId,
        catalog: &CatalogView,
        now: Timestamp,
    ) -> DomainResult<bool> {
        let mut tx = self.store.begin().await?;
        let Some(mut workflow) = tx.lock_workflow(id).await? else {
            return Ok(false);
        };
        let Some(schedule) = workflow.schedule.clone() else {
            return Ok(false);
        };
        let Some(due_at) = schedule
            .next_run_at
            .filter(|at| schedule.enabled && *at <= now)
        else {
            return Ok(false);
        };
        if workflow.status != WorkflowStatus::Active {
            return Ok(false);
        }

        let issues = validator::validate(&workflow, catalog);
        if any_blocking(&issues) {
            let events = workflow.mark_needs_attention(blocking_messages(&issues));
            tx.save_workflow(&workflow).await?;
            tx.append_events(&events).await?;
            tx.commit().await?;
            return Ok(false);
        }

        let values: Map<String, Value> = schedule
            .values
            .iter()
            .filter_map(|v| {
                let input = workflow.input(v.workflow_input_id)?;
                Some((input.name.clone(), Value::String(v.value.clone()?)))
            })
            .collect();
        let created = self
            .runs
            .create_run_in(
                tx.as_mut(),
                &mut workflow,
                catalog,
                NewRun {
                    trigger: RunTrigger::Scheduled,
                    supplied_values: values,
                    draft_test: false,
                    schedule_occurrence_key: Some(occurrence_key(id, due_at)),
                },
                now,
            )
            .await?;
        if created.is_err() {
            return Ok(false);
        }

        let next = match (&schedule.cron_expression, &schedule.timezone) {
            (Some(cron), Some(tz)) => schedule_calculator::next_run_at(cron, tz, now),
            _ => None,
        };
        if let Some(s) = workflow.schedule.as_mut() {
            s.next_run_at = next;
            s.last_dispatched_at = Some(now);
        }
        workflow.next_run_at = next;
        tx.save_workflow(&workflow).await?;
        tx.commit().await?;
        Ok(true)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn occurrence_key_format() {
        let id: WorkflowId = "0b7e8a39-8a6f-4d64-9f40-5d6bb0b2a7c1".parse().unwrap();
        let at: Timestamp = "2026-08-04T09:00:00.123456Z".parse().unwrap();
        assert_eq!(
            occurrence_key(id, at),
            "0b7e8a39-8a6f-4d64-9f40-5d6bb0b2a7c1:2026-08-04T09:00:00Z"
        );
    }
}
