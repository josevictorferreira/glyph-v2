//! Deterministic YAML emission for exported definitions: block style, key
//! order preserved, literal block scalars for multi-line strings, no line
//! wrapping, quoting only where a plain scalar would be misread.

use serde_json::Value;

pub fn to_yaml(value: &Value) -> String {
    let mut out = String::new();
    match value {
        Value::Object(map) if !map.is_empty() => write_map(&mut out, map, 0),
        other => {
            out.push_str(&inline(other, 0));
            out.push('\n');
        }
    }
    out
}

fn pad(out: &mut String, indent: usize) {
    out.extend(std::iter::repeat_n(' ', indent));
}

fn write_map(out: &mut String, map: &serde_json::Map<String, Value>, indent: usize) {
    for (key, value) in map {
        pad(out, indent);
        write_entry(out, key, value, indent);
    }
}

/// Writes `key: value` where the key's indentation was already emitted.
fn write_entry(out: &mut String, key: &str, value: &Value, indent: usize) {
    out.push_str(&string(key, indent, false));
    out.push(':');
    match value {
        Value::Object(map) if !map.is_empty() => {
            out.push('\n');
            write_map(out, map, indent + 2);
        }
        Value::Array(items) if !items.is_empty() => {
            out.push('\n');
            // Sequences inside a mapping are not indented (Psych style).
            write_seq(out, items, indent);
        }
        other => {
            out.push(' ');
            out.push_str(&inline(other, indent + 2));
            out.push('\n');
        }
    }
}

fn write_seq(out: &mut String, items: &[Value], indent: usize) {
    for item in items {
        pad(out, indent);
        out.push_str("- ");
        match item {
            Value::Object(map) if !map.is_empty() => {
                let mut first = true;
                for (key, value) in map {
                    if !first {
                        pad(out, indent + 2);
                    }
                    first = false;
                    write_entry(out, key, value, indent + 2);
                }
            }
            Value::Array(inner) if !inner.is_empty() => {
                out.push('\n');
                write_seq(out, inner, indent + 2);
            }
            other => {
                out.push_str(&inline(other, indent + 2));
                out.push('\n');
            }
        }
    }
}

/// A scalar or empty collection on the current line. `indent` is the
/// indentation for block-scalar content.
fn inline(value: &Value, indent: usize) -> String {
    match value {
        Value::Null => "null".into(),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => match (n.as_i64(), n.as_u64(), n.as_f64()) {
            (Some(i), _, _) => i.to_string(),
            (_, Some(u), _) => u.to_string(),
            (_, _, Some(f)) => format!("{f:?}"),
            _ => n.to_string(),
        },
        Value::String(s) => string(s, indent, true),
        Value::Array(_) => "[]".into(),
        Value::Object(_) => "{}".into(),
    }
}

fn string(s: &str, indent: usize, allow_block: bool) -> String {
    if allow_block && s.contains('\n') && block_safe(s) {
        return literal_block(s, indent);
    }
    if plain_safe(s) {
        s.to_string()
    } else {
        serde_json::to_string(s).expect("strings serialize")
    }
}

fn block_safe(s: &str) -> bool {
    !s.chars().any(|c| (c.is_control() && c != '\n' && c != '\t') || c == '\u{feff}')
        && !s.contains('\r')
        && !s.starts_with([' ', '\t', '\n'])
        && !s.lines().any(|l| l.ends_with([' ', '\t']))
}

fn literal_block(s: &str, indent: usize) -> String {
    let trailing = s.len() - s.trim_end_matches('\n').len();
    let chomp = match trailing {
        0 => "-",
        1 => "",
        _ => "+",
    };
    let body = s.trim_end_matches('\n');
    let mut out = format!("|{chomp}");
    for line in body.split('\n') {
        out.push('\n');
        if !line.is_empty() {
            out.extend(std::iter::repeat_n(' ', indent));
            out.push_str(line);
        }
    }
    for _ in 1..trailing {
        out.push('\n');
    }
    out
}

/// Could this string be written unquoted and read back as the same string?
pub fn plain_safe(s: &str) -> bool {
    if s.is_empty() || s.trim() != s {
        return false;
    }
    let first = s.chars().next().unwrap();
    if "-?:,[]{}#&*!|>'\"%@`".contains(first) {
        // "-x" / "?x" / ":x" are plain in YAML, but keep it simple and quote.
        return false;
    }
    if s.contains(": ") || s.contains(" #") || s.ends_with(':') {
        return false;
    }
    if s.chars().any(|c| c.is_control() || c == '\u{feff}') {
        return false;
    }
    // Must read back as this exact string (not a number, bool, null…).
    crate::features::definition::domain::yaml::load(s)
        .map(|l| l.value == Value::String(s.to_string()))
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::features::definition::domain::yaml;
    use serde_json::json;

    fn round_trip(value: Value) {
        let text = to_yaml(&value);
        assert_eq!(yaml::load(&text).unwrap().value, value, "{text}");
    }

    #[test]
    fn quotes_ambiguous_scalars() {
        for s in ["42", "true", "yes", "null", "~", "", " lead", "a: b", "# c", "- x", "0.5", "'q'", "x #y", "@x"] {
            assert!(!plain_safe(s), "{s:?} should be quoted");
        }
        for s in ["hello", "openai/gpt-5", "Weekly competitor digest", "0 9 * * 1", "a-b"] {
            assert!(plain_safe(s), "{s:?} should be plain");
        }
    }

    #[test]
    fn documents_round_trip() {
        round_trip(json!({
            "name": "W",
            "description": "Line one\n\nLine three: yes",
            "fail_fast": true,
            "inputs": { "region": "LATAM", "topic": {}, "limit": { "value": "42", "ask": false } },
            "steps": [
                { "id": "abc", "name": "a", "temperature": 0.2, "tools": ["read", "bash"],
                  "prompt": "trailing newline\n", "context": "two\n\n", "inputs": {} },
                { "name": "b", "inputs": { "notes": "a", "x": { "from": "a", "required": false } } }
            ]
        }));
    }

    #[test]
    fn literal_blocks_and_style() {
        let text = to_yaml(&json!({ "steps": [{ "name": "a", "prompt": "Summarize.\n\nKeep it short: three bullets." }] }));
        assert_eq!(text, "steps:\n- name: a\n  prompt: |-\n    Summarize.\n\n    Keep it short: three bullets.\n");
    }

    #[test]
    fn floats_keep_a_decimal_point() {
        assert_eq!(to_yaml(&json!({ "t": 1.0 })), "t: 1.0\n");
    }
}
