use std::net::SocketAddr;
use std::time::Duration;

use secrecy::SecretString;

#[derive(Debug, thiserror::Error)]
pub enum ConfigError {
    #[error("{0} is required")]
    Missing(&'static str),
    #[error("{name} is invalid: {reason}")]
    Invalid { name: &'static str, reason: String },
}

#[derive(Debug, Clone)]
pub struct Config {
    pub listen_addr: SocketAddr,
    pub database_url: String,
    pub database_max_connections: u32,
    pub cors_origins: Vec<String>,
    pub log_json: bool,
    /// Base64 of 32 bytes; `None` → insecure dev key (warned at boot).
    pub encryption_key: Option<SecretString>,
    pub velox_base_url: String,
    pub omniroute_base_url: String,
    pub velox_api_key: Option<SecretString>,
    pub omniroute_api_key: Option<SecretString>,
    /// Catalog staleness threshold (GLYPH_MODELS_CACHE_TTL seconds).
    pub models_cache_ttl: Duration,
    /// Runs the job worker and recurring tickers in this process.
    pub worker_enabled: bool,
}

impl Config {
    /// Reads the process environment. `.env` loading happens in `main`.
    pub fn load() -> Result<Self, ConfigError> {
        Self::from_lookup(|key| std::env::var(key).ok())
    }

    pub fn from_lookup(get: impl Fn(&str) -> Option<String>) -> Result<Self, ConfigError> {
        let var = |key: &str| get(key).filter(|v| !v.trim().is_empty());

        Ok(Self {
            listen_addr: parse(&var, "GLYPH_LISTEN_ADDR", "0.0.0.0:3000")?,
            database_url: var("DATABASE_URL").ok_or(ConfigError::Missing("DATABASE_URL"))?,
            database_max_connections: parse(&var, "GLYPH_DATABASE_MAX_CONNECTIONS", "10")?,
            cors_origins: var("GLYPH_CORS_ORIGINS")
                .unwrap_or_else(|| "http://localhost:5173".into())
                .split(',')
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .collect(),
            log_json: parse_bool(&var, "GLYPH_LOG_JSON", false)?,
            encryption_key: var("GLYPH_ENCRYPTION_KEY").map(SecretString::from),
            velox_base_url: var("VELOX_BASE_URL")
                .unwrap_or_else(|| "https://velox.josevictor.me/v1".into()),
            omniroute_base_url: var("OMNIROUTE_BASE_URL")
                .unwrap_or_else(|| "https://omniroute.josevictor.me/v1".into()),
            velox_api_key: var("VELOX_API_KEY").map(SecretString::from),
            omniroute_api_key: var("OMNIROUTE_API_KEY").map(SecretString::from),
            models_cache_ttl: Duration::from_secs(parse(&var, "GLYPH_MODELS_CACHE_TTL", "300")?),
            worker_enabled: parse_bool(&var, "GLYPH_WORKER_ENABLED", true)?,
        })
    }
}

fn parse<T>(
    var: &impl Fn(&str) -> Option<String>,
    name: &'static str,
    default: &str,
) -> Result<T, ConfigError>
where
    T: std::str::FromStr,
    T::Err: std::fmt::Display,
{
    let raw = var(name).unwrap_or_else(|| default.to_string());
    raw.trim().parse().map_err(|e: T::Err| ConfigError::Invalid {
        name,
        reason: e.to_string(),
    })
}

fn parse_bool(
    var: &impl Fn(&str) -> Option<String>,
    name: &'static str,
    default: bool,
) -> Result<bool, ConfigError> {
    match var(name).map(|v| v.trim().to_ascii_lowercase()) {
        None => Ok(default),
        Some(v) if matches!(v.as_str(), "1" | "true" | "yes" | "on") => Ok(true),
        Some(v) if matches!(v.as_str(), "0" | "false" | "no" | "off") => Ok(false),
        Some(v) => Err(ConfigError::Invalid {
            name,
            reason: format!("expected a boolean, got {v:?}"),
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn load(pairs: &[(&str, &str)]) -> Result<Config, ConfigError> {
        let map: HashMap<String, String> = pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect();
        Config::from_lookup(|k| map.get(k).cloned())
    }

    #[test]
    fn requires_database_url() {
        assert!(matches!(
            load(&[]),
            Err(ConfigError::Missing("DATABASE_URL"))
        ));
    }

    #[test]
    fn parses_defaults() {
        let config = load(&[("DATABASE_URL", "postgres://localhost/x")]).unwrap();
        assert_eq!(config.listen_addr, "0.0.0.0:3000".parse().unwrap());
        assert_eq!(config.database_max_connections, 10);
        assert_eq!(config.cors_origins, vec!["http://localhost:5173"]);
        assert!(!config.log_json);
    }

    #[test]
    fn parses_overrides() {
        let config = load(&[
            ("DATABASE_URL", "postgres://localhost/x"),
            ("GLYPH_LISTEN_ADDR", "127.0.0.1:4000"),
            ("GLYPH_CORS_ORIGINS", "http://a, http://b"),
            ("GLYPH_LOG_JSON", "true"),
        ])
        .unwrap();
        assert_eq!(config.listen_addr.port(), 4000);
        assert_eq!(config.cors_origins, vec!["http://a", "http://b"]);
        assert!(config.log_json);
    }

    #[test]
    fn rejects_bad_values() {
        assert!(load(&[("DATABASE_URL", "x"), ("GLYPH_LISTEN_ADDR", "nope")]).is_err());
        assert!(load(&[("DATABASE_URL", "x"), ("GLYPH_LOG_JSON", "maybe")]).is_err());
    }
}
