use axum::http::header;
use axum::response::IntoResponse;

use crate::features::definition::domain::schema::SCHEMA_JSON;

/// `GET /schemas/workflow.json`.
pub async fn schema() -> impl IntoResponse {
    (
        [
            (header::CONTENT_TYPE, "application/schema+json"),
            (header::CACHE_CONTROL, "public, max-age=86400"),
        ],
        SCHEMA_JSON,
    )
}
