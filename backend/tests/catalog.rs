mod common;

use std::io::Write;
use std::sync::{Arc, Mutex};

use common::fakes::FakeGateway;
use glyph_backend::app::bootstrap::Overrides;
use glyph_backend::features::catalog::{ModelGateway, Provider, RefreshModels, WorkflowFlagger};
use glyph_backend::infrastructure::crypto::AesGcmCipher;
use glyph_backend::infrastructure::gateways::OpenAiCompatibleGateway;
use glyph_backend::infrastructure::postgres::PgStore;
use glyph_backend::proto::pb;
use glyph_backend::proto::pb::catalog_service_client::CatalogServiceClient;
use glyph_backend::shared::error::DomainResult;
use glyph_backend::shared::time::SystemClock;
use secrecy::SecretString;
use serde_json::json;
use sqlx::PgPool;
use wiremock::matchers::{header, method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

// --- gateways --------------------------------------------------------------

async fn gateway(provider: Provider, server: &MockServer, key: Option<&str>) -> OpenAiCompatibleGateway {
    OpenAiCompatibleGateway::new(
        provider,
        &format!("{}/v1/", server.uri()),
        key.map(|k| SecretString::from(k.to_string())),
    )
}

#[tokio::test]
async fn omniroute_normalizes_the_model_list() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/v1/models"))
        .and(header("authorization", "Bearer key"))
        .and(header("accept", "application/json"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "data": [
                { "id": "glm-4.7", "capabilities": { "temperature": true } },
                { "id": "auto/best-coding", "name": "Best", "capabilities": { "temperature": true, "tool_calling": true } },
                { "id": "" }
            ]
        })))
        .expect(1)
        .mount(&server)
        .await;

    let models = gateway(Provider::Omniroute, &server, Some("key")).await.fetch_models().await.unwrap();
    assert_eq!(models.len(), 2);
    assert_eq!(models[0].provider, Provider::Omniroute);
    assert_eq!(models[0].model_id, "glm-4.7");
    assert_eq!(models[0].display_name, "glm-4.7");
    assert_eq!(json!(models[0].capabilities), json!({ "temperature": true }));
    assert_eq!(models[1].display_name, "Best");
}

#[tokio::test]
async fn velox_ignores_names_and_capabilities() {
    let server = MockServer::start().await;
    Mock::given(path("/v1/models"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "data": [{ "id": "combo", "name": "ignored", "capabilities": { "temperature": true } }]
        })))
        .mount(&server)
        .await;
    let models = gateway(Provider::Velox, &server, Some("key")).await.fetch_models().await.unwrap();
    assert_eq!(models[0].display_name, "combo");
    assert!(models[0].capabilities.is_empty());
}

#[tokio::test]
async fn gateway_errors() {
    let server = MockServer::start().await;
    Mock::given(path("/v1/models"))
        .respond_with(ResponseTemplate::new(401).set_body_string("unauthorized"))
        .mount(&server)
        .await;
    let err = gateway(Provider::Omniroute, &server, Some("key")).await.fetch_models().await.unwrap_err();
    assert_eq!(err.0, "omniroute /models answered 401");

    let server = MockServer::start().await;
    Mock::given(path("/v1/models"))
        .respond_with(ResponseTemplate::new(200).set_body_string("not json"))
        .mount(&server)
        .await;
    let err = gateway(Provider::Omniroute, &server, Some("key")).await.fetch_models().await.unwrap_err();
    assert_eq!(err.0, "omniroute /models returned invalid JSON");

    let server = MockServer::start().await;
    Mock::given(path("/v1/models"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({ "models": [] })))
        .mount(&server)
        .await;
    let err = gateway(Provider::Velox, &server, Some("key")).await.fetch_models().await.unwrap_err();
    assert_eq!(err.0, "velox /models returned an unexpected payload");

    let err = gateway(Provider::Omniroute, &server, None).await.fetch_models().await.unwrap_err();
    assert_eq!(err.0, "OMNIROUTE_API_KEY is not configured");
    let err = gateway(Provider::Velox, &server, Some("  ")).await.fetch_models().await.unwrap_err();
    assert_eq!(err.0, "VELOX_API_KEY is not configured");
}

#[derive(Clone, Default)]
struct Buffer(Arc<Mutex<Vec<u8>>>);

impl Write for Buffer {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        self.0.lock().unwrap().extend_from_slice(buf);
        Ok(buf.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

#[tokio::test]
async fn api_key_never_reaches_trace_logs() {
    let buffer = Buffer::default();
    let writer = buffer.clone();
    let subscriber = tracing_subscriber::fmt()
        .with_max_level(tracing::Level::TRACE)
        .with_writer(move || writer.clone())
        .finish();
    let _guard = tracing::subscriber::set_default(subscriber);

    let server = MockServer::start().await;
    Mock::given(path("/v1/models"))
        .respond_with(ResponseTemplate::new(500))
        .mount(&server)
        .await;
    let secret = "sk-live-0123456789abcdef";
    let g = gateway(Provider::Omniroute, &server, Some(secret)).await;
    assert!(g.fetch_models().await.is_err());
    tracing::info!("done");

    let logs = String::from_utf8(buffer.0.lock().unwrap().clone()).unwrap();
    assert!(!logs.is_empty());
    assert!(!logs.contains(secret), "{logs}");
}

// --- refresh ---------------------------------------------------------------

#[derive(Default)]
struct RecordingFlagger(Mutex<Vec<String>>);

#[async_trait::async_trait]
impl WorkflowFlagger for RecordingFlagger {
    async fn flag_workflows_using_models(&self, ids: &[String]) -> DomainResult<usize> {
        self.0.lock().unwrap().extend_from_slice(ids);
        Ok(0)
    }
}

fn refresher(pool: &PgPool, gateway: Arc<FakeGateway>, flagger: Arc<RecordingFlagger>) -> RefreshModels {
    RefreshModels::new(
        Arc::new(PgStore::new(pool.clone(), Arc::new(AesGcmCipher::dev()))),
        vec![gateway as Arc<dyn ModelGateway>],
        flagger,
        Arc::new(SystemClock),
    )
}

async fn availability(pool: &PgPool, provider: &str, id: &str) -> Option<bool> {
    sqlx::query_scalar("SELECT available FROM available_models WHERE provider = $1 AND model_id = $2")
        .bind(provider)
        .bind(id)
        .fetch_optional(pool)
        .await
        .unwrap()
}

#[sqlx::test(migrator = "glyph_backend::infrastructure::postgres::migrate::MIGRATOR")]
async fn refresh_upserts_and_marks_vanished_unavailable(pool: PgPool) {
    sqlx::query("INSERT INTO available_models (provider, model_id, available) VALUES ('omniroute', 'old-model', true), ('velox', 'velox-model', true)")
        .execute(&pool)
        .await
        .unwrap();
    let gateway = Arc::new(FakeGateway::new(Provider::Omniroute, &["new-model"]));
    let flagger = Arc::new(RecordingFlagger::default());
    let result = refresher(&pool, gateway.clone(), flagger.clone())
        .refresh(gateway.as_ref())
        .await
        .unwrap();

    assert!(result.refreshed);
    assert_eq!(result.count, 1);
    assert_eq!(result.became_unavailable, vec!["old-model"]);
    assert_eq!(availability(&pool, "omniroute", "new-model").await, Some(true));
    assert_eq!(availability(&pool, "omniroute", "old-model").await, Some(false));
    // Other providers untouched.
    assert_eq!(availability(&pool, "velox", "velox-model").await, Some(true));
    // Both id shapes flagged.
    assert_eq!(*flagger.0.lock().unwrap(), vec!["old-model", "omniroute/old-model"]);

    let (event_type, data): (String, serde_json::Value) = sqlx::query_as(
        "SELECT event_type, data FROM events WHERE stream = 'Omniroute$models' ORDER BY id DESC LIMIT 1",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(event_type, "ModelsRefreshed");
    assert_eq!(data["model_count"], 1);
    assert_eq!(data["unavailable_model_ids"], json!(["old-model"]));
}

#[sqlx::test(migrator = "glyph_backend::infrastructure::postgres::migrate::MIGRATOR")]
async fn refresh_failure_leaves_the_db_untouched(pool: PgPool) {
    sqlx::query("INSERT INTO available_models (provider, model_id, available) VALUES ('omniroute', 'kept', true)")
        .execute(&pool)
        .await
        .unwrap();
    let gateway = Arc::new(FakeGateway::new(Provider::Omniroute, &[]));
    gateway.fail("boom");
    let result = refresher(&pool, gateway.clone(), Arc::default())
        .refresh(gateway.as_ref())
        .await
        .unwrap();
    assert!(!result.refreshed);
    assert_eq!(result.error.as_deref(), Some("boom"));
    assert_eq!(availability(&pool, "omniroute", "kept").await, Some(true));
    let events: i64 = sqlx::query_scalar("SELECT count(*) FROM events").fetch_one(&pool).await.unwrap();
    assert_eq!(events, 0);
}

// --- gRPC ------------------------------------------------------------------

#[sqlx::test(migrator = "glyph_backend::infrastructure::postgres::migrate::MIGRATOR")]
async fn catalog_service(pool: PgPool) {
    let velox = Arc::new(FakeGateway::new(Provider::Velox, &["zeta", "alpha"]));
    let omni = Arc::new(FakeGateway::new(Provider::Omniroute, &["beta"]));
    let server = common::spawn_with(
        pool,
        common::test_config(),
        Overrides {
            gateways: Some(vec![velox.clone(), omni.clone()]),
            ..Overrides::default()
        },
    )
    .await;
    let mut client = CatalogServiceClient::new(server.channel().await);

    let tools = client.list_tools(pb::ListToolsRequest {}).await.unwrap().into_inner().tools;
    let keys: Vec<_> = tools.iter().map(|t| t.key.as_str()).collect();
    assert_eq!(keys, vec!["bash", "edit", "read", "write"]);
    assert!(tools.iter().all(|t| t.enabled && t.pi_tool_name == t.key));

    let empty = client
        .list_models(pb::ListModelsRequest { include_unavailable: false })
        .await
        .unwrap()
        .into_inner();
    assert!(empty.models.is_empty());
    assert!(empty.stale);

    let refreshed = client.refresh_models(pb::RefreshModelsRequest {}).await.unwrap().into_inner();
    assert_eq!(refreshed.results.len(), 2);
    assert!(refreshed.results.iter().all(|r| r.refreshed));

    let list = client
        .list_models(pb::ListModelsRequest { include_unavailable: false })
        .await
        .unwrap()
        .into_inner();
    assert!(!list.stale);
    let ids: Vec<_> = list.models.iter().map(|m| m.full_id.as_str()).collect();
    assert_eq!(ids, vec!["velox/alpha", "velox/zeta", "omniroute/beta"]);
    assert_eq!(list.models[2].capabilities.get("temperature"), Some(&true));

    // Vanished models are hidden unless asked for.
    velox.set(&["alpha"]);
    client.refresh_models(pb::RefreshModelsRequest {}).await.unwrap();
    let list = client
        .list_models(pb::ListModelsRequest { include_unavailable: false })
        .await
        .unwrap()
        .into_inner();
    assert_eq!(list.models.len(), 2);
    let all = client
        .list_models(pb::ListModelsRequest { include_unavailable: true })
        .await
        .unwrap()
        .into_inner();
    assert_eq!(all.models.len(), 3);
    assert!(!all.models.iter().find(|m| m.model_id == "zeta").unwrap().available);

    // Provider errors are reported, not fatal.
    omni.fail("OMNIROUTE_API_KEY is not configured");
    let refreshed = client.refresh_models(pb::RefreshModelsRequest {}).await.unwrap().into_inner();
    let failed = refreshed.results.iter().find(|r| r.provider == "omniroute").unwrap();
    assert!(!failed.refreshed);
    assert_eq!(failed.error.as_deref(), Some("OMNIROUTE_API_KEY is not configured"));
}
