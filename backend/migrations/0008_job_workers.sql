-- Worker liveness for crash recovery. Each job worker upserts its row while
-- alive; a job locked by a worker whose heartbeat went stale was abandoned
-- (OOM kill, node loss) and is recovered by the sweep instead of staying
-- locked and unfinished forever.
CREATE TABLE job_workers (
    id text PRIMARY KEY,
    heartbeat_at timestamptz NOT NULL DEFAULT now()
);
