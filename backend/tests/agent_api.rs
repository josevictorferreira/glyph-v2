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

// --- Write tools (4.2) --------------------------------------------------------

mod write {
    use super::*;
    use glyph_backend::proto::pb;
    use glyph_backend::proto::pb::workflow_service_client::WorkflowServiceClient;

    /// The full fixture with a changed description, kept as YAML text.
    fn edited_yaml(original: &str) -> String {
        original.replace(
            "Summarise competitor moves every Monday.",
            "Summarise competitor moves every Monday, briefly.",
        )
    }

    /// A helper-only workflow: valid without any provider catalog.
    const HELPERS: &str = "name: Helpers\nsteps:\n - name: one\n   kind: helper\n";

    async fn helper_workflow(server: &common::TestServer) -> String {
        let (status, body) = call(server, "create_workflow", json!({ "yaml": HELPERS })).await;
        assert_eq!(status, 200, "{body}");
        body["details"]["workflow_id"].as_str().unwrap().to_string()
    }

    async fn export_yaml(server: &common::TestServer, id: &str) -> (String, String) {
        let mut defs = DefinitionServiceClient::new(server.channel().await);
        let export = defs
            .export_definition(glyph_backend::proto::pb::ExportDefinitionRequest {
                workflow_id: id.to_string(),
            })
            .await
            .unwrap()
            .into_inner();
        (export.yaml, export.fingerprint)
    }

    #[sqlx::test(migrator = "glyph_backend::infrastructure::postgres::migrate::MIGRATOR")]
    async fn update_workflow_needs_fingerprint_and_rejects_stale(pool: PgPool) {
        let server = common::spawn(pool).await;
        let id = seeded_workflow(&server).await;
        let (yaml, _fingerprint) = export_yaml(&server, &id).await;
        let edited = edited_yaml(&yaml);
        // No fingerprint → rejected, nothing changes.
        let (status, body) = call(
            &server,
            "update_workflow",
            json!({ "workflow_id": id, "yaml": edited }),
        )
        .await;
        assert_eq!(status, 422, "{body}");
        assert_eq!(
            body["error"],
            "update_workflow needs the fingerprint from get_workflow_yaml."
        );
        let (again, _) = export_yaml(&server, &id).await;
        assert_eq!(again, yaml, "changed without a fingerprint");
        // Stale fingerprint → re-export message.
        let (status, body) = call(
            &server,
            "update_workflow",
            json!({ "workflow_id": id, "yaml": edited, "fingerprint": "stale" }),
        )
        .await;
        assert_eq!(status, 409, "{body}");
        assert_eq!(
            body["error"],
            "The workflow changed since you exported it. Call get_workflow_yaml again and reapply your edit."
        );
    }

    #[sqlx::test(migrator = "glyph_backend::infrastructure::postgres::migrate::MIGRATOR")]
    async fn update_workflow_applies_and_carries_revert_details(pool: PgPool) {
        let server = common::spawn(pool).await;
        let id = seeded_workflow(&server).await;
        let (yaml, fingerprint) = export_yaml(&server, &id).await;
        let edited = edited_yaml(&yaml);
        let (status, body) = call(
            &server,
            "update_workflow",
            json!({ "workflow_id": id, "yaml": edited, "fingerprint": fingerprint }),
        )
        .await;
        assert_eq!(status, 200, "{body}");
        let details = &body["details"];
        assert_eq!(details["workflow_name"], "Weekly competitor digest");
        assert_eq!(details["workflow_id"], id);
        assert_eq!(details["previous_yaml"], yaml);
        assert_eq!(details["summary"], "Edited the definition.");
        let new_fingerprint = details["fingerprint"].as_str().unwrap().to_string();
        assert!(!new_fingerprint.is_empty(), "{body}");
        assert_ne!(new_fingerprint, fingerprint);
        // The change is applied; the old fingerprint is stale now.
        let (after, _) = export_yaml(&server, &id).await;
        assert!(after.contains("briefly"), "{after}");
        let (status, body) = call(
            &server,
            "update_workflow",
            json!({ "workflow_id": id, "yaml": edited, "fingerprint": fingerprint }),
        )
        .await;
        assert_eq!(status, 409, "{body}");
    }

    #[sqlx::test(migrator = "glyph_backend::infrastructure::postgres::migrate::MIGRATOR")]
    async fn update_workflow_sets_and_round_trips_schedule(pool: PgPool) {
        let server = common::spawn(pool).await;
        let id = seeded_workflow(&server).await;
        let (yaml, fingerprint) = export_yaml(&server, &id).await;
        // cron 0 9 * * 1 → 0 9 * * 2 (Tuesdays), new timezone. The
        // exporter writes the cron unquoted.
        let edited = yaml
            .replace("cron: 0 9 * * 1", "cron: 0 9 * * 2")
            .replace("timezone: America/Sao_Paulo", "timezone: UTC");
        let (status, body) = call(
            &server,
            "update_workflow",
            json!({ "workflow_id": id, "yaml": edited, "fingerprint": fingerprint }),
        )
        .await;
        assert_eq!(status, 200, "{body}");
        let (after, _) = export_yaml(&server, &id).await;
        assert!(after.contains("cron: 0 9 * * 2"), "{after}");
        assert!(after.contains("timezone: UTC"), "{after}");
    }

    #[sqlx::test(migrator = "glyph_backend::infrastructure::postgres::migrate::MIGRATOR")]
    async fn create_workflow_returns_id_and_issues(pool: PgPool) {
        let server = common::spawn(pool).await;
        let (status, body) = call(
            &server,
            "create_workflow",
            json!({ "yaml": "name: Agent made\ndescription: From chat.\nsteps:\n - name: only\n   prompt: Hi\n" }),
        )
        .await;
        assert_eq!(status, 200, "{body}");
        let id = body["details"]["workflow_id"].as_str().unwrap().to_string();
        assert!(!id.is_empty(), "{body}");
        assert_eq!(body["details"]["workflow_name"], "Agent made");
        // The model-less step reports its blocking issues in `details`.
        assert!(
            !body["details"]["issues"].as_array().unwrap().is_empty(),
            "{body}"
        );
        // It exists, as a draft.
        let mut workflows = WorkflowServiceClient::new(server.channel().await);
        let got = workflows
            .get_workflow(glyph_backend::proto::pb::GetWorkflowRequest { id })
            .await
            .unwrap()
            .into_inner();
        assert_eq!(
            got.workflow.unwrap().summary.unwrap().status(),
            pb::WorkflowStatus::Draft
        );
    }

    #[sqlx::test(migrator = "glyph_backend::infrastructure::postgres::migrate::MIGRATOR")]
    async fn create_workflow_rejects_invalid_yaml(pool: PgPool) {
        let server = common::spawn(pool).await;
        let (status, body) = call(
            &server,
            "create_workflow",
            json!({ "yaml": "name: Broken\nsteps:\n - name: only\n   prompt: Hi\n   inputs:\n     notes: ghost\n" }),
        )
        .await;
        assert_eq!(status, 422, "{body}");
        assert!(
            body["error"]
                .as_str()
                .unwrap()
                .contains("not a step or a workflow input"),
            "{body}"
        );
    }

    #[sqlx::test(migrator = "glyph_backend::infrastructure::postgres::migrate::MIGRATOR")]
    async fn set_workflow_state_activates_pauses_resumes_and_refuses_blocking(pool: PgPool) {
        let server = common::spawn(pool).await;
        // Blocking issues (missing models) refuse activation.
        let id = seeded_workflow(&server).await;
        let (status, body) = call(
            &server,
            "set_workflow_state",
            json!({ "workflow_id": id, "action": "activate" }),
        )
        .await;
        assert_eq!(status, 409, "{body}");
        assert_eq!(
            body["error"],
            "Resolve the issues before activating the workflow."
        );
        assert!(
            body["details"]["issues"]
                .as_array()
                .unwrap()
                .iter()
                .any(|issue| issue["blocking"] == true),
            "{body}"
        );
        // A helper-only flow cycles through every action.
        let helper_id = helper_workflow(&server).await;
        for (action, verb, expected) in [
            ("activate", "Activated", "active"),
            ("pause", "Paused", "paused"),
            ("resume", "Resumed", "active"),
            ("pause", "Paused", "paused"),
            ("resume", "Resumed", "active"),
        ] {
            let (status, body) = call(
                &server,
                "set_workflow_state",
                json!({ "workflow_id": helper_id, "action": action }),
            )
            .await;
            assert_eq!(status, 200, "{action}: {body}");
            assert!(
                body["text"].as_str().unwrap().contains(verb),
                "{action}: {body}"
            );
            assert_eq!(body["details"]["status"], expected, "{action}: {body}");
        }
    }

    #[sqlx::test(migrator = "glyph_backend::infrastructure::postgres::migrate::MIGRATOR")]
    async fn set_workflow_state_rejects_unknown_action(pool: PgPool) {
        let server = common::spawn(pool).await;
        let id = seeded_workflow(&server).await;
        let (status, body) = call(
            &server,
            "set_workflow_state",
            json!({ "workflow_id": id, "action": "explode" }),
        )
        .await;
        assert_eq!(status, 422, "{body}");
    }

    #[sqlx::test(migrator = "glyph_backend::infrastructure::postgres::migrate::MIGRATOR")]
    async fn start_run_returns_id_and_get_run_reports_steps(pool: PgPool) {
        let server = common::spawn(pool).await;
        let id = helper_workflow(&server).await;
        let (status, body) = call(&server, "start_run", json!({ "workflow_id": id })).await;
        assert_eq!(status, 200, "{body}");
        let run_id = body["details"]["run_id"].as_str().unwrap().to_string();
        assert!(!run_id.is_empty(), "{body}");
        // Worker disabled → queued, with one step run visible.
        let (status, body) = call(
            &server,
            "get_run",
            json!({ "workflow_id": id, "run_id": run_id }),
        )
        .await;
        assert_eq!(status, 200, "{body}");
        assert!(body["text"].as_str().unwrap().contains("queued"), "{body}");
        assert_eq!(body["details"]["status"], "queued");
        let steps = body["details"]["steps"].as_array().unwrap();
        assert_eq!(steps.len(), 1, "{body}");
        assert_eq!(steps[0]["name"], "one");
        assert_eq!(steps[0]["status"], "queued");
        // Unknown run → 404.
        let (status, body) = call(
            &server,
            "get_run",
            json!({
                "workflow_id": id,
                "run_id": "00000000-0000-0000-0000-000000000000",
            }),
        )
        .await;
        assert_eq!(status, 404, "{body}");
        assert_eq!(body["error"], "run not found");
    }

    #[sqlx::test(migrator = "glyph_backend::infrastructure::postgres::migrate::MIGRATOR")]
    async fn start_run_refuses_workflow_with_issues(pool: PgPool) {
        let server = common::spawn(pool).await;
        let id = seeded_workflow(&server).await;
        // No `company` value and unavailable models → refused.
        let (status, body) = call(&server, "start_run", json!({ "workflow_id": id })).await;
        assert_eq!(status, 409, "{body}");
        assert!(
            body["details"]["issues"]
                .as_array()
                .unwrap()
                .iter()
                .any(|issue| issue["blocking"] == true),
            "{body}"
        );
    }
}
