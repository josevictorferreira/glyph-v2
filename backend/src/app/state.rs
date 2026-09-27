use std::sync::Arc;

use sqlx::PgPool;

use crate::features::runs::RunService;
use crate::infrastructure::crypto::Cipher;

#[derive(Clone)]
pub struct AppState {
    pub pool: PgPool,
    pub cipher: Arc<dyn Cipher>,
    pub runs: RunService,
}
