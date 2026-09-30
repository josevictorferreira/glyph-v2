//! Run + step run persistence. Evidence columns are AES-GCM encrypted in the
//! row mapping; status transitions are compare-and-set `UPDATE … WHERE status`.

use async_trait::async_trait;
use serde_json::{Map, Value};
use sqlx::PgConnection;
use uuid::Uuid;

use crate::features::live::domain::{LiveEvent, LiveKind};
use crate::features::runs::domain::input_resolver::Upstream;
use crate::features::runs::domain::model::*;
use crate::features::runs::ports::repository::{RunListFilter, RunStore, RunTx, StepFinish};
use crate::features::workflows::model::StepKind;
use crate::features::workflows::snapshot::Snapshot;
use crate::infrastructure::crypto::Cipher;
use crate::infrastructure::postgres::PgStore;
use crate::infrastructure::postgres::uow::{PgTx, db, notify};
use crate::shared::error::{DomainError, DomainResult};
use crate::shared::ids::{RunId, StepRunId, WorkflowId};
use crate::shared::output_format::OutputFileFormat;
use crate::shared::time::Timestamp;

fn corrupt(what: &str) -> DomainError {
    DomainError::Internal(anyhow::anyhow!("corrupt row: {what}"))
}

fn enc_text(cipher: &dyn Cipher, value: &Option<String>) -> Option<Vec<u8>> {
    value.as_ref().map(|v| cipher.encrypt(v.as_bytes()))
}

fn enc_json(cipher: &dyn Cipher, value: &Option<Value>) -> Option<Vec<u8>> {
    value
        .as_ref()
        .map(|v| cipher.encrypt(&serde_json::to_vec(v).expect("JSON serializes")))
}

fn dec(cipher: &dyn Cipher, blob: Option<Vec<u8>>, what: &str) -> DomainResult<Option<Vec<u8>>> {
    blob.map(|b| {
        cipher
            .decrypt(&b)
            .map_err(|e| DomainError::Internal(anyhow::anyhow!("decrypting {what}: {e}")))
    })
    .transpose()
}

fn dec_text(
    cipher: &dyn Cipher,
    blob: Option<Vec<u8>>,
    what: &str,
) -> DomainResult<Option<String>> {
    Ok(dec(cipher, blob, what)?.map(|b| String::from_utf8_lossy(&b).into_owned()))
}

fn dec_json(cipher: &dyn Cipher, blob: Option<Vec<u8>>, what: &str) -> DomainResult<Option<Value>> {
    dec(cipher, blob, what)?
        .map(|b| serde_json::from_slice(&b).map_err(DomainError::internal))
        .transpose()
}

fn statuses(list: &[StepRunStatus]) -> Vec<String> {
    list.iter().map(|s| s.as_str().to_string()).collect()
}

fn uuids(ids: &[StepRunId]) -> Vec<Uuid> {
    ids.iter().map(|i| i.as_uuid()).collect()
}

struct RunRow {
    id: Uuid,
    workflow_id: Uuid,
    status: String,
    trigger: String,
    draft_test: bool,
    snapshot: Value,
    supplied_values: Option<Vec<u8>>,
    schedule_occurrence_key: Option<String>,
    queued_at: Option<Timestamp>,
    started_at: Option<Timestamp>,
    ended_at: Option<Timestamp>,
    elapsed_ms: Option<i64>,
    active_ms: i64,
    resumed_at: Option<Timestamp>,
    failure_summary: Option<String>,
    first_failed_step_run_id: Option<Uuid>,
    created_at: Timestamp,
}

fn run_from(cipher: &dyn Cipher, r: RunRow) -> DomainResult<Run> {
    let snapshot: Snapshot = serde_json::from_value(r.snapshot).map_err(DomainError::internal)?;
    let supplied_values = match dec_json(cipher, r.supplied_values, "supplied values")? {
        Some(Value::Object(map)) => map,
        _ => Map::new(),
    };
    Ok(Run {
        id: r.id.into(),
        workflow_id: r.workflow_id.into(),
        status: RunStatus::parse(&r.status).ok_or_else(|| corrupt("run status"))?,
        trigger: RunTrigger::parse(&r.trigger).ok_or_else(|| corrupt("run trigger"))?,
        draft_test: r.draft_test,
        snapshot,
        supplied_values,
        schedule_occurrence_key: r.schedule_occurrence_key,
        queued_at: r.queued_at,
        started_at: r.started_at,
        ended_at: r.ended_at,
        elapsed_ms: r.elapsed_ms,
        active_ms: r.active_ms,
        resumed_at: r.resumed_at,
        failure_summary: r.failure_summary,
        first_failed_step_run_id: r.first_failed_step_run_id.map(Into::into),
        created_at: r.created_at,
    })
}

macro_rules! step_run_from {
    ($cipher:expr, $r:expr) => {{
        let r = $r;
        let cipher: &dyn Cipher = $cipher;
        StepRun {
            id: r.id.into(),
            run_id: r.workflow_run_id.into(),
            snapshot_step_id: r.snapshot_step_id.to_string(),
            step_name: r.step_name,
            step_kind: StepKind::parse(&r.step_kind).ok_or_else(|| corrupt("step kind"))?,
            status: StepRunStatus::parse(&r.status).ok_or_else(|| corrupt("step run status"))?,
            position: r.position,
            allow_failure: r.allow_failure,
            prompt: r.prompt,
            additional_context: r.additional_context,
            expected_output: r.expected_output,
            model_id: r.model_id,
            model_settings: match r.model_settings {
                Value::Object(m) => m,
                _ => Map::new(),
            },
            enabled_tools: serde_json::from_value(r.enabled_tools).unwrap_or_default(),
            output_name: r.output_name,
            output_file_format: OutputFileFormat::parse_or_default(&r.output_file_format),
            resolved_inputs: dec_json(cipher, r.resolved_inputs, "resolved inputs")?,
            output: dec_json(cipher, r.output, "output")?,
            output_text: dec_text(cipher, r.output_text, "output text")?,
            messages: dec_json(cipher, r.messages, "messages")?,
            session_content: dec_text(cipher, r.session_content, "session content")?,
            technical_error: dec_text(cipher, r.technical_error, "technical error")?,
            human_error: r.human_error,
            skipped_reason: r.skipped_reason,
            queued_at: r.queued_at,
            started_at: r.started_at,
            ended_at: r.ended_at,
            elapsed_ms: r.elapsed_ms,
            created_at: r.created_at,
        }
    }};
}

async fn load_run(
    conn: &mut PgConnection,
    cipher: &dyn Cipher,
    id: RunId,
    lock: bool,
) -> DomainResult<Option<Run>> {
    let row = if lock {
        sqlx::query_as!(
            RunRow,
            "SELECT id, workflow_id, status, trigger, draft_test, snapshot, supplied_values,
                    schedule_occurrence_key, queued_at, started_at, ended_at, elapsed_ms,
                    active_ms, resumed_at, failure_summary, first_failed_step_run_id, created_at
             FROM workflow_runs WHERE id = $1 FOR UPDATE",
            id.as_uuid()
        )
        .fetch_optional(&mut *conn)
        .await
    } else {
        sqlx::query_as!(
            RunRow,
            "SELECT id, workflow_id, status, trigger, draft_test, snapshot, supplied_values,
                    schedule_occurrence_key, queued_at, started_at, ended_at, elapsed_ms,
                    active_ms, resumed_at, failure_summary, first_failed_step_run_id, created_at
             FROM workflow_runs WHERE id = $1",
            id.as_uuid()
        )
        .fetch_optional(&mut *conn)
        .await
    }
    .map_err(db)?;
    row.map(|r| run_from(cipher, r)).transpose()
}

async fn load_step_runs(
    conn: &mut PgConnection,
    cipher: &dyn Cipher,
    run: Option<RunId>,
    one: Option<StepRunId>,
) -> DomainResult<Vec<StepRun>> {
    let rows = sqlx::query!(
        "SELECT id, workflow_run_id, snapshot_step_id, step_name, step_kind, status, position,
                allow_failure, prompt, additional_context, expected_output, model_id, model_settings,
                enabled_tools, output_name, output_file_format, resolved_inputs, output, output_text,
                messages, session_content, technical_error, human_error, skipped_reason, queued_at,
                started_at, ended_at, elapsed_ms, created_at
         FROM step_runs
         WHERE ($1::uuid IS NULL OR workflow_run_id = $1) AND ($2::uuid IS NULL OR id = $2)
         ORDER BY position, created_at, id",
        run.map(|r| r.as_uuid()),
        one.map(|s| s.as_uuid()),
    )
    .fetch_all(&mut *conn)
    .await
    .map_err(db)?;
    let mut out = Vec::with_capacity(rows.len());
    for r in rows {
        out.push(step_run_from!(cipher, r));
    }
    Ok(out)
}

#[async_trait]
impl RunStore for PgStore {
    async fn find_run(&self, id: RunId) -> DomainResult<Option<Run>> {
        let mut conn = self.pool.acquire().await.map_err(db)?;
        load_run(&mut conn, self.cipher.as_ref(), id, false).await
    }

    async fn list_runs(
        &self,
        workflow: WorkflowId,
        filter: &RunListFilter,
    ) -> DomainResult<Vec<Run>> {
        let rows = sqlx::query_as!(
            RunRow,
            "SELECT id, workflow_id, status, trigger, draft_test, snapshot, supplied_values,
                    schedule_occurrence_key, queued_at, started_at, ended_at, elapsed_ms,
                    active_ms, resumed_at, failure_summary, first_failed_step_run_id, created_at
             FROM workflow_runs
             WHERE workflow_id = $1 AND ($2::timestamptz IS NULL OR created_at < $2)
             ORDER BY created_at DESC, id DESC
             LIMIT $3",
            workflow.as_uuid(),
            filter.before,
            filter.limit,
        )
        .fetch_all(&self.pool)
        .await
        .map_err(db)?;
        rows.into_iter()
            .map(|r| run_from(self.cipher.as_ref(), r))
            .collect()
    }

    async fn step_runs(&self, run: RunId) -> DomainResult<Vec<StepRun>> {
        let mut conn = self.pool.acquire().await.map_err(db)?;
        load_step_runs(&mut conn, self.cipher.as_ref(), Some(run), None).await
    }

    async fn find_step_run(&self, id: StepRunId) -> DomainResult<Option<StepRun>> {
        let mut conn = self.pool.acquire().await.map_err(db)?;
        Ok(
            load_step_runs(&mut conn, self.cipher.as_ref(), None, Some(id))
                .await?
                .into_iter()
                .next(),
        )
    }

    async fn record_progress(
        &self,
        workflow: WorkflowId,
        run: RunId,
        step_run: StepRunId,
        session_content: &str,
    ) -> DomainResult<()> {
        let mut tx = self.pool.begin().await.map_err(db)?;
        let updated = sqlx::query!(
            "UPDATE step_runs SET session_content = $2, updated_at = now() WHERE id = $1 AND status = 'running'",
            step_run.as_uuid(),
            self.cipher.encrypt(session_content.as_bytes()),
        )
        .execute(&mut *tx)
        .await
        .map_err(db)?
        .rows_affected();
        if updated > 0 {
            notify(
                &mut tx,
                &LiveEvent {
                    kind: LiveKind::StepRunProgress,
                    workflow_id: workflow.to_string(),
                    run_id: Some(run.to_string()),
                    step_run_id: Some(step_run.to_string()),
                    occurred_at: chrono::Utc::now(),
                },
            )
            .await?;
        }
        tx.commit().await.map_err(db)
    }

    async fn begin(&self) -> DomainResult<Box<dyn RunTx>> {
        Ok(Box::new(self.tx().await?))
    }
}

#[async_trait]
impl RunTx for PgTx {
    async fn insert_run(&mut self, run: &Run, step_runs: &[StepRun]) -> DomainResult<()> {
        let cipher = self.cipher.clone();
        sqlx::query!(
            "INSERT INTO workflow_runs
               (id, workflow_id, status, trigger, draft_test, snapshot, supplied_values,
                schedule_occurrence_key, queued_at, created_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)",
            run.id.as_uuid(),
            run.workflow_id.as_uuid(),
            run.status.as_str(),
            run.trigger.as_str(),
            run.draft_test,
            serde_json::to_value(&run.snapshot).map_err(DomainError::internal)?,
            enc_json(
                cipher.as_ref(),
                &Some(Value::Object(run.supplied_values.clone()))
            ),
            run.schedule_occurrence_key,
            run.queued_at,
            run.created_at,
        )
        .execute(&mut *self.tx)
        .await
        .map_err(crate::infrastructure::postgres::runs_repo::insert_error)?;
        for s in step_runs {
            sqlx::query!(
                "INSERT INTO step_runs
                   (id, workflow_run_id, snapshot_step_id, step_name, step_kind, status, position,
                    allow_failure, prompt, additional_context, expected_output, model_id, model_settings,
                    enabled_tools, output_name, output_file_format, queued_at, created_at)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)",
                s.id.as_uuid(),
                s.run_id.as_uuid(),
                s.snapshot_step_id.parse::<Uuid>().map_err(DomainError::internal)?,
                s.step_name,
                s.step_kind.as_str(),
                s.status.as_str(),
                s.position,
                s.allow_failure,
                s.prompt,
                s.additional_context,
                s.expected_output,
                s.model_id,
                Value::Object(s.model_settings.clone()),
                serde_json::to_value(&s.enabled_tools).map_err(DomainError::internal)?,
                s.output_name,
                s.output_file_format.as_str(),
                s.queued_at,
                s.created_at,
            )
            .execute(&mut *self.tx)
            .await
            .map_err(db)?;
        }
        Ok(())
    }

    async fn lock_run(&mut self, id: RunId) -> DomainResult<Option<Run>> {
        load_run(&mut self.tx, self.cipher.as_ref(), id, true).await
    }

    async fn step_run_states(&mut self, run: RunId) -> DomainResult<Vec<StepRunState>> {
        let rows = sqlx::query!(
            "SELECT id, snapshot_step_id, step_name, status, allow_failure, human_error, started_at, created_at
             FROM step_runs WHERE workflow_run_id = $1 ORDER BY position, created_at, id",
            run.as_uuid()
        )
        .fetch_all(&mut *self.tx)
        .await
        .map_err(db)?;
        rows.into_iter()
            .map(|r| {
                Ok(StepRunState {
                    id: r.id.into(),
                    snapshot_step_id: r.snapshot_step_id.to_string(),
                    step_name: r.step_name,
                    status: StepRunStatus::parse(&r.status)
                        .ok_or_else(|| corrupt("step run status"))?,
                    allow_failure: r.allow_failure,
                    human_error: r.human_error,
                    started_at: r.started_at,
                    created_at: r.created_at,
                })
            })
            .collect()
    }

    async fn upstreams(&mut self, run: RunId) -> DomainResult<Vec<Upstream>> {
        let rows = sqlx::query!(
            "SELECT id, snapshot_step_id, step_name, status, allow_failure, output, output_text
             FROM step_runs WHERE workflow_run_id = $1 AND status IN ('succeeded', 'failed')",
            run.as_uuid()
        )
        .fetch_all(&mut *self.tx)
        .await
        .map_err(db)?;
        let cipher = self.cipher.as_ref();
        rows.into_iter()
            .map(|r| {
                Ok(Upstream {
                    id: r.id.into(),
                    snapshot_step_id: r.snapshot_step_id.to_string(),
                    step_name: r.step_name,
                    status: StepRunStatus::parse(&r.status)
                        .ok_or_else(|| corrupt("step run status"))?,
                    allow_failure: r.allow_failure,
                    output: dec_json(cipher, r.output, "output")?,
                    output_text: dec_text(cipher, r.output_text, "output text")?,
                })
            })
            .collect()
    }

    async fn save_run(&mut self, run: &Run) -> DomainResult<()> {
        sqlx::query!(
            "UPDATE workflow_runs SET status = $2, started_at = $3, ended_at = $4, elapsed_ms = $5,
                    active_ms = $6, resumed_at = $7, failure_summary = $8,
                    first_failed_step_run_id = $9, updated_at = now()
             WHERE id = $1",
            run.id.as_uuid(),
            run.status.as_str(),
            run.started_at,
            run.ended_at,
            run.elapsed_ms,
            run.active_ms,
            run.resumed_at,
            run.failure_summary,
            run.first_failed_step_run_id.map(|i| i.as_uuid()),
        )
        .execute(&mut *self.tx)
        .await
        .map_err(db)?;
        Ok(())
    }

    async fn start_run(&mut self, id: RunId, at: Timestamp) -> DomainResult<bool> {
        Ok(sqlx::query!(
            "UPDATE workflow_runs SET status = 'running', started_at = $2, updated_at = now()
             WHERE id = $1 AND status = 'queued'",
            id.as_uuid(),
            at
        )
        .execute(&mut *self.tx)
        .await
        .map_err(db)?
        .rows_affected()
            == 1)
    }

    async fn start_step_run(&mut self, id: StepRunId, at: Timestamp) -> DomainResult<bool> {
        Ok(sqlx::query!(
            "UPDATE step_runs SET status = 'running', started_at = $2, updated_at = now()
             WHERE id = $1 AND status = 'queued'",
            id.as_uuid(),
            at
        )
        .execute(&mut *self.tx)
        .await
        .map_err(db)?
        .rows_affected()
            == 1)
    }

    async fn set_resolved_inputs(&mut self, id: StepRunId, resolved: &Value) -> DomainResult<()> {
        sqlx::query!(
            "UPDATE step_runs SET resolved_inputs = $2, updated_at = now() WHERE id = $1",
            id.as_uuid(),
            enc_json(self.cipher.as_ref(), &Some(resolved.clone())),
        )
        .execute(&mut *self.tx)
        .await
        .map_err(db)?;
        Ok(())
    }

    async fn mark_step_runs(
        &mut self,
        ids: &[StepRunId],
        from: &[StepRunStatus],
        to: StepRunStatus,
        ended_at: Timestamp,
        skipped_reason: Option<&str>,
    ) -> DomainResult<Vec<StepRunId>> {
        if ids.is_empty() {
            return Ok(Vec::new());
        }
        Ok(sqlx::query_scalar!(
            "UPDATE step_runs SET status = $3, ended_at = $4, skipped_reason = COALESCE($5, skipped_reason),
                    updated_at = now()
             WHERE id = ANY($1) AND status = ANY($2)
             RETURNING id",
            &uuids(ids),
            &statuses(from),
            to.as_str(),
            ended_at,
            skipped_reason,
        )
        .fetch_all(&mut *self.tx)
        .await
        .map_err(db)?
        .into_iter()
        .map(Into::into)
        .collect())
    }

    async fn finish_step_run(
        &mut self,
        id: StepRunId,
        from: StepRunStatus,
        f: &StepFinish,
    ) -> DomainResult<bool> {
        let cipher = self.cipher.clone();
        Ok(sqlx::query!(
            "UPDATE step_runs SET status = $3, ended_at = $4, elapsed_ms = $5, output = $6, output_text = $7,
                    messages = $8, session_content = $9, human_error = $10, technical_error = $11,
                    skipped_reason = $12, updated_at = now()
             WHERE id = $1 AND status = $2",
            id.as_uuid(),
            from.as_str(),
            f.status.as_str(),
            f.ended_at,
            f.elapsed_ms,
            enc_json(cipher.as_ref(), &f.output),
            enc_text(cipher.as_ref(), &f.output_text),
            enc_json(cipher.as_ref(), &f.messages),
            enc_text(cipher.as_ref(), &f.session_content),
            f.human_error,
            enc_text(cipher.as_ref(), &f.technical_error),
            f.skipped_reason,
        )
        .execute(&mut *self.tx)
        .await
        .map_err(db)?
        .rows_affected()
            == 1)
    }

    async fn reset_step_runs(
        &mut self,
        ids: &[StepRunId],
        from: &[StepRunStatus],
        now: Timestamp,
    ) -> DomainResult<Vec<StepRunId>> {
        if ids.is_empty() {
            return Ok(Vec::new());
        }
        Ok(sqlx::query_scalar!(
            "UPDATE step_runs SET status = 'queued', queued_at = $3, started_at = NULL, ended_at = NULL, elapsed_ms = NULL,
                    output_text = NULL, output = NULL, messages = NULL, session_content = NULL,
                    human_error = NULL, technical_error = NULL, skipped_reason = NULL, updated_at = now()
             WHERE id = ANY($1) AND status = ANY($2)
             RETURNING id",
            &uuids(ids),
            &statuses(from),
            now,
        )
        .fetch_all(&mut *self.tx)
        .await
        .map_err(db)?
        .into_iter()
        .map(Into::into)
        .collect())
    }

    async fn set_workflow_last_run(
        &mut self,
        workflow: WorkflowId,
        at: Timestamp,
        status: RunStatus,
    ) -> DomainResult<()> {
        sqlx::query!(
            "UPDATE workflows SET last_run_at = $2, last_run_status = $3, updated_at = now() WHERE id = $1",
            workflow.as_uuid(),
            at,
            status.as_str(),
        )
        .execute(&mut *self.tx)
        .await
        .map_err(db)?;
        Ok(())
    }

    async fn delete_run(&mut self, id: RunId) -> DomainResult<bool> {
        Ok(
            sqlx::query!("DELETE FROM workflow_runs WHERE id = $1", id.as_uuid())
                .execute(&mut *self.tx)
                .await
                .map_err(db)?
                .rows_affected()
                == 1,
        )
    }
}

/// A duplicate occurrence key means the occurrence was already dispatched.
pub const OCCURRENCE_TAKEN: &str =
    crate::features::scheduling::application::dispatch_due::OCCURRENCE_TAKEN;

pub(crate) fn insert_error(error: sqlx::Error) -> DomainError {
    if let sqlx::Error::Database(e) = &error
        && e.constraint() == Some("index_workflow_runs_on_schedule_occurrence_key")
    {
        return DomainError::precondition(
            OCCURRENCE_TAKEN,
            "This occurrence was already dispatched.",
        );
    }
    db(error)
}

#[async_trait]
impl crate::features::scheduling::SchedulingStore for PgStore {
    async fn due_workflow_ids(&self, now: Timestamp) -> DomainResult<Vec<WorkflowId>> {
        Ok(sqlx::query_scalar!(
            "SELECT w.id FROM workflows w JOIN workflow_schedules s ON s.workflow_id = w.id
             WHERE w.status = 'active' AND s.enabled AND s.next_run_at <= $1
             ORDER BY s.next_run_at, w.id",
            now
        )
        .fetch_all(&self.pool)
        .await
        .map_err(db)?
        .into_iter()
        .map(Into::into)
        .collect())
    }

    async fn begin(&self) -> DomainResult<Box<dyn RunTx>> {
        Ok(Box::new(self.tx().await?))
    }
}
