use axum::extract::State;
use axum::http::StatusCode;

use crate::app::state::AppState;

/// `GET /up` — 200 `ok` when the database answers.
pub async fn up(State(state): State<AppState>) -> (StatusCode, &'static str) {
    match sqlx::query_scalar::<_, i32>("SELECT 1")
        .fetch_one(&state.pool)
        .await
    {
        Ok(_) => (StatusCode::OK, "ok"),
        Err(error) => {
            tracing::warn!(%error, "health check failed");
            (StatusCode::SERVICE_UNAVAILABLE, "database unavailable")
        }
    }
}
