use std::sync::{Arc, Mutex};

use chrono::{DateTime, Duration, SubsecRound, Utc};

pub type Timestamp = DateTime<Utc>;

/// Time source injected into application services so tests control `now`.
pub trait Clock: Send + Sync {
    fn now(&self) -> Timestamp;
}

#[derive(Debug, Default, Clone, Copy)]
pub struct SystemClock;

impl Clock for SystemClock {
    fn now(&self) -> Timestamp {
        // Postgres stores microseconds; keep domain values comparable after a round trip.
        Utc::now().trunc_subsecs(6)
    }
}

#[derive(Debug, Clone)]
pub struct FixedClock(Arc<Mutex<Timestamp>>);

impl FixedClock {
    pub fn new(at: Timestamp) -> Self {
        Self(Arc::new(Mutex::new(at.trunc_subsecs(6))))
    }

    pub fn advance(&self, by: Duration) {
        let mut now = self.0.lock().unwrap();
        *now += by;
    }

    pub fn set(&self, at: Timestamp) {
        *self.0.lock().unwrap() = at.trunc_subsecs(6);
    }
}

impl Clock for FixedClock {
    fn now(&self) -> Timestamp {
        *self.0.lock().unwrap()
    }
}
