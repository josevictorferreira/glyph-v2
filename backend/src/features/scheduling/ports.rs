use async_trait::async_trait;

use crate::features::runs::RunTx;
use crate::shared::error::DomainResult;
use crate::shared::ids::WorkflowId;
use crate::shared::time::Timestamp;

#[async_trait]
pub trait SchedulingStore: Send + Sync {
    /// Active workflows with an enabled schedule whose next run is due.
    async fn due_workflow_ids(&self, now: Timestamp) -> DomainResult<Vec<WorkflowId>>;
    async fn begin(&self) -> DomainResult<Box<dyn RunTx>>;
}
