use tracing_subscriber::{EnvFilter, fmt, prelude::*};

/// Installs the global tracing subscriber. `RUST_LOG` controls filtering;
/// `GLYPH_LOG_JSON=true` switches to JSON lines for production.
pub fn init() {
    let filter = EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| EnvFilter::new("info,sqlx=warn,tower_http=info"));
    let json = std::env::var("GLYPH_LOG_JSON")
        .map(|v| matches!(v.trim().to_ascii_lowercase().as_str(), "1" | "true" | "yes" | "on"))
        .unwrap_or(false);

    let registry = tracing_subscriber::registry().with(filter);
    let result = if json {
        registry
            .with(fmt::layer().json().flatten_event(true))
            .try_init()
    } else {
        registry.with(fmt::layer()).try_init()
    };
    // A subscriber may already be installed (tests); that is fine.
    let _ = result;
}
