use std::collections::HashSet;

use serde_json::{Map, Value};

/// The catalog facts validation and snapshots need, loaded once per command.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct CatalogView {
    pub models: Vec<CatalogModel>,
    /// Every tool definition (enabled or not).
    pub tools: Vec<ToolRef>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct CatalogModel {
    pub provider: String,
    pub model_id: String,
    pub available: bool,
    pub capabilities: Map<String, Value>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ToolRef {
    pub key: String,
    pub display_name: String,
    pub pi_tool_name: String,
    pub enabled: bool,
}

impl CatalogModel {
    fn full_id(&self) -> String {
        format!("{}/{}", self.provider, self.model_id)
    }
}

impl CatalogView {
    /// Accepts the full id (`provider/model`) and the legacy bare model id.
    pub fn model_available(&self, id: &str) -> bool {
        self.models
            .iter()
            .any(|m| m.available && (m.full_id() == id || m.model_id == id))
    }

    pub fn find_model(&self, id: &str) -> Option<&CatalogModel> {
        self.models
            .iter()
            .find(|m| m.full_id() == id)
            .or_else(|| self.models.iter().find(|m| m.model_id == id))
    }

    /// Ruby truthiness of the model's capability (missing model → false).
    pub fn supports(&self, model_id: &str, capability: &str) -> bool {
        self.find_model(model_id)
            .and_then(|m| m.capabilities.get(capability))
            .is_some_and(|v| !matches!(v, Value::Null | Value::Bool(false)))
    }

    pub fn enabled_tool_keys(&self) -> HashSet<&str> {
        self.tools
            .iter()
            .filter(|t| t.enabled)
            .map(|t| t.key.as_str())
            .collect()
    }

    pub fn tool_enabled(&self, key: &str) -> bool {
        self.tools.iter().any(|t| t.enabled && t.key == key)
    }

    pub fn tool(&self, key: &str) -> Option<&ToolRef> {
        self.tools.iter().find(|t| t.key == key)
    }
}
