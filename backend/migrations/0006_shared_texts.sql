-- 0023 shared texts: workflow-level prompt constants with per-step variables.
-- A step field (prompt / context / expect) references a text; the step's own
-- column is NULL while a reference exists, and snapshots store the rendered
-- text. RESTRICT keeps an in-use text from being deleted by accident.

CREATE TABLE workflow_texts (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    workflow_id uuid NOT NULL REFERENCES workflows (id) ON DELETE CASCADE,
    key text NOT NULL,
    description text,
    body text NOT NULL DEFAULT '',
    position integer NOT NULL DEFAULT 0,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX index_workflow_texts_on_workflow_id_and_lower_key
    ON workflow_texts (workflow_id, lower(key));

CREATE TABLE step_text_refs (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    workflow_step_id uuid NOT NULL REFERENCES workflow_steps (id) ON DELETE CASCADE,
    workflow_text_id uuid NOT NULL REFERENCES workflow_texts (id) ON DELETE RESTRICT,
    field text NOT NULL
        CONSTRAINT step_text_refs_field_check CHECK (field IN ('prompt', 'context', 'expect')),
    vars jsonb NOT NULL DEFAULT '{}',
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX index_step_text_refs_on_step_and_field
    ON step_text_refs (workflow_step_id, field);
CREATE INDEX index_step_text_refs_on_workflow_text_id ON step_text_refs (workflow_text_id);
