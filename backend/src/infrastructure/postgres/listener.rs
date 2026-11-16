//! One `LISTEN` connection per channel feeding an in-process broadcast
//! channel. NOTIFYs are issued inside the mutating transactions, so events
//! arrive only after commit. On reconnect every subscriber gets a RESYNC.
//! The reconnect loop is generic over the channel and payload (spec 0024):
//! `LiveHub` (live runs) and `ChatHub` (chat turns) share it.

use std::time::Duration;

use chrono::Utc;
use serde::de::DeserializeOwned;
use sqlx::PgPool;
use sqlx::postgres::PgListener;
use tokio::sync::broadcast;
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;

use crate::features::chat::domain::events::{CHANNEL as CHAT_CHANNEL, ChatEvent, ChatEventKind};
use crate::features::chat::ports::ChatBus;
use crate::features::live::LiveBus;
use crate::features::live::domain::{CHANNEL, LiveEvent, LiveKind};

pub const CAPACITY: usize = 1024;

/// Shared reconnect loop: listen on `channel`, publish payloads, RESYNC on
/// reconnect.
async fn listen_loop<T, P, R>(
    pool: PgPool,
    stop: CancellationToken,
    channel: &'static str,
    publish: P,
    resync: R,
) where
    T: DeserializeOwned,
    P: Fn(T) + Send + 'static,
    R: Fn() + Send + 'static,
{
    let pool = super::pool::listener_pool(&pool);
    let mut backoff = Duration::from_millis(100);
    let mut connected_before = false;
    loop {
        let mut listener = match connect(&pool, channel).await {
            Ok(l) => l,
            Err(error) => {
                tracing::warn!(%error, channel, "listener connect failed");
                tokio::select! {
                    _ = stop.cancelled() => return,
                    _ = tokio::time::sleep(backoff) => {}
                }
                backoff = (backoff * 2).min(Duration::from_secs(5));
                continue;
            }
        };
        backoff = Duration::from_millis(100);
        if connected_before {
            resync();
        }
        connected_before = true;
        loop {
            tokio::select! {
                _ = stop.cancelled() => return,
                n = listener.try_recv() => match n {
                    Ok(Some(n)) => match serde_json::from_str::<T>(n.payload()) {
                        Ok(event) => publish(event),
                        Err(error) => tracing::warn!(%error, channel, "unreadable payload"),
                    },
                    // Connection lost (sqlx reconnects on the next recv; we
                    // rebuild explicitly so subscribers learn about the gap).
                    Ok(None) | Err(_) => break,
                },
            }
        }
    }
}

async fn connect(pool: &PgPool, channel: &str) -> Result<PgListener, sqlx::Error> {
    let mut listener = PgListener::connect_with(pool).await?;
    listener.listen(channel).await?;
    Ok(listener)
}

// --- live runs -------------------------------------------------------------

#[derive(Clone)]
pub struct LiveHub {
    sender: broadcast::Sender<LiveEvent>,
}

impl LiveHub {
    pub fn new(capacity: usize) -> Self {
        Self {
            sender: broadcast::channel(capacity).0,
        }
    }

    pub fn publish(&self, event: LiveEvent) {
        // No subscribers is fine; a slow one lags and gets a RESYNC.
        let _ = self.sender.send(event);
    }

    fn resync_all(&self) {
        self.publish(LiveEvent {
            kind: LiveKind::Resync,
            workflow_id: String::new(),
            run_id: None,
            step_run_id: None,
            occurred_at: Utc::now(),
        });
    }

    /// Listens until `stop`; dropping the returned task's hub clone closes streams.
    pub fn spawn_listener(self, pool: PgPool, stop: CancellationToken) -> JoinHandle<()> {
        let hub = self.clone();
        let resync_hub = self.clone();
        tokio::spawn(listen_loop::<LiveEvent, _, _>(
            pool,
            stop,
            CHANNEL,
            move |e| hub.publish(e),
            move || resync_hub.resync_all(),
        ))
    }
}

impl LiveBus for LiveHub {
    fn subscribe(&self) -> broadcast::Receiver<LiveEvent> {
        self.sender.subscribe()
    }
}

// --- chat (spec 0024) ------------------------------------------------------

#[derive(Clone)]
pub struct ChatHub {
    sender: broadcast::Sender<ChatEvent>,
}

impl ChatHub {
    pub fn new(capacity: usize) -> Self {
        Self {
            sender: broadcast::channel(capacity).0,
        }
    }

    pub fn publish(&self, event: ChatEvent) {
        let _ = self.sender.send(event);
    }

    fn resync_all(&self) {
        self.publish(ChatEvent {
            kind: ChatEventKind::Resync,
            chat_id: String::new(),
            offset: None,
            text: None,
            message_id: None,
            occurred_at: Utc::now(),
        });
    }

    pub fn spawn_listener(self, pool: PgPool, stop: CancellationToken) -> JoinHandle<()> {
        let hub = self.clone();
        let resync_hub = self.clone();
        tokio::spawn(listen_loop::<ChatEvent, _, _>(
            pool,
            stop,
            CHAT_CHANNEL,
            move |e| hub.publish(e),
            move || resync_hub.resync_all(),
        ))
    }
}

impl ChatBus for ChatHub {
    fn subscribe(&self) -> broadcast::Receiver<ChatEvent> {
        self.sender.subscribe()
    }
}
