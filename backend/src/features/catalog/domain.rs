use std::fmt;

use serde_json::{Map, Value};

use crate::shared::time::Timestamp;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Provider {
    Velox,
    Omniroute,
}

impl Provider {
    pub const ALL: [Self; 2] = [Self::Velox, Self::Omniroute];
    pub const DEFAULT: Self = Self::Velox;

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Velox => "velox",
            Self::Omniroute => "omniroute",
        }
    }

    pub fn parse(raw: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|p| p.as_str() == raw)
    }

    /// Environment variable holding the provider's API key.
    pub fn api_key_var(self) -> &'static str {
        match self {
            Self::Velox => "VELOX_API_KEY",
            Self::Omniroute => "OMNIROUTE_API_KEY",
        }
    }

    /// Event stream name, e.g. `Velox$models`.
    pub fn models_stream(self) -> String {
        let name = self.as_str();
        let mut chars = name.chars();
        let capitalized: String = chars
            .next()
            .map(|c| c.to_ascii_uppercase())
            .into_iter()
            .chain(chars)
            .collect();
        format!("{capitalized}$models")
    }
}

impl fmt::Display for Provider {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// A model as listed by a provider's `/models` endpoint.
#[derive(Debug, Clone, PartialEq)]
pub struct FetchedModel {
    pub provider: Provider,
    pub model_id: String,
    pub display_name: String,
    pub capabilities: Map<String, Value>,
    pub raw: Value,
}

#[derive(Debug, Clone, PartialEq)]
pub struct AvailableModel {
    pub provider: String,
    pub model_id: String,
    pub display_name: Option<String>,
    pub available: bool,
    pub capabilities: Map<String, Value>,
    pub fetched_at: Option<Timestamp>,
}

impl AvailableModel {
    pub fn full_id(&self) -> String {
        full_id(&self.provider, &self.model_id)
    }

    /// Capabilities by truthiness (Ruby semantics: only nil/false are falsy).
    pub fn capability(&self, key: &str) -> bool {
        truthy(self.capabilities.get(key))
    }
}

pub fn full_id(provider: &str, model_id: &str) -> String {
    format!("{provider}/{model_id}")
}

pub fn truthy(value: Option<&Value>) -> bool {
    !matches!(value, None | Some(Value::Null) | Some(Value::Bool(false)))
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ToolDefinition {
    pub key: String,
    pub display_name: String,
    pub description: Option<String>,
    pub pi_tool_name: String,
    pub enabled: bool,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn provider_names() {
        assert_eq!(Provider::parse("omniroute"), Some(Provider::Omniroute));
        assert_eq!(Provider::Velox.models_stream(), "Velox$models");
        assert_eq!(Provider::Omniroute.api_key_var(), "OMNIROUTE_API_KEY");
    }

    #[test]
    fn capability_truthiness() {
        let mut model = AvailableModel {
            provider: "omniroute".into(),
            model_id: "m".into(),
            display_name: None,
            available: true,
            capabilities: Map::new(),
            fetched_at: None,
        };
        assert!(!model.capability("temperature"));
        model.capabilities.insert("temperature".into(), json!(true));
        assert!(model.capability("temperature"));
        model.capabilities.insert("temperature".into(), json!(false));
        assert!(!model.capability("temperature"));
        assert_eq!(model.full_id(), "omniroute/m");
    }
}
