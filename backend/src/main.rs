use glyph_backend::{app::bootstrap, config::Config, infrastructure::telemetry};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    dotenvy::dotenv().ok();
    telemetry::init();
    let config = Config::load()?;
    bootstrap::build(&config).await?.run().await
}
