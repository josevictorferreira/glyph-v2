//! Every RPC of the contract is routed and answers over gRPC-Web.
mod common;

use axum::body::Body;
use glyph_backend::proto::FILE_DESCRIPTOR_SET;
use http_body_util::BodyExt;
use prost::Message;
use sqlx::PgPool;
use tower::ServiceExt;

fn methods() -> Vec<(String, String)> {
    let fds = prost_types::FileDescriptorSet::decode(FILE_DESCRIPTOR_SET).unwrap();
    let mut out = Vec::new();
    for file in fds.file {
        let package = file.package().to_string();
        for service in &file.service {
            for method in &service.method {
                out.push((
                    format!("{package}.{}", service.name()),
                    method.name().to_string(),
                ));
            }
        }
    }
    out
}

async fn grpc_web_status(router: &axum::Router, service: &str, method: &str) -> Option<i32> {
    let response = router
        .clone()
        .oneshot(
            axum::http::Request::post(format!("/{service}/{method}"))
                .header("content-type", "application/grpc-web+proto")
                .body(Body::from(vec![0u8, 0, 0, 0, 0]))
                .unwrap(),
        )
        .await
        .unwrap();
    if let Some(v) = response.headers().get("grpc-status") {
        return v.to_str().ok()?.parse().ok();
    }
    let body = response.into_body().collect().await.unwrap().to_bytes();
    let text = String::from_utf8_lossy(&body);
    let start = text.find("grpc-status:")? + "grpc-status:".len();
    text[start..]
        .chars()
        .take_while(|c| c.is_ascii_digit())
        .collect::<String>()
        .parse()
        .ok()
}

#[sqlx::test(migrations = false)]
async fn every_rpc_is_routed(pool: PgPool) {
    let server = common::spawn(pool).await;
    let methods = methods();
    assert!(methods.len() > 40, "expected the full contract, got {}", methods.len());
    let services: std::collections::BTreeSet<_> = methods.iter().map(|(s, _)| s.clone()).collect();
    assert_eq!(services.len(), 5, "{services:?}");

    for (service, method) in &methods {
        let status = grpc_web_status(&server.router, service, method).await;
        // Handlers are UNIMPLEMENTED (12) until their feature spec lands.
        assert!(status.is_some(), "{service}/{method} returned no grpc-status");
    }
}
