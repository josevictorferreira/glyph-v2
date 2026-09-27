//! Ports of spec/domain/workflows/definition/{parser,exporter,applier,round_trip}_spec.rb.

use serde_json::{Value, json};

use super::applier::apply;
use super::exporter::{document_hash, export, filename, fingerprint};
use super::parser::{ExistingStep, parse};
use super::types::*;
use super::yaml;
use crate::features::workflows::model::*;
use crate::shared::output_format::OutputFileFormat;
use crate::shared::time::Timestamp;

const MINIMAL: &str = include_str!("../../../../tests/fixtures/definitions/minimal.yml");
const FULL: &str = include_str!("../../../../tests/fixtures/definitions/full.yml");
const HELPER_WITH_PROMPT: &str = include_str!("../../../../tests/fixtures/definitions/helper_with_prompt.yml");
const UNKNOWN_KEY: &str = include_str!("../../../../tests/fixtures/definitions/unknown_key.yml");

fn now() -> Timestamp {
    "2026-08-04T08:00:00Z".parse().unwrap()
}

fn errors(text: &str) -> Vec<DefinitionError> {
    parse(text, None).unwrap_err()
}

fn one(text: &str) -> DefinitionError {
    let e = errors(text);
    assert_eq!(e.len(), 1, "{e:?}");
    e.into_iter().next().unwrap()
}

fn messages(text: &str) -> Vec<String> {
    errors(text).into_iter().map(|e| e.message).collect()
}

fn import(text: &str) -> Workflow {
    let doc = parse(text, None).unwrap();
    let (mut wf, _) = Workflow::create(&doc.name, None, false, now());
    apply(&mut wf, &doc, now());
    wf
}

fn existing(wf: &Workflow) -> Vec<ExistingStep> {
    wf.steps.iter().map(|s| ExistingStep { id: s.id, name: s.name.clone() }).collect()
}

fn reapply(wf: &mut Workflow, text: &str) -> Vec<String> {
    let doc = parse(text, Some(&existing(wf))).unwrap();
    apply(wf, &doc, now()).into_iter().map(|e| e.event_type).collect()
}

// --- parser -------------------------------------------------------------------

#[test]
fn valid_document() {
    assert!(parse(MINIMAL, None).is_ok());
}

#[test]
fn staged_errors() {
    let e = one("");
    assert_eq!((e.path.as_deref(), e.line), (Some("/"), Some(1)));
    assert_eq!(e.message, "The document is empty. Start with a name and one step.");

    let e = one(&format!("description: {}\n", "x".repeat(300_000)));
    assert_eq!((e.line, e.message.as_str()), (None, "The document is too large (limit 256 KiB)."));

    let e = one("name: Broken\nsteps:\n\t- name: Research\n\t prompt: Find\n");
    assert!(e.message.starts_with("YAML syntax error:"), "{e:?}");
    assert!(e.line.is_some());

    for text in [
        "name: &name Workflow\nsteps:\n- name: *name\n  prompt: Find\n",
        "name: Workflow\nsteps:\n- name: Research\n  prompt: !ruby/object:Object {}\n",
    ] {
        let e = one(text);
        assert_eq!((e.line, e.message.as_str()), (None, "Aliases and tags are not allowed."));
    }

    assert_eq!(one("- name: Workflow\n- name: Other\n").message, "The document must be a map with name and steps.");
}

#[test]
fn schema_errors_carry_lines() {
    let e = one(HELPER_WITH_PROMPT);
    assert_eq!((e.path.as_deref(), e.line), (Some("/steps/0"), Some(3)));
    assert_eq!(e.message, "\"prompt\" is not allowed on a helper step.");

    let e = one(UNKNOWN_KEY);
    assert_eq!((e.path.as_deref(), e.line), (Some("/steps/0"), Some(3)));
    assert_eq!(e.message, "\"bogus\" is not a known key here.");

    let e = one("name: Workflow\nsteps:\n- name: Research\n  prompt: Find\n  temperature: 5\n");
    assert_eq!((e.path.as_deref(), e.line), (Some("/steps/0/temperature"), Some(5)));
    assert_eq!(e.message, "temperature must be between 0 and 2.");
}

#[test]
fn builds_the_full_fixture() {
    let doc = parse(FULL, None).unwrap();
    assert_eq!(doc.steps.len(), 3);
    let notes = &doc.steps[1].inputs[0];
    assert_eq!(notes.source, Some(Source { kind: SourceKind::Step, name: "research".into() }));
    assert_eq!(doc.steps[2].inputs[1].source.as_ref().unwrap().kind, SourceKind::WorkflowInput);
    assert_eq!(doc.steps[0].model.as_deref(), Some("openai/gpt-5"));
    assert_eq!(doc.steps[1].model.as_deref(), Some("anthropic/claude-sonnet-5"));
    assert_eq!(doc.steps[0].tools, vec!["read", "bash"]);
    assert_eq!(doc.steps[0].output, "research");
    assert_eq!(doc.steps[0].format, OutputFileFormat::FreeTextMarkdown);
    assert_eq!(doc.steps[2].kind, StepKind::Helper);
    assert!(doc.steps[2].model.is_none() && doc.steps[2].tools.is_empty());
    let schedule = doc.schedule.unwrap();
    assert_eq!((schedule.cron.as_str(), schedule.enabled), ("0 9 * * 1", true));
}

#[test]
fn reference_checks() {
    let e = one("name: Workflow\nsteps:\n- name: Research\n  prompt: Find\n- name: research\n  prompt: Dig\n");
    assert_eq!(e.path.as_deref(), Some("/steps/1/name"));
    assert_eq!(e.message, "Two steps are named “research”. Step names must be unique.");

    let e = one("name: Workflow\nsteps:\n- name: Research\n  prompt: Find\n- name: Digest\n  prompt: Combine\n  inputs:\n    notes:\n      from: nope\n");
    assert_eq!(e.path.as_deref(), Some("/steps/1/inputs/notes"));
    assert_eq!(e.line, Some(8));
    assert_eq!(e.message, "“nope” is not a step or a workflow input. Check the spelling.");

    assert_eq!(
        messages("name: Workflow\ninputs:\n  notes: seed\nsteps:\n- name: Notes\n  prompt: Find\n- name: Digest\n  prompt: Combine\n  inputs:\n    notes:\n      from: notes\n"),
        vec!["“notes” is both a step and a workflow input. Rename one of them."]
    );
    assert_eq!(
        messages("name: Workflow\nsteps:\n- name: digest\n  prompt: Combine\n  inputs:\n    digest:\n      from: digest\n"),
        vec!["“digest” cannot feed itself."]
    );
    let e = one("name: Workflow\nsteps:\n- name: Alpha\n  prompt: Find\n  inputs:\n    beta:\n      from: beta\n- name: Beta\n  prompt: Dig\n  inputs:\n    alpha:\n      from: alpha\n");
    assert_eq!((e.path.as_deref(), e.line), (Some("/steps"), None));
    assert_eq!(e.message, "The connections form a cycle. Remove the link that closes the loop.");

    let e = one("name: Workflow\ninputs:\n  region:\n    ask: false\nsteps:\n- name: Research\n  prompt: Find\n");
    assert_eq!(e.path.as_deref(), Some("/inputs/region"));
    assert_eq!(e.message, "Constant input “region” needs a value, or set ask: true.");

    assert_eq!(
        messages("name: Workflow\ninputs:\n  Company: Glyph\n  company: Glyph\nsteps:\n- name: Research\n  prompt: Find\n"),
        vec!["Two workflow inputs are named “company”."]
    );
    let mut m = messages("name: Workflow\nschedule:\n  cron: not cron\n  timezone: Mars/Olympus\nsteps:\n- name: Research\n  prompt: Find\n");
    m.sort();
    assert_eq!(
        m,
        vec!["The recurrence is not a valid cron expression.", "The schedule timezone is not a known IANA timezone."]
    );
    assert_eq!(
        messages("name: Workflow\nschedule:\n  cron: \"0 9 * * *\"\n  timezone: Europe/Berlin\n  values:\n    nope: 1\nsteps:\n- name: Research\n  prompt: Find\n"),
        vec!["The schedule sets “nope”, which is not a workflow input."]
    );
    assert_eq!(
        messages("name: \"   \"\nsteps:\n- name: Research\n  prompt: Find\n"),
        vec!["Give the workflow a name."]
    );
}

#[test]
fn step_ids_against_an_existing_workflow() {
    let text = "name: Workflow\nsteps:\n- id: \"999\"\n  name: Research\n  prompt: Find\n";
    let (mut wf, _) = Workflow::create("W", None, false, now());
    let e = parse(text, Some(&existing(&wf))).unwrap_err();
    assert_eq!(e[0].path.as_deref(), Some("/steps/0/id"));
    assert_eq!(
        e[0].message,
        "No step with id “999” exists in this workflow. Remove the id to create a new step."
    );
    // Ignored on import.
    assert!(parse(text, None).unwrap().steps.iter().all(|s| s.id.is_none()));

    for _ in 0..2 {
        let (id, _) = wf.add_step(StepKind::Pi, None, now());
        wf.step_mut(id).unwrap().name = "Step".into();
    }
    let e = parse("name: Workflow\nsteps:\n- name: Step\n  prompt: Find\n", Some(&existing(&wf))).unwrap_err();
    assert_eq!(
        e[0].message,
        "The workflow already has two steps named “Step”. Download the YAML to get their ids."
    );
}

#[test]
fn input_forms_and_defaults() {
    let doc = parse(
        "name: Workflow\ninputs:\n  notes:\n    description: Research notes\n    value: seed\n  question:\n    description: What next?\n  region: LATAM\n  limit: 42\nsteps:\n- name: Research\n  prompt: Find\n  format: markdown\n  temperature: 0.2\n",
        None,
    )
    .unwrap();
    let get = |n: &str| doc.inputs.iter().find(|i| i.name == n).unwrap().clone();
    let notes = get("notes");
    assert_eq!((notes.value.as_deref(), notes.ask, notes.required), (Some("seed"), false, true));
    let question = get("question");
    assert_eq!((question.value.as_deref(), question.ask), (None, true));
    let region = get("region");
    assert_eq!((region.value.as_deref(), region.ask), (Some("LATAM"), false));
    assert_eq!(get("limit").value.as_deref(), Some("42"));
    assert_eq!(doc.steps[0].format, OutputFileFormat::FreeTextMarkdown);
    assert_eq!(doc.steps[0].temperature, Some(0.2));
}

// --- exporter -----------------------------------------------------------------

/// Factory `:workflow_step`.
fn factory_step(wf: &mut Workflow, name: &str, position: i32) -> crate::shared::ids::StepId {
    let (id, _) = wf.add_step(StepKind::Pi, None, now());
    let s = wf.step_mut(id).unwrap();
    s.name = name.into();
    s.prompt = Some("Do the thing".into());
    s.output_name = Some("result".into());
    s.expected_output = Some("The result".into());
    s.model_id = Some("test-model".into());
    s.position = position;
    id
}

fn keys(v: &Value) -> Vec<String> {
    v.as_object().unwrap().keys().cloned().collect()
}

#[test]
fn exports_only_essential_keys() {
    let (mut wf, _) = Workflow::create("Workflow 1", None, false, now());
    let id = factory_step(&mut wf, "Do", 1);
    wf.step_mut(id).unwrap().output_name = Some("Do".into());
    let doc = document_hash(&wf);
    assert_eq!(keys(&doc), vec!["name", "steps"]);
    assert_eq!(keys(&doc["steps"][0]), vec!["id", "name", "model", "prompt", "expect"]);
}

#[test]
fn exports_key_order_and_folding() {
    let (mut wf, _) = Workflow::create("W", Some("A workflow".into()), true, now());
    wf.inputs.push(WorkflowInput {
        id: Default::default(),
        name: "greeting".into(),
        description: Some("The greeting".into()),
        required: true,
        ask_at_run_time: false,
        value: Some("hello".into()),
        position: 1,
        created_at: now(),
    });
    let mut schedule = Schedule::new(now());
    schedule.cron_expression = Some("0 9 * * *".into());
    schedule.timezone = Some("UTC".into());
    wf.schedule = Some(schedule);
    for (name, pos) in [("First", 1), ("Second", 2)] {
        let id = factory_step(&mut wf, name, pos);
        let s = wf.step_mut(id).unwrap();
        s.model_id = Some("sonnet".into());
        s.enabled_tool_ids = vec!["read".into()];
    }
    let (helper, _) = wf.add_step(StepKind::Helper, None, now());
    wf.step_mut(helper).unwrap().name = "Help".into();

    let doc = document_hash(&wf);
    assert_eq!(
        keys(&doc),
        vec!["name", "description", "fail_fast", "defaults", "inputs", "schedule", "steps"]
    );
    assert_eq!(doc["defaults"], json!({ "model": "sonnet", "tools": ["read"] }));
    assert!(doc["steps"][0].get("model").is_none());
    assert_eq!(
        doc["inputs"]["greeting"],
        json!({ "description": "The greeting", "value": "hello", "ask": false })
    );
    assert_eq!(doc["schedule"], json!({ "cron": "0 9 * * *", "timezone": "UTC", "enabled": false }));
    assert_eq!(keys(&doc["steps"][2]), vec!["id", "name", "kind", "inputs"]);
    assert_eq!(doc["steps"][2]["inputs"], json!({}));
}

#[test]
fn exports_step_fields_in_order() {
    let (mut wf, _) = Workflow::create("W", None, false, now());
    let earlier = factory_step(&mut wf, "Earlier", 1);
    let later = factory_step(&mut wf, "Later", 2);
    {
        let s = wf.step_mut(later).unwrap();
        s.description = Some("Does more".into());
        s.model_id = Some("sonnet".into());
        s.model_settings.insert("temperature".into(), json!(0.2));
        s.enabled_tool_ids = vec!["read".into()];
        s.expected_output = Some("The more".into());
        s.output_name = Some("summary".into());
        s.output_file_format = OutputFileFormat::Html;
        s.allow_failure = true;
    }
    let (input, _) = wf.add_step_input(later, "payload", true, now()).unwrap();
    wf.create_connection(earlier, input, false, now()).unwrap();
    let step = &document_hash(&wf)["steps"][1];
    assert_eq!(
        keys(step),
        vec!["id", "name", "description", "model", "temperature", "tools", "prompt", "expect", "output", "format", "allow_failure", "inputs"]
    );
    assert_eq!(step["inputs"], json!({ "payload": "Earlier" }));
    assert_eq!(step["format"], "html");
    assert_eq!(step["temperature"], 0.2);
}

#[test]
fn exports_step_input_forms() {
    let (mut wf, _) = Workflow::create("W", None, false, now());
    let earlier = factory_step(&mut wf, "Earlier", 1);
    let later = factory_step(&mut wf, "Later", 2);
    let (optional, _) = wf.add_step_input(later, "payload", false, now()).unwrap();
    wf.create_connection(earlier, optional, false, now()).unwrap();
    wf.add_step_input(later, "loose", true, now()).unwrap();
    let inputs = &document_hash(&wf)["steps"][1]["inputs"];
    assert_eq!(inputs["payload"], json!({ "from": "Earlier", "required": false }));
    assert_eq!(inputs["loose"], json!({}));
}

#[test]
fn export_text() {
    let (mut wf, _) = Workflow::create("W", None, false, now());
    let id = factory_step(&mut wf, "Do", 1);
    wf.step_mut(id).unwrap().prompt = Some("Summarize the notes.\n\nKeep it short: three bullets.".into());
    let text = export(&wf, Some("https://glyph.test/schemas/workflow.json"));
    let mut lines = text.lines();
    assert_eq!(lines.next(), Some("# yaml-language-server: $schema=https://glyph.test/schemas/workflow.json"));
    assert!(lines.next().unwrap().starts_with("name: "));
    assert!(text.contains("prompt: |-"));
    assert!(!text.lines().any(|l| l.trim() == "---" || l.trim() == "..."));
    let body = yaml::load(&text).unwrap().value;
    assert_eq!(body["steps"][0]["prompt"], "Summarize the notes.\n\nKeep it short: three bullets.");
    assert!(export(&wf, None).starts_with("# yaml-language-server: $schema=/schemas/workflow.json\n"));

    let f = fingerprint(&wf);
    assert_eq!(f.len(), 64);
    assert_eq!(fingerprint(&wf), f);
    wf.step_mut(id).unwrap().prompt = Some("Second draft".into());
    assert_ne!(fingerprint(&wf), f);
    assert_eq!(filename(&wf), "w.yml");
    wf.name = "Design POC — Tournament!".into();
    assert_eq!(filename(&wf), "design-poc-tournament.yml");
    wf.name = "***".into();
    assert_eq!(filename(&wf), "workflow.yml");
}

// --- applier ------------------------------------------------------------------

#[test]
fn imports_the_full_fixture_with_its_meaning() {
    let wf = import(FULL);
    let by_name = |n: &str| wf.steps.iter().find(|s| s.name == n).unwrap();
    assert_eq!(by_name("research").model_id.as_deref(), Some("openai/gpt-5"));
    assert_eq!(by_name("digest").model_id.as_deref(), Some("anthropic/claude-sonnet-5"));
    assert_eq!(by_name("package").kind, StepKind::Helper);
    assert_eq!(by_name("research").enabled_tool_ids, vec!["read", "bash"]);
    assert_eq!(wf.inputs.iter().find(|i| i.name == "region").unwrap().value.as_deref(), Some("LATAM"));
    let schedule = wf.schedule.as_ref().unwrap();
    assert_eq!(schedule.cron_expression.as_deref(), Some("0 9 * * 1"));
    assert!(schedule.enabled && schedule.next_run_at.is_none(), "drafts have no next run");

    let digest = by_name("digest");
    let notes = &digest.inputs[0];
    let connection = wf.incoming_connection(notes.id).unwrap();
    assert_eq!(connection.source_step_id, by_name("research").id);
    assert_eq!(connection.source_output_name, "research");
    let company = by_name("package").inputs.iter().find(|i| i.name == "company").unwrap();
    assert_eq!(wf.input(company.workflow_input_id.unwrap()).unwrap().name, "company");
    // Layout: research is a root; digest right of it; package right of digest.
    assert_eq!((by_name("research").canvas_x, by_name("research").canvas_y), (120, 120));
    assert_eq!(by_name("digest").canvas_x, 440);
    assert_eq!(by_name("package").canvas_x, 760);
}

#[test]
fn applying_its_own_export_is_a_no_op() {
    let mut wf = import(FULL);
    let before = fingerprint(&wf);
    let text = export(&wf, None);
    let events = reapply(&mut wf, &text);
    assert!(events.is_empty(), "{events:?}");
    assert_eq!(fingerprint(&wf), before);
}

#[test]
fn export_import_export_is_stable() {
    fn strip_ids(v: &mut Value) {
        match v {
            Value::Object(m) => {
                m.remove("id");
                m.values_mut().for_each(strip_ids);
            }
            Value::Array(a) => a.iter_mut().for_each(strip_ids),
            _ => {}
        }
    }
    let first = import(FULL);
    let second = import(&export(&first, None));
    let (mut a, mut b) = (document_hash(&first), document_hash(&second));
    strip_ids(&mut a);
    strip_ids(&mut b);
    assert_eq!(a, b);
}

#[test]
fn round_trips_every_field() {
    let (mut wf, _) = Workflow::create("Everything", Some("All fields".into()), true, now());
    wf.add_workflow_input(
        crate::features::workflows::WorkflowInputFields {
            name: "company".into(),
            description: Some("Company to research".into()),
            required: true,
            ask_at_run_time: true,
            value: None,
        },
        now(),
    )
    .unwrap();
    wf.add_workflow_input(
        crate::features::workflows::WorkflowInputFields {
            name: "region".into(),
            required: true,
            value: Some("LATAM".into()),
            ask_at_run_time: false,
            description: None,
        },
        now(),
    )
    .unwrap();
    wf.add_workflow_input(
        crate::features::workflows::WorkflowInputFields {
            name: "defaulted".into(),
            required: false,
            value: Some("x".into()),
            ask_at_run_time: true,
            description: None,
        },
        now(),
    )
    .unwrap();
    let research = factory_step(&mut wf, "research", 1);
    {
        let s = wf.step_mut(research).unwrap();
        s.prompt = Some("Research {{company}}.".into());
        s.output_name = Some("research".into());
        s.model_id = Some("openai/gpt-5".into());
        s.model_settings.insert("temperature".into(), json!(0.2));
        s.enabled_tool_ids = vec!["read".into(), "bash".into()];
        s.output_file_format = OutputFileFormat::Html;
    }
    let digest = factory_step(&mut wf, "digest", 2);
    wf.step_mut(digest).unwrap().allow_failure = true;
    let (helper, _) = wf.add_step(StepKind::Helper, None, now());
    wf.step_mut(helper).unwrap().name = "package".into();
    let (notes, _) = wf.add_step_input(digest, "notes", true, now()).unwrap();
    wf.create_connection(research, notes, false, now()).unwrap();
    let mut schedule = Schedule::new(now());
    schedule.enabled = true;
    schedule.cron_expression = Some("0 9 * * 1".into());
    schedule.timezone = Some("America/Sao_Paulo".into());
    wf.schedule = Some(schedule);

    let text = export(&wf, None);
    let fresh = import(&text);
    let reexport = export(&fresh, None);
    let strip = |t: &str| {
        let mut v = yaml::load(t).unwrap().value;
        fn go(v: &mut Value) {
            match v {
                Value::Object(m) => {
                    m.remove("id");
                    m.values_mut().for_each(go);
                }
                Value::Array(a) => a.iter_mut().for_each(go),
                _ => {}
            }
        }
        go(&mut v);
        v
    };
    assert_eq!(strip(&reexport), strip(&text), "{text}\n---\n{reexport}");
    let defaulted = fresh.inputs.iter().find(|i| i.name == "defaulted").unwrap();
    assert!(defaulted.ask_at_run_time && !defaulted.required);
}

#[test]
fn applier_attribute_and_input_events() {
    let (mut wf, _) = Workflow::create("Original", None, false, now());
    assert!(reapply(&mut wf, "name: Original\nsteps:\n- name: s\n").contains(&"WorkflowStepAdded".to_string()));
    let events = reapply(&mut wf, "name: New name\ndescription: Fresh\nfail_fast: true\nsteps:\n- name: s\n");
    assert_eq!(events, vec!["WorkflowUpdated"]);
    assert!(wf.fail_fast);

    let events = reapply(&mut wf, "name: New name\ndescription: Fresh\nfail_fast: true\ninputs:\n  Company: Acme\nsteps:\n- name: s\n");
    assert_eq!(events, vec!["WorkflowInputMapped"]);
    // Case-insensitive match updates in place.
    let id = wf.inputs[0].id;
    let events = reapply(&mut wf, "name: New name\ndescription: Fresh\nfail_fast: true\ninputs:\n  company: Acme\nsteps:\n- name: s\n");
    assert_eq!(events, vec!["WorkflowUpdated"]);
    assert_eq!((wf.inputs[0].id, wf.inputs[0].name.as_str()), (id, "company"));
    let events = reapply(&mut wf, "name: New name\ndescription: Fresh\nfail_fast: true\nsteps:\n- name: s\n");
    assert_eq!(events, vec!["WorkflowUpdated"]);
    assert!(wf.inputs.is_empty());
}

#[test]
fn applier_steps_inputs_and_connections() {
    let mut wf = import("name: W\ninputs:\n  Company: {}\nsteps:\n- name: Up\n  prompt: x\n  output: old\n- name: Down\n  prompt: x\n  inputs:\n    notes: Up\n    extra: {}\n    mapped: Company\n");
    let up = wf.steps[0].id;
    let (x, y) = (wf.steps[0].canvas_x, wf.steps[0].canvas_y);

    // Rename output: outgoing connection follows; rename step keeps canvas.
    let events = reapply(
        &mut wf,
        &format!("name: W\ninputs:\n  Company: {{}}\nsteps:\n- id: \"{up}\"\n  name: Upper\n  prompt: x\n  output: new\n- name: Down\n  prompt: x\n  inputs:\n    notes: Upper\n    extra: {{}}\n    mapped: Company\n"),
    );
    assert_eq!(events, vec!["WorkflowStepUpdated"], "{events:?}");
    assert_eq!(wf.connections[0].source_output_name, "new");
    assert_eq!((wf.steps[0].canvas_x, wf.steps[0].canvas_y), (x, y));

    // Remove input + connection; drop mapping.
    let events = reapply(
        &mut wf,
        "name: W\ninputs:\n  Company: {}\nsteps:\n- name: Upper\n  prompt: x\n  output: new\n- name: Down\n  prompt: x\n  inputs:\n    mapped: {}\n",
    );
    // The connection goes with its removed input (no separate event, as Rails).
    assert_eq!(events, vec!["WorkflowStepUpdated"]);
    let down = &wf.steps[1];
    assert_eq!(down.inputs.len(), 1);
    assert!(down.inputs[0].workflow_input_id.is_none());
    assert!(wf.connections.is_empty());

    // Absent step deleted; downstream input declared in the document kept.
    let events = reapply(&mut wf, "name: W\ninputs:\n  Company: {}\nsteps:\n- name: Down\n  prompt: x\n  inputs:\n    mapped: {}\n");
    assert_eq!(events, vec!["WorkflowStepDeleted", "WorkflowStepUpdated"]);
    assert_eq!(wf.steps.len(), 1);
    assert_eq!(wf.steps[0].position, 1);
}

#[test]
fn applier_schedule() {
    let mut wf = import("name: W\ninputs:\n  Kept: {}\n  Dropped: {}\nschedule:\n  cron: \"0 9 * * *\"\n  timezone: UTC\n  description: Morning run\n  values:\n    Kept: daily\n    Dropped: old\nsteps:\n- name: s\n");
    let s = wf.schedule.as_ref().unwrap();
    assert!(s.enabled && s.next_run_at.is_none());
    assert_eq!(s.values.len(), 2);

    let events = reapply(&mut wf, "name: W\ninputs:\n  Kept: {}\n  Dropped: {}\nschedule:\n  cron: \"0 9 * * *\"\n  timezone: UTC\n  description: Morning run\n  values:\n    Kept: daily\nsteps:\n- name: s\n");
    assert_eq!(events, vec!["WorkflowScheduleChanged"]);
    let values = &wf.schedule.as_ref().unwrap().values;
    assert_eq!(values.len(), 1);
    assert_eq!(values[0].value.as_deref(), Some("daily"));

    // Active workflow gets a next run.
    wf.status = WorkflowStatus::Active;
    reapply(&mut wf, "name: W\ninputs:\n  Kept: {}\n  Dropped: {}\nschedule:\n  cron: \"0 9 * * *\"\n  timezone: UTC\n  values:\n    Kept: daily\nsteps:\n- name: s\n");
    assert_eq!(wf.next_run_at, Some("2026-08-04T09:00:00Z".parse().unwrap()));

    let events = reapply(&mut wf, "name: W\ninputs:\n  Kept: {}\n  Dropped: {}\nsteps:\n- name: s\n");
    assert_eq!(events, vec!["WorkflowScheduleChanged"]);
    assert!(wf.schedule.is_none() && wf.next_run_at.is_none());
}
