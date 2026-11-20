//! Shared Pi child-process plumbing (spec 0024, task 4.4): provider
//! resolution, `models.json`, the env allow-list and termination. Safety
//! rules live here once for every Pi invocation (steps and chat turns).
use std::path::Path;
use std::process::Stdio;
use std::time::Duration;

use secrecy::{ExposeSecret, SecretString};
use serde_json::json;
use tokio::process::{Child, Command};

use crate::features::catalog::Provider;

/// Pi's fallback output budget (16k) is exhausted by reasoning models.
pub const PI_MAX_OUTPUT_TOKENS: u32 = 131_072;
pub const KILL_GRACE: Duration = Duration::from_secs(3);

/// `provider/model` as Pi expects it on the command line.
pub struct Target {
    pub provider: String,
    pub model: String,
}

/// `provider/model` → the pair; bare → catalog lookup by model id else the
/// default provider (velox). A missing catalog never blocks: the default
/// provider is used.
pub fn target(
    model_id: &str,
    view: Option<&crate::features::workflows::CatalogView>,
) -> Target {
    match model_id.split_once('/') {
        Some((provider, model)) => Target {
            provider: provider.to_string(),
            model: model.to_string(),
        },
        None => Target {
            provider: view
                .and_then(|v| v.models.iter().find(|m| m.model_id == model_id))
                .map(|m| m.provider.clone())
                .unwrap_or_else(|| Provider::DEFAULT.as_str().to_string()),
            model: model_id.to_string(),
        },
    }
}

/// The gateway base URL and API key a provider must have configured.
pub fn provider_settings(
    provider: &str,
    velox_base_url: &str,
    velox_api_key: &Option<SecretString>,
) -> Result<(String, String), String> {
    let (base, key) = match Provider::parse(provider) {
        Some(Provider::Velox) => (velox_base_url, velox_api_key),
        None => {
            return Err(format!(
                "{}_API_KEY is not configured",
                provider.to_uppercase()
            ));
        }
    };
    let key = key
        .as_ref()
        .map(|k| k.expose_secret().trim().to_string())
        .filter(|k| !k.is_empty())
        .ok_or_else(|| format!("{}_API_KEY is not configured", provider.to_uppercase()))?;
    Ok((base.to_string(), key))
}

/// Writes `<agent_dir>/models.json` pointing Pi at one model.
pub fn write_models_json(
    agent_dir: &Path,
    target: &Target,
    base_url: &str,
) -> Result<(), String> {
    let models = json!({
        "providers": {
            target.provider.clone(): {
                "api": "openai-completions",
                "apiKey": "supplied-via-cli-flag",
                "baseUrl": base_url,
                "models": [{ "id": target.model, "name": target.model, "maxTokens": PI_MAX_OUTPUT_TOKENS }],
            }
        }
    });
    std::fs::write(
        agent_dir.join("models.json"),
        serde_json::to_vec_pretty(&models).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())
}

/// The env allow-list: a throwaway HOME, PATH, TZ and CA bundles only when
/// set (an empty value breaks TLS defaults).
pub fn child_env(home: &Path) -> Vec<(String, String)> {
    let mut env = vec![
        ("HOME".to_string(), home.display().to_string()),
        (
            "PATH".to_string(),
            std::env::var("PATH").unwrap_or_default(),
        ),
        (
            "TZ".to_string(),
            std::env::var("TZ")
                .ok()
                .filter(|v| !v.is_empty())
                .unwrap_or_else(|| "UTC".into()),
        ),
    ];
    for key in ["SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS"] {
        if let Ok(v) = std::env::var(key)
            && !v.is_empty()
        {
            env.push((key.to_string(), v));
        }
    }
    env
}

/// Spawns Pi with argv only (never a shell), `env_clear()` plus the
/// allow-list and any caller-supplied extras, stdin closed and pipes
/// captured.
pub fn spawn(
    pi_bin: &str,
    args: &[String],
    home: &Path,
    work: &Path,
    extra_env: &[(String, String)],
) -> Result<Child, String> {
    Command::new(pi_bin)
        .args(args)
        .env_clear()
        .envs(child_env(home).into_iter().chain(extra_env.to_vec()))
        .current_dir(work)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| format!("spawning {pi_bin}: {e}"))
}

/// SIGTERM, then SIGKILL if the process is still alive after the grace.
pub async fn terminate(child: &mut Child) {
    if let Some(pid) = child.id() {
        let _ = nix::sys::signal::kill(
            nix::unistd::Pid::from_raw(pid as i32),
            nix::sys::signal::Signal::SIGTERM,
        );
    }
    if tokio::time::timeout(KILL_GRACE, child.wait())
        .await
        .is_err()
    {
        let _ = child.kill().await;
    }
}
