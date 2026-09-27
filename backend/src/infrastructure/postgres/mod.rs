pub mod catalog_repo;
pub mod migrate;
pub mod pool;
pub mod uow;

use std::sync::Arc;

use sqlx::PgPool;

use crate::infrastructure::crypto::Cipher;
use crate::shared::error::DomainResult;
use uow::PgTx;

/// Postgres adapter implementing every feature's store port.
#[derive(Clone)]
pub struct PgStore {
    pub pool: PgPool,
    pub cipher: Arc<dyn Cipher>,
}

impl PgStore {
    pub fn new(pool: PgPool, cipher: Arc<dyn Cipher>) -> Self {
        Self { pool, cipher }
    }

    pub async fn tx(&self) -> DomainResult<PgTx> {
        PgTx::begin(&self.pool, self.cipher.clone()).await
    }
}
