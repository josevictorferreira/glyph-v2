//! Safe YAML loading: typed scalars into an order-preserving JSON value,
//! plus a JSON-pointer → 1-based line index recorded in the same pass.
//! Aliases, anchors and tags are refused (Rails `Psych.safe_load(aliases: false)`).

use std::borrow::Cow;
use std::collections::HashMap;

use saphyr_parser::{Event, Parser, ScalarStyle, ScanError, Span};
use serde_json::{Map, Number, Value};

#[derive(Debug, Clone, PartialEq)]
pub enum LoadError {
    Syntax { line: Option<i32>, message: String },
    AliasOrTag,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct Loaded {
    pub value: Value,
    /// JSON pointer ("/steps/0/name") → line of the key or sequence item.
    pub lines: HashMap<String, i32>,
}

/// JSON-pointer escaping so a key with "~" or "/" cannot forge a path.
pub fn escape(key: &str) -> String {
    key.replace('~', "~0").replace('/', "~1")
}

pub fn load(text: &str) -> Result<Loaded, LoadError> {
    let mut events = Vec::new();
    for item in Parser::new_from_str(text) {
        let (event, span) = item.map_err(syntax)?;
        match &event {
            Event::Alias(_) => return Err(LoadError::AliasOrTag),
            Event::Scalar(_, _, anchor, tag) if *anchor != 0 || tag.is_some() => {
                return Err(LoadError::AliasOrTag);
            }
            Event::SequenceStart(anchor, tag) | Event::MappingStart(anchor, tag)
                if *anchor != 0 || tag.is_some() =>
            {
                return Err(LoadError::AliasOrTag);
            }
            _ => {}
        }
        events.push((event, span));
    }

    let mut builder = Builder {
        events,
        at: 0,
        lines: HashMap::new(),
    };
    // StreamStart, then (optionally) one document.
    builder.skip_until_document();
    let value = if builder.peek().is_some_and(|e| !matches!(e, Event::StreamEnd)) {
        builder.node("")
    } else {
        Value::Null
    };
    Ok(Loaded {
        value,
        lines: builder.lines,
    })
}

fn syntax(error: ScanError) -> LoadError {
    LoadError::Syntax {
        line: i32::try_from(error.marker().line()).ok(),
        message: error.info().to_string(),
    }
}

struct Builder<'a> {
    events: Vec<(Event<'a>, Span)>,
    at: usize,
    lines: HashMap<String, i32>,
}

impl<'a> Builder<'a> {
    fn peek(&self) -> Option<&Event<'a>> {
        self.events.get(self.at).map(|(e, _)| e)
    }

    fn line(&self) -> i32 {
        self.events
            .get(self.at)
            .map(|(_, s)| s.start.line() as i32)
            .unwrap_or(0)
    }

    fn skip_until_document(&mut self) {
        while let Some(event) = self.peek() {
            match event {
                Event::StreamStart | Event::Nothing => self.at += 1,
                Event::DocumentStart(_) => {
                    self.at += 1;
                    return;
                }
                _ => return,
            }
        }
    }

    fn next(&mut self) -> Option<Event<'a>> {
        let event = self.events.get(self.at).map(|(e, _)| e.clone());
        self.at += 1;
        event
    }

    fn node(&mut self, pointer: &str) -> Value {
        match self.next() {
            Some(Event::Scalar(text, style, _, _)) => scalar(&text, style),
            Some(Event::SequenceStart(..)) => {
                let mut items = Vec::new();
                loop {
                    match self.peek() {
                        Some(Event::SequenceEnd) | None => {
                            self.at += 1;
                            break;
                        }
                        _ => {
                            let child = format!("{pointer}/{}", items.len());
                            self.lines.insert(child.clone(), self.line());
                            items.push(self.node(&child));
                        }
                    }
                }
                Value::Array(items)
            }
            Some(Event::MappingStart(..)) => {
                let mut map = Map::new();
                loop {
                    match self.peek() {
                        Some(Event::MappingEnd) | None => {
                            self.at += 1;
                            break;
                        }
                        _ => {
                            let line = self.line();
                            let key = match self.node("") {
                                Value::String(s) => s,
                                Value::Null => String::new(),
                                other => other.to_string(),
                            };
                            let child = format!("{pointer}/{}", escape(&key));
                            self.lines.insert(child.clone(), line);
                            let value = self.node(&child);
                            map.insert(key, value);
                        }
                    }
                }
                Value::Object(map)
            }
            _ => Value::Null,
        }
    }
}

/// YAML 1.1 core resolution for plain scalars (as Psych); quoted and block
/// scalars are always strings.
fn scalar(text: &Cow<'_, str>, style: ScalarStyle) -> Value {
    if style != ScalarStyle::Plain {
        return Value::String(text.to_string());
    }
    let t = text.as_ref();
    match t {
        "" | "~" | "null" | "Null" | "NULL" => return Value::Null,
        "true" | "True" | "TRUE" | "yes" | "Yes" | "YES" | "on" | "On" | "ON" => {
            return Value::Bool(true);
        }
        "false" | "False" | "FALSE" | "no" | "No" | "NO" | "off" | "Off" | "OFF" => {
            return Value::Bool(false);
        }
        _ => {}
    }
    if let Some(n) = integer(t) {
        return Value::Number(n);
    }
    if let Some(f) = float(t) {
        if let Some(n) = Number::from_f64(f) {
            return Value::Number(n);
        }
    }
    Value::String(t.to_string())
}

fn integer(t: &str) -> Option<Number> {
    let cleaned: String = t.chars().filter(|c| *c != '_').collect();
    let (sign, digits) = match cleaned.strip_prefix('-') {
        Some(rest) => (-1i128, rest.to_string()),
        None => (1, cleaned.strip_prefix('+').unwrap_or(&cleaned).to_string()),
    };
    if digits.is_empty() || !digits.chars().all(|c| c.is_ascii_digit()) {
        return None;
    }
    let value = sign * digits.parse::<i128>().ok()?;
    if let Ok(v) = i64::try_from(value) {
        Some(Number::from(v))
    } else {
        u64::try_from(value).ok().map(Number::from)
    }
}

fn float(t: &str) -> Option<f64> {
    let valid = {
        let body = t.strip_prefix(['-', '+']).unwrap_or(t);
        let (mantissa, exponent) = match body.find(['e', 'E']) {
            Some(i) => (&body[..i], Some(&body[i + 1..])),
            None => (body, None),
        };
        let mantissa_ok = !mantissa.is_empty()
            && mantissa.chars().filter(|c| *c == '.').count() <= 1
            && mantissa.chars().all(|c| c.is_ascii_digit() || c == '.')
            && mantissa.chars().any(|c| c.is_ascii_digit());
        let exponent_ok = exponent.is_none_or(|e| {
            let e = e.strip_prefix(['-', '+']).unwrap_or(e);
            !e.is_empty() && e.chars().all(|c| c.is_ascii_digit())
        });
        mantissa_ok && exponent_ok
    };
    if valid {
        t.parse().ok()
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn typed_scalars_and_order() {
        let loaded = load("b: 1\na: 0.5\nc: yes\nd: '42'\ne: ~\nf: text\ng: |\n  one\n  two\n").unwrap();
        assert_eq!(
            loaded.value,
            json!({"b": 1, "a": 0.5, "c": true, "d": "42", "e": null, "f": "text", "g": "one\ntwo\n"})
        );
        let keys: Vec<_> = loaded.value.as_object().unwrap().keys().cloned().collect();
        assert_eq!(keys, vec!["b", "a", "c", "d", "e", "f", "g"]);
    }

    #[test]
    fn line_index() {
        let text = "name: W\nsteps:\n  - name: A\n    prompt: x\n  - name: B\ninputs:\n  a/b~c: 1\n";
        let loaded = load(text).unwrap();
        assert_eq!(loaded.lines["/name"], 1);
        assert_eq!(loaded.lines["/steps"], 2);
        assert_eq!(loaded.lines["/steps/0"], 3);
        assert_eq!(loaded.lines["/steps/0/prompt"], 4);
        assert_eq!(loaded.lines["/steps/1/name"], 5);
        assert_eq!(loaded.lines["/inputs/a~1b~0c"], 7);
    }

    #[test]
    fn rejects_aliases_anchors_and_tags() {
        assert_eq!(
            load("name: &name W\nsteps:\n- name: *name\n").unwrap_err(),
            LoadError::AliasOrTag
        );
        assert_eq!(
            load("name: W\nsteps:\n- prompt: !ruby/object:Object {}\n").unwrap_err(),
            LoadError::AliasOrTag
        );
    }

    #[test]
    fn syntax_errors_carry_a_line() {
        let err = load("name: Broken\nsteps:\n\t- name: Research\n\t prompt: Find\n").unwrap_err();
        let LoadError::Syntax { line, .. } = err else { panic!("{err:?}") };
        assert!(line.is_some());
    }

    #[test]
    fn empty_is_null() {
        assert_eq!(load("").unwrap().value, Value::Null);
        assert_eq!(load("# only a comment\n").unwrap().value, Value::Null);
    }
}
