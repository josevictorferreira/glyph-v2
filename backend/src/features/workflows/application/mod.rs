//! Workflow use cases. Every mutation: lock aggregate → domain method →
//! revalidate → save + append events → reload, in one transaction.

use std::sync::Arc;

use crate::features::workflows::domain::catalog_view::CatalogView;
use crate::features::workflows::domain::model::{StepKind, Workflow, WorkflowSummary};
use crate::features::workflows::domain::schedule_calculator::Recurrence;
use crate::features::workflows::domain::validator;
use crate::features::workflows::domain::workflow::{Events, WorkflowInputFields};
use crate::features::workflows::ports::catalog::CatalogReader;
use crate::features::workflows::ports::repository::{ListFilter, WorkflowStore};
use crate::shared::error::{DomainError, DomainResult};
use crate::shared::ids::*;
use crate::shared::issue::Issue;
use crate::shared::output_format::OutputFileFormat;
use crate::shared::time::{Clock, Timestamp};

pub const MAX_LIST_LIMIT: i64 = 100;

/// A mutation's result: the reloaded aggregate, post-change issues, and the
/// command's own return value (e.g. a new id).
#[derive(Debug, Clone)]
pub struct Mutation<T = ()> {
    pub workflow: Workflow,
    pub issues: Vec<Issue>,
    pub value: T,
}

#[derive(Clone)]
pub struct WorkflowService {
    store: Arc<dyn WorkflowStore>,
    catalog: Arc<dyn CatalogReader>,
    clock: Arc<dyn Clock>,
}

impl WorkflowService {
    pub fn new(
        store: Arc<dyn WorkflowStore>,
        catalog: Arc<dyn CatalogReader>,
        clock: Arc<dyn Clock>,
    ) -> Self {
        Self {
            store,
            catalog,
            clock,
        }
    }

    pub fn now(&self) -> Timestamp {
        self.clock.now()
    }

    pub async fn catalog_view(&self) -> DomainResult<CatalogView> {
        self.catalog.view().await
    }

    // --- reads -------------------------------------------------------------

    pub async fn list(&self, mut filter: ListFilter) -> DomainResult<Vec<WorkflowSummary>> {
        if filter.limit <= 0 || filter.limit > MAX_LIST_LIMIT {
            filter.limit = MAX_LIST_LIMIT;
        }
        self.store.list(&filter).await
    }

    pub async fn get(&self, id: WorkflowId) -> DomainResult<(Workflow, Vec<Issue>)> {
        let workflow = self
            .store
            .find(id)
            .await?
            .ok_or(DomainError::NotFound("workflow"))?;
        let issues = validator::validate(&workflow, &self.catalog.view().await?);
        Ok((workflow, issues))
    }

    pub async fn validate(&self, id: WorkflowId) -> DomainResult<Vec<Issue>> {
        Ok(self.get(id).await?.1)
    }

    // --- pipeline ----------------------------------------------------------

    /// Runs `change` on the locked aggregate. `revalidate` applies the
    /// Revalidator (active + blocking → needs_attention); move/pause skip it.
    async fn mutate<T, F>(&self, id: WorkflowId, revalidate: bool, change: F) -> DomainResult<Mutation<T>>
    where
        F: FnOnce(&mut Workflow, &CatalogView, Timestamp) -> DomainResult<(T, Events)> + Send,
        T: Send,
    {
        let catalog = self.catalog.view().await?;
        let now = self.clock.now();
        let mut tx = self.store.begin().await?;
        let mut workflow = tx
            .lock_workflow(id)
            .await?
            .ok_or(DomainError::NotFound("workflow"))?;
        let (value, mut events) = change(&mut workflow, &catalog, now)?;
        let issues = if revalidate {
            let (issues, more) = workflow.revalidate(&catalog);
            events.extend(more);
            issues
        } else {
            validator::validate(&workflow, &catalog)
        };
        tx.save_workflow(&workflow).await?;
        tx.append_events(&events).await?;
        let workflow = tx
            .load_workflow(id)
            .await?
            .ok_or(DomainError::NotFound("workflow"))?;
        tx.commit().await?;
        Ok(Mutation {
            workflow,
            issues,
            value,
        })
    }

    // --- CRUD --------------------------------------------------------------

    pub async fn create(
        &self,
        name: &str,
        description: Option<String>,
        fail_fast: bool,
    ) -> DomainResult<Mutation> {
        let catalog = self.catalog.view().await?;
        let (workflow, events) = Workflow::create(name, description, fail_fast, self.clock.now());
        let mut tx = self.store.begin().await?;
        tx.save_workflow(&workflow).await?;
        tx.append_events(&events).await?;
        let workflow = tx
            .load_workflow(workflow.id)
            .await?
            .ok_or(DomainError::NotFound("workflow"))?;
        tx.commit().await?;
        let issues = validator::validate(&workflow, &catalog);
        Ok(Mutation {
            workflow,
            issues,
            value: (),
        })
    }

    pub async fn update(
        &self,
        id: WorkflowId,
        name: String,
        description: Option<String>,
        fail_fast: bool,
    ) -> DomainResult<Mutation> {
        self.mutate(id, true, move |wf, _, _| {
            Ok(((), wf.update_details(&name, description, fail_fast)?))
        })
        .await
    }

    // --- steps -------------------------------------------------------------

    pub async fn add_step(
        &self,
        id: WorkflowId,
        kind: StepKind,
        position: Option<(i32, i32)>,
    ) -> DomainResult<Mutation<StepId>> {
        self.mutate(id, true, move |wf, _, now| Ok(wf.add_step(kind, position, now)))
            .await
    }

    pub async fn duplicate_step(&self, id: WorkflowId, step: StepId) -> DomainResult<Mutation<StepId>> {
        self.mutate(id, true, move |wf, _, now| wf.duplicate_step(step, now))
            .await
    }

    pub async fn update_step_details(
        &self,
        id: WorkflowId,
        step: StepId,
        name: String,
        description: Option<String>,
        allow_failure: bool,
    ) -> DomainResult<Mutation> {
        self.mutate(id, true, move |wf, _, _| {
            Ok(((), wf.update_step_details(step, &name, description, allow_failure)?))
        })
        .await
    }

    pub async fn update_step_prompt(
        &self,
        id: WorkflowId,
        step: StepId,
        prompt: Option<String>,
        additional_context: Option<String>,
    ) -> DomainResult<Mutation> {
        self.mutate(id, true, move |wf, _, _| {
            Ok(((), wf.update_step_prompt(step, prompt, additional_context)?))
        })
        .await
    }

    pub async fn update_step_output(
        &self,
        id: WorkflowId,
        step: StepId,
        output_name: String,
        output_description: Option<String>,
        expected_output: Option<String>,
        format: OutputFileFormat,
    ) -> DomainResult<Mutation> {
        self.mutate(id, true, move |wf, _, _| {
            Ok((
                (),
                wf.update_step_output(step, &output_name, output_description, expected_output, format)?,
            ))
        })
        .await
    }

    pub async fn update_step_model(
        &self,
        id: WorkflowId,
        step: StepId,
        model_id: String,
        temperature: Option<f64>,
    ) -> DomainResult<Mutation> {
        self.mutate(id, true, move |wf, _, _| {
            Ok(((), wf.update_step_model(step, &model_id, temperature)?))
        })
        .await
    }

    pub async fn toggle_step_tool(&self, id: WorkflowId, step: StepId, key: String) -> DomainResult<Mutation> {
        self.mutate(id, true, move |wf, catalog, _| {
            Ok(((), wf.toggle_step_tool(step, &key, catalog)?))
        })
        .await
    }

    pub async fn move_step(&self, id: WorkflowId, step: StepId, x: i32, y: i32) -> DomainResult<Mutation> {
        self.mutate(id, false, move |wf, _, _| {
            wf.move_step(step, x, y)?;
            Ok(((), Vec::new()))
        })
        .await
    }

    pub async fn delete_step(&self, id: WorkflowId, step: StepId) -> DomainResult<Mutation> {
        self.mutate(id, true, move |wf, _, _| Ok(((), wf.delete_step(step)?)))
            .await
    }

    // --- step inputs -------------------------------------------------------

    pub async fn add_step_input(
        &self,
        id: WorkflowId,
        step: StepId,
        name: String,
        required: bool,
    ) -> DomainResult<Mutation<StepInputId>> {
        self.mutate(id, true, move |wf, _, now| wf.add_step_input(step, &name, required, now))
            .await
    }

    pub async fn remove_step_input(&self, id: WorkflowId, input: StepInputId) -> DomainResult<Mutation> {
        self.mutate(id, true, move |wf, _, _| Ok(((), wf.remove_step_input(input)?)))
            .await
    }

    pub async fn map_step_input(
        &self,
        id: WorkflowId,
        input: StepInputId,
        workflow_input: Option<WorkflowInputId>,
    ) -> DomainResult<Mutation> {
        self.mutate(id, true, move |wf, _, _| {
            Ok(((), wf.map_step_input(input, workflow_input)?))
        })
        .await
    }

    // --- workflow inputs ---------------------------------------------------

    pub async fn add_workflow_input(
        &self,
        id: WorkflowId,
        fields: WorkflowInputFields,
    ) -> DomainResult<Mutation<WorkflowInputId>> {
        self.mutate(id, true, move |wf, _, now| wf.add_workflow_input(fields, now))
            .await
    }

    pub async fn update_workflow_input(
        &self,
        id: WorkflowId,
        input: WorkflowInputId,
        fields: WorkflowInputFields,
    ) -> DomainResult<Mutation> {
        self.mutate(id, true, move |wf, _, _| {
            Ok(((), wf.update_workflow_input(input, fields)?))
        })
        .await
    }

    pub async fn remove_workflow_input(&self, id: WorkflowId, input: WorkflowInputId) -> DomainResult<Mutation> {
        self.mutate(id, true, move |wf, _, _| Ok(((), wf.remove_workflow_input(input)?)))
            .await
    }

    // --- connections -------------------------------------------------------

    pub async fn create_connection(
        &self,
        id: WorkflowId,
        source: StepId,
        input: StepInputId,
        replace_existing: bool,
    ) -> DomainResult<Mutation<ConnectionId>> {
        self.mutate(id, true, move |wf, _, now| {
            wf.create_connection(source, input, replace_existing, now)
        })
        .await
    }

    pub async fn connect_output_to_step(
        &self,
        id: WorkflowId,
        source: StepId,
        target: StepId,
    ) -> DomainResult<Mutation<(ConnectionId, StepInputId)>> {
        self.mutate(id, true, move |wf, _, now| {
            let (connection, input, events) = wf.connect_output_to_step(source, target, now)?;
            Ok(((connection, input), events))
        })
        .await
    }

    pub async fn remove_connection(&self, id: WorkflowId, connection: ConnectionId) -> DomainResult<Mutation> {
        self.mutate(id, true, move |wf, _, _| Ok(((), wf.remove_connection(connection)?)))
            .await
    }

    // --- schedule ----------------------------------------------------------

    pub async fn save_schedule(
        &self,
        id: WorkflowId,
        recurrence: Option<Recurrence>,
        timezone: String,
        enabled: bool,
    ) -> DomainResult<Mutation> {
        self.mutate(id, true, move |wf, _, now| {
            Ok(((), wf.save_schedule(recurrence, &timezone, enabled, now)?))
        })
        .await
    }

    pub async fn set_schedule_value(
        &self,
        id: WorkflowId,
        input: WorkflowInputId,
        value: String,
    ) -> DomainResult<Mutation> {
        self.mutate(id, true, move |wf, _, now| {
            wf.set_schedule_value(input, &value, now)?;
            Ok(((), Vec::new()))
        })
        .await
    }

    // --- lifecycle ---------------------------------------------------------

    pub async fn activate(&self, id: WorkflowId) -> DomainResult<Mutation> {
        self.mutate(id, false, move |wf, catalog, now| Ok(((), wf.activate(catalog, now)?)))
            .await
    }

    pub async fn pause(&self, id: WorkflowId) -> DomainResult<Mutation> {
        self.mutate(id, false, move |wf, _, _| Ok(((), wf.pause())))
            .await
    }

    /// `value` is whether the workflow resumed (false → needs_attention).
    pub async fn resume(&self, id: WorkflowId) -> DomainResult<Mutation<bool>> {
        self.mutate(id, false, move |wf, catalog, now| {
            let (resumed, _, events) = wf.resume(catalog, now);
            Ok((resumed, events))
        })
        .await
    }

    /// Active workflows with a step using any of `model_ids` → needs_attention.
    pub async fn flag_workflows_using_models(&self, model_ids: &[String]) -> DomainResult<usize> {
        if model_ids.is_empty() {
            return Ok(0);
        }
        let mut tx = self.store.begin().await?;
        let mut flagged = 0;
        for id in tx.active_workflow_ids().await? {
            let Some(mut workflow) = tx.lock_workflow(id).await? else {
                continue;
            };
            if !workflow.uses_any_model(model_ids) {
                continue;
            }
            let events =
                workflow.mark_needs_attention(vec!["A selected model is no longer available.".into()]);
            tx.save_workflow(&workflow).await?;
            tx.append_events(&events).await?;
            flagged += 1;
        }
        tx.commit().await?;
        Ok(flagged)
    }
}
