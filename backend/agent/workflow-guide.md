# Workflow guide

Glyph workflows are DAG-shaped documents: steps run the Pi agent (or a
deterministic helper), outputs flow along connections, and runs are
immutable evidence. This document is the complete authoring reference.

## Shape

```yaml workflow
name: Weekly competitor digest
description: Summarize competitor news into a weekly brief.
fail_fast: false
inputs:
  competitor: Acme
steps:
  - name: Gather
    prompt: List this week's updates for {{competitor}}.
    expect: A bullet list of updates with dates.
    output: updates
    inputs:
      competitor: competitor
  - name: Summarize
    model: velox/glm-5-3
    prompt: Write a one-paragraph brief from the updates.
    expect: One paragraph.
    output: brief
    inputs:
      updates: Gather
```

The top-level keys: `name` (required), `description`, `fail_fast`,
`defaults`, `inputs`, `texts`, `schedule`, `steps` (required, at least one).
Dependencies come from step inputs, never from list order: the `Summarize`
step above runs after `Gather` because it names `Gather` as an input
source.

## Steps

Every step has a `name`; `kind` is `pi` (default) or `helper`.

- `pi` steps run a prompt through a model. Keys: `model` (`provider/model`,
  from `list_models`), `prompt`, `context`, `expect`, `output`,
  `output_description`, `format` (`markdown` | `text` | `json` | `html`),
  `temperature`, `tools` (keys from `list_tools`), `allow_failure`.
- `helper` steps are deterministic: they gather their inputs into one
  structured output without a model. They take `output`, `description` and
  `inputs`, and ignore model keys.

## Connections

A step input is `input name: source`, where the source is either another
step's name (that step's output flows in) or a workflow input's name:

```yaml workflow
name: Connection example
inputs:
  feature: dark mode
steps:
  - name: Draft
    prompt: Draft an announcement for {{feature}}.
    expect: One paragraph.
    output: draft
    inputs:
      feature: feature
  - name: Review
    prompt: |
      Tighten this draft:
      {{draft}}
    expect: One paragraph.
    output: final
    inputs:
      draft: Draft
```

The object form adds validation and documentation:
`feature: { from: feature, required: false, description: … }`.

## Inputs

`inputs:` maps a name to either a scalar (a constant, stored once and never
asked at run time) or an object (asked at run time unless it carries a
`value`):

```yaml workflow
name: Input forms
inputs:
  tone: professional
  topic:
    description: What the brief covers.
  depth:
    description: How deep to go.
    value: summary
steps:
  - name: Write
    prompt: Write a {{tone}} note about {{topic}}, at {{depth}} depth.
    expect: One short note.
    output: note
    inputs:
      topic: topic
```

At run time `start_run` supplies values by input name; a scalar input's
value cannot be overridden.

## Shared texts

`texts:` are written once and referenced from any step's `prompt`,
`context` or `expect` with `{ ref: name }`; `vars` fills the text's
`{{placeholders}}` per step:

```yaml workflow
name: Shared text example
texts:
  reviewer: |
    Review the entry for {{focus}}. Be specific and fair.
steps:
  - name: Review clarity
    prompt: { ref: reviewer, vars: { focus: clarity } }
    expect: Three bullet points.
    output: clarity_notes
  - name: Review tone
    prompt: { ref: reviewer, vars: { focus: tone } }
    expect: Three bullet points.
    output: tone_notes
```

A shared text is either the body (a scalar) or `{ description, body }`.

## Schedule

A workflow with a `schedule:` runs itself; `cron` is a five-field
expression and `timezone` an IANA name. Removing the block removes the
schedule:

```yaml workflow
name: Scheduled digest
schedule:
  cron: 0 9 * * 1
  timezone: America/Sao_Paulo
steps:
  - name: Digest
    prompt: Summarize this week in one line.
    expect: One line.
    output: line
```

Activation is separate: only an active workflow's schedule fires, so
`set_workflow_state` with `activate` is still needed after adding one.

## Helper steps

Helpers package upstream outputs for shared reuse without a model call:

```yaml workflow
name: Helper example
inputs:
  brief: Write a to-do app.
steps:
  - name: Shared Context
    kind: helper
    description: Gathers the brief once for every participant.
    output: context
    inputs:
      brief: brief
  - name: Act
    prompt: 'Act on the brief: {{brief}}.'
    expect: One paragraph.
    output: plan
    inputs:
      context: Shared Context
```

## `defaults`

`defaults:` holds values (`model`, `temperature`, `expect`, …) inherited by
every `pi` step that omits the same key; each step is stored with its
resolved value at import time.

## The editing loop: export → edit → validate → apply

1. `get_workflow_yaml` exports the current YAML plus a fingerprint.
2. Edit the YAML.
3. `validate_yaml` with the same `workflow_id` reports every error
   (reference checks need the workflow's real steps) — nothing is written.
4. `update_workflow` with the edited YAML **and the fingerprint** applies
   it. A stale fingerprint means someone changed the workflow in between:
   re-export and re-apply. Never guess the fingerprint; it is in the
   export's text.

`create_workflow` takes just the YAML (no fingerprint) and makes a draft.

## Common mistakes

- Referencing an input that is neither a step nor a workflow input:
  `is not a step or a workflow input` (the error carries the line).
- Unknown model id (`is not an available model`): use `list_models`.
- `update_workflow` without the fingerprint or with a stale one:
  `The workflow changed since this definition was loaded. Reload and try again.`
- A `texts:` reference to a name that does not exist, or a `vars` key the
  text never uses.
- Forgetting `kind: helper` on a step that has no prompt (a `pi` step
  requires one).
- Adding a `schedule:` and expecting it to fire: the workflow must also be
  activated.
