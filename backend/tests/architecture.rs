//! Dependency rules (AGENTS.md):
//! - `features/*/domain` and `features/*/application` never import transport,
//!   database, process or network crates, nor `crate::infrastructure`.
//! - A feature reaches another feature only through that feature's `mod.rs`
//!   re-exports — never its `domain`/`application`/`ports`/`grpc`/`http`.

use std::path::{Path, PathBuf};

const FORBIDDEN: &[&str] = &[
    "tonic",
    "axum",
    "sqlx",
    "reqwest",
    "hyper",
    "tower",
    "tokio::process",
    "tokio::net",
    "crate::infrastructure",
    "crate::app",
];

const INTERNALS: &[&str] = &["domain", "application", "ports", "grpc", "http"];

fn rust_files(dir: &Path, out: &mut Vec<PathBuf>) {
    for entry in std::fs::read_dir(dir).unwrap() {
        let path = entry.unwrap().path();
        if path.is_dir() {
            rust_files(&path, out);
        } else if path.extension().is_some_and(|e| e == "rs") {
            out.push(path);
        }
    }
}

/// `use` paths and fully qualified paths mentioned in `source`, joined with
/// continuation lines so multi-line `use` trees are seen whole.
fn statements(source: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut current = String::new();
    for line in source.lines() {
        let line = line.trim();
        if line.starts_with("//") {
            continue;
        }
        if !current.is_empty() {
            current.push(' ');
            current.push_str(line);
            if line.ends_with(';') {
                out.push(std::mem::take(&mut current));
            }
            continue;
        }
        if line.starts_with("use ") || line.starts_with("pub use ") {
            if line.ends_with(';') {
                out.push(line.to_string());
            } else {
                current = line.to_string();
            }
        } else if line.contains("crate::") || line.contains("::") {
            out.push(line.to_string());
        }
    }
    out
}

fn mentions(statement: &str, path: &str) -> bool {
    let bytes = statement.as_bytes();
    statement.match_indices(path).any(|(i, _)| {
        let before_ok = i == 0
            || !(bytes[i - 1].is_ascii_alphanumeric()
                || bytes[i - 1] == b'_'
                || bytes[i - 1] == b':');
        let after = statement[i + path.len()..].chars().next();
        let after_ok = after.is_none_or(|c| !(c.is_ascii_alphanumeric() || c == '_'));
        before_ok && after_ok
    })
}

/// Violations for one file of feature `feature` in layer `layer`.
fn check(feature: &str, layer: Option<&str>, source: &str) -> Vec<String> {
    let mut violations = Vec::new();
    for statement in statements(source) {
        if matches!(layer, Some("domain" | "application")) {
            for f in FORBIDDEN {
                if mentions(&statement, f) {
                    violations.push(format!("{f} in {feature}/{}: {statement}", layer.unwrap()));
                }
            }
        }
        for (i, _) in statement.match_indices("crate::features::") {
            let rest = &statement[i + "crate::features::".len()..];
            let mut parts = rest
                .split(|c: char| !(c.is_ascii_alphanumeric() || c == '_'))
                .filter(|p| !p.is_empty());
            let (Some(other), Some(next)) = (parts.next(), parts.next()) else {
                continue;
            };
            if other != feature && INTERNALS.contains(&next) {
                violations.push(format!(
                    "{feature} reaches into {other}::{next}: {statement}"
                ));
            }
        }
    }
    violations
}

#[test]
fn features_respect_the_dependency_rules() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("src/features");
    let mut files = Vec::new();
    rust_files(&root, &mut files);
    let mut violations = Vec::new();
    for file in files {
        let relative = file.strip_prefix(&root).unwrap();
        let mut components = relative
            .components()
            .map(|c| c.as_os_str().to_str().unwrap());
        let feature = components.next().unwrap();
        let layer = components.next().map(|l| l.trim_end_matches(".rs"));
        let source = std::fs::read_to_string(&file).unwrap();
        violations.extend(
            check(feature, layer, &source)
                .into_iter()
                .map(|v| format!("{}: {v}", relative.display())),
        );
    }
    assert!(
        violations.is_empty(),
        "architecture violations:\n{}",
        violations.join("\n")
    );
}

#[test]
fn the_checker_catches_violations() {
    assert!(!check("workflows", Some("domain"), "use sqlx::PgPool;").is_empty());
    assert!(!check("runs", Some("application"), "use tokio::process::Command;").is_empty());
    assert!(
        !check(
            "runs",
            Some("application"),
            "use crate::infrastructure::postgres::PgStore;"
        )
        .is_empty()
    );
    assert!(
        !check(
            "runs",
            Some("domain"),
            "use crate::features::workflows::domain::model::Step;"
        )
        .is_empty()
    );
    assert!(
        !check(
            "runs",
            Some("grpc"),
            "use crate::features::workflows::{\n    domain::model,\n};"
        )
        .is_empty()
    );
    // Allowed: own internals, other features' re-exports, pure crates, grpc using tonic.
    assert!(
        check(
            "runs",
            Some("domain"),
            "use crate::features::runs::domain::model::Run;"
        )
        .is_empty()
    );
    assert!(
        check(
            "runs",
            Some("domain"),
            "use crate::features::workflows::snapshot::Snapshot;"
        )
        .is_empty()
    );
    assert!(
        check(
            "runs",
            Some("domain"),
            "use serde_json::Value;\nuse regex::Regex;"
        )
        .is_empty()
    );
    assert!(check("runs", Some("grpc"), "use tonic::Status;").is_empty());
    assert!(
        check(
            "runs",
            Some("application"),
            "use std::time::Instant; // tokio::net in a comment"
        )
        .is_empty()
    );
}
