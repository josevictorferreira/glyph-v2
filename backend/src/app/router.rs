use axum::Router;
use axum::http::{HeaderName, HeaderValue, Method};
use axum::routing::get;
use tower_http::cors::{AllowOrigin, CorsLayer};
use tower_http::trace::TraceLayer;

use crate::app::state::AppState;
use crate::features::{definition, health, runs};

/// One router, one port: plain HTTP routes + gRPC (native h2 and gRPC-Web).
pub fn build(state: AppState, grpc: Router, cors: CorsLayer) -> Router {
    Router::new()
        .route("/up", get(health::http::up))
        .route(definition::SCHEMA_ROUTE, get(definition::http::schema))
        .route(
            "/workflows/{workflow_id}/runs/{run_id}/step_runs/{step_run_id}/download",
            get(runs::http::download),
        )
        .route(
            "/workflows/{workflow_id}/runs/{run_id}/step_runs/{step_run_id}/preview",
            get(runs::http::preview),
        )
        .with_state(state)
        .merge(grpc)
        .layer(cors)
        .layer(TraceLayer::new_for_http())
}

pub fn cors(origins: &[String]) -> CorsLayer {
    let origins: Vec<HeaderValue> = origins
        .iter()
        .filter_map(|o| HeaderValue::from_str(o).ok())
        .collect();
    CorsLayer::new()
        .allow_origin(AllowOrigin::list(origins))
        .allow_methods([Method::GET, Method::POST, Method::OPTIONS])
        .allow_headers([
            HeaderName::from_static("content-type"),
            HeaderName::from_static("x-grpc-web"),
            HeaderName::from_static("x-user-agent"),
            HeaderName::from_static("grpc-timeout"),
            HeaderName::from_static("connect-protocol-version"),
            HeaderName::from_static("authorization"),
        ])
        .expose_headers([
            HeaderName::from_static("grpc-status"),
            HeaderName::from_static("grpc-message"),
            HeaderName::from_static("grpc-status-details-bin"),
            HeaderName::from_static("content-disposition"),
        ])
}
