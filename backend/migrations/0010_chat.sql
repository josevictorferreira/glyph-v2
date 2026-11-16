-- Chat conversations with the Pi-backed agent (spec 0024).
-- Encrypted columns are bytea holding nonce ‖ ciphertext ‖ tag.
CREATE TABLE chats (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    title text NOT NULL DEFAULT '',
    status text NOT NULL DEFAULT 'idle'
        CONSTRAINT chats_status_check CHECK (status IN ('idle', 'running')),
    cancel_requested boolean NOT NULL DEFAULT false,
    -- encrypted Pi session .jsonl and its path relative to the session dir
    pi_session bytea,
    pi_session_path text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE chat_messages (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    chat_id uuid NOT NULL REFERENCES chats (id) ON DELETE CASCADE,
    seq integer NOT NULL,
    kind text NOT NULL
        CONSTRAINT chat_messages_kind_check CHECK (kind IN ('user', 'assistant', 'tool')),
    status text NOT NULL
        CONSTRAINT chat_messages_status_check CHECK (status IN ('streaming', 'done', 'failed')),
    -- encrypted: markdown for user/assistant, JSON ToolCall for tool
    content bytea NOT NULL,
    error text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX index_chat_messages_on_chat_id_and_seq ON chat_messages (chat_id, seq);
