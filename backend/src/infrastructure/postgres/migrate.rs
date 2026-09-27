use sqlx::PgPool;
use sqlx::migrate::{MigrateError, Migrator};

pub static MIGRATOR: Migrator = sqlx::migrate!("./migrations");

/// Applies embedded migrations; a second run is a no-op.
pub async fn run(pool: &PgPool) -> Result<(), MigrateError> {
    MIGRATOR.run(pool).await
}
