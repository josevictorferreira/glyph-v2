# Workflow guide

Glyph workflows are DAG-shaped documents. A minimal definition:

```yaml workflow
name: Minimal
steps:
  - name: Do the work
    kind: helper
```

Every step has a `name`; `kind` is `pi` (default) or `helper`. Pi steps run
a prompt through a model; helper steps compute deterministic values.

The full shape — inputs, connections, schedules, shared texts — is
documented here in detail as spec 0024 lands it. Meanwhile, the reliable
path is: `get_workflow_yaml` an existing workflow, edit what you see, and
`validate_yaml` before applying.
