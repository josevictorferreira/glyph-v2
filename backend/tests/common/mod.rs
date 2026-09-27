#![allow(dead_code)]

use std::net::SocketAddr;

use glyph_backend::app::bootstrap;
use glyph_backend::config::Config;
use sqlx::PgPool;
use tokio::net::TcpListener;

pub fn test_config() -> Config {
    Config::from_lookup(|key| match key {
        "DATABASE_URL" => Some("postgres://unused".into()),
        "GLYPH_LISTEN_ADDR" => Some("127.0.0.1:0".into()),
        _ => None,
    })
    .unwrap()
}

pub struct TestServer {
    pub addr: SocketAddr,
    pub router: axum::Router,
    shutdown: Option<tokio::sync::oneshot::Sender<()>>,
}

impl TestServer {
    pub fn url(&self) -> String {
        format!("http://{}", self.addr)
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
    let app = bootstrap::build_with_pool(&test_config(), pool).await.unwrap();
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
    });
    TestServer {
        addr,
        router,
        shutdown: Some(tx),
    }
}
