use std::time::Duration;

use tokio_util::sync::CancellationToken;

pub const REFRESH_EVERY: Duration = Duration::from_secs(5 * 60);

/// Runs `tick` every `every` (first tick immediately) until `stop` fires.
pub async fn run_periodically<F, Fut>(every: Duration, stop: CancellationToken, mut tick: F)
where
    F: FnMut() -> Fut,
    Fut: Future<Output = ()>,
{
    let mut interval = tokio::time::interval(every);
    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        tokio::select! {
            _ = stop.cancelled() => return,
            _ = interval.tick() => tick().await,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use std::sync::atomic::{AtomicUsize, Ordering};

    #[tokio::test(start_paused = true)]
    async fn ticks_once_per_interval() {
        let count = Arc::new(AtomicUsize::new(0));
        let stop = CancellationToken::new();
        let c = count.clone();
        let task = tokio::spawn(run_periodically(REFRESH_EVERY, stop.clone(), move || {
            let c = c.clone();
            async move {
                c.fetch_add(1, Ordering::SeqCst);
            }
        }));
        tokio::time::sleep(Duration::from_secs(1)).await;
        assert_eq!(count.load(Ordering::SeqCst), 1, "first tick is immediate");
        tokio::time::sleep(REFRESH_EVERY).await;
        assert_eq!(count.load(Ordering::SeqCst), 2, "one more after 5 minutes");
        stop.cancel();
        task.await.unwrap();
    }
}
