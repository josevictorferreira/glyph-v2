use std::net::SocketAddr;
use std::time::Duration;

use anyhow::Context;
use axum::Router;
use sqlx::PgPool;
use tokio::net::TcpListener;
use tonic::service::Routes;
use tonic_web::GrpcWebLayer;

use crate::app::{router, state::AppState};
use crate::config::Config;
use crate::features::catalog::grpc::CatalogGrpc;
use crate::features::definition::grpc::DefinitionGrpc;
use crate::features::live::grpc::LiveGrpc;
use crate::features::runs::grpc::RunGrpc;
use crate::features::workflows::grpc::WorkflowGrpc;
use crate::infrastructure::postgres;
use crate::proto;
use crate::proto::pb::catalog_service_server::CatalogServiceServer;
use crate::proto::pb::definition_service_server::DefinitionServiceServer;
use crate::proto::pb::live_service_server::LiveServiceServer;
use crate::proto::pb::run_service_server::RunServiceServer;
use crate::proto::pb::workflow_service_server::WorkflowServiceServer;

pub struct App {
    router: Router,
    listen_addr: SocketAddr,
}

pub async fn build(config: &Config) -> anyhow::Result<App> {
    let pool = postgres::pool::connect(config)
        .await
        .context("connecting to the database")?;
    build_with_pool(config, pool).await
}

/// Composition root: the only place that names concrete adapters.
pub async fn build_with_pool(config: &Config, pool: PgPool) -> anyhow::Result<App> {
    postgres::migrate::run(&pool)
        .await
        .context("running migrations")?;

    let state = AppState { pool };

    let (_health_reporter, health_service) = tonic_health::server::health_reporter();
    let reflection = tonic_reflection::server::Builder::configure()
        .register_encoded_file_descriptor_set(proto::FILE_DESCRIPTOR_SET)
        .register_encoded_file_descriptor_set(tonic_health::pb::FILE_DESCRIPTOR_SET)
        .build_v1()
        .context("building gRPC reflection")?;
    let grpc = Routes::new(health_service)
        .add_service(reflection)
        .add_service(CatalogServiceServer::new(CatalogGrpc))
        .add_service(WorkflowServiceServer::new(WorkflowGrpc))
        .add_service(DefinitionServiceServer::new(DefinitionGrpc))
        .add_service(RunServiceServer::new(RunGrpc))
        .add_service(LiveServiceServer::new(LiveGrpc))
        .prepare()
        .into_axum_router()
        .layer(GrpcWebLayer::new());

    Ok(App {
        router: router::build(state, grpc, router::cors(&config.cors_origins)),
        listen_addr: config.listen_addr,
    })
}

impl App {
    pub fn router(&self) -> Router {
        self.router.clone()
    }

    pub async fn run(self) -> anyhow::Result<()> {
        let listener = TcpListener::bind(self.listen_addr)
            .await
            .with_context(|| format!("binding {}", self.listen_addr))?;
        tracing::info!(addr = %listener.local_addr()?, "listening");
        serve(listener, self.router, shutdown_signal()).await
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
    let server = tokio::spawn(async move { server.await });

    // Graceful drain is capped: in-flight requests get 10s after the signal.
    let mut server = server;
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
