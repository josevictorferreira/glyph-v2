//! Ports of spec/domain/workflows/{validator,lifecycle,snapshot_builder}_spec.rb
//! and the editor mutation scenarios, as pure unit tests.

use std::collections::BTreeMap;

use chrono::Utc;
use serde_json::json;

use super::catalog_view::{CatalogModel, CatalogView, ToolRef};
use super::model::*;
use super::schedule_calculator::{IntervalUnit, Recurrence};
use super::snapshot;
use super::validator::validate;
use super::workflow::WorkflowInputFields;
use crate::shared::error::DomainError;
use crate::shared::ids::*;
use crate::shared::issue::{EntityType, any_blocking};
use crate::shared::output_format::OutputFileFormat;
use crate::shared::time::Timestamp;

fn now() -> Timestamp {
    "2026-08-04T08:00:00Z".parse().unwrap()
}

fn catalog() -> CatalogView {
    CatalogView {
        models: vec![CatalogModel {
            provider: "omniroute".into(),
            model_id: "test-model".into(),
            available: true,
            capabilities: json!({ "temperature": true }).as_object().unwrap().clone(),
        }],
        tools: ["bash", "edit", "read", "write"]
            .into_iter()
            .map(|k| ToolRef {
                key: k.into(),
                display_name: k.into(),
                pi_tool_name: k.into(),
                enabled: true,
            })
            .collect(),
    }
}

fn workflow() -> Workflow {
    Workflow::create("Workflow", Some("A workflow".into()), false, now()).0
}

/// Factory `:workflow_step` — a fully configured pi step.
fn complete_step(wf: &mut Workflow, name: &str) -> StepId {
    let (id, _) = wf.add_step(StepKind::Pi, None, now());
    let step = wf.step_mut(id).unwrap();
    step.name = name.into();
    step.prompt = Some("Do the thing".into());
    step.output_name = Some("result".into());
    step.expected_output = Some("The result".into());
    step.model_id = Some("test-model".into());
    id
}

fn messages(wf: &Workflow) -> Vec<String> {
    validate(wf, &catalog())
        .into_iter()
        .map(|i| i.message)
        .collect()
}

fn input_fields(name: &str) -> WorkflowInputFields {
    WorkflowInputFields {
        name: name.into(),
        required: true,
        ask_at_run_time: true,
        ..Default::default()
    }
}

// --- validator ---------------------------------------------------------------

#[test]
fn empty_workflow_blocks_on_name_and_steps() {
    let mut wf = workflow();
    wf.name = String::new();
    let m = messages(&wf);
    assert!(m.contains(&"Give the workflow a name before it can run.".into()));
    assert!(m.contains(&"Add at least one step before the workflow can run.".into()));
    assert!(any_blocking(&validate(&wf, &catalog())));
}

#[test]
fn incomplete_step_names_each_missing_field() {
    let mut wf = workflow();
    wf.add_step(StepKind::Pi, None, now());
    let m = messages(&wf);
    for expected in [
        "Name the step.",
        "“Unnamed step” needs a prompt.",
        "Describe the expected output of “Unnamed step”.",
        "Name the output exposed by “Unnamed step”.",
        "Choose a model for “Unnamed step”.",
    ] {
        assert!(m.contains(&expected.to_string()), "{expected} not in {m:?}");
    }
}

#[test]
fn unavailable_model_blocks() {
    let mut wf = workflow();
    complete_step(&mut wf, "Step 1");
    let mut cat = catalog();
    cat.models[0].available = false;
    let m: Vec<_> = validate(&wf, &cat).into_iter().map(|i| i.message).collect();
    assert!(m.contains(
        &"The model “test-model” selected for “Step 1” is no longer available. Choose a replacement."
            .to_string()
    ));
}

#[test]
fn full_model_ids_are_accepted() {
    let mut wf = workflow();
    let id = complete_step(&mut wf, "Step 1");
    wf.step_mut(id).unwrap().model_id = Some("omniroute/test-model".into());
    wf.step_mut(id)
        .unwrap()
        .model_settings
        .insert("temperature".into(), json!(0.5));
    assert!(messages(&wf).is_empty());
}

#[test]
fn model_settings_checks() {
    let mut wf = workflow();
    let id = complete_step(&mut wf, "Step 1");
    wf.step_mut(id)
        .unwrap()
        .model_settings
        .insert("seed".into(), json!(42));
    assert!(messages(&wf).contains(&"“seed” is not a supported model setting.".into()));

    let mut wf = workflow();
    let id = complete_step(&mut wf, "Step 1");
    wf.step_mut(id)
        .unwrap()
        .model_settings
        .insert("temperature".into(), json!(0.5));
    assert!(messages(&wf).is_empty(), "supported settings pass");
    let mut cat = catalog();
    cat.models[0].capabilities.clear();
    let m: Vec<_> = validate(&wf, &cat).into_iter().map(|i| i.message).collect();
    assert!(m.contains(
        &"The selected model does not support “temperature”. Remove the setting.".into()
    ));
}

#[test]
fn constant_inputs_need_values() {
    let mut wf = workflow();
    complete_step(&mut wf, "Step 1");
    let (id, _) = wf
        .add_workflow_input(
            WorkflowInputFields {
                name: "tone".into(),
                required: true,
                ask_at_run_time: false,
                value: Some("formal".into()),
                ..Default::default()
            },
            now(),
        )
        .unwrap();
    assert!(messages(&wf).is_empty());
    wf.inputs.iter_mut().find(|i| i.id == id).unwrap().value = None;
    let issues = validate(&wf, &catalog());
    let issue = issues
        .iter()
        .find(|i| i.entity_type == EntityType::WorkflowInput && i.entity_id == id.to_string())
        .unwrap();
    assert!(issue.message.contains("tone"));
}

#[test]
fn prompt_variables() {
    let mut wf = workflow();
    let step = complete_step(&mut wf, "Step 1");
    wf.step_mut(step).unwrap().prompt = Some("Write about {{topic}} with a {{tone}}.".into());
    let joined = messages(&wf).join(" ");
    assert!(joined.contains("topic") && joined.contains("tone"));
    assert!(joined.contains(
        "“Step 1” uses “{{topic}}” but no workflow value or input provides it. Add one or fix the spelling."
    ));

    wf.add_workflow_input(input_fields("topic"), now()).unwrap();
    wf.add_step_input(step, "tone", false, now()).unwrap();
    assert!(messages(&wf).is_empty());
}

#[test]
fn brace_heavy_json_is_not_a_variable() {
    let mut wf = workflow();
    let step = complete_step(&mut wf, "Step 1");
    wf.step_mut(step).unwrap().prompt =
        Some(r#"Return {{"name": "Isdin", "tags": [1, 2]}} exactly."#.into());
    assert!(messages(&wf).is_empty());
}

#[test]
fn additional_context_variables_are_checked() {
    let mut wf = workflow();
    let step = complete_step(&mut wf, "Step 1");
    wf.step_mut(step).unwrap().additional_context = Some("Client brief: {{brief}}".into());
    assert!(messages(&wf).join(" ").contains("brief"));
}

#[test]
fn tools_outside_the_catalog_block() {
    let mut wf = workflow();
    let step = complete_step(&mut wf, "Step 1");
    wf.step_mut(step).unwrap().enabled_tool_ids = vec!["rm_rf".into()];
    assert!(
        messages(&wf)
            .contains(&"The tool “rm_rf” enabled for “Step 1” is not available. Remove it.".into())
    );
    wf.step_mut(step).unwrap().enabled_tool_ids = vec!["read".into()];
    assert!(messages(&wf).is_empty());
}

#[test]
fn input_sources() {
    let mut wf = workflow();
    let step = complete_step(&mut wf, "Step 1");
    let (input, _) = wf.add_step_input(step, "topic", true, now()).unwrap();
    assert!(messages(&wf).contains(
        &"Required input “topic” on “Step 1” needs a connection or a workflow value.".into()
    ));

    let (wi, _) = wf
        .add_workflow_input(input_fields("value_1"), now())
        .unwrap();
    wf.map_step_input(input, Some(wi)).unwrap();
    assert!(messages(&wf).is_empty());

    // Double-sourced (only reachable by bypassing the editor guard).
    let other = complete_step(&mut wf, "Other");
    wf.connections.push(Connection {
        id: ConnectionId::new(),
        source_step_id: other,
        source_output_name: "result".into(),
        destination_step_id: step,
        destination_input_id: input,
        created_at: now(),
    });
    assert!(messages(&wf).contains(&"Input “topic” on “Step 1” has two sources; keep one.".into()));
}

#[test]
fn connection_problems() {
    let mut wf = workflow();
    let source = complete_step(&mut wf, "Source");
    let destination = complete_step(&mut wf, "Destination");
    let (input, _) = wf.add_step_input(destination, "in", true, now()).unwrap();
    wf.create_connection(source, input, false, now()).unwrap();
    wf.connections[0].source_output_name = "old".into();
    assert!(messages(&wf).contains(
        &"The connection from “Source” refers to an output that no longer exists.".into()
    ));
    wf.connections[0].source_output_name = "result".into();

    let (back, _) = wf.add_step_input(source, "back", true, now()).unwrap();
    wf.connections.push(Connection {
        id: ConnectionId::new(),
        source_step_id: destination,
        source_output_name: "result".into(),
        destination_step_id: source,
        destination_input_id: back,
        created_at: now(),
    });
    assert!(
        messages(&wf).contains(
            &"The connections form a cycle. Remove the link that closes the loop.".into()
        )
    );
}

#[test]
fn schedule_problems() {
    let mut wf = workflow();
    complete_step(&mut wf, "Step 1");
    let mut schedule = Schedule::new(now());
    schedule.enabled = true;
    schedule.cron_expression = Some("not a cron".into());
    schedule.timezone = Some("Mars/Olympus".into());
    wf.schedule = Some(schedule);
    let m = messages(&wf);
    assert!(m.contains(&"The recurrence is not a valid cron expression.".into()));
    assert!(m.contains(&"The schedule timezone is not a known IANA timezone.".into()));

    let s = wf.schedule.as_mut().unwrap();
    s.cron_expression = Some("0 9 * * *".into());
    s.timezone = Some("UTC".into());
    let (topic, _) = wf.add_workflow_input(input_fields("topic"), now()).unwrap();
    let missing = "The schedule needs a value for the required workflow input “topic”.".to_string();
    assert!(messages(&wf).contains(&missing));
    wf.set_schedule_value(topic, "nix", now()).unwrap();
    assert!(!messages(&wf).contains(&missing));

    wf.schedule.as_mut().unwrap().cron_expression = None;
    assert!(
        messages(&wf).contains(&"An enabled schedule needs a recurrence and a timezone.".into())
    );
}

#[test]
fn helper_steps() {
    let mut wf = workflow();
    let (step, _) = wf.add_step(StepKind::Helper, None, now());
    {
        let s = wf.step_mut(step).unwrap();
        s.name = "Brief".into();
        s.output_name = Some("brief".into());
        s.enabled_tool_ids = vec!["not_a_tool".into()];
        s.prompt = Some("{{unknown}}".into());
    }
    let (input, _) = wf.add_step_input(step, "topic", true, now()).unwrap();
    assert!(messages(&wf).contains(
        &"Required input “topic” on “Brief” needs a connection or a workflow value.".into()
    ));
    let (wi, _) = wf
        .add_workflow_input(input_fields("value_1"), now())
        .unwrap();
    wf.map_step_input(input, Some(wi)).unwrap();
    assert!(messages(&wf).is_empty(), "{:?}", messages(&wf));

    let s = wf.step_mut(step).unwrap();
    s.name = String::new();
    s.output_name = None;
    let m = messages(&wf);
    assert!(m.contains(&"Name the step.".into()));
    assert!(m.contains(&"Name the output exposed by “Unnamed step”.".into()));
}

#[test]
fn fully_configured_workflow_has_no_issues() {
    let mut wf = workflow();
    complete_step(&mut wf, "Step 1");
    assert!(validate(&wf, &catalog()).is_empty());
}

// --- lifecycle ---------------------------------------------------------------

fn enabled_schedule(wf: &mut Workflow) {
    let mut schedule = Schedule::new(now());
    schedule.enabled = true;
    schedule.cron_expression = Some("0 9 * * *".into());
    schedule.timezone = Some("UTC".into());
    wf.schedule = Some(schedule);
}

#[test]
fn activation() {
    let mut wf = workflow();
    complete_step(&mut wf, "Step 1");
    enabled_schedule(&mut wf);
    let events = wf.activate(&catalog(), now()).unwrap();
    assert_eq!(wf.status, WorkflowStatus::Active);
    assert_eq!(
        wf.next_run_at,
        Some("2026-08-04T09:00:00Z".parse().unwrap())
    );
    assert_eq!(wf.schedule.as_ref().unwrap().next_run_at, wf.next_run_at);
    assert_eq!(events[0].event_type, "WorkflowActivated");
}

#[test]
fn activation_refuses_invalid_workflows() {
    let mut wf = workflow();
    let step = complete_step(&mut wf, "Step 1");
    wf.step_mut(step).unwrap().prompt = None;
    let err = wf.activate(&catalog(), now()).unwrap_err();
    let DomainError::Precondition { code, issues, .. } = err else {
        panic!("expected precondition");
    };
    assert_eq!(code, "VALIDATION_FAILED");
    assert!(
        issues
            .iter()
            .any(|i| i.message == "“Step 1” needs a prompt.")
    );
    assert_eq!(wf.status, WorkflowStatus::Draft);
}

#[test]
fn pause_clears_next_run_and_keeps_recurrence() {
    let mut wf = workflow();
    complete_step(&mut wf, "Step 1");
    enabled_schedule(&mut wf);
    wf.activate(&catalog(), now()).unwrap();
    let events = wf.pause();
    assert_eq!(wf.status, WorkflowStatus::Paused);
    assert!(wf.next_run_at.is_none());
    assert!(wf.schedule.as_ref().unwrap().next_run_at.is_none());
    assert_eq!(
        wf.schedule.as_ref().unwrap().cron_expression.as_deref(),
        Some("0 9 * * *")
    );
    assert_eq!(events[0].event_type, "WorkflowPaused");
}

#[test]
fn resume() {
    let mut wf = workflow();
    let step = complete_step(&mut wf, "Step 1");
    enabled_schedule(&mut wf);
    wf.status = WorkflowStatus::Paused;
    let (resumed, _, events) = wf.resume(&catalog(), now());
    assert!(resumed);
    assert_eq!(wf.status, WorkflowStatus::Active);
    assert!(wf.next_run_at.is_some());
    assert_eq!(events[0].event_type, "WorkflowResumed");

    wf.status = WorkflowStatus::Paused;
    wf.step_mut(step).unwrap().model_id = Some("ghost-model".into());
    let (resumed, issues, events) = wf.resume(&catalog(), now());
    assert!(!resumed);
    assert!(!issues.is_empty());
    assert_eq!(wf.status, WorkflowStatus::NeedsAttention);
    assert!(wf.next_run_at.is_none());
    assert_eq!(events[0].event_type, "WorkflowNeedsAttention");
    assert_eq!(events[0].data["issues"].as_array().unwrap().len(), 1);
}

#[test]
fn revalidation() {
    let mut wf = workflow();
    let step = complete_step(&mut wf, "Step 1");
    wf.status = WorkflowStatus::Active;
    let (_, events) = wf.revalidate(&catalog());
    assert!(events.is_empty());
    assert_eq!(wf.status, WorkflowStatus::Active);

    wf.next_run_at = Some(now());
    wf.step_mut(step).unwrap().prompt = None;
    let (issues, events) = wf.revalidate(&catalog());
    assert!(!issues.is_empty());
    assert_eq!(wf.status, WorkflowStatus::NeedsAttention);
    assert!(wf.next_run_at.is_none());
    assert_eq!(events[0].event_type, "WorkflowNeedsAttention");

    // needs_attention never auto-heals; drafts stay drafts.
    wf.step_mut(step).unwrap().prompt = Some("x".into());
    wf.revalidate(&catalog());
    assert_eq!(wf.status, WorkflowStatus::NeedsAttention);
    let mut draft = workflow();
    draft.revalidate(&catalog());
    assert_eq!(draft.status, WorkflowStatus::Draft);
}

// --- snapshot ----------------------------------------------------------------

#[test]
fn snapshot_captures_everything() {
    let mut wf = Workflow::create("Snapshot me", None, false, now()).0;
    let research = complete_step(&mut wf, "Research");
    {
        let s = wf.step_mut(research).unwrap();
        s.prompt = Some("Find things".into());
        s.canvas_x = 42;
        s.canvas_y = 24;
        s.enabled_tool_ids = vec!["read".into(), "unknown_tool".into()];
    }
    enabled_schedule(&mut wf);
    let (topic, _) = wf.add_workflow_input(input_fields("topic"), now()).unwrap();
    let (mapped, _) = wf
        .add_step_input(research, "topic_in", true, now())
        .unwrap();
    wf.map_step_input(mapped, Some(topic)).unwrap();
    let write = complete_step(&mut wf, "Write");
    let (_, input, _) = wf.connect_output_to_step(research, write, now()).unwrap();

    let snap = snapshot::build(&wf, &catalog(), now());
    let json = serde_json::to_value(&snap).unwrap();
    assert_eq!(json["version"], 3);
    assert_eq!(json["captured_at"], "2026-08-04T08:00:00.000000Z");
    assert_eq!(json["workflow"]["name"], "Snapshot me");
    assert_eq!(json["workflow"]["schedule"]["cron_expression"], "0 9 * * *");
    assert_eq!(json["inputs"][0]["name"], "topic");
    let step = &json["steps"][0];
    assert_eq!(step["kind"], "pi");
    assert_eq!(step["name"], "Research");
    assert_eq!(step["prompt"], "Find things");
    assert_eq!(step["canvas_x"], 42);
    assert_eq!(step["output_file_format"], "free_text_markdown");
    assert_eq!(
        step["enabled_tools"],
        json!([{ "key": "read", "display_name": "read", "pi_tool_name": "read" }])
    );
    assert_eq!(step["inputs"][0]["workflow_input_id"], topic.to_string());
    assert_eq!(step["inputs"][0]["workflow_input_name"], "topic");
    assert_eq!(
        json["connections"][0]["destination_input_id"],
        input.to_string()
    );
    assert_eq!(json["connections"][0]["destination_input_name"], "result");
    let back: snapshot::Snapshot = serde_json::from_value(json).unwrap();
    assert_eq!(back, snap);
}

// --- editor mutations --------------------------------------------------------

#[test]
fn add_step_positions() {
    let mut wf = workflow();
    for _ in 0..5 {
        wf.add_step(StepKind::Pi, None, now());
    }
    let coords: Vec<_> = wf
        .steps
        .iter()
        .map(|s| (s.canvas_x, s.canvas_y, s.position))
        .collect();
    assert_eq!(coords[0], (120, 120, 1));
    assert_eq!(coords[3], (1020, 120, 4));
    assert_eq!(coords[4], (120, 340, 5));

    let (id, events) = wf.add_step(StepKind::Helper, Some((-100, 99_999)), now());
    let s = wf.step(id).unwrap();
    assert_eq!((s.canvas_x, s.canvas_y), (0, 3000));
    assert_eq!(events[0].data["kind"], "helper");
    assert_eq!(events[0].data["step_id"], id.to_string());
}

#[test]
fn duplicate_step() {
    let mut wf = workflow();
    let original = complete_step(&mut wf, "Original Step");
    {
        let s = wf.step_mut(original).unwrap();
        s.canvas_x = 100;
        s.canvas_y = 150;
        s.enabled_tool_ids = vec!["read".into()];
    }
    wf.add_step_input(original, "brief", false, now()).unwrap();
    let other = complete_step(&mut wf, "Other");
    wf.connect_output_to_step(original, other, now()).unwrap();

    let (copy, _) = wf.duplicate_step(original, now()).unwrap();
    let c = wf.step(copy).unwrap();
    assert_eq!(c.name, "Original Step");
    assert_eq!(c.prompt.as_deref(), Some("Do the thing"));
    assert_eq!((c.canvas_x, c.canvas_y), (140, 190));
    assert!(c.model_id.is_none() && c.output_name.is_none() && c.enabled_tool_ids.is_empty());
    assert_eq!(c.inputs.len(), 1);
    assert!(
        wf.connections
            .iter()
            .all(|x| x.source_step_id != copy && x.destination_step_id != copy)
    );
    assert!(matches!(
        wf.duplicate_step(StepId::new(), now()),
        Err(DomainError::NotFound(_))
    ));
}

#[test]
fn output_rename_propagates_to_connections() {
    let mut wf = workflow();
    let source = complete_step(&mut wf, "Source");
    let dest = complete_step(&mut wf, "Dest");
    wf.connect_output_to_step(source, dest, now()).unwrap();
    wf.update_step_output(
        source,
        " new_output ",
        None,
        Some("x".into()),
        OutputFileFormat::Html,
    )
    .unwrap();
    assert_eq!(wf.connections[0].source_output_name, "new_output");
    assert_eq!(
        wf.step(source).unwrap().output_name.as_deref(),
        Some("new_output")
    );
    assert_eq!(
        wf.step(source).unwrap().output_file_format,
        OutputFileFormat::Html
    );
}

#[test]
fn update_step_model() {
    let mut wf = workflow();
    let step = complete_step(&mut wf, "S");
    wf.update_step_model(step, "velox/new-model", Some(0.7))
        .unwrap();
    let s = wf.step(step).unwrap();
    assert_eq!(s.model_id.as_deref(), Some("velox/new-model"));
    assert_eq!(s.temperature(), Some(0.7));
    wf.update_step_model(step, "", None).unwrap();
    let s = wf.step(step).unwrap();
    assert!(s.model_id.is_none() && s.temperature().is_none());
    let err = wf.update_step_model(step, "m", Some(2.5)).unwrap_err();
    assert_eq!(
        err.to_string(),
        "Unable to save — temperature must be a number between 0 and 2."
    );
}

#[test]
fn toggle_step_tool() {
    let mut wf = workflow();
    let step = complete_step(&mut wf, "S");
    wf.toggle_step_tool(step, "read", &catalog()).unwrap();
    assert_eq!(wf.step(step).unwrap().enabled_tool_ids, vec!["read"]);
    wf.toggle_step_tool(step, "read", &catalog()).unwrap();
    assert!(wf.step(step).unwrap().enabled_tool_ids.is_empty());
    assert_eq!(
        wf.toggle_step_tool(step, "rm", &catalog())
            .unwrap_err()
            .to_string(),
        "Unable to save — that tool is not available."
    );
}

#[test]
fn step_inputs() {
    let mut wf = workflow();
    let step = complete_step(&mut wf, "S");
    assert_eq!(
        wf.add_step_input(step, " ", true, now())
            .unwrap_err()
            .to_string(),
        "Unable to save — name the input."
    );
    wf.add_step_input(step, "Topic", true, now()).unwrap();
    assert_eq!(
        wf.add_step_input(step, "topic", true, now())
            .unwrap_err()
            .to_string(),
        "Unable to save — Name has already been taken."
    );
    let wi = WorkflowInputId::new();
    let input = wf.step(step).unwrap().inputs[0].id;
    assert_eq!(
        wf.map_step_input(input, Some(wi)).unwrap_err().to_string(),
        "Unable to save — that workflow value does not exist."
    );
}

#[test]
fn workflow_input_validation_messages() {
    let mut wf = workflow();
    assert_eq!(
        wf.add_workflow_input(input_fields(""), now())
            .unwrap_err()
            .to_string(),
        "Unable to save — name the workflow value."
    );
    assert_eq!(
        wf.add_workflow_input(input_fields("1bad"), now())
            .unwrap_err()
            .to_string(),
        "Unable to save — Name must start with a letter and use letters, numbers, spaces or underscores."
    );
    wf.add_workflow_input(input_fields("topic"), now()).unwrap();
    let err = wf
        .add_workflow_input(
            WorkflowInputFields {
                name: "Topic".into(),
                required: true,
                ask_at_run_time: false,
                ..Default::default()
            },
            now(),
        )
        .unwrap_err();
    assert_eq!(
        err.to_string(),
        "Unable to save — Name has already been taken and Value can't be blank."
    );
}

#[test]
fn remove_workflow_input_unmaps_and_drops_schedule_values() {
    let mut wf = workflow();
    let step = complete_step(&mut wf, "S");
    let (wi, _) = wf.add_workflow_input(input_fields("topic"), now()).unwrap();
    let (input, _) = wf.add_step_input(step, "t", true, now()).unwrap();
    wf.map_step_input(input, Some(wi)).unwrap();
    wf.schedule = Some(Schedule::new(now()));
    wf.set_schedule_value(wi, "x", now()).unwrap();
    let events = wf.remove_workflow_input(wi).unwrap();
    assert!(wf.inputs.is_empty());
    assert!(wf.step_input(input).unwrap().1.workflow_input_id.is_none());
    assert!(wf.schedule.as_ref().unwrap().values.is_empty());
    assert_eq!(events[0].data["removed_workflow_input_id"], wi.to_string());
}

#[test]
fn create_connection_guards() {
    let mut wf = workflow();
    let a = complete_step(&mut wf, "A");
    let b = complete_step(&mut wf, "B");
    let (b_in, _) = wf.add_step_input(b, "in", true, now()).unwrap();
    let (a_in, _) = wf.add_step_input(a, "in", true, now()).unwrap();

    let msg = |r: Result<_, DomainError>| r.map(|_| ()).unwrap_err().to_string();
    assert_eq!(
        msg(wf.create_connection(StepId::new(), b_in, false, now())),
        "Unable to save — choose an output and an input to connect."
    );
    assert_eq!(
        msg(wf.create_connection(a, a_in, false, now())),
        "Unable to save — a step cannot connect to itself."
    );
    wf.step_mut(a).unwrap().output_name = None;
    assert_eq!(
        msg(wf.create_connection(a, b_in, false, now())),
        "Unable to save — “A” has no named output yet."
    );
    wf.step_mut(a).unwrap().output_name = Some("result".into());

    let (_, events) = wf.create_connection(a, b_in, false, now()).unwrap();
    assert_eq!(events[0].event_type, "WorkflowConnectionCreated");
    assert_eq!(wf.connections[0].source_output_name, "result");
    assert_eq!(
        msg(wf.create_connection(b, a_in, false, now())),
        "Unable to save — that connection would create a cycle."
    );

    // Already fed → precondition, then replace.
    let c = complete_step(&mut wf, "C");
    let err = wf.create_connection(c, b_in, false, now()).unwrap_err();
    let DomainError::Precondition { code, meta, .. } = err else {
        panic!()
    };
    assert_eq!(code, "CONNECTION_SOURCE_EXISTS");
    assert!(meta.contains(&("existing_source_label".into(), "A".into())));
    wf.create_connection(c, b_in, true, now()).unwrap();
    assert_eq!(wf.connections.len(), 1);
    assert_eq!(wf.connections[0].source_step_id, c);

    // A mapped input is also "fed"; replacing clears the mapping.
    let (wi, _) = wf.add_workflow_input(input_fields("v"), now()).unwrap();
    let (mapped, _) = wf.add_step_input(b, "mapped", true, now()).unwrap();
    wf.map_step_input(mapped, Some(wi)).unwrap();
    assert!(wf.create_connection(a, mapped, false, now()).is_err());
    wf.create_connection(a, mapped, true, now()).unwrap();
    assert!(wf.step_input(mapped).unwrap().1.workflow_input_id.is_none());
}

#[test]
fn connect_output_to_step_creates_an_optional_input() {
    let mut wf = workflow();
    let source = complete_step(&mut wf, "Source");
    let target = complete_step(&mut wf, "Target");
    let (_, input, events) = wf.connect_output_to_step(source, target, now()).unwrap();
    let (_, i) = wf.step_input(input).unwrap();
    assert_eq!(i.name, "result");
    assert!(!i.required);
    assert_eq!(wf.connections[0].destination_input_id, input);
    let types: Vec<_> = events.iter().map(|e| e.event_type.as_str()).collect();
    assert_eq!(
        types,
        vec!["WorkflowConnectionCreated", "WorkflowStepUpdated"]
    );
}

#[test]
fn remove_connection_deletes_the_destination_input() {
    let mut wf = workflow();
    let source = complete_step(&mut wf, "Source");
    let dest = complete_step(&mut wf, "Dest");
    let (conn, input, _) = wf.connect_output_to_step(source, dest, now()).unwrap();
    wf.remove_connection(conn).unwrap();
    assert!(wf.connections.is_empty());
    assert!(wf.step_input(input).is_none());
}

#[test]
fn delete_step_removes_downstream_inputs_and_own_edges() {
    let mut wf = workflow();
    let upstream = complete_step(&mut wf, "Upstream");
    let target = complete_step(&mut wf, "Target");
    let downstream = complete_step(&mut wf, "Downstream");
    wf.connect_output_to_step(upstream, target, now()).unwrap();
    let (_, down_in, _) = wf
        .connect_output_to_step(target, downstream, now())
        .unwrap();
    let (own, _) = wf
        .add_step_input(downstream, "own_input", false, now())
        .unwrap();

    let events = wf.delete_step(target).unwrap();
    assert!(wf.step(target).is_none());
    assert!(wf.step_input(down_in).is_none());
    assert!(wf.step_input(own).is_some());
    assert!(wf.connections.is_empty());
    assert_eq!(events[0].event_type, "WorkflowStepDeleted");
}

#[test]
fn move_step_clamps() {
    let mut wf = workflow();
    let s = complete_step(&mut wf, "S");
    wf.move_step(s, 5000, -3).unwrap();
    let step = wf.step(s).unwrap();
    assert_eq!((step.canvas_x, step.canvas_y), (4000, 0));
}

#[test]
fn save_schedule() {
    let mut wf = workflow();
    complete_step(&mut wf, "S");
    let daily = Recurrence::Daily { hour: 9, minute: 0 };
    // Draft: stored disabled.
    wf.save_schedule(Some(daily.clone()), "UTC", true, now())
        .unwrap();
    let s = wf.schedule.as_ref().unwrap();
    assert!(!s.enabled && s.next_run_at.is_none());
    assert_eq!(s.human_description.as_deref(), Some("Daily at 09:00 (UTC)"));

    wf.status = WorkflowStatus::Active;
    let events = wf.save_schedule(Some(daily), "UTC", true, now()).unwrap();
    assert!(wf.schedule.as_ref().unwrap().enabled);
    assert_eq!(
        wf.next_run_at,
        Some("2026-08-04T09:00:00Z".parse().unwrap())
    );
    assert_eq!(events[0].data["mode"], "daily");
    assert_eq!(events[0].data["cron_expression"], "0 9 * * *");

    assert_eq!(
        wf.save_schedule(
            Some(Recurrence::Interval {
                every: 90,
                unit: IntervalUnit::Minutes
            }),
            "UTC",
            true,
            now()
        )
        .unwrap_err()
        .to_string(),
        "Unable to save — the recurrence or timezone is invalid."
    );
    assert!(
        wf.save_schedule(
            Some(Recurrence::Daily { hour: 1, minute: 0 }),
            "Mars/Olympus",
            true,
            now()
        )
        .is_err()
    );

    let events = wf.save_schedule(None, "", false, now()).unwrap();
    assert!(wf.schedule.is_none() && wf.next_run_at.is_none());
    assert_eq!(events[0].data["mode"], "none");
}

#[test]
fn create_defaults_the_name() {
    let (wf, events) = Workflow::create("  ", None, true, Utc::now());
    assert_eq!(wf.name, "Untitled workflow");
    assert!(wf.fail_fast);
    assert_eq!(events[0].event_type, "WorkflowCreated");
    let mut wf = wf;
    assert_eq!(
        wf.update_details("", None, false).unwrap_err().to_string(),
        "Unable to save — the workflow needs a name."
    );
    wf.update_details("  Named  ", Some(String::new()), false)
        .unwrap();
    assert_eq!(wf.name, "Named");
    assert!(wf.description.is_none());
}

// --- shared texts -----------------------------------------------------------

/// A complete step whose prompt is linked to a new shared text.
fn linked_step(
    wf: &mut Workflow,
    name: &str,
    body: &str,
    vars: &[(&str, &str)],
) -> (StepId, SharedTextId) {
    let step = complete_step(wf, name);
    let (text, _) = wf.add_text("designer_brief", None, body).unwrap();
    let mut map = BTreeMap::new();
    for (k, v) in vars {
        map.insert(k.to_string(), v.to_string());
    }
    wf.set_step_text_ref(
        step,
        TextField::Prompt,
        Some(TextRef {
            text_id: text,
            vars: map,
        }),
    )
    .unwrap();
    (step, text)
}

#[test]
fn effective_fields_render_the_shared_text() {
    let mut wf = workflow();
    let (step, text) = linked_step(
        &mut wf,
        "Step 1",
        "Hello {{who}}, keep {{missing}}.",
        &[("who", "Ada")],
    );
    let s = wf.step(step).unwrap();
    assert_eq!(s.prompt, None, "the own column is NULL while linked");
    assert_eq!(
        wf.effective_prompt(s).as_deref(),
        Some("Hello Ada, keep {{missing}}.")
    );
    assert!(wf.effective_context(s).is_none());
    assert_eq!(wf.effective_expect(s).as_deref(), Some("The result"));
    assert!(s.configured(&wf), "a linked prompt configures the step");
    assert_eq!(wf.steps_using_text(text).len(), 1);
}

#[test]
fn shared_text_key_validation() {
    let mut wf = workflow();
    let (id, _) = wf
        .add_text("designer brief", Some("A brief".into()), "Body")
        .unwrap();
    assert_eq!(
        wf.add_text("  ", None, "Body").unwrap_err().to_string(),
        "Unable to save — name the shared text."
    );
    assert_eq!(
        wf.add_text("Designer Brief", None, "Body")
            .unwrap_err()
            .to_string(),
        "Unable to save — Name has already been taken."
    );
    assert_eq!(
        wf.add_text("9bad", None, "Body").unwrap_err().to_string(),
        "Unable to save — Name must start with a letter and use letters, numbers, spaces or underscores."
    );
    wf.update_text(id, "renamed", None, "New body").unwrap();
    let text = wf.text(id).unwrap();
    assert_eq!(
        (text.key.as_str(), text.body.as_str()),
        ("renamed", "New body")
    );
    assert!(matches!(
        wf.update_text(SharedTextId::new(), "x", None, "y"),
        Err(DomainError::NotFound(_))
    ));
    // Positions grow.
    let (second, _) = wf.add_text("other", None, "Body").unwrap();
    assert_eq!(wf.text(second).unwrap().position, 2);
}

#[test]
fn remove_text_refused_while_in_use() {
    let mut wf = workflow();
    let (step, text) = linked_step(&mut wf, "Step 1", "Body", &[]);
    let other = complete_step(&mut wf, "Step 2");
    wf.set_step_text_ref(
        other,
        TextField::Context,
        Some(TextRef {
            text_id: text,
            vars: BTreeMap::new(),
        }),
    )
    .unwrap();
    let err = wf.remove_text(text).unwrap_err();
    assert_eq!(
        err.to_string(),
        "“designer_brief” is used by 2 steps. Detach them first."
    );
    assert!(matches!(err, DomainError::Precondition { .. }));
    wf.set_step_text_ref(step, TextField::Prompt, None).unwrap();
    wf.set_step_text_ref(other, TextField::Context, None)
        .unwrap();
    let events = wf.remove_text(text).unwrap();
    assert_eq!(events[0].event_type, "WorkflowUpdated");
    assert!(wf.texts.is_empty());
}

#[test]
fn detach_copies_the_rendered_text() {
    let mut wf = workflow();
    let (step, _text) = linked_step(
        &mut wf,
        "Step 1",
        "Hello {{who}} and {{topic}}.",
        &[("who", "Ada")],
    );
    wf.set_step_text_ref(step, TextField::Prompt, None).unwrap();
    let s = wf.step(step).unwrap();
    assert!(s.prompt_ref.is_none());
    assert_eq!(
        s.prompt.as_deref(),
        Some("Hello Ada and {{topic}}."),
        "the rendered text is copied, unfilled tokens stay for run time"
    );
    // Detaching a field that is not linked leaves it alone.
    wf.set_step_text_ref(step, TextField::Prompt, None).unwrap();
    assert_eq!(
        wf.step(step).unwrap().prompt.as_deref(),
        Some("Hello Ada and {{topic}}.")
    );
    assert!(matches!(
        wf.set_step_text_ref(StepId::new(), TextField::Prompt, None),
        Err(DomainError::NotFound(_))
    ));
    assert!(matches!(
        wf.set_step_text_ref(
            step,
            TextField::Prompt,
            Some(TextRef {
                text_id: SharedTextId::new(),
                vars: BTreeMap::new()
            }),
        ),
        Err(DomainError::NotFound(_))
    ));
}

#[test]
fn plain_prompt_update_clears_the_ref() {
    let mut wf = workflow();
    let (step, text) = linked_step(&mut wf, "Step 1", "Shared body", &[]);
    // A blank prompt leaves the link in place.
    wf.update_step_prompt(step, Some("   ".into()), None)
        .unwrap();
    assert!(wf.step(step).unwrap().prompt_ref.is_some());
    // Plain text replaces it.
    wf.update_step_prompt(step, Some("Own words".into()), None)
        .unwrap();
    let s = wf.step(step).unwrap();
    assert_eq!(s.prompt.as_deref(), Some("Own words"));
    assert!(s.prompt_ref.is_none());
    // Same for expect through the output update; a blank expect keeps the link.
    wf.set_step_text_ref(
        step,
        TextField::Expect,
        Some(TextRef {
            text_id: text,
            vars: BTreeMap::new(),
        }),
    )
    .unwrap();
    wf.update_step_output(
        step,
        "result",
        None,
        None,
        OutputFileFormat::FreeTextMarkdown,
    )
    .unwrap();
    assert!(wf.step(step).unwrap().expect_ref.is_some());
    wf.update_step_output(
        step,
        "result",
        None,
        Some("Own words".into()),
        OutputFileFormat::FreeTextMarkdown,
    )
    .unwrap();
    assert!(wf.step(step).unwrap().expect_ref.is_none());
}

#[test]
fn extract_text_creates_links_and_clears_the_field() {
    let mut wf = workflow();
    let step = complete_step(&mut wf, "Step 1");
    wf.step_mut(step).unwrap().prompt = None;
    let err = wf
        .extract_text(step, TextField::Prompt, "brief")
        .unwrap_err();
    assert_eq!(
        err.to_string(),
        "There is nothing to share yet. Write the text first."
    );
    wf.step_mut(step).unwrap().prompt = Some("Write a brief".into());
    let (text, events) = wf.extract_text(step, TextField::Prompt, "brief").unwrap();
    assert_eq!(
        events
            .iter()
            .map(|e| e.event_type.as_str())
            .collect::<Vec<_>>(),
        vec!["WorkflowUpdated", "WorkflowStepUpdated"]
    );
    let s = wf.step(step).unwrap();
    assert_eq!(wf.text(text).unwrap().body, "Write a brief");
    assert_eq!(s.prompt, None);
    assert_eq!(
        s.prompt_ref,
        Some(TextRef {
            text_id: text,
            vars: BTreeMap::new()
        })
    );
    assert_eq!(
        wf.extract_text(step, TextField::Prompt, "other")
            .unwrap_err()
            .to_string(),
        "There is nothing to share yet. Write the text first.",
        "a linked field has nothing of its own to share"
    );
    let other = complete_step(&mut wf, "Step 2");
    wf.step_mut(other).unwrap().prompt = Some("Again".into());
    assert_eq!(
        wf.extract_text(other, TextField::Prompt, "Brief")
            .unwrap_err()
            .to_string(),
        "Unable to save — Name has already been taken."
    );
}

#[test]
fn duplicate_step_copies_text_refs_with_vars() {
    let mut wf = workflow();
    let (step, text) = linked_step(
        &mut wf,
        "Step 1",
        "Judge {{judge_name}}",
        &[("judge_name", "Sauron")],
    );
    let (copy, _) = wf.duplicate_step(step, now()).unwrap();
    let c = wf.step(copy).unwrap();
    assert_eq!(
        c.prompt_ref,
        Some(TextRef {
            text_id: text,
            vars: BTreeMap::from([("judge_name".to_string(), "Sauron".to_string())])
        })
    );
    assert_eq!(wf.effective_prompt(c).as_deref(), Some("Judge Sauron"));
    assert_eq!(wf.steps_using_text(text).len(), 2);
}

#[test]
fn validator_reports_shared_text_problems() {
    let mut wf = workflow();
    let (text, _) = wf.add_text("brief", None, "Hello {{who}}.").unwrap();
    let step = complete_step(&mut wf, "Step 1");
    wf.set_step_text_ref(
        step,
        TextField::Prompt,
        Some(TextRef {
            text_id: text,
            vars: BTreeMap::from([
                ("who".to_string(), "Ada".to_string()),
                ("unused".to_string(), "x".to_string()),
            ]),
        }),
    )
    .unwrap();
    wf.set_step_text_ref(
        step,
        TextField::Expect,
        Some(TextRef {
            text_id: text,
            vars: BTreeMap::new(),
        }),
    )
    .unwrap();
    let m = messages(&wf);
    assert!(
        m.contains(&"“Step 1” sets “unused”, which the shared text “brief” doesn’t use.".into()),
        "{m:?}"
    );
    assert!(
        m.contains(
            &"“Step 1” leaves “{{who}}” unfilled in its expected output. Set it in vars.".into()
        ),
        "{m:?}"
    );

    // A dangling ref reads as a missing prompt.
    wf.step_mut(step).unwrap().prompt_ref = Some(TextRef {
        text_id: SharedTextId::new(),
        vars: BTreeMap::new(),
    });
    wf.step_mut(step).unwrap().expect_ref = None;
    wf.step_mut(step).unwrap().expected_output = Some("The result".into());
    assert!(messages(&wf).contains(&"“Step 1” needs a prompt.".into()));

    // A var filled by the ref is not reported by the unknown-token check.
    let mut wf = workflow();
    let (text, _) = wf.add_text("brief", None, "Hello {{who}}.").unwrap();
    let step = complete_step(&mut wf, "Step 1");
    wf.set_step_text_ref(
        step,
        TextField::Prompt,
        Some(TextRef {
            text_id: text,
            vars: BTreeMap::from([("who".to_string(), "Ada".to_string())]),
        }),
    )
    .unwrap();
    assert!(messages(&wf).is_empty(), "vars satisfy the token");
}

#[test]
fn snapshot_freezes_the_rendered_text() {
    let mut wf = workflow();
    let (step, _) = linked_step(
        &mut wf,
        "Step 1",
        "Hello {{who}} and {{topic}}.",
        &[("who", "Ada")],
    );
    let snap = snapshot::build(&wf, &catalog(), now());
    assert_eq!(
        snap.steps[0].prompt.as_deref(),
        Some("Hello Ada and {{topic}}."),
        "snapshot renders vars and leaves run-time tokens"
    );
    // Editing the shared text after the snapshot changes nothing.
    wf.texts[0].body = "Rewritten".into();
    assert_eq!(
        snap.steps[0].prompt.as_deref(),
        Some("Hello Ada and {{topic}}.")
    );
    assert_eq!(
        wf.effective_prompt(wf.step(step).unwrap()).as_deref(),
        Some("Rewritten"),
        "future runs see the new body"
    );
}
