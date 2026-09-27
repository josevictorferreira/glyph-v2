-- Append-only audit log of domain events (ids + status only, never payloads).
CREATE TABLE events (
    id bigserial PRIMARY KEY,
    event_id uuid NOT NULL DEFAULT gen_random_uuid(),
    event_type text NOT NULL,
    stream text NOT NULL,
    correlation_id uuid,
    data jsonb NOT NULL DEFAULT '{}',
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX index_events_on_event_id ON events (event_id);
CREATE INDEX index_events_on_stream_and_id ON events (stream, id);
CREATE INDEX index_events_on_event_type ON events (event_type);

-- Transactional outbox / job queue. Enqueued in the same transaction as the
-- state change; claimed with FOR UPDATE SKIP LOCKED; never retried.
CREATE TABLE jobs (
    id bigserial PRIMARY KEY,
    kind text NOT NULL,
    queue text NOT NULL,
    payload jsonb NOT NULL DEFAULT '{}',
    run_at timestamptz NOT NULL DEFAULT now(),
    locked_at timestamptz,
    locked_by text,
    finished_at timestamptz,
    error text,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX index_jobs_ready ON jobs (queue, run_at) WHERE finished_at IS NULL AND locked_at IS NULL;
CREATE INDEX index_jobs_on_kind_unfinished ON jobs (kind) WHERE finished_at IS NULL;
