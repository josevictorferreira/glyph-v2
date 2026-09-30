-- Audit ticket 4: run duration must measure active execution time, not
-- wall-clock from first start (a retry a day later reported "14h 05m").
-- active_ms accumulates finished execution windows; resumed_at opens the
-- current window after a retry revives a terminal run.
ALTER TABLE workflow_runs ADD COLUMN active_ms bigint NOT NULL DEFAULT 0;
ALTER TABLE workflow_runs ADD COLUMN resumed_at timestamptz;
