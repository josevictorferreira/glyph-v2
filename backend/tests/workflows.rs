//! WorkflowService over gRPC against a real database (ports the Rails editor
//! spec scenarios, lifecycle and listing behaviour).
mod common;

use std::sync::Arc;

use common::fakes::FakeGateway;
use glyph_backend::app::bootstrap::Overrides;
use glyph_backend::features::catalog::Provider;
use glyph_backend::proto::pb;
use glyph_backend::proto::pb::catalog_service_client::CatalogServiceClient;
use glyph_backend::proto::pb::workflow_service_client::WorkflowServiceClient;
use glyph_backend::proto::status::{error_info, validation_issues};
use sqlx::PgPool;
use tonic::Code;
use tonic::transport::Channel;

type Client = WorkflowServiceClient<Channel>;

async fn seed_model(pool: &PgPool) {
    sqlx::query(
        "INSERT INTO available_models (provider, model_id, available, capabilities, fetched_at)
         VALUES ('velox', 'test-model', true, '{\"temperature\": true}', now())",
    )
    .execute(pool)
    .await
    .unwrap();
}

async fn setup(pool: PgPool) -> (common::TestServer, Client) {
    seed_model(&pool).await;
    let server = common::spawn(pool).await;
    let client = WorkflowServiceClient::new(server.channel().await);
    (server, client)
}

async fn create(client: &mut Client, name: &str) -> pb::Workflow {
    client
        .create_workflow(pb::CreateWorkflowRequest {
            name: name.into(),
            description: Some("A workflow".into()),
            fail_fast: false,
        })
        .await
        .unwrap()
        .into_inner()
        .workflow
        .unwrap()
}

fn wid(wf: &pb::Workflow) -> String {
    wf.summary.as_ref().unwrap().id.clone()
}

/// Adds a fully configured pi step (factory `:workflow_step`).
async fn complete_step(client: &mut Client, workflow_id: &str, name: &str) -> String {
    let step_id = client
        .add_step(pb::AddStepRequest {
            workflow_id: workflow_id.into(),
            kind: pb::StepKind::Pi as i32,
            canvas_x: None,
            canvas_y: None,
        })
        .await
        .unwrap()
        .into_inner()
        .new_step_id;
    client
        .update_step_details(pb::UpdateStepDetailsRequest {
            workflow_id: workflow_id.into(),
            step_id: step_id.clone(),
            name: name.into(),
            description: None,
            allow_failure: false,
        })
        .await
        .unwrap();
    client
        .update_step_prompt(pb::UpdateStepPromptRequest {
            workflow_id: workflow_id.into(),
            step_id: step_id.clone(),
            prompt: Some("Do the thing".into()),
            additional_context: None,
        })
        .await
        .unwrap();
    client
        .update_step_output(pb::UpdateStepOutputRequest {
            workflow_id: workflow_id.into(),
            step_id: step_id.clone(),
            output_name: "result".into(),
            output_description: None,
            expected_output: Some("The result".into()),
            output_file_format: pb::OutputFileFormat::FreeTextMarkdown as i32,
        })
        .await
        .unwrap();
    client
        .update_step_model(pb::UpdateStepModelRequest {
            workflow_id: workflow_id.into(),
            step_id: step_id.clone(),
            model_id: "velox/test-model".into(),
            temperature: None,
        })
        .await
        .unwrap();
    step_id
}

async fn event_types(pool: &PgPool, workflow_id: &str) -> Vec<String> {
    sqlx::query_scalar("SELECT event_type FROM events WHERE stream = $1 ORDER BY id")
        .bind(format!("Workflow${workflow_id}"))
        .fetch_all(pool)
        .await
        .unwrap()
}

fn step<'a>(wf: &'a pb::Workflow, id: &str) -> &'a pb::Step {
    wf.steps.iter().find(|s| s.id == id).unwrap()
}

fn status(wf: &pb::Workflow) -> pb::WorkflowStatus {
    wf.summary.as_ref().unwrap().status()
}

#[sqlx::test(migrator = "glyph_backend::infrastructure::postgres::migrate::MIGRATOR")]
async fn create_get_update_list(pool: PgPool) {
    let (server, mut client) = setup(pool).await;
    let blank = create(&mut client, "  ").await;
    assert_eq!(blank.summary.as_ref().unwrap().name, "Untitled workflow");
    assert_eq!(status(&blank), pb::WorkflowStatus::Draft);
    assert_eq!(
        event_types(&server.pool, &wid(&blank)).await,
        vec!["WorkflowCreated"]
    );

    let wf = create(&mut client, "Research 50%_off").await;
    let err = client
        .update_workflow(pb::UpdateWorkflowRequest {
            id: wid(&wf),
            name: " ".into(),
            description: None,
            fail_fast: false,
        })
        .await
        .unwrap_err();
    assert_eq!(err.code(), Code::InvalidArgument);
    assert_eq!(err.message(), "Unable to save — the workflow needs a name.");

    let updated = client
        .update_workflow(pb::UpdateWorkflowRequest {
            id: wid(&wf),
            name: "  Research 50%_off  ".into(),
            description: Some("desc".into()),
            fail_fast: true,
        })
        .await
        .unwrap()
        .into_inner();
    let summary = updated.workflow.unwrap().summary.unwrap();
    assert_eq!(summary.name, "Research 50%_off");
    assert!(summary.fail_fast);
    // A blank workflow blocks on "no steps".
    assert!(
        updated
            .issues
            .iter()
            .any(|i| i.message == "Add at least one step before the workflow can run.")
    );

    let list = |query: &str, status: Option<pb::WorkflowStatus>| {
        let mut client = client.clone();
        let query = query.to_string();
        async move {
            client
                .list_workflows(pb::ListWorkflowsRequest {
                    query,
                    status: status.map(|s| s as i32),
                    limit: 0,
                })
                .await
                .unwrap()
                .into_inner()
                .workflows
        }
    };
    let all = list("", None).await;
    assert_eq!(all.len(), 2);
    assert_eq!(
        all[0].name, "Research 50%_off",
        "most recently updated first"
    );
    assert_eq!(list("50%", None).await.len(), 1);
    assert_eq!(list("%", None).await.len(), 1, "wildcards are escaped");
    assert_eq!(
        list("DESC", None).await.len(),
        1,
        "description matches case-insensitively"
    );
    assert_eq!(list("", Some(pb::WorkflowStatus::Active)).await.len(), 0);

    let got = client
        .get_workflow(pb::GetWorkflowRequest { id: wid(&wf) })
        .await
        .unwrap()
        .into_inner();
    assert_eq!(
        got.workflow
            .unwrap()
            .summary
            .unwrap()
            .description
            .as_deref(),
        Some("desc")
    );
    let missing = client
        .get_workflow(pb::GetWorkflowRequest {
            id: uuid::Uuid::new_v4().to_string(),
        })
        .await
        .unwrap_err();
    assert_eq!(missing.code(), Code::NotFound);
    let bad = client
        .get_workflow(pb::GetWorkflowRequest { id: "nope".into() })
        .await
        .unwrap_err();
    assert_eq!(bad.code(), Code::InvalidArgument);
}

#[sqlx::test(migrator = "glyph_backend::infrastructure::postgres::migrate::MIGRATOR")]
async fn steps_and_events(pool: PgPool) {
    let (server, mut client) = setup(pool).await;
    let wf = create(&mut client, "W").await;
    let id = wid(&wf);

    let helper = client
        .add_step(pb::AddStepRequest {
            workflow_id: id.clone(),
            kind: pb::StepKind::Helper as i32,
            canvas_x: Some(-100),
            canvas_y: Some(99_999),
        })
        .await
        .unwrap()
        .into_inner();
    let h = step(helper.workflow.as_ref().unwrap(), &helper.new_step_id);
    assert_eq!(h.kind(), pb::StepKind::Helper);
    assert_eq!((h.canvas_x, h.canvas_y), (0, 3000));
    let data: serde_json::Value = sqlx::query_scalar(
        "SELECT data FROM events WHERE event_type = 'WorkflowStepAdded' ORDER BY id DESC LIMIT 1",
    )
    .fetch_one(&server.pool)
    .await
    .unwrap();
    assert_eq!(data["kind"], "helper");
    assert_eq!(data["step_id"], helper.new_step_id);
    assert!(data["actor_id"].is_null());

    let source = complete_step(&mut client, &id, "Original Step").await;
    client
        .toggle_step_tool(pb::ToggleStepToolRequest {
            workflow_id: id.clone(),
            step_id: source.clone(),
            tool_key: "read".into(),
        })
        .await
        .unwrap();
    let err = client
        .toggle_step_tool(pb::ToggleStepToolRequest {
            workflow_id: id.clone(),
            step_id: source.clone(),
            tool_key: "rm_rf".into(),
        })
        .await
        .unwrap_err();
    assert_eq!(
        err.message(),
        "Unable to save — that tool is not available."
    );
    let err = client
        .update_step_model(pb::UpdateStepModelRequest {
            workflow_id: id.clone(),
            step_id: source.clone(),
            model_id: "velox/test-model".into(),
            temperature: Some(3.0),
        })
        .await
        .unwrap_err();
    assert_eq!(
        err.message(),
        "Unable to save — temperature must be a number between 0 and 2."
    );
    let with_temp = client
        .update_step_model(pb::UpdateStepModelRequest {
            workflow_id: id.clone(),
            step_id: source.clone(),
            model_id: "velox/test-model".into(),
            temperature: Some(0.4),
        })
        .await
        .unwrap()
        .into_inner();
    let s = step(with_temp.workflow.as_ref().unwrap(), &source);
    assert_eq!(s.temperature, Some(0.4));
    assert_eq!(s.enabled_tool_keys, vec!["read"]);
    assert!(s.configured);

    let dup = client
        .duplicate_step(pb::DuplicateStepRequest {
            workflow_id: id.clone(),
            step_id: source.clone(),
        })
        .await
        .unwrap()
        .into_inner();
    let copy = step(dup.workflow.as_ref().unwrap(), &dup.new_step_id);
    let original = step(dup.workflow.as_ref().unwrap(), &source);
    assert_eq!(copy.name, "Original Step");
    assert_eq!(
        (copy.canvas_x, copy.canvas_y),
        (original.canvas_x + 40, original.canvas_y + 40)
    );
    assert!(copy.model_id.is_none());

    let moved = client
        .move_step(pb::MoveStepRequest {
            workflow_id: id.clone(),
            step_id: source.clone(),
            canvas_x: 5000,
            canvas_y: 10,
        })
        .await
        .unwrap()
        .into_inner();
    assert_eq!(
        step(moved.workflow.as_ref().unwrap(), &source).canvas_x,
        4000
    );

    let deleted = client
        .delete_step(pb::DeleteStepRequest {
            workflow_id: id.clone(),
            step_id: dup.new_step_id.clone(),
        })
        .await
        .unwrap()
        .into_inner();
    assert_eq!(deleted.workflow.unwrap().steps.len(), 2);

    let types = event_types(&server.pool, &id).await;
    assert_eq!(types.first().map(String::as_str), Some("WorkflowCreated"));
    assert!(types.contains(&"WorkflowStepDeleted".to_string()));
    assert!(types.contains(&"WorkflowStepUpdated".to_string()));
    // MoveStep publishes nothing.
    let before_move = types.len();
    client
        .move_step(pb::MoveStepRequest {
            workflow_id: id.clone(),
            step_id: source,
            canvas_x: 1,
            canvas_y: 1,
        })
        .await
        .unwrap();
    assert_eq!(event_types(&server.pool, &id).await.len(), before_move);
}

#[sqlx::test(migrator = "glyph_backend::infrastructure::postgres::migrate::MIGRATOR")]
async fn inputs_connections_and_deletion(pool: PgPool) {
    let (server, mut client) = setup(pool).await;
    let wf = create(&mut client, "W").await;
    let id = wid(&wf);
    let source = complete_step(&mut client, &id, "Source").await;
    let dest = complete_step(&mut client, &id, "Dest").await;

    // Step inputs.
    let added = client
        .add_step_input(pb::AddStepInputRequest {
            workflow_id: id.clone(),
            step_id: dest.clone(),
            name: " topic ".into(),
            required: true,
        })
        .await
        .unwrap()
        .into_inner();
    let topic = added.new_input_id.clone();
    assert!(
        added.issues.iter().any(|i| i.message
            == "Required input “topic” on “Dest” needs a connection or a workflow value.")
    );
    let dup = client
        .add_step_input(pb::AddStepInputRequest {
            workflow_id: id.clone(),
            step_id: dest.clone(),
            name: "TOPIC".into(),
            required: true,
        })
        .await
        .unwrap_err();
    assert_eq!(
        dup.message(),
        "Unable to save — Name has already been taken."
    );

    // Workflow inputs + mapping.
    let wi = client
        .add_workflow_input(pb::AddWorkflowInputRequest {
            workflow_id: id.clone(),
            name: "subject".into(),
            description: None,
            required: true,
            value: None,
            ask_at_run_time: true,
        })
        .await
        .unwrap()
        .into_inner()
        .new_input_id;
    let err = client
        .add_workflow_input(pb::AddWorkflowInputRequest {
            workflow_id: id.clone(),
            name: "9lives".into(),
            description: None,
            required: false,
            value: None,
            ask_at_run_time: true,
        })
        .await
        .unwrap_err();
    assert_eq!(
        err.message(),
        "Unable to save — Name must start with a letter and use letters, numbers, spaces or underscores."
    );
    let mapped = client
        .map_step_input(pb::MapStepInputRequest {
            workflow_id: id.clone(),
            input_id: topic.clone(),
            workflow_input_id: Some(wi.clone()),
        })
        .await
        .unwrap()
        .into_inner();
    assert!(mapped.issues.is_empty(), "{:?}", mapped.issues);

    // Connecting into a mapped input needs confirmation.
    let err = client
        .create_connection(pb::CreateConnectionRequest {
            workflow_id: id.clone(),
            source_step_id: source.clone(),
            destination_input_id: topic.clone(),
            replace_existing: false,
        })
        .await
        .unwrap_err();
    assert_eq!(err.code(), Code::FailedPrecondition);
    assert_eq!(
        err.message(),
        "“topic” already has a source. Connecting from Source replaces it."
    );
    let info = error_info(&err).unwrap();
    assert_eq!(info.reason, "CONNECTION_SOURCE_EXISTS");
    assert_eq!(info.metadata["existing_source_label"], "subject");

    let replaced = client
        .create_connection(pb::CreateConnectionRequest {
            workflow_id: id.clone(),
            source_step_id: source.clone(),
            destination_input_id: topic.clone(),
            replace_existing: true,
        })
        .await
        .unwrap()
        .into_inner();
    let wfp = replaced.workflow.unwrap();
    let input = &step(&wfp, &dest).inputs[0];
    assert!(input.workflow_input_id.is_none());
    assert_eq!(
        input.incoming_connection_id.as_deref(),
        Some(replaced.connection_id.as_str())
    );

    // Cycle.
    let err = client
        .connect_output_to_step(pb::ConnectOutputToStepRequest {
            workflow_id: id.clone(),
            source_step_id: dest.clone(),
            target_step_id: source.clone(),
        })
        .await
        .unwrap_err();
    assert_eq!(
        err.message(),
        "Unable to save — that connection would create a cycle."
    );

    // Output rename propagates.
    let renamed = client
        .update_step_output(pb::UpdateStepOutputRequest {
            workflow_id: id.clone(),
            step_id: source.clone(),
            output_name: "new_output".into(),
            output_description: None,
            expected_output: Some("x".into()),
            output_file_format: pb::OutputFileFormat::Unspecified as i32,
        })
        .await
        .unwrap()
        .into_inner();
    let wfp = renamed.workflow.unwrap();
    assert_eq!(wfp.connections[0].source_output_name, "new_output");
    assert_eq!(
        step(&wfp, &source).output_file_format(),
        pb::OutputFileFormat::FreeTextMarkdown
    );

    // Drag output onto a card, then remove that connection (input goes too).
    let third = complete_step(&mut client, &id, "Third").await;
    let dragged = client
        .connect_output_to_step(pb::ConnectOutputToStepRequest {
            workflow_id: id.clone(),
            source_step_id: source.clone(),
            target_step_id: third.clone(),
        })
        .await
        .unwrap()
        .into_inner();
    let wfp = dragged.workflow.unwrap();
    let created = &step(&wfp, &third).inputs[0];
    assert_eq!(created.name, "new_output");
    assert!(!created.required);
    let removed = client
        .remove_connection(pb::RemoveConnectionRequest {
            workflow_id: id.clone(),
            connection_id: dragged.connection_id,
        })
        .await
        .unwrap()
        .into_inner();
    assert!(
        step(removed.workflow.as_ref().unwrap(), &third)
            .inputs
            .is_empty()
    );

    // Removing the workflow input unmaps (nothing mapped now) and emits WorkflowUpdated.
    client
        .remove_workflow_input(pb::RemoveWorkflowInputRequest {
            workflow_id: id.clone(),
            input_id: wi,
        })
        .await
        .unwrap();

    // Deleting the source removes the downstream input it fed.
    let after = client
        .delete_step(pb::DeleteStepRequest {
            workflow_id: id.clone(),
            step_id: source,
        })
        .await
        .unwrap()
        .into_inner()
        .workflow
        .unwrap();
    assert!(after.connections.is_empty());
    assert!(step(&after, &dest).inputs.is_empty());
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM step_inputs")
        .fetch_one(&server.pool)
        .await
        .unwrap();
    assert_eq!(count, 0);

    let types = event_types(&server.pool, &id).await;
    for expected in [
        "WorkflowInputMapped",
        "WorkflowConnectionCreated",
        "WorkflowConnectionRemoved",
        "WorkflowUpdated",
        "WorkflowStepDeleted",
    ] {
        assert!(
            types.contains(&expected.to_string()),
            "{expected} missing from {types:?}"
        );
    }
}

#[sqlx::test(migrator = "glyph_backend::infrastructure::postgres::migrate::MIGRATOR")]
async fn schedule_and_lifecycle(pool: PgPool) {
    let (server, mut client) = setup(pool).await;
    let wf = create(&mut client, "W").await;
    let id = wid(&wf);

    // Activation refused while invalid, with issues in the error detail.
    let err = client
        .activate_workflow(pb::ActivateWorkflowRequest { id: id.clone() })
        .await
        .unwrap_err();
    assert_eq!(err.code(), Code::FailedPrecondition);
    assert_eq!(error_info(&err).unwrap().reason, "VALIDATION_FAILED");
    assert!(
        validation_issues(&err)
            .iter()
            .any(|i| i.message == "Add at least one step before the workflow can run.")
    );

    complete_step(&mut client, &id, "Step").await;
    let daily =
        pb::save_schedule_request::Recurrence::Daily(pb::ScheduleDaily { hour: 9, minute: 0 });
    let saved = client
        .save_schedule(pb::SaveScheduleRequest {
            workflow_id: id.clone(),
            recurrence: Some(daily.clone()),
            timezone: "America/Sao_Paulo".into(),
            enabled: true,
        })
        .await
        .unwrap()
        .into_inner()
        .workflow
        .unwrap();
    let schedule = saved.schedule.unwrap();
    assert!(!schedule.enabled, "drafts store schedules disabled");
    assert_eq!(
        schedule.human_description.as_deref(),
        Some("Daily at 09:00 (America/Sao_Paulo)")
    );

    let active = client
        .activate_workflow(pb::ActivateWorkflowRequest { id: id.clone() })
        .await
        .unwrap()
        .into_inner()
        .workflow
        .unwrap();
    assert_eq!(status(&active), pb::WorkflowStatus::Active);

    let scheduled = client
        .save_schedule(pb::SaveScheduleRequest {
            workflow_id: id.clone(),
            recurrence: Some(daily),
            timezone: "America/Sao_Paulo".into(),
            enabled: true,
        })
        .await
        .unwrap()
        .into_inner()
        .workflow
        .unwrap();
    let summary = scheduled.summary.as_ref().unwrap();
    assert!(summary.next_run_at.is_some());
    assert_eq!(
        summary.schedule_summary.as_deref(),
        Some("Daily at 09:00 (America/Sao_Paulo)")
    );
    assert_eq!(
        scheduled.schedule.as_ref().unwrap().next_run_at,
        summary.next_run_at
    );

    // Invalid recurrence.
    let err = client
        .save_schedule(pb::SaveScheduleRequest {
            workflow_id: id.clone(),
            recurrence: Some(pb::save_schedule_request::Recurrence::Interval(
                pb::ScheduleInterval {
                    every: 90,
                    unit: pb::IntervalUnit::Minutes as i32,
                },
            )),
            timezone: "UTC".into(),
            enabled: true,
        })
        .await
        .unwrap_err();
    assert_eq!(
        err.message(),
        "Unable to save — the recurrence or timezone is invalid."
    );

    // A required input without value makes the active workflow need attention.
    let wi = client
        .add_workflow_input(pb::AddWorkflowInputRequest {
            workflow_id: id.clone(),
            name: "topic".into(),
            description: None,
            required: true,
            value: None,
            ask_at_run_time: true,
        })
        .await
        .unwrap()
        .into_inner();
    let flagged = wi.workflow.unwrap();
    assert_eq!(status(&flagged), pb::WorkflowStatus::NeedsAttention);
    assert!(flagged.summary.as_ref().unwrap().next_run_at.is_none());

    // Scheduled value (encrypted at rest) fixes it; resume brings it back.
    let fixed = client
        .set_schedule_value(pb::SetScheduleValueRequest {
            workflow_id: id.clone(),
            workflow_input_id: wi.new_input_id.clone(),
            value: "secret-value".into(),
        })
        .await
        .unwrap()
        .into_inner();
    assert!(fixed.issues.is_empty(), "{:?}", fixed.issues);
    assert_eq!(
        fixed
            .workflow
            .as_ref()
            .unwrap()
            .schedule
            .as_ref()
            .unwrap()
            .values[0]
            .value,
        "secret-value"
    );
    let raw: Vec<u8> = sqlx::query_scalar("SELECT value FROM workflow_schedule_values")
        .fetch_one(&server.pool)
        .await
        .unwrap();
    assert!(!String::from_utf8_lossy(&raw).contains("secret-value"));

    let resumed = client
        .resume_workflow(pb::ResumeWorkflowRequest { id: id.clone() })
        .await
        .unwrap()
        .into_inner();
    assert!(resumed.resumed);
    assert_eq!(
        status(resumed.workflow.as_ref().unwrap()),
        pb::WorkflowStatus::Active
    );

    let paused = client
        .pause_workflow(pb::PauseWorkflowRequest { id: id.clone() })
        .await
        .unwrap()
        .into_inner()
        .workflow
        .unwrap();
    assert_eq!(status(&paused), pb::WorkflowStatus::Paused);
    assert!(paused.summary.unwrap().next_run_at.is_none());
    assert!(paused.schedule.as_ref().unwrap().next_run_at.is_none());
    assert_eq!(
        paused.schedule.unwrap().cron_expression.as_deref(),
        Some("0 9 * * *")
    );

    // Removing the schedule.
    let none = client
        .save_schedule(pb::SaveScheduleRequest {
            workflow_id: id.clone(),
            recurrence: Some(pb::save_schedule_request::Recurrence::None(
                pb::ScheduleNone {},
            )),
            timezone: String::new(),
            enabled: false,
        })
        .await
        .unwrap()
        .into_inner()
        .workflow
        .unwrap();
    assert!(none.schedule.is_none());

    let types = event_types(&server.pool, &id).await;
    for expected in [
        "WorkflowScheduleChanged",
        "WorkflowActivated",
        "WorkflowNeedsAttention",
        "WorkflowResumed",
        "WorkflowPaused",
    ] {
        assert!(
            types.contains(&expected.to_string()),
            "{expected} missing from {types:?}"
        );
    }

    let resumed_invalid = {
        // Paused + invalid → needs_attention, still OK.
        let step_id = paused_step(&mut client, &id).await;
        client
            .update_step_model(pb::UpdateStepModelRequest {
                workflow_id: id.clone(),
                step_id,
                model_id: "ghost".into(),
                temperature: None,
            })
            .await
            .unwrap();
        client
            .resume_workflow(pb::ResumeWorkflowRequest { id: id.clone() })
            .await
            .unwrap()
            .into_inner()
    };
    assert!(!resumed_invalid.resumed);
    assert!(!resumed_invalid.issues.is_empty());
    assert_eq!(
        status(resumed_invalid.workflow.as_ref().unwrap()),
        pb::WorkflowStatus::NeedsAttention
    );
}

async fn paused_step(client: &mut Client, id: &str) -> String {
    client
        .get_workflow(pb::GetWorkflowRequest { id: id.into() })
        .await
        .unwrap()
        .into_inner()
        .workflow
        .unwrap()
        .steps[0]
        .id
        .clone()
}

#[sqlx::test(migrator = "glyph_backend::infrastructure::postgres::migrate::MIGRATOR")]
async fn vanished_models_flag_active_workflows(pool: PgPool) {
    seed_model(&pool).await;
    let velox = Arc::new(FakeGateway::new(Provider::Velox, &["test-model"]));
    let server = common::spawn_with(
        pool,
        common::test_config(),
        Overrides {
            gateways: Some(vec![velox.clone()]),
            ..Overrides::default()
        },
    )
    .await;
    let mut client = WorkflowServiceClient::new(server.channel().await);
    let mut catalog = CatalogServiceClient::new(server.channel().await);

    let wf = create(&mut client, "Uses model").await;
    let id = wid(&wf);
    complete_step(&mut client, &id, "Step").await;
    client
        .activate_workflow(pb::ActivateWorkflowRequest { id: id.clone() })
        .await
        .unwrap();
    let untouched = create(&mut client, "Draft").await;

    velox.set(&["other-model"]);
    catalog
        .refresh_models(pb::RefreshModelsRequest {})
        .await
        .unwrap();

    let got = client
        .get_workflow(pb::GetWorkflowRequest { id: id.clone() })
        .await
        .unwrap()
        .into_inner()
        .workflow
        .unwrap();
    assert_eq!(status(&got), pb::WorkflowStatus::NeedsAttention);
    assert_eq!(
        got.steps[0].model_id.as_deref(),
        Some("velox/test-model"),
        "choice stays visible"
    );
    let data: serde_json::Value = sqlx::query_scalar(
        "SELECT data FROM events WHERE stream = $1 AND event_type = 'WorkflowNeedsAttention'",
    )
    .bind(format!("Workflow${id}"))
    .fetch_one(&server.pool)
    .await
    .unwrap();
    assert_eq!(
        data["issues"],
        serde_json::json!(["A selected model is no longer available."])
    );
    let draft = client
        .get_workflow(pb::GetWorkflowRequest {
            id: wid(&untouched),
        })
        .await
        .unwrap()
        .into_inner()
        .workflow
        .unwrap();
    assert_eq!(status(&draft), pb::WorkflowStatus::Draft);
}

// --- shared texts -----------------------------------------------------------

/// Adds a shared text and returns its id.
async fn add_text(client: &mut Client, workflow_id: &str, key: &str, body: &str) -> String {
    client
        .add_shared_text(pb::AddSharedTextRequest {
            workflow_id: workflow_id.into(),
            key: key.into(),
            description: None,
            body: body.into(),
        })
        .await
        .unwrap()
        .into_inner()
        .new_text_id
}

async fn set_ref(
    client: &mut Client,
    workflow_id: &str,
    step_id: &str,
    field: pb::TextField,
    text_id: Option<&str>,
    vars: Vec<(String, String)>,
) {
    client
        .set_step_text_ref(pb::SetStepTextRefRequest {
            workflow_id: workflow_id.into(),
            step_id: step_id.into(),
            field: field as i32,
            r#ref: text_id.map(|text_id| pb::TextRef {
                text_id: text_id.into(),
                vars: vars.into_iter().collect(),
            }),
        })
        .await
        .unwrap();
}

#[sqlx::test(migrator = "glyph_backend::infrastructure::postgres::migrate::MIGRATOR")]
async fn shared_texts_crud_and_refs(pool: PgPool) {
    let (server, mut client) = setup(pool).await;
    let wf = create(&mut client, "Shared").await;
    let id = wid(&wf);
    let step_id = complete_step(&mut client, &id, "Generate").await;

    // Add + duplicate key refused.
    let text = add_text(&mut client, &id, "designer_brief", "Design {{judge_name}}").await;
    let err = client
        .add_shared_text(pb::AddSharedTextRequest {
            workflow_id: id.clone(),
            key: "Designer_Brief".into(),
            description: None,
            body: "Body".into(),
        })
        .await
        .unwrap_err();
    assert_eq!(err.code(), Code::InvalidArgument);
    assert_eq!(
        err.message(),
        "Unable to save — Name has already been taken."
    );

    // Update the body; link the step prompt with a var.
    client
        .update_shared_text(pb::UpdateSharedTextRequest {
            workflow_id: id.clone(),
            text_id: text.clone(),
            key: "designer_brief".into(),
            description: Some("Shared brief".into()),
            body: "Design well, {{judge_name}}.".into(),
        })
        .await
        .unwrap();
    set_ref(
        &mut client,
        &id,
        &step_id,
        pb::TextField::Prompt,
        Some(&text),
        vec![("judge_name".to_string(), "Sauron".to_string())],
    )
    .await;
    let got = client
        .get_workflow(pb::GetWorkflowRequest { id: id.clone() })
        .await
        .unwrap()
        .into_inner()
        .workflow
        .unwrap();
    assert_eq!(got.texts.len(), 1);
    assert_eq!(got.texts[0].key, "designer_brief");
    assert_eq!(got.texts[0].body, "Design well, {{judge_name}}.");
    let s = step(&got, &step_id);
    assert_eq!(
        s.prompt.as_deref(),
        Some("Design well, Sauron."),
        "the step carries the effective prompt"
    );
    assert_eq!(
        s.prompt_ref.as_ref().unwrap().text_id,
        text,
        "and the ref tells the editor it is linked"
    );
    assert_eq!(
        s.prompt_ref
            .as_ref()
            .unwrap()
            .vars
            .get("judge_name")
            .map(String::as_str),
        Some("Sauron")
    );

    // Update the text body: the effective prompt follows.
    client
        .update_shared_text(pb::UpdateSharedTextRequest {
            workflow_id: id.clone(),
            text_id: text.clone(),
            key: "designer_brief".into(),
            description: None,
            body: "Rewritten {{judge_name}}.".into(),
        })
        .await
        .unwrap();
    let got = client
        .get_workflow(pb::GetWorkflowRequest { id: id.clone() })
        .await
        .unwrap()
        .into_inner()
        .workflow
        .unwrap();
    assert_eq!(
        step(&got, &step_id).prompt.as_deref(),
        Some("Rewritten Sauron.")
    );

    // Detach copies the rendered text.
    set_ref(
        &mut client,
        &id,
        &step_id,
        pb::TextField::Prompt,
        None,
        vec![],
    )
    .await;
    let got = client
        .get_workflow(pb::GetWorkflowRequest { id: id.clone() })
        .await
        .unwrap()
        .into_inner()
        .workflow
        .unwrap();
    let s = step(&got, &step_id);
    assert!(s.prompt_ref.is_none());
    assert_eq!(s.prompt.as_deref(), Some("Rewritten Sauron."));

    // Remove while linked → FAILED_PRECONDITION; after detaching, removed.
    set_ref(
        &mut client,
        &id,
        &step_id,
        pb::TextField::Prompt,
        Some(&text),
        vec![],
    )
    .await;
    let err = client
        .remove_shared_text(pb::RemoveSharedTextRequest {
            workflow_id: id.clone(),
            text_id: text.clone(),
        })
        .await
        .unwrap_err();
    assert_eq!(err.code(), Code::FailedPrecondition);
    assert_eq!(
        err.message(),
        "“designer_brief” is used by 1 steps. Detach them first."
    );
    assert_eq!(
        error_info(&err).as_ref().map(|i| i.reason.as_str()),
        Some("SHARED_TEXT_IN_USE")
    );
    set_ref(
        &mut client,
        &id,
        &step_id,
        pb::TextField::Prompt,
        None,
        vec![],
    )
    .await;
    client
        .remove_shared_text(pb::RemoveSharedTextRequest {
            workflow_id: id.clone(),
            text_id: text.clone(),
        })
        .await
        .unwrap();
    let got = client
        .get_workflow(pb::GetWorkflowRequest { id: id.clone() })
        .await
        .unwrap()
        .into_inner()
        .workflow
        .unwrap();
    assert!(got.texts.is_empty());

    let types = event_types(&server.pool, &id).await;
    assert!(types.iter().filter(|t| *t == "WorkflowUpdated").count() >= 3);

    // Unknown ids.
    assert_eq!(
        client
            .remove_shared_text(pb::RemoveSharedTextRequest {
                workflow_id: id.clone(),
                text_id: text.clone(),
            })
            .await
            .unwrap_err()
            .code(),
        Code::NotFound
    );
}

#[sqlx::test(migrator = "glyph_backend::infrastructure::postgres::migrate::MIGRATOR")]
async fn extract_and_duplicate_share_the_text(pool: PgPool) {
    let (server, mut client) = setup(pool).await;
    let _ = server;
    let wf = create(&mut client, "Shared").await;
    let id = wid(&wf);
    let step_id = complete_step(&mut client, &id, "Generate — GLM").await;

    // "Make shared" from the step's own prompt.
    let text = client
        .extract_shared_text(pb::ExtractSharedTextRequest {
            workflow_id: id.clone(),
            step_id: step_id.clone(),
            field: pb::TextField::Prompt as i32,
            key: "generate_glm_5_3_prompt".into(),
        })
        .await
        .unwrap()
        .into_inner()
        .new_text_id;
    let got = client
        .get_workflow(pb::GetWorkflowRequest { id: id.clone() })
        .await
        .unwrap()
        .into_inner()
        .workflow
        .unwrap();
    assert_eq!(got.texts[0].id, text);
    assert_eq!(got.texts[0].body, "Do the thing");
    let s = step(&got, &step_id);
    assert_eq!(s.prompt.as_deref(), Some("Do the thing"), "effective text");
    assert_eq!(s.prompt_ref.as_ref().unwrap().text_id, text);

    // Blank field is refused.
    let empty = complete_step(&mut client, &id, "Empty").await;
    client
        .update_step_prompt(pb::UpdateStepPromptRequest {
            workflow_id: id.clone(),
            step_id: empty.clone(),
            prompt: None,
            additional_context: None,
        })
        .await
        .unwrap();
    let err = client
        .extract_shared_text(pb::ExtractSharedTextRequest {
            workflow_id: id.clone(),
            step_id: empty.clone(),
            field: pb::TextField::Prompt as i32,
            key: "empty_prompt".into(),
        })
        .await
        .unwrap_err();
    assert_eq!(
        err.message(),
        "There is nothing to share yet. Write the text first."
    );

    // Duplicate keeps the copy linked with the same vars.
    set_ref(
        &mut client,
        &id,
        &step_id,
        pb::TextField::Prompt,
        Some(&text),
        vec![("judge_name".to_string(), "Sauron".to_string())],
    )
    .await;
    let copy = client
        .duplicate_step(pb::DuplicateStepRequest {
            workflow_id: id.clone(),
            step_id: step_id.clone(),
        })
        .await
        .unwrap()
        .into_inner()
        .new_step_id;
    let got = client
        .get_workflow(pb::GetWorkflowRequest { id: id.clone() })
        .await
        .unwrap()
        .into_inner()
        .workflow
        .unwrap();
    let original = step(&got, &step_id).prompt_ref.clone().unwrap();
    let copied = step(&got, &copy).prompt_ref.clone().unwrap();
    assert_eq!(copied.text_id, original.text_id);
    assert_eq!(copied.vars, original.vars);

    // Deleting a step that shares the text leaves the text usable.
    client
        .delete_step(pb::DeleteStepRequest {
            workflow_id: id.clone(),
            step_id: copy,
        })
        .await
        .unwrap();
    client
        .remove_shared_text(pb::RemoveSharedTextRequest {
            workflow_id: id.clone(),
            text_id: text,
        })
        .await
        .unwrap_err();
}

#[sqlx::test(migrator = "glyph_backend::infrastructure::postgres::migrate::MIGRATOR")]
async fn texts_round_trip_through_the_store_and_cascade(pool: PgPool) {
    let (server, mut client) = setup(pool).await;
    let wf = create(&mut client, "Round trip").await;
    let id = wid(&wf);
    let step_id = complete_step(&mut client, &id, "Gen").await;
    let text = add_text(&mut client, &id, "brief", "Hello {{who}}").await;
    set_ref(
        &mut client,
        &id,
        &step_id,
        pb::TextField::Prompt,
        Some(&text),
        vec![("who".to_string(), "Ada".to_string())],
    )
    .await;
    set_ref(
        &mut client,
        &id,
        &step_id,
        pb::TextField::Context,
        Some(&text),
        vec![],
    )
    .await;

    // Reloaded from the store: texts, refs and vars survive.
    let got = client
        .get_workflow(pb::GetWorkflowRequest { id: id.clone() })
        .await
        .unwrap()
        .into_inner()
        .workflow
        .unwrap();
    assert_eq!(got.texts.len(), 1);
    let s = step(&got, &step_id);
    assert_eq!(
        s.prompt_ref
            .as_ref()
            .unwrap()
            .vars
            .get("who")
            .map(String::as_str),
        Some("Ada")
    );
    assert_eq!(s.context_ref.as_ref().unwrap().text_id, text);
    let refs: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM step_text_refs r JOIN workflow_steps s ON s.id = r.workflow_step_id WHERE s.workflow_id = $1::uuid",
    )
    .bind(id.parse::<uuid::Uuid>().unwrap())
    .fetch_one(&server.pool)
    .await
    .unwrap();
    assert_eq!(refs, 2);

    // Deleting the workflow cascades texts (refs go with the steps).
    client
        .get_workflow(pb::GetWorkflowRequest { id: id.clone() })
        .await
        .unwrap();
    sqlx::query("DELETE FROM workflows WHERE id = $1")
        .bind(id.parse::<uuid::Uuid>().unwrap())
        .execute(&server.pool)
        .await
        .unwrap();
    let texts: i64 = sqlx::query_scalar("SELECT count(*) FROM workflow_texts")
        .fetch_one(&server.pool)
        .await
        .unwrap();
    let refs: i64 = sqlx::query_scalar("SELECT count(*) FROM step_text_refs")
        .fetch_one(&server.pool)
        .await
        .unwrap();
    assert_eq!((texts, refs), (0, 0));
}
