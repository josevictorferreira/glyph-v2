//! One `LISTEN glyph_events` connection feeding an in-process broadcast
//! channel. NOTIFYs are issued inside the mutating transactions, so events
//! arrive only after commit. On reconnect every subscriber gets a RESYNC.

use std::time::Duration;

use chrono::Utc;
use sqlx::PgPool;
use sqlx::postgres::PgListener;
use tokio::sync::broadcast;
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;

use crate::features::live::LiveBus;
use crate::features::live::domain::{CHANNEL, LiveEvent, LiveKind};

pub const CAPACITY: usize = 1024;

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
        let pool = super::pool::listener_pool(&pool);
        tokio::spawn(async move {
            let mut backoff = Duration::from_millis(100);
            let mut connected_before = false;
            loop {
                let mut listener = match connect(&pool).await {
                    Ok(l) => l,
                    Err(error) => {
                        tracing::warn!(%error, "live listener connect failed");
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
                    self.resync_all();
                }
                connected_before = true;
                loop {
                    tokio::select! {
                        _ = stop.cancelled() => return,
                        n = listener.try_recv() => match n {
                            Ok(Some(n)) => match serde_json::from_str::<LiveEvent>(n.payload()) {
                                Ok(event) => self.publish(event),
                                Err(error) => tracing::warn!(%error, "unreadable live payload"),
                            },
                            // Connection lost (sqlx reconnects on the next recv; we
                            // rebuild explicitly so subscribers learn about the gap).
                            Ok(None) | Err(_) => break,
                        },
                    }
                }
            }
        })
    }
}

async fn connect(pool: &PgPool) -> Result<PgListener, sqlx::Error> {
    let mut listener = PgListener::connect_with(pool).await?;
    listener.listen(CHANNEL).await?;
    Ok(listener)
}

impl LiveBus for LiveHub {
    fn subscribe(&self) -> broadcast::Receiver<LiveEvent> {
        self.sender.subscribe()
    }
}
