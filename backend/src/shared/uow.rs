use async_trait::async_trait;

use crate::shared::error::DomainResult;
use crate::shared::events::{DomainEvent, Job};

/// A database transaction as seen by application code. Feature-specific
/// transaction ports (`WorkflowTx`, `RunTx`, …) extend it; the Postgres
/// adapter implements all of them on one `sqlx` transaction, so a use case
/// spanning features still commits atomically.
#[async_trait]
pub trait UnitOfWork: Send {
    /// Appends events and issues the matching live NOTIFY (delivered on commit).
    async fn append_events(&mut self, events: &[DomainEvent]) -> DomainResult<()>;
    async fn enqueue(&mut self, job: Job) -> DomainResult<()>;
    async fn commit(self: Box<Self>) -> DomainResult<()>;
}
