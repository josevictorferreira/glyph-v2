mod common;

use axum::body::Body;
use http_body_util::BodyExt;
use sqlx::PgPool;
use tonic_health::pb::HealthCheckRequest;
use tonic_health::pb::health_check_response::ServingStatus;
use tonic_health::pb::health_client::HealthClient;
use tower::ServiceExt;

#[sqlx::test(migrations = false)]
async fn up_returns_ok(pool: PgPool) {
    let server = common::spawn(pool).await;
    let response = server
        .router
        .clone()
        .oneshot(
            axum::http::Request::get("/up")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    let body = response.into_body().collect().await.unwrap().to_bytes();
    assert_eq!(&body[..], b"ok");
}

#[sqlx::test(migrations = false)]
async fn native_grpc_health_is_serving(pool: PgPool) {
    let server = common::spawn(pool).await;
    let channel = tonic::transport::Channel::from_shared(server.url())
        .unwrap()
        .connect()
        .await
        .unwrap();
    let mut client = HealthClient::new(channel);
    let response = client
        .check(HealthCheckRequest {
            service: String::new(),
        })
        .await
        .unwrap();
    assert_eq!(response.into_inner().status(), ServingStatus::Serving);
}

#[sqlx::test(migrations = false)]
async fn grpc_web_request_is_accepted(pool: PgPool) {
    let server = common::spawn(pool).await;
    // An empty HealthCheckRequest in one uncompressed gRPC-Web frame.
    let frame = vec![0u8, 0, 0, 0, 0];
    let response = server
        .router
        .clone()
        .oneshot(
            axum::http::Request::post("/grpc.health.v1.Health/Check")
                .header("content-type", "application/grpc-web+proto")
                .header("x-grpc-web", "1")
                .body(Body::from(frame))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    assert_eq!(
        response.headers()["content-type"],
        "application/grpc-web+proto"
    );
    let body = response.into_body().collect().await.unwrap().to_bytes();
    // Data frame (flag 0) followed by a trailers frame (flag 0x80) with grpc-status:0.
    assert_eq!(body[0], 0);
    let text = String::from_utf8_lossy(&body);
    assert!(text.contains("grpc-status:0"), "{text}");
}
