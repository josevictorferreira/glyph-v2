//! Read-only agent routes (spec 0024, task 4.1): JSON over HTTP for the
//! Pi extension, backed by the same application services as gRPC.
mod common;
use axum::body::Body;
use common::fakes::FakeGateway;
use glyph_backend::app::bootstrap::Overrides;
use glyph_backend::features::catalog::Provider;
use glyph_backend::proto::pb::definition_service_client::DefinitionServiceClient;
use http_body_util::BodyExt;
use serde_json::{Value, json};
use sqlx::PgPool;
use tower::ServiceExt;

const FULL: &str = include_str!("fixtures/definitions/full.yml");

/// POSTs `body` to `/agent/v1/{tool}` and returns (status, JSON).
async fn call(server: &common::TestServer, tool: &str, body: Value) -> (u16, Value) {
    let response = server
        .router
        .clone()
        .oneshot(
            axum::http::Request::post(format!("/agent/v1/{tool}"))
                .header("content-type", "application/json")
                .body(Body::from(body.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status().as_u16();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    let value = if bytes.is_empty() {
        Value::Null
    } else {
        serde_json::from_slice(&bytes).unwrap()
    };
    (status, value)
}

/// Imports the full fixture and returns the new workflow id.
async fn seeded_workflow(server: &common::TestServer) -> String {
    let mut defs = DefinitionServiceClient::new(server.channel().await);
    let imported = defs
        .import_workflow(glyph_backend::proto::pb::ImportWorkflowRequest { yaml: FULL.into() })
        .await
        .unwrap()
        .into_inner();
    imported.workflow.unwrap().summary.unwrap().id
}

#[sqlx::test(migrator = "glyph_backend::infrastructure::postgres::migrate::MIGRATOR")]
async fn lists_workflows_with_id_name_and_status(pool: PgPool) {
    let server = common::spawn(pool).await;
    let id = seeded_workflow(&server).await;
    let (status, body) = call(&server, "list_workflows", json!({})).await;
    assert_eq!(status, 200, "{body}");
    let text = body["text"].as_str().unwrap();
    assert!(text.contains("Weekly competitor digest"), "{text}");
    assert!(text.contains(&id), "{text}");
    assert!(text.contains("draft"), "{text}");
}

#[sqlx::test(migrator = "glyph_backend::infrastructure::postgres::migrate::MIGRATOR")]
async fn exports_yaml_with_fingerprint_and_details(pool: PgPool) {
    let server = common::spawn(pool).await;
    let id = seeded_workflow(&server).await;
    let (status, body) = call(&server, "get_workflow_yaml", json!({ "workflow_id": id })).await;
    assert_eq!(status, 200, "{body}");
    let text = body["text"].as_str().unwrap();
    assert!(text.contains("name: Weekly competitor digest"), "{text}");
    assert!(text.contains("fingerprint:"), "{text}");
    assert_eq!(body["details"]["workflow_name"], "Weekly competitor digest");
    assert_eq!(body["details"]["workflow_id"], id);
    assert!(
        body["details"]["fingerprint"]
            .as_str()
            .is_some_and(|f| !f.is_empty()),
        "{body}"
    );
}

#[sqlx::test(migrator = "glyph_backend::infrastructure::postgres::migrate::MIGRATOR")]
async fn validates_yaml_valid_and_invalid_with_lines(pool: PgPool) {
    let server = common::spawn(pool).await;
    let id = seeded_workflow(&server).await;
    let mut defs = DefinitionServiceClient::new(server.channel().await);
    let export = defs
        .export_definition(glyph_backend::proto::pb::ExportDefinitionRequest {
            workflow_id: id.clone(),
        })
        .await
        .unwrap()
        .into_inner();
    // Valid: no errors.
    let (status, body) = call(
        &server,
        "validate_yaml",
        json!({ "workflow_id": id, "yaml": export.yaml }),
    )
    .await;
    assert_eq!(status, 200, "{body}");
    assert!(body["text"].as_str().unwrap().contains("valid"), "{body}");
    // Invalid: located errors in the text (a reference error carries its
    // source line; schema errors do not).
    let invalid = "name: Broken\nsteps:\n - name: first\n   prompt: Hi\n   expect: Bye\n   inputs:\n     notes: ghost\n";
    let (status, body) = call(
        &server,
        "validate_yaml",
        json!({ "workflow_id": id, "yaml": invalid }),
    )
    .await;
    assert_eq!(status, 200, "{body}");
    let text = body["text"].as_str().unwrap();
    assert!(text.contains("is not a step or a workflow input"), "{text}");
    assert!(text.contains("line "), "{text}");
}

#[sqlx::test(migrator = "glyph_backend::infrastructure::postgres::migrate::MIGRATOR")]
async fn lists_models_and_tools(pool: PgPool) {
    let server = common::spawn_with(
        pool,
        common::test_config(),
        Overrides {
            gateways: Some(vec![common::arc(FakeGateway::new(
                Provider::Velox,
                &["gemini-2.5-pro"],
            ))]),
            ..Overrides::default()
        },
    )
    .await;
    // Prime the catalog through the app's own refresh path.
    let mut catalog = glyph_backend::proto::pb::catalog_service_client::CatalogServiceClient::new(
        server.channel().await,
    );
    catalog
        .refresh_models(glyph_backend::proto::pb::RefreshModelsRequest {})
        .await
        .unwrap();
    let (status, body) = call(&server, "list_models", json!({})).await;
    assert_eq!(status, 200, "{body}");
    let text = body["text"].as_str().unwrap();
    assert!(text.contains("velox/gemini-2.5-pro"), "{text}");
    let (status, body) = call(&server, "list_tools", json!({})).await;
    assert_eq!(status, 200, "{body}");
    let text = body["text"].as_str().unwrap();
    for key in ["bash", "edit", "read", "write"] {
        assert!(text.contains(key), "{text}");
    }
}

#[sqlx::test(migrator = "glyph_backend::infrastructure::postgres::migrate::MIGRATOR")]
async fn maps_domain_errors_verbatim(pool: PgPool) {
    let server = common::spawn(pool).await;
    // Unknown workflow → 404 with the gRPC twin's message.
    let (status, body) = call(
        &server,
        "get_workflow_yaml",
        json!({ "workflow_id": "00000000-0000-0000-0000-000000000000" }),
    )
    .await;
    assert_eq!(status, 404, "{body}");
    assert_eq!(body["error"], "workflow not found");
    // Invalid tool body → 422.
    let (status, body) = call(&server, "get_workflow_yaml", json!({ "workflow_id": 42 })).await;
    assert_eq!(status, 422, "{body}");
    assert!(body["error"].as_str().is_some(), "{body}");
    // Unknown tool → 404.
    let (status, body) = call(&server, "no_such_tool", json!({})).await;
    assert_eq!(status, 404, "{body}");
}
