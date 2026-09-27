-- Server-managed tool catalog: the only Pi tools an author may enable.
INSERT INTO tool_definitions (key, display_name, description, pi_tool_name, enabled) VALUES
    ('read', 'Read files', 'Read files inside the step''s isolated working directory.', 'read', true),
    ('bash', 'Run shell commands', 'Execute shell commands inside the step''s isolated working directory.', 'bash', true),
    ('edit', 'Edit files', 'Modify files inside the step''s isolated working directory.', 'edit', true),
    ('write', 'Write files', 'Create files inside the step''s isolated working directory.', 'write', true)
ON CONFLICT (key) DO UPDATE SET
    display_name = EXCLUDED.display_name,
    description = EXCLUDED.description,
    pi_tool_name = EXCLUDED.pi_tool_name,
    enabled = EXCLUDED.enabled,
    updated_at = now();
