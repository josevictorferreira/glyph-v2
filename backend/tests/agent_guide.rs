//! Drift tests between the agent's guide, its extension and the workflow
//! definition (spec 0024, task 4.8): every `yaml workflow` block in the
//! guide parses clean, the extension registers exactly `AGENT_TOOLS`, and
//! the guide documents every top-level definition key.
use glyph_backend::features::chat::http::AGENT_TOOLS;
use glyph_backend::features::definition::domain::parser;

const GUIDE: &str = include_str!("../agent/workflow-guide.md");
const SYSTEM_PROMPT: &str = include_str!("../agent/system-prompt.md");
const TOOLS_TS: &str = include_str!("../agent/glyph-tools.ts");

/// Every fenced block tagged `yaml workflow`, verbatim.
fn workflow_blocks() -> Vec<(usize, String)> {
    let mut blocks = Vec::new();
    let mut lines = GUIDE.lines().enumerate().peekable();
    while let Some((n, line)) = lines.next() {
        let trimmed = line.trim_start();
        let tagged = trimmed
            .strip_prefix("```")
            .is_some_and(|tag| tag.trim() == "yaml workflow");
        if tagged {
            let mut body = String::new();
            for (_, inner) in lines.by_ref() {
                if inner.trim_start().starts_with("```") {
                    break;
                }
                body.push_str(inner);
                body.push('\n');
            }
            blocks.push((n + 2, body)); // 1-based line of the first body line
        }
    }
    blocks
}

#[test]
fn every_guide_workflow_parses_with_zero_errors() {
    let blocks = workflow_blocks();
    assert!(
        !blocks.is_empty(),
        "the guide has no `yaml workflow` blocks"
    );
    for (line, body) in blocks {
        let errors = parser::parse(&body, None).err().unwrap_or_default();
        assert!(
            errors.is_empty(),
            "guide block at line {line} is invalid: {errors:?}\n{body}"
        );
    }
}

#[test]
fn the_extension_registers_exactly_the_agent_tools() {
    for name in AGENT_TOOLS {
        let registered = format!("name: \"{name}\"");
        assert!(
            TOOLS_TS.contains(&registered),
            "glyph-tools.ts does not register {name}"
        );
    }
    let registered: Vec<String> = TOOLS_TS
        .lines()
        .filter(|l| l.trim_start().starts_with("name: "))
        .filter_map(|l| l.split('"').nth(1).map(str::to_string))
        .collect();
    assert_eq!(
        registered.len(),
        AGENT_TOOLS.len(),
        "extra tools: {registered:?}"
    );
    for name in &registered {
        assert!(
            AGENT_TOOLS.contains(&name.as_str()),
            "glyph-tools.ts registers unknown tool {name}"
        );
    }
}

#[test]
fn the_guide_documents_every_top_level_definition_key() {
    let schema: serde_json::Value =
        serde_json::from_str(include_str!("../src/features/definition/schema.json")).unwrap();
    let keys: Vec<&str> = schema["properties"]
        .as_object()
        .expect("schema properties")
        .keys()
        .map(String::as_str)
        .collect();
    assert!(!keys.is_empty());
    for key in keys {
        let word = format!("\n{key}:");
        assert!(
            GUIDE.contains(&word) || GUIDE.contains(&format!("`{key}`")),
            "the guide never mentions the `{key}` key"
        );
    }
}

#[test]
fn the_guide_covers_the_agent_loop_and_common_mistakes() {
    for topic in [
        "export",      // the export → edit → validate → apply loop
        "validate",    //
        "fingerprint", // optimistic concurrency for update_workflow
        "inputs",      // workflow inputs
        "ref",         // shared texts { ref, vars }
        "schedule",    // scheduling
        "helper",      // helper steps
        "connections", // DAG connections
    ] {
        assert!(GUIDE.contains(topic), "guide does not cover {topic}");
    }
}

#[test]
fn the_system_prompt_names_the_glyph_tools() {
    for tool in ["get_workflow_yaml", "validate_yaml", "update_workflow"] {
        assert!(
            SYSTEM_PROMPT.contains(tool),
            "system prompt does not mention {tool}"
        );
    }
}
