//! Run use cases (Rails `Execution::*`). Every state change is a
//! compare-and-set or happens under the run lock; events and follow-up jobs
//! are written in the same transaction (outbox). Jobs are never retried.

use std::sync::Arc;
use std::time::Instant;

use async_trait::async_trait;
use serde_json::{Map, Value, json};

use crate::features::runs::domain::engine::{self, NewRun};
use crate::features::runs::domain::events as ev;
use crate::features::runs::domain::input_resolver;
use crate::features::runs::domain::model::*;
use crate::features::runs::domain::workflow_values;
use crate::features::runs::ports::repository::{RunListFilter, RunStore, RunTx, StepFinish};
use crate::features::runs::ports::step_runner::{ProgressSink, StepRunContext, StepRunner};
use crate::features::workflows::{
    CatalogReader, CatalogView, Workflow, WorkflowStatus, snapshot, validator,
};
use crate::shared::error::{DomainError, DomainResult};
use crate::shared::events::{DomainEvent, Job};
use crate::shared::ids::{RunId, StepId, StepRunId, WorkflowId};
use crate::shared::issue::{Issue, any_blocking};
use crate::shared::time::{Clock, Timestamp};

pub const EXECUTE_RUN: &str = "execute_workflow_run";
pub const EXECUTE_STEP: &str = "execute_step_run";
pub const RUN_QUEUE: &str = "workflow_execution";
pub const STEP_QUEUE: &str = "step_execution";
pub const INTERRUPTED: &str = "The step was interrupted before it finished.";

pub fn execute_run_job(run: RunId) -> Job {
    Job::new(EXECUTE_RUN, RUN_QUEUE, json!({ "run_id": run.to_string() }))
}

pub fn execute_step_job(step_run: StepRunId) -> Job {
    Job::new(
        EXECUTE_STEP,
        STEP_QUEUE,
        json!({ "step_run_id": step_run.to_string() }),
    )
}

#[derive(Clone)]
pub struct RunService {
    store: Arc<dyn RunStore>,
    catalog: Arc<dyn CatalogReader>,
    runner: Arc<dyn StepRunner>,
    clock: Arc<dyn Clock>,
}

/// Why a run could not be created.
#[derive(Debug, Clone, PartialEq)]
pub struct NotCreated {
    pub issues: Vec<Issue>,
    pub missing_values: bool,
}

impl From<NotCreated> for DomainError {
    fn from(n: NotCreated) -> Self {
        let first = n
            .issues
            .iter()
            .find(|i| i.blocking())
            .map(|i| i.message.clone())
            .unwrap_or_else(|| "unspecified reason".into());
        DomainError::Precondition {
            code: if n.missing_values {
                "MISSING_VALUES"
            } else {
                "VALIDATION_FAILED"
            },
            reason: format!("This workflow cannot run yet: {first}"),
            meta: Vec::new(),
            issues: n.issues,
        }
    }
}

struct Progress {
    store: Arc<dyn RunStore>,
    workflow: WorkflowId,
    run: RunId,
    step_run: StepRunId,
}

#[async_trait]
impl ProgressSink for Progress {
    async fn report(&self, session_content: String) {
        if let Err(error) = self
            .store
            .record_progress(self.workflow, self.run, self.step_run, &session_content)
            .await
        {
            tracing::warn!(%error, step_run_id = %self.step_run, "progress update failed");
        }
    }
}

fn non_blank(values: Map<String, Value>) -> Map<String, Value> {
    values
        .into_iter()
        .filter(|(_, v)| match v {
            Value::Null => false,
            Value::String(s) => !s.trim().is_empty(),
            _ => true,
        })
        .collect()
}

impl RunService {
    pub fn new(
        store: Arc<dyn RunStore>,
        catalog: Arc<dyn CatalogReader>,
        runner: Arc<dyn StepRunner>,
        clock: Arc<dyn Clock>,
    ) -> Self {
        Self {
            store,
            catalog,
            runner,
            clock,
        }
    }

    pub fn store(&self) -> &Arc<dyn RunStore> {
        &self.store
    }

    pub async fn catalog_view(&self) -> DomainResult<CatalogView> {
        self.catalog.view().await
    }

    // --- creation ------------------------------------------------------------

    /// Creates a queued run inside the caller's transaction (manual trigger and
    /// scheduler share this). The workflow must be locked by the caller.
    pub async fn create_run_in(
        &self,
        tx: &mut dyn RunTx,
        workflow: &mut Workflow,
        catalog: &CatalogView,
        new: NewRun,
        now: Timestamp,
    ) -> DomainResult<Result<Run, NotCreated>> {
        let missing = engine::missing_value_issues(workflow, &new.supplied_values);
        let mut issues = validator::validate(workflow, catalog);
        let missing_values = !missing.is_empty();
        issues.extend(missing);
        if any_blocking(&issues) {
            return Ok(Err(NotCreated {
                issues,
                missing_values,
            }));
        }
        let snapshot = snapshot::build(workflow, catalog, now);
        let (run, step_runs) = engine::build_run(workflow, snapshot, new, now);
        tx.insert_run(&run, &step_runs).await?;
        tx.set_workflow_last_run(workflow.id, now, RunStatus::Queued)
            .await?;
        workflow.last_run_at = Some(now);
        workflow.last_run_status = Some(RunStatus::Queued.as_str().into());

        let mut events: Vec<DomainEvent> = step_runs
            .iter()
            .map(|s| ev::step(ev::STEP_QUEUED, run.workflow_id, run.id, s.id, None, None))
            .collect();
        events.push(ev::run_event(
            ev::RUN_QUEUED,
            run.workflow_id,
            run.id,
            json!({
                "trigger": run.trigger.as_str(),
                "actor_id": null,
                "draft_test": run.draft_test,
            }),
        ));
        tx.append_events(&events).await?;
        tx.enqueue(execute_run_job(run.id)).await?;
        Ok(Ok(run))
    }

    /// Manual trigger: values keyed by input name; a draft runs as a test.
    pub async fn start_run(
        &self,
        workflow_id: WorkflowId,
        values: Map<String, Value>,
    ) -> DomainResult<Run> {
        let catalog = self.catalog.view().await?;
        let now = self.clock.now();
        let mut tx = self.store.begin().await?;
        let mut workflow = tx
            .lock_workflow(workflow_id)
            .await?
            .ok_or(DomainError::NotFound("workflow"))?;
        let draft_test = workflow.status == WorkflowStatus::Draft;
        let created = self
            .create_run_in(
                tx.as_mut(),
                &mut workflow,
                &catalog,
                NewRun {
                    trigger: RunTrigger::Manual,
                    supplied_values: non_blank(values),
                    draft_test,
                    schedule_occurrence_key: None,
                },
                now,
            )
            .await?;
        let run = created?;
        tx.commit().await?;
        Ok(run)
    }

    // --- execution -------------------------------------------------------------

    /// Job `execute_workflow_run`: CAS queued → running, dispatch roots, finalize.
    pub async fn execute_run(&self, run_id: RunId) -> DomainResult<()> {
        let now = self.clock.now();
        let mut tx = self.store.begin().await?;
        if !tx.start_run(run_id, now).await? {
            return tx.commit().await;
        }
        let run = tx
            .lock_run(run_id)
            .await?
            .ok_or(DomainError::NotFound("run"))?;
        tx.append_events(&[ev::run_event(
            ev::RUN_STARTED,
            run.workflow_id,
            run.id,
            json!({}),
        )])
        .await?;
        self.advance(tx.as_mut(), run, None, now).await?;
        tx.commit().await
    }

    /// Dispatch + finalization under the run lock (Rails `StepDispatcher`
    /// `after_step_finished` / `dispatch_ready` + `RunFinalizer.attempt`).
    async fn advance(
        &self,
        tx: &mut dyn RunTx,
        mut run: Run,
        finished: Option<StepRunId>,
        now: Timestamp,
    ) -> DomainResult<()> {
        if run.status.terminal() {
            return Ok(());
        }
        let states = tx.step_run_states(run.id).await?;
        let finished = finished.and_then(|id| states.iter().find(|s| s.id == id).cloned());
        match finished {
            Some(failed) if failed.status == StepRunStatus::Failed && !failed.allow_failure => {
                let mut events = Vec::new();
                if run.snapshot.workflow.fail_fast {
                    let reason = engine::cancelled_reason(&failed.step_name);
                    let ids = engine::to_cancel(&states, failed.id);
                    for id in tx
                        .mark_step_runs(
                            &ids,
                            &[StepRunStatus::Queued, StepRunStatus::Running],
                            StepRunStatus::Cancelled,
                            now,
                            None,
                        )
                        .await?
                    {
                        events.push(ev::step(
                            ev::STEP_CANCELLED,
                            run.workflow_id,
                            run.id,
                            id,
                            Some("cancelled"),
                            Some(&reason),
                        ));
                    }
                } else {
                    let reason = engine::skipped_reason(&failed.step_name);
                    let ids = engine::blocked_descendants(&run.snapshot, &states, &failed);
                    for id in tx
                        .mark_step_runs(
                            &ids,
                            &[StepRunStatus::Queued],
                            StepRunStatus::Skipped,
                            now,
                            Some(&reason),
                        )
                        .await?
                    {
                        events.push(ev::step(
                            ev::STEP_SKIPPED,
                            run.workflow_id,
                            run.id,
                            id,
                            Some("skipped"),
                            Some(&reason),
                        ));
                    }
                }
                tx.append_events(&events).await?;
            }
            Some(s) if !matches!(s.status, StepRunStatus::Succeeded | StepRunStatus::Failed) => {}
            _ => {
                for id in engine::ready_to_dispatch(&run.snapshot, &states) {
                    tx.enqueue(execute_step_job(id)).await?;
                }
            }
        }

        let states = tx.step_run_states(run.id).await?;
        if let Some(f) = engine::finalization(&run, &states) {
            run.status = f.status;
            run.ended_at = Some(now);
            run.elapsed_ms = Some(run.elapsed_until(now));
            run.failure_summary = f.failure_summary.clone();
            run.first_failed_step_run_id = f.first_failed;
            tx.save_run(&run).await?;
            let event = match f.status {
                RunStatus::Failed => {
                    ev::run_status(ev::RUN_FAILED, &run, f.failure_summary.as_deref())
                }
                _ => ev::run_status(ev::RUN_SUCCEEDED, &run, None),
            };
            tx.append_events(&[event]).await?;
            tx.set_workflow_last_run(run.workflow_id, now, run.status)
                .await?;
        }
        Ok(())
    }

    async fn after_step_finished(&self, run_id: RunId, step_run: StepRunId) -> DomainResult<()> {
        let now = self.clock.now();
        let mut tx = self.store.begin().await?;
        let run = tx
            .lock_run(run_id)
            .await?
            .ok_or(DomainError::NotFound("run"))?;
        self.advance(tx.as_mut(), run, Some(step_run), now).await?;
        tx.commit().await
    }

    async fn finish(
        &self,
        run: &Run,
        step_run: StepRunId,
        from: StepRunStatus,
        finish: StepFinish,
        reason: Option<&str>,
    ) -> DomainResult<bool> {
        let mut tx = self.store.begin().await?;
        if !tx.finish_step_run(step_run, from, &finish).await? {
            tx.commit().await?;
            return Ok(false);
        }
        let event_type = match finish.status {
            StepRunStatus::Succeeded => ev::STEP_SUCCEEDED,
            StepRunStatus::Skipped => ev::STEP_SKIPPED,
            _ => ev::STEP_FAILED,
        };
        tx.append_events(&[ev::step(
            event_type,
            run.workflow_id,
            run.id,
            step_run,
            Some(finish.status.as_str()),
            reason,
        )])
        .await?;
        tx.commit().await?;
        Ok(true)
    }

    /// Job `execute_step_run` (Rails `StepRunExecutor`).
    pub async fn execute_step(&self, step_run_id: StepRunId) -> DomainResult<()> {
        let Some(step_run) = self.store.find_step_run(step_run_id).await? else {
            return Ok(());
        };
        if step_run.status.terminal() {
            return Ok(());
        }
        let run = self
            .store
            .find_run(step_run.run_id)
            .await?
            .ok_or(DomainError::NotFound("run"))?;

        let mut tx = self.store.begin().await?;
        if !tx.start_step_run(step_run_id, self.clock.now()).await? {
            return tx.commit().await;
        }
        tx.append_events(&[ev::step(
            ev::STEP_STARTED,
            run.workflow_id,
            run.id,
            step_run_id,
            Some("running"),
            None,
        )])
        .await?;
        let upstreams = tx.upstreams(run.id).await?;
        tx.commit().await?;

        let step_snapshot = step_run
            .snapshot_step_id
            .parse::<StepId>()
            .ok()
            .and_then(|id| run.snapshot.step(id).cloned());
        let Some(step_snapshot) = step_snapshot else {
            let finish = StepFinish {
                status: StepRunStatus::Failed,
                ended_at: self.clock.now(),
                elapsed_ms: None,
                output: None,
                output_text: None,
                messages: None,
                session_content: None,
                human_error: Some("The step could not be executed.".into()),
                technical_error: Some("Step is missing from the run snapshot.".into()),
                skipped_reason: None,
            };
            self.finish(
                &run,
                step_run_id,
                StepRunStatus::Running,
                finish,
                Some("The step could not be executed."),
            )
            .await?;
            return self.after_step_finished(run.id, step_run_id).await;
        };

        let entries = workflow_values::entries(&run.snapshot.inputs, &run.supplied_values);
        let resolutions =
            match input_resolver::resolve(&run.snapshot, &step_snapshot, &upstreams, &entries) {
                Ok(r) => r,
                Err(missing) => {
                    let reason = format!("A required input was unavailable: {missing}");
                    let finish = StepFinish {
                        status: StepRunStatus::Skipped,
                        ended_at: self.clock.now(),
                        elapsed_ms: None,
                        output: None,
                        output_text: None,
                        messages: None,
                        session_content: None,
                        human_error: None,
                        technical_error: None,
                        skipped_reason: Some(reason.clone()),
                    };
                    if self
                        .finish(
                            &run,
                            step_run_id,
                            StepRunStatus::Running,
                            finish,
                            Some(&reason),
                        )
                        .await?
                    {
                        self.after_step_finished(run.id, step_run_id).await?;
                    }
                    return Ok(());
                }
            };
        let mut tx = self.store.begin().await?;
        tx.set_resolved_inputs(step_run_id, &input_resolver::evidence(&resolutions))
            .await?;
        tx.commit().await?;
        let inputs = input_resolver::values_map(&resolutions);

        if engine::is_helper(step_snapshot.kind()) {
            // Deterministic: the output is the resolved input map; no Pi, no credentials.
            let started = Instant::now();
            let output = Value::Object(inputs);
            let elapsed = (started.elapsed().as_micros() as i64 + 999) / 1000;
            let finish = StepFinish {
                status: StepRunStatus::Succeeded,
                ended_at: self.clock.now(),
                elapsed_ms: Some(elapsed.max(1)),
                output: Some(output),
                output_text: None,
                messages: None,
                session_content: None,
                human_error: None,
                technical_error: None,
                skipped_reason: None,
            };
            if self
                .finish(&run, step_run_id, StepRunStatus::Running, finish, None)
                .await?
            {
                self.after_step_finished(run.id, step_run_id).await?;
            }
            return Ok(());
        }

        let context = StepRunContext {
            workflow_id: run.workflow_id,
            run_id: run.id,
            step_run_id,
            step_name: step_run.step_name.clone(),
            prompt: step_run.prompt.clone(),
            additional_context: step_run.additional_context.clone(),
            expected_output: step_run.expected_output.clone(),
            model_id: step_run.model_id.clone(),
            model_settings: step_run.model_settings.clone(),
            enabled_tools: step_run.enabled_tools.clone(),
            output_file_format: step_run.output_file_format,
            inputs,
            workflow_values: workflow_values::values(&run.snapshot.inputs, &run.supplied_values),
        };
        let progress = Arc::new(Progress {
            store: self.store.clone(),
            workflow: run.workflow_id,
            run: run.id,
            step_run: step_run_id,
        });
        let outcome = self.runner.run(context, progress).await;
        let finish = StepFinish::from_outcome(&outcome, self.clock.now());
        let reason = finish.human_error.clone();
        // Fail-fast may have cancelled this step meanwhile: never overwrite it.
        if self
            .finish(
                &run,
                step_run_id,
                StepRunStatus::Running,
                finish,
                reason.as_deref(),
            )
            .await?
        {
            self.after_step_finished(run.id, step_run_id).await?;
        }
        Ok(())
    }

    // --- crash recovery ----------------------------------------------------------

    /// A step whose worker died (OOM kill, node loss) or whose job errored
    /// after it started: its agent result is lost. It fails (never
    /// re-executed: no retries for execution jobs), keeping the last progress
    /// snapshot as evidence (untouched in place), and the run advances.
    pub async fn interrupt_step(&self, step_run_id: StepRunId) -> DomainResult<()> {
        let Some(step_run) = self.store.find_step_run(step_run_id).await? else {
            return Ok(());
        };
        if step_run.status.terminal() {
            return Ok(());
        }
        let run = self
            .store
            .find_run(step_run.run_id)
            .await?
            .ok_or(DomainError::NotFound("run"))?;
        let now = self.clock.now();
        let finish = StepFinish {
            status: StepRunStatus::Failed,
            ended_at: now,
            elapsed_ms: step_run
                .started_at
                .map(|at| (now - at).num_milliseconds().max(0)),
            output: None,
            output_text: None,
            messages: None,
            // Kept as-is by the store: rewriting a large snapshot only to
            // preserve it is what a recovering database can least afford.
            session_content: None,
            human_error: Some(INTERRUPTED.into()),
            technical_error: Some(
                "The worker executing this step stopped before the step finished.".into(),
            ),
            skipped_reason: None,
        };
        if self
            .finish(
                &run,
                step_run_id,
                step_run.status,
                finish,
                Some(INTERRUPTED),
            )
            .await?
        {
            self.after_step_finished(run.id, step_run_id).await?;
        }
        Ok(())
    }

    /// An `execute_workflow_run` job whose worker died: its transaction never
    /// committed, so the run is still queued and only needs a new job.
    pub async fn requeue_run(&self, run_id: RunId) -> DomainResult<()> {
        let mut tx = self.store.begin().await?;
        let Some(run) = tx.lock_run(run_id).await? else {
            return tx.commit().await;
        };
        if run.status == RunStatus::Queued {
            tx.enqueue(execute_run_job(run.id)).await?;
        }
        tx.commit().await
    }

    // --- operator actions ------------------------------------------------------

    async fn run_of(&self, workflow: WorkflowId, run: RunId) -> DomainResult<Run> {
        self.store
            .find_run(run)
            .await?
            .filter(|r| r.workflow_id == workflow)
            .ok_or(DomainError::NotFound("run"))
    }

    /// Queued step runs are skipped; running ones finish with their real outcome.
    pub async fn stop_run(&self, workflow: WorkflowId, run_id: RunId) -> DomainResult<Run> {
        let run = self.run_of(workflow, run_id).await?;
        if !run.status.live() {
            return Err(DomainError::precondition(
                "RUN_FINISHED",
                "The run has already finished.",
            ));
        }
        let now = self.clock.now();
        let mut tx = self.store.begin().await?;
        let mut run = tx
            .lock_run(run_id)
            .await?
            .ok_or(DomainError::NotFound("run"))?;
        if !run.status.live() {
            return Err(DomainError::precondition(
                "RUN_NOT_RUNNING",
                "The run is no longer running.",
            ));
        }
        run.status = RunStatus::Cancelled;
        run.ended_at = Some(now);
        run.elapsed_ms = Some(run.elapsed_until(now));
        tx.save_run(&run).await?;
        let queued: Vec<StepRunId> = tx
            .step_run_states(run.id)
            .await?
            .into_iter()
            .filter(|s| s.status == StepRunStatus::Queued)
            .map(|s| s.id)
            .collect();
        let mut events = Vec::new();
        for id in tx
            .mark_step_runs(
                &queued,
                &[StepRunStatus::Queued],
                StepRunStatus::Skipped,
                now,
                Some(engine::STOPPED_REASON),
            )
            .await?
        {
            events.push(ev::step(
                ev::STEP_SKIPPED,
                run.workflow_id,
                run.id,
                id,
                Some("skipped"),
                Some(engine::STOPPED_REASON),
            ));
        }
        events.push(ev::run_status(ev::RUN_CANCELLED, &run, None));
        tx.append_events(&events).await?;
        tx.commit().await?;
        self.run_of(workflow, run_id).await
    }

    /// Requeues a failed step and its skipped/cancelled descendants in a finished run.
    pub async fn retry_step(
        &self,
        workflow: WorkflowId,
        run_id: RunId,
        step_run_id: StepRunId,
    ) -> DomainResult<Run> {
        let run = self.run_of(workflow, run_id).await?;
        let step = self
            .store
            .find_step_run(step_run_id)
            .await?
            .filter(|s| s.run_id == run.id);
        match &step {
            None => {
                return Err(DomainError::precondition(
                    "STEP_NOT_FOUND",
                    "Step run not found.",
                ));
            }
            Some(s) if s.status != StepRunStatus::Failed => {
                return Err(DomainError::precondition(
                    "STEP_NOT_FAILED",
                    "Only failed steps can be retried.",
                ));
            }
            _ => {}
        }
        if !run.status.terminal() {
            return Err(DomainError::precondition(
                "RUN_NOT_FINISHED",
                "The run must be finished before retrying a step.",
            ));
        }

        let mut tx = self.store.begin().await?;
        let mut run = tx
            .lock_run(run_id)
            .await?
            .ok_or(DomainError::NotFound("run"))?;
        let now = self.clock.now();
        if run.status.terminal() {
            run.status = RunStatus::Running;
            // The clock resumes now: the dead time between the original
            // failure and this retry must not count as execution (audit 4).
            run.resume_clock(now);
            run.ended_at = None;
            run.elapsed_ms = None;
            run.failure_summary = None;
            run.first_failed_step_run_id = None;
            tx.save_run(&run).await?;
        }
        let states = tx.step_run_states(run.id).await?;
        let failed = states
            .iter()
            .find(|s| s.id == step_run_id)
            .cloned()
            .ok_or(DomainError::NotFound("step run"))?;
        let mut requeued = tx
            .reset_step_runs(&[step_run_id], &[StepRunStatus::Failed], now)
            .await?;
        let descendants = engine::retry_targets(&run.snapshot, &states, &failed);
        requeued.extend(
            tx.reset_step_runs(
                &descendants,
                &[StepRunStatus::Skipped, StepRunStatus::Cancelled],
                now,
            )
            .await?,
        );
        let events: Vec<DomainEvent> = requeued
            .iter()
            .map(|id| ev::step(ev::STEP_QUEUED, run.workflow_id, run.id, id, None, None))
            .collect();
        tx.append_events(&events).await?;
        let states = tx.step_run_states(run.id).await?;
        for id in engine::ready_to_dispatch(&run.snapshot, &states) {
            tx.enqueue(execute_step_job(id)).await?;
        }
        tx.commit().await?;
        self.run_of(workflow, run_id).await
    }

    pub async fn delete_run(&self, workflow: WorkflowId, run_id: RunId) -> DomainResult<()> {
        let run = self.run_of(workflow, run_id).await?;
        let mut tx = self.store.begin().await?;
        tx.delete_run(run.id).await?;
        tx.append_events(&[ev::run_event(
            ev::RUN_DELETED,
            run.workflow_id,
            run.id,
            json!({}),
        )])
        .await?;
        tx.commit().await
    }

    // --- queries ---------------------------------------------------------------

    pub async fn get_run(
        &self,
        workflow: WorkflowId,
        run: RunId,
    ) -> DomainResult<(Run, Vec<StepRun>)> {
        let run = self.run_of(workflow, run).await?;
        let step_runs = self.store.step_runs(run.id).await?;
        Ok((run, step_runs))
    }

    pub async fn list_runs(
        &self,
        workflow: WorkflowId,
        mut filter: RunListFilter,
    ) -> DomainResult<Vec<Run>> {
        if filter.limit <= 0 {
            filter.limit = 20;
        }
        filter.limit = filter.limit.min(100);
        self.store.list_runs(workflow, &filter).await
    }

    pub async fn get_step_run(
        &self,
        workflow: WorkflowId,
        run: RunId,
        step_run: StepRunId,
    ) -> DomainResult<(Run, StepRun)> {
        let run = self.run_of(workflow, run).await?;
        let step_run = self
            .store
            .find_step_run(step_run)
            .await?
            .filter(|s| s.run_id == run.id)
            .ok_or(DomainError::NotFound("step run"))?;
        Ok((run, step_run))
    }
}
