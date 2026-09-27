//! Workflow aggregate persistence: load the full aggregate, persist it back
//! with one `UNNEST` upsert per table (rows only rewritten when they changed)
//! plus deletes of children no longer present — all inside the caller's tx.

use async_trait::async_trait;
use serde_json::Value;
use sqlx::PgConnection;
use uuid::Uuid;

use crate::features::workflows::domain::model::*;
use crate::features::workflows::ports::repository::{ListFilter, WorkflowStore, WorkflowTx};
use crate::infrastructure::crypto::Cipher;
use crate::infrastructure::postgres::PgStore;
use crate::infrastructure::postgres::uow::{PgTx, db};
use crate::shared::error::{DomainError, DomainResult};
use crate::shared::ids::*;
use crate::shared::output_format::OutputFileFormat;

fn corrupt(what: &str) -> DomainError {
    DomainError::Internal(anyhow::anyhow!("corrupt row: {what}"))
}

fn status(raw: &str) -> DomainResult<WorkflowStatus> {
    WorkflowStatus::parse(raw).ok_or_else(|| corrupt("workflow status"))
}

/// Unique violations surface as the Rails validation message.
pub(crate) fn save_error(error: sqlx::Error) -> DomainError {
    if let sqlx::Error::Database(db_error) = &error
        && db_error.code().as_deref() == Some("23505")
    {
        return match db_error.constraint() {
            Some(c) if c.contains("lower_name") => {
                DomainError::invalid("Unable to save — Name has already been taken.")
            }
            Some("index_workflow_connections_on_destination_input_id") => {
                DomainError::invalid("Unable to save — Destination input has already been taken.")
            }
            _ => db(error),
        };
    }
    db(error)
}

fn encrypt_json(cipher: &dyn Cipher, value: &Option<String>) -> Option<Vec<u8>> {
    value.as_ref().map(|v| {
        cipher.encrypt(
            serde_json::to_string(v)
                .expect("strings serialize")
                .as_bytes(),
        )
    })
}

fn decrypt_json_string(cipher: &dyn Cipher, blob: Option<Vec<u8>>) -> DomainResult<Option<String>> {
    let Some(blob) = blob else { return Ok(None) };
    let plain = cipher
        .decrypt(&blob)
        .map_err(|e| DomainError::Internal(anyhow::anyhow!("decrypting schedule value: {e}")))?;
    let value: Value = serde_json::from_slice(&plain).map_err(DomainError::internal)?;
    Ok(match value {
        Value::Null => None,
        Value::String(s) => Some(s),
        other => Some(other.to_string()),
    })
}

pub(crate) async fn load(
    conn: &mut PgConnection,
    cipher: &dyn Cipher,
    id: WorkflowId,
    lock: bool,
) -> DomainResult<Option<Workflow>> {
    let uuid = id.as_uuid();
    macro_rules! header {
        ($sql:literal) => {
            sqlx::query!($sql, uuid)
                .fetch_optional(&mut *conn)
                .await
                .map_err(db)?
                .map(|r| {
                    Ok::<_, DomainError>(Workflow {
                        id,
                        name: r.name,
                        description: r.description,
                        status: status(&r.status)?,
                        fail_fast: r.fail_fast,
                        last_run_at: r.last_run_at,
                        last_run_status: r.last_run_status,
                        next_run_at: r.next_run_at,
                        created_at: r.created_at,
                        updated_at: r.updated_at,
                        inputs: Vec::new(),
                        steps: Vec::new(),
                        connections: Vec::new(),
                        schedule: None,
                    })
                })
                .transpose()?
        };
    }
    let workflow = if lock {
        header!(
            "SELECT name, description, status, fail_fast, last_run_at, last_run_status, next_run_at, created_at, updated_at
             FROM workflows WHERE id = $1 FOR UPDATE"
        )
    } else {
        header!(
            "SELECT name, description, status, fail_fast, last_run_at, last_run_status, next_run_at, created_at, updated_at
             FROM workflows WHERE id = $1"
        )
    };
    let Some(mut workflow) = workflow else {
        return Ok(None);
    };

    workflow.inputs = sqlx::query!(
        "SELECT id, name, description, required, ask_at_run_time, value, position, created_at
         FROM workflow_inputs WHERE workflow_id = $1 ORDER BY position, created_at",
        uuid
    )
    .fetch_all(&mut *conn)
    .await
    .map_err(db)?
    .into_iter()
    .map(|r| WorkflowInput {
        id: r.id.into(),
        name: r.name,
        description: r.description,
        required: r.required,
        ask_at_run_time: r.ask_at_run_time,
        value: r.value,
        position: r.position,
        created_at: r.created_at,
    })
    .collect();

    let mut steps = Vec::new();
    for r in sqlx::query!(
        "SELECT id, kind, name, description, prompt, additional_context, expected_output, output_name,
                output_description, output_file_format, model_id, model_settings, enabled_tool_ids,
                allow_failure, canvas_x, canvas_y, position, created_at
         FROM workflow_steps WHERE workflow_id = $1 ORDER BY position, created_at",
        uuid
    )
    .fetch_all(&mut *conn)
    .await
    .map_err(db)?
    {
        steps.push(Step {
            id: r.id.into(),
            kind: StepKind::parse(&r.kind).ok_or_else(|| corrupt("step kind"))?,
            name: r.name,
            description: r.description,
            prompt: r.prompt,
            additional_context: r.additional_context,
            expected_output: r.expected_output,
            output_name: r.output_name,
            output_description: r.output_description,
            output_file_format: OutputFileFormat::parse_or_default(&r.output_file_format),
            model_id: r.model_id,
            model_settings: match r.model_settings {
                Value::Object(map) => map,
                _ => Default::default(),
            },
            enabled_tool_ids: serde_json::from_value(r.enabled_tool_ids).unwrap_or_default(),
            allow_failure: r.allow_failure,
            canvas_x: r.canvas_x,
            canvas_y: r.canvas_y,
            position: r.position,
            inputs: Vec::new(),
            created_at: r.created_at,
        });
    }
    for r in sqlx::query!(
        "SELECT si.id, si.workflow_step_id, si.name, si.description, si.required, si.position,
                si.workflow_input_id, si.created_at
         FROM step_inputs si JOIN workflow_steps s ON s.id = si.workflow_step_id
         WHERE s.workflow_id = $1 ORDER BY si.position, si.created_at",
        uuid
    )
    .fetch_all(&mut *conn)
    .await
    .map_err(db)?
    {
        let step_id = StepId::from(r.workflow_step_id);
        if let Some(step) = steps.iter_mut().find(|s| s.id == step_id) {
            step.inputs.push(StepInput {
                id: r.id.into(),
                name: r.name,
                description: r.description,
                required: r.required,
                position: r.position,
                workflow_input_id: r.workflow_input_id.map(Into::into),
                created_at: r.created_at,
            });
        }
    }
    workflow.steps = steps;

    workflow.connections = sqlx::query!(
        "SELECT id, source_step_id, source_output_name, destination_step_id, destination_input_id, created_at
         FROM workflow_connections WHERE workflow_id = $1 ORDER BY created_at, id",
        uuid
    )
    .fetch_all(&mut *conn)
    .await
    .map_err(db)?
    .into_iter()
    .map(|r| Connection {
        id: r.id.into(),
        source_step_id: r.source_step_id.into(),
        source_output_name: r.source_output_name,
        destination_step_id: r.destination_step_id.into(),
        destination_input_id: r.destination_input_id.into(),
        created_at: r.created_at,
    })
    .collect();

    if let Some(r) = sqlx::query!(
        "SELECT id, enabled, cron_expression, timezone, human_description, next_run_at,
                last_dispatched_at, created_at
         FROM workflow_schedules WHERE workflow_id = $1",
        uuid
    )
    .fetch_optional(&mut *conn)
    .await
    .map_err(db)?
    {
        let mut values = Vec::new();
        for v in sqlx::query!(
            "SELECT id, workflow_input_id, value, created_at FROM workflow_schedule_values
             WHERE workflow_schedule_id = $1 ORDER BY created_at, id",
            r.id
        )
        .fetch_all(&mut *conn)
        .await
        .map_err(db)?
        {
            values.push(ScheduleValue {
                id: v.id.into(),
                workflow_input_id: v.workflow_input_id.into(),
                value: decrypt_json_string(cipher, v.value)?,
                created_at: v.created_at,
            });
        }
        workflow.schedule = Some(Schedule {
            id: r.id.into(),
            enabled: r.enabled,
            cron_expression: r.cron_expression,
            timezone: r.timezone,
            human_description: r.human_description,
            next_run_at: r.next_run_at,
            last_dispatched_at: r.last_dispatched_at,
            values,
            created_at: r.created_at,
        });
    }

    Ok(Some(workflow))
}

pub(crate) async fn save(
    conn: &mut PgConnection,
    cipher: &dyn Cipher,
    wf: &Workflow,
) -> DomainResult<()> {
    let wid = wf.id.as_uuid();

    sqlx::query!(
        r#"INSERT INTO workflows AS w
             (id, name, description, status, fail_fast, last_run_at, last_run_status, next_run_at, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
           ON CONFLICT (id) DO UPDATE SET
             name = EXCLUDED.name, description = EXCLUDED.description, status = EXCLUDED.status,
             fail_fast = EXCLUDED.fail_fast, last_run_at = EXCLUDED.last_run_at,
             last_run_status = EXCLUDED.last_run_status, next_run_at = EXCLUDED.next_run_at,
             updated_at = now()
           WHERE (w.name, w.description, w.status, w.fail_fast, w.last_run_at, w.last_run_status, w.next_run_at)
                 IS DISTINCT FROM
                 (EXCLUDED.name, EXCLUDED.description, EXCLUDED.status, EXCLUDED.fail_fast,
                  EXCLUDED.last_run_at, EXCLUDED.last_run_status, EXCLUDED.next_run_at)"#,
        wid,
        wf.name,
        wf.description,
        wf.status.as_str(),
        wf.fail_fast,
        wf.last_run_at,
        wf.last_run_status,
        wf.next_run_at,
        wf.created_at,
    )
    .execute(&mut *conn)
    .await
    .map_err(save_error)?;

    // --- deletes first, so replacements never collide with unique indexes ---
    let connection_ids: Vec<Uuid> = wf.connections.iter().map(|c| c.id.as_uuid()).collect();
    let step_ids: Vec<Uuid> = wf.steps.iter().map(|s| s.id.as_uuid()).collect();
    let step_input_ids: Vec<Uuid> = wf
        .steps
        .iter()
        .flat_map(|s| s.inputs.iter().map(|i| i.id.as_uuid()))
        .collect();
    let input_ids: Vec<Uuid> = wf.inputs.iter().map(|i| i.id.as_uuid()).collect();

    sqlx::query!(
        "DELETE FROM workflow_connections WHERE workflow_id = $1 AND NOT (id = ANY($2))",
        wid,
        &connection_ids
    )
    .execute(&mut *conn)
    .await
    .map_err(db)?;
    sqlx::query!(
        "DELETE FROM step_inputs si USING workflow_steps s
         WHERE s.id = si.workflow_step_id AND s.workflow_id = $1 AND NOT (si.id = ANY($2))",
        wid,
        &step_input_ids
    )
    .execute(&mut *conn)
    .await
    .map_err(db)?;
    sqlx::query!(
        "DELETE FROM workflow_steps WHERE workflow_id = $1 AND NOT (id = ANY($2))",
        wid,
        &step_ids
    )
    .execute(&mut *conn)
    .await
    .map_err(db)?;
    match &wf.schedule {
        None => {
            sqlx::query!("DELETE FROM workflow_schedules WHERE workflow_id = $1", wid)
                .execute(&mut *conn)
                .await
                .map_err(db)?;
        }
        Some(schedule) => {
            let value_ids: Vec<Uuid> = schedule.values.iter().map(|v| v.id.as_uuid()).collect();
            sqlx::query!(
                "DELETE FROM workflow_schedules WHERE workflow_id = $1 AND id <> $2",
                wid,
                schedule.id.as_uuid()
            )
            .execute(&mut *conn)
            .await
            .map_err(db)?;
            sqlx::query!(
                "DELETE FROM workflow_schedule_values WHERE workflow_schedule_id = $1 AND NOT (id = ANY($2))",
                schedule.id.as_uuid(),
                &value_ids
            )
            .execute(&mut *conn)
            .await
            .map_err(db)?;
        }
    }
    sqlx::query!(
        "DELETE FROM workflow_inputs WHERE workflow_id = $1 AND NOT (id = ANY($2))",
        wid,
        &input_ids
    )
    .execute(&mut *conn)
    .await
    .map_err(db)?;

    // --- upserts --------------------------------------------------------------
    if !wf.inputs.is_empty() {
        let i = &wf.inputs;
        sqlx::query!(
            r#"INSERT INTO workflow_inputs AS t
                 (id, workflow_id, name, description, required, ask_at_run_time, value, position, created_at)
               SELECT u.id, $1, u.name, u.description, u.required, u.ask, u.value, u.position, u.created_at
               FROM UNNEST($2::uuid[], $3::text[], $4::text[], $5::bool[], $6::bool[], $7::text[], $8::int[], $9::timestamptz[])
                 AS u(id, name, description, required, ask, value, position, created_at)
               ON CONFLICT (id) DO UPDATE SET
                 name = EXCLUDED.name, description = EXCLUDED.description, required = EXCLUDED.required,
                 ask_at_run_time = EXCLUDED.ask_at_run_time, value = EXCLUDED.value,
                 position = EXCLUDED.position, updated_at = now()
               WHERE (t.name, t.description, t.required, t.ask_at_run_time, t.value, t.position)
                     IS DISTINCT FROM
                     (EXCLUDED.name, EXCLUDED.description, EXCLUDED.required, EXCLUDED.ask_at_run_time,
                      EXCLUDED.value, EXCLUDED.position)"#,
            wid,
            &i.iter().map(|x| x.id.as_uuid()).collect::<Vec<_>>(),
            &i.iter().map(|x| x.name.clone()).collect::<Vec<_>>(),
            &i.iter().map(|x| x.description.clone()).collect::<Vec<_>>() as &[Option<String>],
            &i.iter().map(|x| x.required).collect::<Vec<_>>(),
            &i.iter().map(|x| x.ask_at_run_time).collect::<Vec<_>>(),
            &i.iter().map(|x| x.value.clone()).collect::<Vec<_>>() as &[Option<String>],
            &i.iter().map(|x| x.position).collect::<Vec<_>>(),
            &i.iter().map(|x| x.created_at).collect::<Vec<_>>(),
        )
        .execute(&mut *conn)
        .await
        .map_err(save_error)?;
    }

    if !wf.steps.is_empty() {
        let s = &wf.steps;
        sqlx::query!(
            r#"INSERT INTO workflow_steps AS t
                 (id, workflow_id, kind, name, description, prompt, additional_context, expected_output,
                  output_name, output_description, output_file_format, model_id, model_settings,
                  enabled_tool_ids, allow_failure, canvas_x, canvas_y, position, created_at)
               SELECT u.id, $1, u.kind, u.name, u.description, u.prompt, u.context, u.expected,
                      u.output_name, u.output_description, u.format, u.model_id, u.settings,
                      u.tools, u.allow_failure, u.x, u.y, u.position, u.created_at
               FROM UNNEST($2::uuid[], $3::text[], $4::text[], $5::text[], $6::text[], $7::text[], $8::text[],
                           $9::text[], $10::text[], $11::text[], $12::text[], $13::jsonb[], $14::jsonb[],
                           $15::bool[], $16::int[], $17::int[], $18::int[], $19::timestamptz[])
                 AS u(id, kind, name, description, prompt, context, expected, output_name, output_description,
                      format, model_id, settings, tools, allow_failure, x, y, position, created_at)
               ON CONFLICT (id) DO UPDATE SET
                 kind = EXCLUDED.kind, name = EXCLUDED.name, description = EXCLUDED.description,
                 prompt = EXCLUDED.prompt, additional_context = EXCLUDED.additional_context,
                 expected_output = EXCLUDED.expected_output, output_name = EXCLUDED.output_name,
                 output_description = EXCLUDED.output_description,
                 output_file_format = EXCLUDED.output_file_format, model_id = EXCLUDED.model_id,
                 model_settings = EXCLUDED.model_settings, enabled_tool_ids = EXCLUDED.enabled_tool_ids,
                 allow_failure = EXCLUDED.allow_failure, canvas_x = EXCLUDED.canvas_x,
                 canvas_y = EXCLUDED.canvas_y, position = EXCLUDED.position, updated_at = now()
               WHERE (t.kind, t.name, t.description, t.prompt, t.additional_context, t.expected_output,
                      t.output_name, t.output_description, t.output_file_format, t.model_id,
                      t.model_settings, t.enabled_tool_ids, t.allow_failure, t.canvas_x, t.canvas_y, t.position)
                     IS DISTINCT FROM
                     (EXCLUDED.kind, EXCLUDED.name, EXCLUDED.description, EXCLUDED.prompt,
                      EXCLUDED.additional_context, EXCLUDED.expected_output, EXCLUDED.output_name,
                      EXCLUDED.output_description, EXCLUDED.output_file_format, EXCLUDED.model_id,
                      EXCLUDED.model_settings, EXCLUDED.enabled_tool_ids, EXCLUDED.allow_failure,
                      EXCLUDED.canvas_x, EXCLUDED.canvas_y, EXCLUDED.position)"#,
            wid,
            &s.iter().map(|x| x.id.as_uuid()).collect::<Vec<_>>(),
            &s.iter().map(|x| x.kind.as_str().to_string()).collect::<Vec<_>>(),
            &s.iter().map(|x| x.name.clone()).collect::<Vec<_>>(),
            &s.iter().map(|x| x.description.clone()).collect::<Vec<_>>() as &[Option<String>],
            &s.iter().map(|x| x.prompt.clone()).collect::<Vec<_>>() as &[Option<String>],
            &s.iter().map(|x| x.additional_context.clone()).collect::<Vec<_>>() as &[Option<String>],
            &s.iter().map(|x| x.expected_output.clone()).collect::<Vec<_>>() as &[Option<String>],
            &s.iter().map(|x| x.output_name.clone()).collect::<Vec<_>>() as &[Option<String>],
            &s.iter().map(|x| x.output_description.clone()).collect::<Vec<_>>() as &[Option<String>],
            &s.iter().map(|x| x.output_file_format.as_str().to_string()).collect::<Vec<_>>(),
            &s.iter().map(|x| x.model_id.clone()).collect::<Vec<_>>() as &[Option<String>],
            &s.iter().map(|x| Value::Object(x.model_settings.clone())).collect::<Vec<_>>(),
            &s.iter().map(|x| serde_json::json!(x.enabled_tool_ids)).collect::<Vec<_>>(),
            &s.iter().map(|x| x.allow_failure).collect::<Vec<_>>(),
            &s.iter().map(|x| x.canvas_x).collect::<Vec<_>>(),
            &s.iter().map(|x| x.canvas_y).collect::<Vec<_>>(),
            &s.iter().map(|x| x.position).collect::<Vec<_>>(),
            &s.iter().map(|x| x.created_at).collect::<Vec<_>>(),
        )
        .execute(&mut *conn)
        .await
        .map_err(save_error)?;
    }

    let step_inputs: Vec<(Uuid, &StepInput)> = wf
        .steps
        .iter()
        .flat_map(|s| s.inputs.iter().map(move |i| (s.id.as_uuid(), i)))
        .collect();
    if !step_inputs.is_empty() {
        let si = &step_inputs;
        sqlx::query!(
            r#"INSERT INTO step_inputs AS t
                 (id, workflow_step_id, name, description, required, position, workflow_input_id, created_at)
               SELECT * FROM UNNEST($1::uuid[], $2::uuid[], $3::text[], $4::text[], $5::bool[], $6::int[],
                                    $7::uuid[], $8::timestamptz[])
               ON CONFLICT (id) DO UPDATE SET
                 workflow_step_id = EXCLUDED.workflow_step_id, name = EXCLUDED.name,
                 description = EXCLUDED.description, required = EXCLUDED.required,
                 position = EXCLUDED.position, workflow_input_id = EXCLUDED.workflow_input_id,
                 updated_at = now()
               WHERE (t.workflow_step_id, t.name, t.description, t.required, t.position, t.workflow_input_id)
                     IS DISTINCT FROM
                     (EXCLUDED.workflow_step_id, EXCLUDED.name, EXCLUDED.description, EXCLUDED.required,
                      EXCLUDED.position, EXCLUDED.workflow_input_id)"#,
            &si.iter().map(|(_, i)| i.id.as_uuid()).collect::<Vec<_>>(),
            &si.iter().map(|(s, _)| *s).collect::<Vec<_>>(),
            &si.iter().map(|(_, i)| i.name.clone()).collect::<Vec<_>>(),
            &si.iter().map(|(_, i)| i.description.clone()).collect::<Vec<_>>() as &[Option<String>],
            &si.iter().map(|(_, i)| i.required).collect::<Vec<_>>(),
            &si.iter().map(|(_, i)| i.position).collect::<Vec<_>>(),
            &si.iter().map(|(_, i)| i.workflow_input_id.map(|w| w.as_uuid())).collect::<Vec<_>>() as &[Option<Uuid>],
            &si.iter().map(|(_, i)| i.created_at).collect::<Vec<_>>(),
        )
        .execute(&mut *conn)
        .await
        .map_err(save_error)?;
    }

    if !wf.connections.is_empty() {
        let c = &wf.connections;
        sqlx::query!(
            r#"INSERT INTO workflow_connections AS t
                 (id, workflow_id, source_step_id, source_output_name, destination_step_id,
                  destination_input_id, created_at)
               SELECT u.id, $1, u.source, u.output, u.dest, u.input, u.created_at
               FROM UNNEST($2::uuid[], $3::uuid[], $4::text[], $5::uuid[], $6::uuid[], $7::timestamptz[])
                 AS u(id, source, output, dest, input, created_at)
               ON CONFLICT (id) DO UPDATE SET
                 source_step_id = EXCLUDED.source_step_id, source_output_name = EXCLUDED.source_output_name,
                 destination_step_id = EXCLUDED.destination_step_id,
                 destination_input_id = EXCLUDED.destination_input_id, updated_at = now()
               WHERE (t.source_step_id, t.source_output_name, t.destination_step_id, t.destination_input_id)
                     IS DISTINCT FROM
                     (EXCLUDED.source_step_id, EXCLUDED.source_output_name, EXCLUDED.destination_step_id,
                      EXCLUDED.destination_input_id)"#,
            wid,
            &c.iter().map(|x| x.id.as_uuid()).collect::<Vec<_>>(),
            &c.iter().map(|x| x.source_step_id.as_uuid()).collect::<Vec<_>>(),
            &c.iter().map(|x| x.source_output_name.clone()).collect::<Vec<_>>(),
            &c.iter().map(|x| x.destination_step_id.as_uuid()).collect::<Vec<_>>(),
            &c.iter().map(|x| x.destination_input_id.as_uuid()).collect::<Vec<_>>(),
            &c.iter().map(|x| x.created_at).collect::<Vec<_>>(),
        )
        .execute(&mut *conn)
        .await
        .map_err(save_error)?;
    }

    if let Some(schedule) = &wf.schedule {
        let sid = schedule.id.as_uuid();
        sqlx::query!(
            r#"INSERT INTO workflow_schedules AS t
                 (id, workflow_id, enabled, cron_expression, timezone, human_description, next_run_at,
                  last_dispatched_at, created_at)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
               ON CONFLICT (id) DO UPDATE SET
                 enabled = EXCLUDED.enabled, cron_expression = EXCLUDED.cron_expression,
                 timezone = EXCLUDED.timezone, human_description = EXCLUDED.human_description,
                 next_run_at = EXCLUDED.next_run_at, last_dispatched_at = EXCLUDED.last_dispatched_at,
                 updated_at = now()
               WHERE (t.enabled, t.cron_expression, t.timezone, t.human_description, t.next_run_at,
                      t.last_dispatched_at)
                     IS DISTINCT FROM
                     (EXCLUDED.enabled, EXCLUDED.cron_expression, EXCLUDED.timezone,
                      EXCLUDED.human_description, EXCLUDED.next_run_at, EXCLUDED.last_dispatched_at)"#,
            sid,
            wid,
            schedule.enabled,
            schedule.cron_expression,
            schedule.timezone,
            schedule.human_description,
            schedule.next_run_at,
            schedule.last_dispatched_at,
            schedule.created_at,
        )
        .execute(&mut *conn)
        .await
        .map_err(db)?;

        // Ciphertexts differ per encryption; only rewrite values that changed.
        let mut stored = std::collections::HashMap::new();
        for r in sqlx::query!(
            "SELECT id, value FROM workflow_schedule_values WHERE workflow_schedule_id = $1",
            sid
        )
        .fetch_all(&mut *conn)
        .await
        .map_err(db)?
        {
            stored.insert(r.id, decrypt_json_string(cipher, r.value)?);
        }
        for value in &schedule.values {
            if stored.get(&value.id.as_uuid()) == Some(&value.value) {
                continue;
            }
            sqlx::query!(
                r#"INSERT INTO workflow_schedule_values (id, workflow_schedule_id, workflow_input_id, value, created_at)
                   VALUES ($1, $2, $3, $4, $5)
                   ON CONFLICT (id) DO UPDATE SET value = EXCLUDED.value, updated_at = now()"#,
                value.id.as_uuid(),
                sid,
                value.workflow_input_id.as_uuid(),
                encrypt_json(cipher, &value.value),
                value.created_at,
            )
            .execute(&mut *conn)
            .await
            .map_err(db)?;
        }
    }
    Ok(())
}

fn escape_like(query: &str) -> String {
    let mut out = String::with_capacity(query.len() + 2);
    out.push('%');
    for c in query.chars() {
        if matches!(c, '%' | '_' | '\\') {
            out.push('\\');
        }
        out.push(c);
    }
    out.push('%');
    out
}

#[async_trait]
impl WorkflowStore for PgStore {
    async fn find(&self, id: WorkflowId) -> DomainResult<Option<Workflow>> {
        let mut conn = self.pool.acquire().await.map_err(db)?;
        load(&mut conn, self.cipher.as_ref(), id, false).await
    }

    async fn list(&self, filter: &ListFilter) -> DomainResult<Vec<WorkflowSummary>> {
        let query = filter.query.trim();
        let pattern = (!query.is_empty()).then(|| escape_like(query));
        let rows = sqlx::query!(
            r#"SELECT w.id, w.name, w.description, w.status, w.fail_fast, w.last_run_at, w.last_run_status,
                      w.next_run_at, w.created_at, w.updated_at,
                      CASE WHEN s.enabled THEN s.human_description END AS schedule_summary
               FROM workflows w LEFT JOIN workflow_schedules s ON s.workflow_id = w.id
               WHERE ($1::text IS NULL OR w.name ILIKE $1 OR w.description ILIKE $1)
                 AND ($2::text IS NULL OR w.status = $2)
               ORDER BY w.updated_at DESC
               LIMIT $3"#,
            pattern,
            filter.status.map(|s| s.as_str()),
            filter.limit,
        )
        .fetch_all(&self.pool)
        .await
        .map_err(db)?;
        rows.into_iter()
            .map(|r| {
                Ok(WorkflowSummary {
                    id: r.id.into(),
                    name: r.name,
                    description: r.description,
                    status: status(&r.status)?,
                    fail_fast: r.fail_fast,
                    last_run_at: r.last_run_at,
                    last_run_status: r.last_run_status,
                    next_run_at: r.next_run_at,
                    schedule_summary: r.schedule_summary,
                    created_at: r.created_at,
                    updated_at: r.updated_at,
                })
            })
            .collect()
    }

    async fn begin(&self) -> DomainResult<Box<dyn WorkflowTx>> {
        Ok(Box::new(self.tx().await?))
    }
}

#[async_trait]
impl WorkflowTx for PgTx {
    async fn lock_workflow(&mut self, id: WorkflowId) -> DomainResult<Option<Workflow>> {
        load(&mut self.tx, self.cipher.as_ref(), id, true).await
    }

    async fn load_workflow(&mut self, id: WorkflowId) -> DomainResult<Option<Workflow>> {
        load(&mut self.tx, self.cipher.as_ref(), id, false).await
    }

    async fn save_workflow(&mut self, workflow: &Workflow) -> DomainResult<()> {
        save(&mut self.tx, self.cipher.as_ref(), workflow).await
    }

    async fn active_workflow_ids(&mut self) -> DomainResult<Vec<WorkflowId>> {
        Ok(sqlx::query_scalar!(
            "SELECT id FROM workflows WHERE status = 'active' ORDER BY created_at"
        )
        .fetch_all(&mut *self.tx)
        .await
        .map_err(db)?
        .into_iter()
        .map(Into::into)
        .collect())
    }
}
