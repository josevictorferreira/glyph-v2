#![allow(dead_code)]

pub mod fakes;

use std::net::SocketAddr;
use std::sync::Arc;

use glyph_backend::app::bootstrap::{self, Overrides};
use glyph_backend::config::Config;
use sqlx::PgPool;
use tokio::net::TcpListener;

pub fn test_config() -> Config {
    config_with(&[])
}

pub fn config_with(extra: &[(&str, &str)]) -> Config {
    let extra: Vec<(String, String)> = extra
        .iter()
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect();
    Config::from_lookup(move |key| {
        if let Some((_, v)) = extra.iter().find(|(k, _)| k == key) {
            return Some(v.clone());
        }
        match key {
            "DATABASE_URL" => Some("postgres://unused".into()),
            "GLYPH_LISTEN_ADDR" => Some("127.0.0.1:0".into()),
            "GLYPH_WORKER_ENABLED" => Some("false".into()),
            _ => None,
        }
    })
    .unwrap()
}

pub struct TestServer {
    pub addr: SocketAddr,
    pub router: axum::Router,
    pub pool: PgPool,
    shutdown: Option<tokio::sync::oneshot::Sender<()>>,
}

impl TestServer {
    pub fn url(&self) -> String {
        format!("http://{}", self.addr)
    }

    pub async fn channel(&self) -> tonic::transport::Channel {
        tonic::transport::Channel::from_shared(self.url())
            .unwrap()
            .connect()
            .await
            .unwrap()
    }
}

impl Drop for TestServer {
    fn drop(&mut self) {
        if let Some(tx) = self.shutdown.take() {
            let _ = tx.send(());
        }
    }
}

pub async fn spawn(pool: PgPool) -> TestServer {
    spawn_with(pool, test_config(), Overrides::default()).await
}

pub async fn spawn_with(pool: PgPool, config: Config, overrides: Overrides) -> TestServer {
    let app = bootstrap::build_with(&config, pool.clone(), overrides)
        .await
        .unwrap();
    let router = app.router();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let (tx, rx) = tokio::sync::oneshot::channel::<()>();
    let serve_router = router.clone();
    tokio::spawn(async move {
        let _ = bootstrap::serve(listener, serve_router, async {
            let _ = rx.await;
        })
        .await;
        app.shutdown().await;
    });
    TestServer {
        addr,
        router,
        pool,
        shutdown: Some(tx),
    }
}

pub fn arc<T>(value: T) -> Arc<T> {
    Arc::new(value)
}
