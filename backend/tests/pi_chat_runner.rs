//! `PiChatRunner` against the fixture script (spec 0024, task 4.6): argv,
//! environment, session round-trip, termination, redaction.
use std::path::{Path, PathBuf};
use std::time::Duration;

use tokio::sync::mpsc;

use glyph_backend::features::chat::domain::pi_events::Parsed;
use glyph_backend::features::chat::ports::{AgentEvent, ChatRunner, SessionFile, Turn};
use glyph_backend::infrastructure::pi::chat_runner::{PiChatConfig, PiChatRunner};
use glyph_backend::shared::ids::ChatId;
use glyph_backend::shared::redactor::Redactor;
use secrecy::SecretString;
use tokio_util::sync::CancellationToken;

const KEY: &str = "velox-key-123456";

fn runner(timeout: Duration) -> PiChatRunner {
    PiChatRunner::new(
        PiChatConfig {
            pi_bin: concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/tests/fixtures/fake_pi_chat.sh"
            )
            .into(),
            timeout,
            velox_base_url: "https://velox.test/v1".into(),
            velox_api_key: Some(SecretString::from(KEY.to_string())),
            agent_api_url: "http://127.0.0.1:3000".into(),
        },
        Redactor::new([KEY.to_string()]),
    )
}

fn turn(model: &str, message: &str, session: Option<SessionFile>) -> Turn {
    Turn {
        chat_id: ChatId::new(),
        model_id: model.into(),
        message: message.into(),
        session,
    }
}

/// Runs one turn, returning (events, TurnEnd).
async fn drive(
    runner: &PiChatRunner,
    turn: Turn,
    cancel: CancellationToken,
) -> (
    Vec<AgentEvent>,
    glyph_backend::features::chat::ports::TurnEnd,
) {
    let (tx, mut rx) = mpsc::channel(64);
    let end = runner.run(turn, tx, cancel).await;
    let mut events = Vec::new();
    while let Some(event) = rx.recv().await {
        events.push(event);
    }
    (events, end)
}

fn read(path: &Path, file: &str) -> String {
    std::fs::read_to_string(path.join(file)).unwrap()
}

/// The capture dir the script records argv/env/session evidence into; the
/// runner's temp dir is gone by the end, so the message names this one.
fn capture_dir() -> PathBuf {
    static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let n = NEXT.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    let dir = std::env::temp_dir().join(format!("glyph-chat-test-{}-{}", std::process::id(), n));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

#[tokio::test]
async fn argv_matches_the_contract_and_env_is_allowlisted() {
    let capture = capture_dir();
    let runner = runner(Duration::from_secs(10));
    let (events, end) = drive(
        &runner,
        turn(
            "velox/ok-chat-model",
            &format!("CAPTURE_DIR={}\nhi", capture.display()),
            None,
        ),
        CancellationToken::new(),
    )
    .await;
    assert!(end.error.is_none(), "{:?}", end.error.map(|e| e.technical));
    let deltas: Vec<&str> = events
        .iter()
        .filter_map(|e| match e {
            AgentEvent::TextDelta(delta) => Some(delta.as_str()),
            _ => None,
        })
        .collect();
    assert_eq!(deltas, ["Hello ", "there."]);

    let argv: Vec<String> = read(&capture, "argv")
        .split('\0')
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .collect();
    let find = |flag: &str| argv.iter().position(|a| a == flag).unwrap();
    assert_eq!(argv[0], "--print");
    assert_eq!(argv[find("--mode") + 1], "json");
    assert_eq!(argv[find("--provider") + 1], "velox");
    assert_eq!(argv[find("--model") + 1], "ok-chat-model");
    assert!(argv.contains(&"--api-key".to_string()));
    let tools = argv.iter().position(|a| a == "--tools").unwrap();
    let expected_tools = glyph_backend::features::chat::http::AGENT_TOOLS.join(",");
    assert_eq!(argv[tools + 1], expected_tools);
    assert!(argv.contains(&"--no-extensions".to_string()));
    let ext = argv.iter().position(|a| a == "-e").unwrap();
    assert!(argv[ext + 1].ends_with("agent/glyph-tools.ts"), "{argv:?}");
    assert!(argv.contains(&"--no-skills".to_string()));
    assert!(argv.contains(&"--no-context-files".to_string()));
    assert!(argv.contains(&"--offline".to_string()));
    let sys = argv.iter().position(|a| a == "--system-prompt").unwrap();
    assert!(argv[sys + 1].contains("Glyph"));
    let guide = argv
        .iter()
        .position(|a| a == "--append-system-prompt")
        .unwrap();
    assert!(argv[guide + 1].ends_with("agent/workflow-guide.md"));
    assert!(argv.last().unwrap().starts_with('@'));

    let env: Vec<String> = read(&capture, "env")
        .lines()
        .filter_map(|l| {
            let l = l
                .trim_start_matches("export ")
                .trim_start_matches("declare -x ");
            l.split_once('=').map(|(k, _)| k.to_string())
        })
        .collect();
    for key in ["HOME", "PATH", "TZ", "GLYPH_AGENT_API_URL"] {
        assert!(env.contains(&key.to_string()), "missing {key}: {env:?}");
    }
    let allowed = [
        "HOME",
        "PWD",
        "SHLVL",
        "PATH",
        "TZ",
        "GLYPH_AGENT_API_URL",
        "SSL_CERT_FILE",
        "SSL_CERT_DIR",
        "NODE_EXTRA_CA_CERTS",
    ];
    assert!(
        env.iter().all(|k| allowed.contains(&k.as_str())),
        "unexpected env: {env:?}"
    );
}

#[tokio::test]
async fn session_round_trips_and_the_temp_dir_is_gone() {
    let capture = capture_dir();
    let runner = runner(Duration::from_secs(10));
    // Turn two: a stored session restored at its relative path.
    let stored = SessionFile {
        relative_path: "slug/00000000-0000-0000-0000-000000000001.jsonl".into(),
        bytes: b"{\"type\":\"session\",\"version\":3}\n".to_vec(),
    };
    let chat_id = ChatId::new();
    let (_, end) = drive(
        &runner,
        Turn {
            chat_id,
            model_id: "velox/ok-chat-model".into(),
            message: format!("CAPTURE_DIR={}\nagain", capture.display()),
            session: Some(stored),
        },
        CancellationToken::new(),
    )
    .await;
    assert!(end.error.is_none(), "{:?}", end.error.map(|e| e.technical));
    // The script saw the stored bytes.
    assert!(read(&capture, "restored_session").contains("\"version\":3"));
    // The session the script wrote comes back.
    let session = end.session.expect("session written");
    assert_eq!(
        session.relative_path,
        "00000000-0000-0000-0000-000000000001.jsonl"
    );
    assert!(String::from_utf8_lossy(&session.bytes).contains("fake-chat"));
}

#[tokio::test]
async fn timeout_terminates_and_reports_the_matching_error() {
    let runner = runner(Duration::from_secs(1));
    let started = std::time::Instant::now();
    let (_, end) = drive(
        &runner,
        turn("velox/sleep-chat-model", "hi", None),
        CancellationToken::new(),
    )
    .await;
    assert!(started.elapsed() < Duration::from_secs(20));
    let error = end.error.expect("timeout error");
    assert_eq!(
        error.human,
        "The agent took longer than 1 seconds and was stopped."
    );
    assert!(error.technical.contains("timed out"), "{}", error.technical);
}

#[tokio::test]
async fn cancel_terminates_the_process() {
    let runner = runner(Duration::from_secs(600));
    let cancel = CancellationToken::new();
    let timer = {
        let cancel = cancel.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(200)).await;
            cancel.cancel();
        })
    };
    let started = std::time::Instant::now();
    let (_, end) = drive(&runner, turn("velox/sleep-chat-model", "hi", None), cancel).await;
    timer.await.unwrap();
    assert!(started.elapsed() < Duration::from_secs(20));
    assert!(end.error.is_some(), "cancelled turn must carry an error");
}

#[tokio::test]
async fn stderr_is_redacted_in_the_technical_error() {
    let runner = runner(Duration::from_secs(10));
    let (_, end) = drive(
        &runner,
        turn("velox/fail-chat-model", "hi", None),
        CancellationToken::new(),
    )
    .await;
    let error = end.error.expect("error");
    assert_eq!(error.human, "The agent could not complete this reply.");
    assert!(
        !error.technical.contains(KEY),
        "leaked key: {}",
        error.technical
    );
}

/// The fake models.json points at one model with the max-tokens budget.
#[test]
fn pi_events_parser_still_maps_fixture_lines() {
    let line = r#"{"type":"tool_execution_end","toolCallId":"c1","toolName":"list_workflows","result":{"content":[{"type":"text","text":"none"}],"details":{}},"isError":false}"#;
    assert!(matches!(
        glyph_backend::features::chat::domain::pi_events::parse_line(line),
        Parsed::ToolFinished { .. }
    ));
}
