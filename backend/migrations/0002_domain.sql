-- Domain tables, translated from the Rails schema (timestamps are timestamptz,
-- encrypted columns are bytea holding nonce ‖ ciphertext ‖ tag).

CREATE TABLE workflows (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name text NOT NULL DEFAULT '',
    description text,
    status text NOT NULL DEFAULT 'draft'
        CONSTRAINT workflows_status_check CHECK (status IN ('draft', 'active', 'paused', 'needs_attention')),
    fail_fast boolean NOT NULL DEFAULT false,
    last_run_at timestamptz,
    last_run_status text,
    next_run_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX index_workflows_on_next_run_at ON workflows (next_run_at) WHERE next_run_at IS NOT NULL;
CREATE INDEX index_workflows_on_updated_at ON workflows (updated_at DESC);

CREATE TABLE workflow_inputs (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    workflow_id uuid NOT NULL REFERENCES workflows (id) ON DELETE CASCADE,
    name text NOT NULL,
    description text,
    required boolean NOT NULL DEFAULT true,
    ask_at_run_time boolean NOT NULL DEFAULT true,
    value text,
    position integer NOT NULL DEFAULT 0,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX index_workflow_inputs_on_workflow_id ON workflow_inputs (workflow_id);
CREATE UNIQUE INDEX index_workflow_inputs_on_workflow_id_and_lower_name
    ON workflow_inputs (workflow_id, lower(name));

CREATE TABLE workflow_steps (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    workflow_id uuid NOT NULL REFERENCES workflows (id) ON DELETE CASCADE,
    kind text NOT NULL DEFAULT 'pi'
        CONSTRAINT workflow_steps_kind_check CHECK (kind IN ('pi', 'helper')),
    name text NOT NULL DEFAULT '',
    description text,
    prompt text,
    additional_context text,
    expected_output text,
    output_name text,
    output_description text,
    output_file_format text NOT NULL DEFAULT 'free_text_markdown'
        CONSTRAINT workflow_steps_output_file_format_check
        CHECK (output_file_format IN ('free_text_markdown', 'html', 'json', 'zip')),
    model_id text,
    model_settings jsonb NOT NULL DEFAULT '{}',
    enabled_tool_ids jsonb NOT NULL DEFAULT '[]',
    allow_failure boolean NOT NULL DEFAULT false,
    canvas_x integer NOT NULL DEFAULT 0,
    canvas_y integer NOT NULL DEFAULT 0,
    position integer NOT NULL DEFAULT 0,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX index_workflow_steps_on_workflow_id_and_position ON workflow_steps (workflow_id, position);

CREATE TABLE step_inputs (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    workflow_step_id uuid NOT NULL REFERENCES workflow_steps (id) ON DELETE CASCADE,
    workflow_input_id uuid REFERENCES workflow_inputs (id) ON DELETE SET NULL,
    name text NOT NULL,
    description text,
    required boolean NOT NULL DEFAULT true,
    position integer NOT NULL DEFAULT 0,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX index_step_inputs_on_workflow_input_id ON step_inputs (workflow_input_id);
CREATE UNIQUE INDEX index_step_inputs_on_workflow_step_id_and_lower_name
    ON step_inputs (workflow_step_id, lower(name));

CREATE TABLE workflow_connections (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    workflow_id uuid NOT NULL REFERENCES workflows (id) ON DELETE CASCADE,
    source_step_id uuid NOT NULL REFERENCES workflow_steps (id) ON DELETE CASCADE,
    source_output_name text NOT NULL,
    destination_step_id uuid NOT NULL REFERENCES workflow_steps (id) ON DELETE CASCADE,
    destination_input_id uuid NOT NULL REFERENCES step_inputs (id) ON DELETE CASCADE,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT workflow_connections_no_self_edge CHECK (source_step_id <> destination_step_id)
);
CREATE UNIQUE INDEX index_workflow_connections_on_destination_input_id ON workflow_connections (destination_input_id);
CREATE INDEX index_workflow_connections_on_workflow_id_and_source_step_id
    ON workflow_connections (workflow_id, source_step_id);
CREATE INDEX index_workflow_connections_on_destination_step_id ON workflow_connections (destination_step_id);

CREATE TABLE workflow_schedules (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    workflow_id uuid NOT NULL REFERENCES workflows (id) ON DELETE CASCADE,
    enabled boolean NOT NULL DEFAULT false,
    cron_expression text,
    timezone text,
    human_description text,
    next_run_at timestamptz,
    last_dispatched_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX index_workflow_schedules_on_workflow_id ON workflow_schedules (workflow_id);

CREATE TABLE workflow_schedule_values (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    workflow_schedule_id uuid NOT NULL REFERENCES workflow_schedules (id) ON DELETE CASCADE,
    workflow_input_id uuid NOT NULL REFERENCES workflow_inputs (id) ON DELETE CASCADE,
    -- encrypted JSON string
    value bytea,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX index_schedule_values_on_schedule_and_input
    ON workflow_schedule_values (workflow_schedule_id, workflow_input_id);
CREATE INDEX index_workflow_schedule_values_on_workflow_input_id ON workflow_schedule_values (workflow_input_id);

CREATE TABLE workflow_runs (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    workflow_id uuid NOT NULL REFERENCES workflows (id),
    status text NOT NULL DEFAULT 'queued'
        CONSTRAINT workflow_runs_status_check
        CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
    trigger text NOT NULL
        CONSTRAINT workflow_runs_trigger_check CHECK (trigger IN ('manual', 'scheduled')),
    draft_test boolean NOT NULL DEFAULT false,
    snapshot jsonb NOT NULL,
    -- encrypted JSON object {input name: value}
    supplied_values bytea,
    schedule_occurrence_key text,
    queued_at timestamptz,
    started_at timestamptz,
    ended_at timestamptz,
    elapsed_ms bigint,
    failure_summary text,
    first_failed_step_run_id uuid,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX index_workflow_runs_on_schedule_occurrence_key
    ON workflow_runs (schedule_occurrence_key) WHERE schedule_occurrence_key IS NOT NULL;
CREATE INDEX index_workflow_runs_on_status ON workflow_runs (status);
CREATE INDEX index_workflow_runs_on_workflow_id_and_created_at ON workflow_runs (workflow_id, created_at DESC);

CREATE TABLE step_runs (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    workflow_run_id uuid NOT NULL REFERENCES workflow_runs (id) ON DELETE CASCADE,
    snapshot_step_id uuid NOT NULL,
    step_name text NOT NULL DEFAULT '',
    step_kind text NOT NULL DEFAULT 'pi'
        CONSTRAINT step_runs_step_kind_check CHECK (step_kind IN ('pi', 'helper')),
    status text NOT NULL DEFAULT 'queued'
        CONSTRAINT step_runs_status_check
        CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'skipped', 'cancelled')),
    position integer NOT NULL DEFAULT 0,
    allow_failure boolean NOT NULL DEFAULT false,
    prompt text,
    additional_context text,
    expected_output text,
    model_id text,
    model_settings jsonb NOT NULL DEFAULT '{}',
    enabled_tools jsonb NOT NULL DEFAULT '[]',
    output_name text,
    output_file_format text NOT NULL DEFAULT 'free_text_markdown'
        CONSTRAINT step_runs_output_file_format_check
        CHECK (output_file_format IN ('free_text_markdown', 'html', 'json', 'zip')),
    -- encrypted evidence
    resolved_inputs bytea,
    output bytea,
    output_text bytea,
    messages bytea,
    session_content bytea,
    technical_error bytea,
    human_error text,
    skipped_reason text,
    queued_at timestamptz,
    started_at timestamptz,
    ended_at timestamptz,
    elapsed_ms bigint,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX index_step_runs_on_workflow_run_id_and_snapshot_step_id
    ON step_runs (workflow_run_id, snapshot_step_id);
CREATE INDEX index_step_runs_on_workflow_run_id_and_status ON step_runs (workflow_run_id, status);

-- Deferred so a run and its step runs can be deleted together without first
-- clearing the reference (replaces the Rails before_destroy hack).
ALTER TABLE workflow_runs
    ADD CONSTRAINT workflow_runs_first_failed_step_run_id_fkey
    FOREIGN KEY (first_failed_step_run_id) REFERENCES step_runs (id)
    DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE available_models (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    provider text NOT NULL,
    model_id text NOT NULL,
    display_name text,
    available boolean NOT NULL DEFAULT true,
    capabilities jsonb NOT NULL DEFAULT '{}',
    raw jsonb NOT NULL DEFAULT '{}',
    fetched_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX index_available_models_on_provider_and_model_id ON available_models (provider, model_id);
CREATE INDEX index_available_models_on_available ON available_models (available);

CREATE TABLE tool_definitions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    key text NOT NULL,
    display_name text NOT NULL,
    description text,
    pi_tool_name text NOT NULL,
    enabled boolean NOT NULL DEFAULT true,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX index_tool_definitions_on_key ON tool_definitions (key);
