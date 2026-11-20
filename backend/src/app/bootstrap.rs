use std::net::SocketAddr;
use std::sync::{Arc, OnceLock};
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
use crate::features::chat::grpc::ChatGrpc;
use crate::features::chat::ChatService;
use crate::features::chat::ports::{ChatPublisher, ChatRunner};
use crate::features::catalog::{
    CatalogStore, ListModels, ModelGateway, Provider, RefreshModels, WorkflowFlagger,
};
use crate::features::definition::DefinitionService;
use crate::features::definition::grpc::DefinitionGrpc;
use crate::features::live::grpc::LiveGrpc;
use crate::features::runs::grpc::RunGrpc;
use crate::features::runs::{self, RunService, StepRunner};
use crate::features::scheduling::{DISPATCH_DUE, DispatchDueWorkflows, SCHEDULING_QUEUE};
use crate::features::settings::SettingsService;
use crate::features::settings::grpc::SettingsGrpc;
use crate::features::workflows::WorkflowService;
use crate::features::workflows::grpc::WorkflowGrpc;
use crate::infrastructure::crypto::{AesGcmCipher, Cipher};
use crate::infrastructure::fake_chat_runner::FakeChatRunner;
use crate::infrastructure::fake_runner::FakeStepRunner;
use crate::infrastructure::gateways::OpenAiCompatibleGateway;
use crate::infrastructure::jobs::recovery::{self, Recovery};
use crate::infrastructure::jobs::recurring::{self, Recurring};
use crate::infrastructure::jobs::worker::Worker;
use crate::infrastructure::pi::runner::{PiConfig, PiStepRunner};
use crate::infrastructure::postgres::listener::{self, ChatHub, LiveHub};
use crate::infrastructure::postgres::{self, PgStore};
use crate::proto;
use crate::proto::pb::catalog_service_server::CatalogServiceServer;
use crate::proto::pb::chat_service_server::ChatServiceServer;
use crate::proto::pb::definition_service_server::DefinitionServiceServer;
use crate::proto::pb::live_service_server::LiveServiceServer;
use crate::proto::pb::run_service_server::RunServiceServer;
use crate::proto::pb::settings_service_server::SettingsServiceServer;
use crate::proto::pb::workflow_service_server::WorkflowServiceServer;
use crate::shared::error::DomainResult;
use crate::shared::redactor::Redactor;
use crate::shared::time::{Clock, SystemClock};

/// Adapters that tests replace. `None` → the production adapter from config.
#[derive(Default, Clone)]
pub struct Overrides {
    pub clock: Option<Arc<dyn Clock>>,
    pub gateways: Option<Vec<Arc<dyn ModelGateway>>>,
    pub step_runner: Option<Arc<dyn StepRunner>>,
    pub chat_runner: Option<Arc<dyn ChatRunner>>,
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
    Redactor::new(
        config
            .secret_values
            .iter()
            .map(|s| s.expose_secret().to_string()),
    )
}

/// Composition root: the only place that names concrete adapters.
pub async fn build_with(
    config: &Config,
    pool: PgPool,
    overrides: Overrides,
) -> anyhow::Result<App> {
    postgres::migrate::run(&pool)
        .await
        .context("running migrations")?;

    let cipher: Arc<dyn Cipher> = Arc::new(
        AesGcmCipher::from_config(config.encryption_key.as_ref().map(|k| k.expose_secret()))
            .map_err(anyhow::Error::msg)?,
    );
    let clock: Arc<dyn Clock> = overrides
        .clock
        .clone()
        .unwrap_or_else(|| Arc::new(SystemClock));
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
        vec![Arc::new(OpenAiCompatibleGateway::new(
            Provider::Velox,
            &config.velox_base_url,
            config.velox_api_key.clone(),
        )) as Arc<dyn ModelGateway>]
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

    // --- chat --------------------------------------------------------------
    let settings = SettingsService::new(
        Arc::new(store.clone()),
        Arc::new(list_models.clone()),
        clock.clone(),
    );
    // --- chat --------------------------------------------------------------
    let chat = ChatService::new(Arc::new(store.clone()), settings.clone(), clock.clone());
    // The default fake carries a slot `FAKE_TOOL:` markers use to call the
    // agent routes; bootstrap fills it once the router exists (the runner
    // is behind an `Arc` before then).
    let default_chat_runner = || {
        let runner = FakeChatRunner::new();
        let slot = runner.router_slot();
        (Arc::new(runner) as Arc<dyn ChatRunner>, slot)
    };
    let (chat_runner, agent_router_slot): (Arc<dyn ChatRunner>, _) = match overrides
        .chat_runner
        .clone()
    {
        Some(runner) => (runner, Arc::new(OnceLock::new())),
        None => match config.step_runner {
            // The real Pi chat runner arrives with phase 5; until then the
            // deterministic runner stands in so wiring is exercised.
            StepRunnerKind::Fake => default_chat_runner(),
            StepRunnerKind::Pi => default_chat_runner(),
        },
    };
    let chat_publisher: Arc<dyn ChatPublisher> = Arc::new(store.clone());

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
                    velox_api_key: config.velox_api_key.clone(),
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

    // --- live --------------------------------------------------------------
    let stop = CancellationToken::new();
    let hub = LiveHub::new(listener::CAPACITY);
    let chat_hub = ChatHub::new(listener::CAPACITY);
    let mut background = vec![
        hub.clone().spawn_listener(pool.clone(), stop.clone()),
        chat_hub.clone().spawn_listener(pool.clone(), stop.clone()),
    ];

    // --- transport ---------------------------------------------------------
    let state = AppState {
        pool: pool.clone(),
        cipher,
        runs: runs.clone(),
    };
    let (health_reporter, health_service) = tonic_health::server::health_reporter();
    background.push(tokio::spawn({
        let stop = stop.clone();
        async move {
            stop.cancelled().await;
            health_reporter
                .set_service_status("", tonic_health::ServingStatus::NotServing)
                .await;
        }
    }));
    let reflection = tonic_reflection::server::Builder::configure()
        .register_encoded_file_descriptor_set(proto::FILE_DESCRIPTOR_SET)
        .register_encoded_file_descriptor_set(tonic_health::pb::FILE_DESCRIPTOR_SET)
        .build_v1()
        .context("building gRPC reflection")?;
    let grpc = Routes::new(health_service)
        .add_service(reflection)
        .add_service(CatalogServiceServer::new(CatalogGrpc::new(
            list_models.clone(),
            refresh_models.clone(),
        )))
        .add_service(WorkflowServiceServer::new(WorkflowGrpc::new(
            workflows.clone(),
        )))
        .add_service(DefinitionServiceServer::new(DefinitionGrpc::new(
            definitions.clone(),
        )))
        .add_service(RunServiceServer::new(RunGrpc::new(runs.clone())))
        .add_service(SettingsServiceServer::new(SettingsGrpc::new(settings)))
        .add_service(ChatServiceServer::new(ChatGrpc::new(
            chat.clone(),
            Arc::new(chat_hub),
            config.live_heartbeat,
            stop.clone(),
        )))
        .add_service(LiveServiceServer::new(LiveGrpc::new(
            Arc::new(hub),
            config.live_heartbeat,
            stop.clone(),
        )))
        .prepare()
        .into_axum_router()
        .layer(GrpcWebLayer::new());

    // --- background --------------------------------------------------------
    let scheduling = DispatchDueWorkflows::new(Arc::new(store.clone()), runs.clone());
    if overrides.background.unwrap_or(config.worker_enabled) {
        let worker = worker(
            pool.clone(),
            config,
            &runs,
            &chat,
            chat_runner.clone(),
            chat_publisher.clone(),
            redactor(config),
        )
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
        background.push(recovery::spawn(
            pool.clone(),
            recovery(config, &runs, &chat),
            stop.clone(),
        ));
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

    let agent = crate::features::chat::http::AgentApi::new(
        workflows.clone(),
        definitions.clone(),
        list_models.clone(),
        runs.clone(),
    );
    // The fake runner's tool markers now reach the real agent routes.
    let _ = agent_router_slot.set(crate::features::chat::http::routes(agent.clone()));
    Ok(App {
        router: router::build(state, agent, grpc, router::cors(&config.cors_origins)),
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
#[allow(clippy::too_many_arguments)]
fn worker(
    pool: PgPool,
    config: &Config,
    runs: &RunService,
    chat: &ChatService,
    chat_runner: Arc<dyn ChatRunner>,
    chat_publisher: Arc<dyn ChatPublisher>,
    redactor: Redactor,
) -> Worker {
    let (run_exec, step_exec) = (runs.clone(), runs.clone());
    Worker::new(pool)
        .queue(runs::application::RUN_QUEUE, 2)
        .queue(runs::application::STEP_QUEUE, config.step_concurrency)
        .queue(crate::features::chat::CHAT_QUEUE, 1)
        .handle(crate::features::chat::application::RUN_CHAT_TURN, {
            let (chat, chat_runner, chat_publisher, redactor) =
                (chat.clone(), chat_runner, chat_publisher, redactor);
            move |payload| {
                let (chat, chat_runner, chat_publisher, redactor) =
                    (chat.clone(), chat_runner.clone(), chat_publisher.clone(), redactor.clone());
                async move {
                    let chat_id: crate::shared::ids::ChatId = id_from(&payload, "chat_id")?;
                    Ok(chat.run_turn(chat_id, chat_runner, chat_publisher, redactor).await?)
                }
            }
        })
        .handle(runs::application::EXECUTE_RUN, move |payload| {
            let runs = run_exec.clone();
            async move { Ok(runs.execute_run(id_from(&payload, "run_id")?).await?) }
        })
        .handle(runs::application::EXECUTE_STEP, move |payload| {
            let runs = step_exec.clone();
            async move { Ok(runs.execute_step(id_from(&payload, "step_run_id")?).await?) }
        })
}

/// Dead-worker recovery → application operations.
fn recovery(config: &Config, runs: &RunService, chat: &ChatService) -> Recovery {
    let (job_runs, step_runs) = (runs.clone(), runs.clone());
    let chat_job_recovery = chat.clone();
    Recovery {
        every: config.recovery_every,
        // Far above the worker's 10s heartbeat: a struggling database delays
        // heartbeats, and recovering a live step would lose its result.
        stale_after: Duration::from_secs(5 * 60),
        step_kind: runs::application::EXECUTE_STEP.into(),
        chat_kind: crate::features::chat::RUN_CHAT_TURN.into(),
        recover_job: Arc::new(move |job| {
            let (runs, chat) = (job_runs.clone(), chat_job_recovery.clone());
            Box::pin(async move {
                match job.kind.as_str() {
                    runs::application::EXECUTE_STEP => {
                        runs.interrupt_step(id_from(&job.payload, "step_run_id")?)
                            .await?
                    }
                    runs::application::EXECUTE_RUN => {
                        runs.requeue_run(id_from(&job.payload, "run_id")?).await?
                    }
                    crate::features::chat::RUN_CHAT_TURN => {
                        chat.interrupt_turn(id_from(&job.payload, "chat_id")?).await?
                    }
                    // Recurring kinds are enqueued again by their ticker.
                    _ => {}
                }
                Ok(())
            })
        }),
        recover_step: Arc::new(move |id| {
            let runs = step_runs.clone();
            Box::pin(async move { Ok(runs.interrupt_step(id.into()).await?) })
        }),
        recover_chat: Arc::new({
            let chat = chat.clone();
            move |id| {
                let chat = chat.clone();
                Box::pin(async move { Ok(chat.interrupt_turn(id.into()).await?) })
            }
        }),
    }
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
        // On the signal: stop background work (tickers, worker drain, live
        // streams) while in-flight HTTP requests drain.
        let stop = self.stop.clone();
        let result = serve(listener, self.router, async move {
            shutdown_signal().await;
            stop.cancel();
        })
        .await;
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
