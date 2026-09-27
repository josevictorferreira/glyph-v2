use tokio::sync::broadcast;

use crate::features::live::domain::LiveEvent;

/// Fan-out of live events to subscribers (fed by Postgres LISTEN/NOTIFY).
pub trait LiveBus: Send + Sync {
    fn subscribe(&self) -> broadcast::Receiver<LiveEvent>;
}
