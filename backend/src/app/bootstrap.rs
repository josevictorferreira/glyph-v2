use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

use anyhow::Context;
use async_trait::async_trait;
use axum::Router;
use secrecy::ExposeSecret;
use sqlx::PgPool;
use tokio::net::TcpListener;
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;
use tonic::service::Routes;
use tonic_web::GrpcWebLayer;

use crate::app::{router, state::AppState};
use crate::config::{Config, StepRunnerKind};
use crate::features::catalog::grpc::CatalogGrpc;
use crate::features::catalog::{
    CatalogStore, ListModels, ModelGateway, Provider, RefreshModels, WorkflowFlagger,
};
use crate::features::definition::DefinitionService;
use crate::features::definition::grpc::DefinitionGrpc;
use crate::features::live::grpc::LiveGrpc;
use crate::features::runs::{self, RunService, StepRunner};
use crate::features::runs::grpc::RunGrpc;
use crate::features::workflows::WorkflowService;
use crate::features::workflows::grpc::WorkflowGrpc;
use crate::infrastructure::crypto::{AesGcmCipher, Cipher};
use crate::infrastructure::fake_runner::FakeStepRunner;
use crate::infrastructure::gateways::OpenAiCompatibleGateway;
use crate::features::scheduling::{DISPATCH_DUE, DispatchDueWorkflows, SCHEDULING_QUEUE};
use crate::infrastructure::jobs::recurring::{self, Recurring};
use crate::infrastructure::jobs::worker::Worker;
use crate::infrastructure::pi::runner::{PiConfig, PiStepRunner};
use crate::shared::redactor::Redactor;
use crate::infrastructure::postgres::{self, PgStore};
use crate::proto;
use crate::proto::pb::catalog_service_server::CatalogServiceServer;
use crate::proto::pb::definition_service_server::DefinitionServiceServer;
use crate::proto::pb::live_service_server::LiveServiceServer;
use crate::proto::pb::run_service_server::RunServiceServer;
use crate::proto::pb::workflow_service_server::WorkflowServiceServer;
use crate::shared::error::DomainResult;
use crate::shared::time::{Clock, SystemClock};

/// Adapters that tests replace. `None` → the production adapter from config.
#[derive(Default, Clone)]
pub struct Overrides {
    pub clock: Option<Arc<dyn Clock>>,
    pub gateways: Option<Vec<Arc<dyn ModelGateway>>>,
    pub step_runner: Option<Arc<dyn StepRunner>>,
    /// Start background tasks even when `worker_enabled` is false.
    pub background: Option<bool>,
}

pub struct App {
    router: Router,
    listen_addr: SocketAddr,
    stop: CancellationToken,
    background: Vec<JoinHandle<()>>,
}

pub async fn build(config: &Config) -> anyhow::Result<App> {
    let pool = postgres::pool::connect(config)
        .await
        .context("connecting to the database")?;
    build_with(config, pool, Overrides::default()).await
}

pub async fn build_with_pool(config: &Config, pool: PgPool) -> anyhow::Result<App> {
    build_with(config, pool, Overrides::default()).await
}

pub const REFRESH_MODELS: &str = "refresh_models";
pub const MAINTENANCE_QUEUE: &str = "maintenance";

/// Catalog → workflows: vanished models flag active workflows.
struct WorkflowsFlagger(WorkflowService);

#[async_trait]
impl WorkflowFlagger for WorkflowsFlagger {
    async fn flag_workflows_using_models(&self, model_ids: &[String]) -> DomainResult<usize> {
        self.0.flag_workflows_using_models(model_ids).await
    }
}

pub fn redactor(config: &Config) -> Redactor {
    Redactor::new(config.secret_values.iter().map(|s| s.expose_secret().to_string()))
}

/// Composition root: the only place that names concrete adapters.
pub async fn build_with(config: &Config, pool: PgPool, overrides: Overrides) -> anyhow::Result<App> {
    postgres::migrate::run(&pool)
        .await
        .context("running migrations")?;

    let cipher: Arc<dyn Cipher> = Arc::new(
        AesGcmCipher::from_config(config.encryption_key.as_ref().map(|k| k.expose_secret()))
            .map_err(anyhow::Error::msg)?,
    );
    let clock: Arc<dyn Clock> = overrides.clock.clone().unwrap_or_else(|| Arc::new(SystemClock));
    let store = PgStore::new(pool.clone(), cipher.clone());

    // --- workflows ---------------------------------------------------------
    let workflows = WorkflowService::new(
        Arc::new(store.clone()),
        Arc::new(store.clone()),
        clock.clone(),
    );

    let definitions = DefinitionService::new(
        Arc::new(store.clone()),
        Arc::new(store.clone()),
        clock.clone(),
        config.public_url.clone(),
    );

    // --- catalog -----------------------------------------------------------
    let gateways = overrides.gateways.clone().unwrap_or_else(|| {
        vec![
            Arc::new(OpenAiCompatibleGateway::new(
                Provider::Velox,
                &config.velox_base_url,
                config.velox_api_key.clone(),
            )) as Arc<dyn ModelGateway>,
            Arc::new(OpenAiCompatibleGateway::new(
                Provider::Omniroute,
                &config.omniroute_base_url,
                config.omniroute_api_key.clone(),
            )),
        ]
    });
    let catalog_store: Arc<dyn CatalogStore> = Arc::new(store.clone());
    let list_models = ListModels::new(
        catalog_store.clone(),
        clock.clone(),
        chrono::Duration::from_std(config.models_cache_ttl)?,
    );
    let refresh_models = RefreshModels::new(
        catalog_store,
        gateways,
        Arc::new(WorkflowsFlagger(workflows.clone())),
        clock.clone(),
    );

    // --- runs --------------------------------------------------------------
    let step_runner: Arc<dyn StepRunner> = match overrides.step_runner.clone() {
        Some(runner) => runner,
        None => match config.step_runner {
            StepRunnerKind::Fake => Arc::new(FakeStepRunner),
            StepRunnerKind::Pi => Arc::new(PiStepRunner::new(
                PiConfig {
                    pi_bin: config.pi_bin.clone(),
                    timeout: config.pi_timeout,
                    velox_base_url: config.velox_base_url.clone(),
                    omniroute_base_url: config.omniroute_base_url.clone(),
                    velox_api_key: config.velox_api_key.clone(),
                    omniroute_api_key: config.omniroute_api_key.clone(),
                },
                Arc::new(store.clone()),
                redactor(config),
            )),
        },
    };
    let runs = RunService::new(
        Arc::new(store.clone()),
        Arc::new(store.clone()),
        step_runner,
        clock.clone(),
    );

    // --- transport ---------------------------------------------------------
    let state = AppState {
        pool: pool.clone(),
        cipher,
        runs: runs.clone(),
    };
    let (_health_reporter, health_service) = tonic_health::server::health_reporter();
    let reflection = tonic_reflection::server::Builder::configure()
        .register_encoded_file_descriptor_set(proto::FILE_DESCRIPTOR_SET)
        .register_encoded_file_descriptor_set(tonic_health::pb::FILE_DESCRIPTOR_SET)
        .build_v1()
        .context("building gRPC reflection")?;
    let grpc = Routes::new(health_service)
        .add_service(reflection)
        .add_service(CatalogServiceServer::new(CatalogGrpc::new(
            list_models,
            refresh_models.clone(),
        )))
        .add_service(WorkflowServiceServer::new(WorkflowGrpc::new(workflows.clone())))
        .add_service(DefinitionServiceServer::new(DefinitionGrpc::new(definitions)))
        .add_service(RunServiceServer::new(RunGrpc::new(runs.clone())))
        .add_service(LiveServiceServer::new(LiveGrpc))
        .prepare()
        .into_axum_router()
        .layer(GrpcWebLayer::new());

    // --- background --------------------------------------------------------
    let scheduling = DispatchDueWorkflows::new(Arc::new(store.clone()), runs.clone());
    let stop = CancellationToken::new();
    let mut background = Vec::new();
    if overrides.background.unwrap_or(config.worker_enabled) {
        let worker = worker(pool.clone(), config, &runs)
            .queue(SCHEDULING_QUEUE, 1)
            .queue(MAINTENANCE_QUEUE, 1)
            .handle(DISPATCH_DUE, {
                let (scheduling, clock) = (scheduling.clone(), clock.clone());
                move |_| {
                    let (scheduling, clock) = (scheduling.clone(), clock.clone());
                    async move {
                        let dispatched = scheduling.dispatch(clock.now()).await?;
                        if dispatched > 0 {
                            tracing::info!(dispatched, "scheduled runs created");
                        }
                        Ok(())
                    }
                }
            })
            .handle(REFRESH_MODELS, {
                let refresh = refresh_models.clone();
                move |_| {
                    let refresh = refresh.clone();
                    async move {
                        refresh.refresh_all().await;
                        Ok(())
                    }
                }
            });
        background.push(worker.spawn(stop.clone(), config.shutdown_grace));
        background.push(recurring::spawn(
            pool.clone(),
            Recurring {
                kind: REFRESH_MODELS.into(),
                queue: MAINTENANCE_QUEUE.into(),
                every: Duration::from_secs(5 * 60),
            },
            stop.clone(),
        ));
        if config.scheduler_enabled {
            background.push(recurring::spawn(
                pool.clone(),
                Recurring {
                    kind: DISPATCH_DUE.into(),
                    queue: SCHEDULING_QUEUE.into(),
                    every: Duration::from_secs(60),
                },
                stop.clone(),
            ));
        }
    }

    Ok(App {
        router: router::build(state, grpc, router::cors(&config.cors_origins)),
        listen_addr: config.listen_addr,
        stop,
        background,
    })
}

fn id_from<T: std::str::FromStr>(payload: &serde_json::Value, key: &str) -> anyhow::Result<T> {
    payload
        .get(key)
        .and_then(|v| v.as_str())
        .and_then(|v| v.parse().ok())
        .with_context(|| format!("job payload has no valid {key}"))
}

/// Job kinds → application operations.
fn worker(pool: PgPool, config: &Config, runs: &RunService) -> Worker {
    let (run_exec, step_exec) = (runs.clone(), runs.clone());
    Worker::new(pool)
        .queue(runs::application::RUN_QUEUE, 2)
        .queue(runs::application::STEP_QUEUE, config.step_concurrency)
        .handle(runs::application::EXECUTE_RUN, move |payload| {
            let runs = run_exec.clone();
            async move { Ok(runs.execute_run(id_from(&payload, "run_id")?).await?) }
        })
        .handle(runs::application::EXECUTE_STEP, move |payload| {
            let runs = step_exec.clone();
            async move { Ok(runs.execute_step(id_from(&payload, "step_run_id")?).await?) }
        })
}

impl App {
    pub fn router(&self) -> Router {
        self.router.clone()
    }

    /// Stops background tasks (tests drop the app without serving).
    pub async fn shutdown(self) {
        self.stop.cancel();
        for handle in self.background {
            let _ = handle.await;
        }
    }

    pub async fn run(self) -> anyhow::Result<()> {
        let listener = TcpListener::bind(self.listen_addr)
            .await
            .with_context(|| format!("binding {}", self.listen_addr))?;
        tracing::info!(addr = %listener.local_addr()?, "listening");
        let result = serve(listener, self.router, shutdown_signal()).await;
        self.stop.cancel();
        for handle in self.background {
            let _ = handle.await;
        }
        result
    }
}

pub async fn serve(
    listener: TcpListener,
    router: Router,
    shutdown: impl Future<Output = ()> + Send + 'static,
) -> anyhow::Result<()> {
    let (drained_tx, drained_rx) = tokio::sync::oneshot::channel::<()>();
    let signal = async move {
        shutdown.await;
        tracing::info!("shutting down");
        let _ = drained_tx.send(());
    };
    let server = axum::serve(listener, router).with_graceful_shutdown(signal);
    let mut server = tokio::spawn(async move { server.await });

    // Graceful drain is capped: in-flight requests get 10s after the signal.
    tokio::select! {
        result = &mut server => result??,
        _ = async {
            let _ = drained_rx.await;
            tokio::time::sleep(Duration::from_secs(10)).await;
        } => {
            tracing::warn!("in-flight requests did not drain within 10s; aborting");
            server.abort();
        }
    }
    Ok(())
}

pub async fn shutdown_signal() {
    let ctrl_c = async {
        let _ = tokio::signal::ctrl_c().await;
    };
    #[cfg(unix)]
    let terminate = async {
        match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
            Ok(mut sig) => {
                sig.recv().await;
            }
            Err(_) => std::future::pending::<()>().await,
        }
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();
    tokio::select! {
        _ = ctrl_c => {},
        _ = terminate => {},
    }
}
