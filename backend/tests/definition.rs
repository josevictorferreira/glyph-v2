//! DefinitionService + schema route (ports importer/yaml_editor/seed specs).
mod common;

use axum::body::Body;
use glyph_backend::proto::pb;
use glyph_backend::proto::pb::definition_service_client::DefinitionServiceClient;
use glyph_backend::proto::pb::workflow_service_client::WorkflowServiceClient;
use glyph_backend::proto::status::definition_errors;
use http_body_util::BodyExt;
use sqlx::PgPool;
use tonic::Code;
use tower::ServiceExt;

const FULL: &str = include_str!("fixtures/definitions/full.yml");
const UNKNOWN_KEY: &str = include_str!("fixtures/definitions/unknown_key.yml");
const TOURNAMENT: &str = include_str!("../seeds/design_poc_tournament.yml");

async fn events(pool: &PgPool, workflow_id: &str) -> i64 {
    sqlx::query_scalar("SELECT count(*) FROM events WHERE stream = $1")
        .bind(format!("Workflow${workflow_id}"))
        .fetch_one(pool)
        .await
        .unwrap()
}

#[sqlx::test(migrator = "glyph_backend::infrastructure::postgres::migrate::MIGRATOR")]
async fn schema_route(pool: PgPool) {
    let server = common::spawn(pool).await;
    let response = server
        .router
        .clone()
        .oneshot(axum::http::Request::get("/schemas/workflow.json").body(Body::empty()).unwrap())
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    assert_eq!(response.headers()["content-type"], "application/schema+json");
    assert_eq!(response.headers()["cache-control"], "public, max-age=86400");
    let body = response.into_body().collect().await.unwrap().to_bytes();
    let schema: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(schema["$id"], "/schemas/workflow.json");
}

#[sqlx::test(migrator = "glyph_backend::infrastructure::postgres::migrate::MIGRATOR")]
async fn import_apply_export(pool: PgPool) {
    let server = common::spawn_with(
        pool,
        common::config_with(&[("GLYPH_PUBLIC_URL", "https://glyph.test")]),
        Default::default(),
    )
    .await;
    let mut defs = DefinitionServiceClient::new(server.channel().await);

    // Invalid import creates nothing and carries located errors.
    let err = defs
        .import_workflow(pb::ImportWorkflowRequest { yaml: UNKNOWN_KEY.into() })
        .await
        .unwrap_err();
    assert_eq!(err.code(), Code::InvalidArgument);
    let located = definition_errors(&err);
    assert_eq!(located[0].path.as_deref(), Some("/steps/0"));
    assert_eq!(located[0].line, Some(3));
    assert_eq!(located[0].message, "\"bogus\" is not a known key here.");
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM workflows").fetch_one(&server.pool).await.unwrap();
    assert_eq!(count, 0);

    // Import.
    let imported = defs
        .import_workflow(pb::ImportWorkflowRequest { yaml: FULL.into() })
        .await
        .unwrap()
        .into_inner();
    let wf = imported.workflow.unwrap();
    let id = wf.summary.as_ref().unwrap().id.clone();
    assert_eq!(wf.summary.as_ref().unwrap().name, "Weekly competitor digest");
    assert_eq!(wf.summary.as_ref().unwrap().status(), pb::WorkflowStatus::Draft);
    assert_eq!(wf.steps.len(), 3);
    assert_eq!(wf.connections.len(), 2);
    assert!(!imported.issues.is_empty(), "models are not in the catalog");
    let first: String = sqlx::query_scalar("SELECT event_type FROM events WHERE stream = $1 ORDER BY id LIMIT 1")
        .bind(format!("Workflow${id}"))
        .fetch_one(&server.pool)
        .await
        .unwrap();
    assert_eq!(first, "WorkflowCreated");

    // Export → apply is a no-op.
    let export = defs
        .export_definition(pb::ExportDefinitionRequest { workflow_id: id.clone() })
        .await
        .unwrap()
        .into_inner();
    assert!(export.yaml.starts_with("# yaml-language-server: $schema=https://glyph.test/schemas/workflow.json\n"));
    assert_eq!(export.filename, "weekly-competitor-digest.yml");
    let baseline = events(&server.pool, &id).await;
    let applied = defs
        .apply_definition(pb::ApplyDefinitionRequest {
            workflow_id: id.clone(),
            yaml: export.yaml.clone(),
            fingerprint: export.fingerprint.clone(),
        })
        .await
        .unwrap()
        .into_inner();
    assert_eq!(applied.new_fingerprint, export.fingerprint);
    assert_eq!(events(&server.pool, &id).await, baseline);

    // Dry run.
    let parsed = defs
        .parse_definition(pb::ParseDefinitionRequest {
            workflow_id: Some(id.clone()),
            yaml: "name: W\nsteps:\n- id: \"999\"\n  name: X\n".into(),
        })
        .await
        .unwrap()
        .into_inner();
    assert_eq!(parsed.errors[0].path.as_deref(), Some("/steps/0/id"));
    assert!(defs
        .parse_definition(pb::ParseDefinitionRequest { workflow_id: None, yaml: FULL.into() })
        .await
        .unwrap()
        .into_inner()
        .errors
        .is_empty());

    // An edit elsewhere makes the old fingerprint stale → ABORTED, nothing written.
    let mut workflows = WorkflowServiceClient::new(server.channel().await);
    workflows
        .update_workflow(pb::UpdateWorkflowRequest {
            id: id.clone(),
            name: "Changed elsewhere".into(),
            description: None,
            fail_fast: false,
        })
        .await
        .unwrap();
    let err = defs
        .apply_definition(pb::ApplyDefinitionRequest {
            workflow_id: id.clone(),
            yaml: FULL.into(),
            fingerprint: export.fingerprint.clone(),
        })
        .await
        .unwrap_err();
    assert_eq!(err.code(), Code::Aborted);

    // Invalid YAML is rejected with errors; valid YAML applies and reports issues.
    let err = defs
        .apply_definition(pb::ApplyDefinitionRequest {
            workflow_id: id.clone(),
            yaml: UNKNOWN_KEY.into(),
            fingerprint: String::new(),
        })
        .await
        .unwrap_err();
    assert!(definition_errors(&err)[0].line.unwrap() > 0);
    let applied = defs
        .apply_definition(pb::ApplyDefinitionRequest {
            workflow_id: id.clone(),
            yaml: "name: Renamed\nsteps:\n- name: research\n  prompt: Only one\n".into(),
            fingerprint: String::new(),
        })
        .await
        .unwrap()
        .into_inner();
    let wf = applied.workflow.unwrap();
    assert_eq!(wf.summary.unwrap().name, "Renamed");
    assert_eq!(wf.steps.len(), 1);
    assert_eq!(wf.steps[0].prompt.as_deref(), Some("Only one"));
    assert!(wf.inputs.is_empty() && wf.schedule.is_none());
    assert!(applied.issues.iter().any(|i| i.message == "Describe the expected output of “research”."));

    let url = defs.get_schema_url(pb::GetSchemaUrlRequest {}).await.unwrap().into_inner().url;
    assert_eq!(url, "https://glyph.test/schemas/workflow.json");
}

#[sqlx::test(migrator = "glyph_backend::infrastructure::postgres::migrate::MIGRATOR")]
async fn tournament_seed_imports_and_validates(pool: PgPool) {
    for model in ["glm-5-3", "deepseek-v4-flash", "gandalf", "radagast"] {
        sqlx::query("INSERT INTO available_models (provider, model_id, available, fetched_at) VALUES ('velox', $1, true, now())")
            .bind(model)
            .execute(&pool)
            .await
            .unwrap();
    }
    let server = common::spawn(pool).await;
    let mut defs = DefinitionServiceClient::new(server.channel().await);
    let imported = defs
        .import_workflow(pb::ImportWorkflowRequest { yaml: TOURNAMENT.into() })
        .await
        .unwrap()
        .into_inner();
    assert!(imported.issues.is_empty(), "{:?}", imported.issues);
    let wf = imported.workflow.unwrap();
    let helper = wf.steps.iter().find(|s| s.kind() == pb::StepKind::Helper).unwrap();
    assert_eq!(helper.name, "Shared Context");
    assert_eq!(helper.inputs.len(), 1);
    assert!(helper.inputs[0].workflow_input_id.is_some());
    let fed: Vec<_> = wf.connections.iter().filter(|c| c.source_step_id == helper.id).collect();
    assert_eq!(fed.len(), 6);
    assert!(fed.iter().all(|c| c.source_output_name == "context"));

    let generate: Vec<_> = wf.steps.iter().filter(|s| s.name.starts_with("Generate")).collect();
    assert_eq!(
        generate.iter().map(|s| s.name.as_str()).collect::<Vec<_>>(),
        vec!["Generate — GLM 5.3", "Generate — DeepSeek V4", "Generate — Gandalf", "Generate — Radagast"]
    );
    assert!(generate.iter().all(|s| s.output_file_format() == pb::OutputFileFormat::Html && s.allow_failure));
    let others: Vec<_> = wf.steps.iter().filter(|s| !s.name.starts_with("Generate")).collect();
    assert!(others.iter().all(|s| s.output_file_format() == pb::OutputFileFormat::FreeTextMarkdown));
    let aggregate = wf.steps.iter().find(|s| s.name == "Aggregate Rankings").unwrap();
    assert!(aggregate.inputs.iter().all(|i| i.name.starts_with("scorecard_")));
    let judge = wf.steps.iter().find(|s| s.name == "Judge — Gandalf").unwrap();
    assert!(judge.additional_context.as_deref().unwrap().starts_with("# UX/UI Evaluation Scorecard"));
    assert_eq!(judge.inputs.len(), 5);
}
