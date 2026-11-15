-- App-wide settings (first key: chat_model_id, the chat agent's model).
CREATE TABLE app_settings (
    key text PRIMARY KEY,
    value text NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now()
);
