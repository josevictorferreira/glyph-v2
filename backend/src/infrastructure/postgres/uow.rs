use std::sync::Arc;

use async_trait::async_trait;
use chrono::Utc;
use sqlx::{PgPool, Postgres, Transaction};

use crate::features::live::domain::{CHANNEL, LiveEvent};
use crate::infrastructure::crypto::Cipher;
use crate::shared::error::{DomainError, DomainResult};
use crate::shared::events::{DomainEvent, Job};
use crate::shared::uow::UnitOfWork;

/// One `sqlx` transaction implementing every feature's transaction port.
pub struct PgTx {
    pub(crate) tx: Transaction<'static, Postgres>,
    pub(crate) cipher: Arc<dyn Cipher>,
}

impl PgTx {
    pub async fn begin(pool: &PgPool, cipher: Arc<dyn Cipher>) -> DomainResult<Self> {
        Ok(Self {
            tx: pool.begin().await.map_err(db)?,
            cipher,
        })
    }
}

pub fn db(error: sqlx::Error) -> DomainError {
    DomainError::Internal(anyhow::Error::new(error).context("database error"))
}

pub async fn append_events(
    conn: &mut sqlx::PgConnection,
    events: &[DomainEvent],
) -> DomainResult<()> {
    for event in events {
        sqlx::query!(
            "INSERT INTO events (event_type, stream, correlation_id, data) VALUES ($1, $2, $3, $4)",
            event.event_type,
            event.stream,
            event.correlation_id,
            event.data,
        )
        .execute(&mut *conn)
        .await
        .map_err(db)?;
        if let Some(live) = LiveEvent::from_domain(event, Utc::now()) {
            notify(&mut *conn, &live).await?;
        }
    }
    Ok(())
}

/// `pg_notify` inside the caller's transaction: delivered only on commit.
pub async fn notify(conn: &mut sqlx::PgConnection, event: &LiveEvent) -> DomainResult<()> {
    let payload = serde_json::to_string(event).map_err(DomainError::internal)?;
    sqlx::query!("SELECT pg_notify($1, $2)", CHANNEL, payload)
        .execute(&mut *conn)
        .await
        .map_err(db)?;
    Ok(())
}

pub async fn enqueue(conn: &mut sqlx::PgConnection, job: &Job) -> DomainResult<()> {
    sqlx::query!(
        "INSERT INTO jobs (kind, queue, payload) VALUES ($1, $2, $3)",
        job.kind,
        job.queue,
        job.payload,
    )
    .execute(&mut *conn)
    .await
    .map_err(db)?;
    // Wakes idle workers on commit (they also poll).
    sqlx::query!("SELECT pg_notify($1, $2)", super::jobs::WAKE_CHANNEL, job.queue)
        .execute(&mut *conn)
        .await
        .map_err(db)?;
    Ok(())
}

#[async_trait]
impl UnitOfWork for PgTx {
    async fn append_events(&mut self, events: &[DomainEvent]) -> DomainResult<()> {
        append_events(&mut self.tx, events).await
    }

    async fn enqueue(&mut self, job: Job) -> DomainResult<()> {
        enqueue(&mut self.tx, &job).await
    }

    async fn commit(self: Box<Self>) -> DomainResult<()> {
        self.tx.commit().await.map_err(db)
    }
}
