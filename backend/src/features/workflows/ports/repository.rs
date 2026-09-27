use async_trait::async_trait;

use crate::features::workflows::domain::model::{Workflow, WorkflowStatus, WorkflowSummary};
use crate::shared::error::DomainResult;
use crate::shared::ids::WorkflowId;
use crate::shared::uow::UnitOfWork;

#[derive(Debug, Clone, Default)]
pub struct ListFilter {
    /// Case-insensitive substring of name or description.
    pub query: String,
    pub status: Option<WorkflowStatus>,
    pub limit: i64,
}

#[async_trait]
pub trait WorkflowStore: Send + Sync {
    /// The full aggregate: inputs, steps (+inputs), connections, schedule (+values).
    async fn find(&self, id: WorkflowId) -> DomainResult<Option<Workflow>>;
    /// `updated_at DESC`, at most `limit`.
    async fn list(&self, filter: &ListFilter) -> DomainResult<Vec<WorkflowSummary>>;
    async fn begin(&self) -> DomainResult<Box<dyn WorkflowTx>>;
}

#[async_trait]
pub trait WorkflowTx: UnitOfWork {
    /// Loads the aggregate holding `SELECT … FOR UPDATE` on the workflow row
    /// until the transaction ends.
    async fn lock_workflow(&mut self, id: WorkflowId) -> DomainResult<Option<Workflow>>;
    /// Loads without locking (read inside the transaction).
    async fn load_workflow(&mut self, id: WorkflowId) -> DomainResult<Option<Workflow>>;
    /// Persists the aggregate: upserts every row, deletes children no longer present.
    async fn save_workflow(&mut self, workflow: &Workflow) -> DomainResult<()>;
    async fn active_workflow_ids(&mut self) -> DomainResult<Vec<WorkflowId>>;
}
