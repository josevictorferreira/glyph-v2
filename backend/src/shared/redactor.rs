//! Removes secret values and token shapes from any text before it is
//! persisted, logged, published or rendered (Rails `Execution::Redactor`).

use std::sync::LazyLock;

use regex::Regex;

pub const REPLACEMENT: &str = "[redacted]";

static TOKEN_PATTERNS: LazyLock<[Regex; 2]> = LazyLock::new(|| {
    [
        Regex::new(r"sk-[A-Za-z0-9][A-Za-z0-9_\-]{8,}").unwrap(),
        Regex::new(r"(?i)Bearer\s+[A-Za-z0-9][A-Za-z0-9._\-]{8,}").unwrap(),
    ]
});

#[derive(Debug, Clone, Default)]
pub struct Redactor {
    /// Non-blank secret values, longest first so overlaps redact fully.
    secrets: Vec<String>,
}

impl Redactor {
    pub fn new(secrets: impl IntoIterator<Item = String>) -> Self {
        let mut secrets: Vec<String> = secrets
            .into_iter()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .collect();
        secrets.sort_by_key(|s| std::cmp::Reverse(s.len()));
        secrets.dedup();
        Self { secrets }
    }

    pub fn redact(&self, text: &str) -> String {
        if text.is_empty() {
            return String::new();
        }
        let mut out = text.to_string();
        for secret in &self.secrets {
            if out.contains(secret.as_str()) {
                out = out.replace(secret.as_str(), REPLACEMENT);
            }
        }
        for pattern in TOKEN_PATTERNS.iter() {
            out = pattern.replace_all(&out, REPLACEMENT).into_owned();
        }
        out
    }

    pub fn redact_opt(&self, text: Option<&str>) -> Option<String> {
        text.map(|t| self.redact(t))
    }
}

/// The password component of a `postgres://user:password@host/db` URL.
pub fn database_password(url: &str) -> Option<String> {
    let rest = url.split_once("://")?.1;
    let userinfo = rest.split_once('@')?.0;
    let password = userinfo.split_once(':')?.1;
    (!password.is_empty()).then(|| password.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redacts_secret_values() {
        let r = Redactor::new([
            "super-secret-test-key-123".to_string(),
            "velox-secret-key-456".into(),
            "  ".into(),
        ]);
        assert_eq!(
            r.redact("the key is super-secret-test-key-123 ok"),
            "the key is [redacted] ok"
        );
        assert_eq!(
            r.redact("leaked velox-secret-key-456 here"),
            "leaked [redacted] here"
        );
    }

    #[test]
    fn redacts_token_shapes() {
        let r = Redactor::default();
        assert_eq!(r.redact("sk-abc123def456ghi789"), "[redacted]");
        assert_eq!(
            r.redact("Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload"),
            "Authorization: [redacted]"
        );
    }

    #[test]
    fn leaves_ordinary_text_alone() {
        let r = Redactor::new(["secret".to_string()]);
        assert_eq!(r.redact("a normal sentence"), "a normal sentence");
        assert_eq!(r.redact(""), "");
        assert_eq!(r.redact_opt(None), None);
        let input = String::from("secret");
        let _ = r.redact(&input);
        assert_eq!(input, "secret", "input is not mutated");
    }

    #[test]
    fn database_url_password() {
        assert_eq!(
            database_password("postgres://u:p%40ss@h:5432/db").as_deref(),
            Some("p%40ss")
        );
        assert_eq!(database_password("postgres://u@h/db"), None);
        assert_eq!(database_password("postgres://u:@h/db"), None);
    }
}
