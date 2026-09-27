//! YAML definition use cases (Rails `Importer`, `YamlEditor#apply`,
//! `WorkflowsController#definition`).

use std::sync::Arc;

use crate::features::definition::domain::parser::{self, ExistingStep};
use crate::features::definition::domain::types::DefinitionError;
use crate::features::definition::domain::{applier, exporter, schema};
use crate::features::workflows::{CatalogReader, Mutation, Workflow, WorkflowStore, validator};
use crate::shared::error::{DomainError, DomainResult, Violation};
use crate::shared::ids::WorkflowId;
use crate::shared::time::Clock;

pub struct Export {
    pub yaml: String,
    pub fingerprint: String,
    pub filename: String,
}

#[derive(Clone)]
pub struct DefinitionService {
    store: Arc<dyn WorkflowStore>,
    catalog: Arc<dyn CatalogReader>,
    clock: Arc<dyn Clock>,
    /// Absolute base URL for the schema header (e.g. https://glyph.example).
    public_url: Option<String>,
}

fn violations(errors: Vec<DefinitionError>) -> DomainError {
    DomainError::Violations(
        errors
            .into_iter()
            .map(|e| Violation {
                path: e.path,
                line: e.line,
                message: e.message,
            })
            .collect(),
    )
}

/// Storage-level validation failures become an unlocated document error.
fn as_violation(error: DomainError) -> DomainError {
    match error {
        DomainError::Invalid(message) => DomainError::Violations(vec![Violation {
            path: None,
            line: None,
            message,
        }]),
        other => other,
    }
}

fn existing_steps(workflow: &Workflow) -> Vec<ExistingStep> {
    workflow
        .steps
        .iter()
        .map(|s| ExistingStep {
            id: s.id,
            name: s.name.clone(),
        })
        .collect()
}

impl DefinitionService {
    pub fn new(
        store: Arc<dyn WorkflowStore>,
        catalog: Arc<dyn CatalogReader>,
        clock: Arc<dyn Clock>,
        public_url: Option<String>,
    ) -> Self {
        Self {
            store,
            catalog,
            clock,
            public_url,
        }
    }

    pub fn schema_url(&self) -> String {
        match &self.public_url {
            Some(base) => schema::url(base),
            None => schema::ROUTE.to_string(),
        }
    }

    async fn workflow(&self, id: WorkflowId) -> DomainResult<Workflow> {
        self.store
            .find(id)
            .await?
            .ok_or(DomainError::NotFound("workflow"))
    }

    pub async fn export(&self, id: WorkflowId) -> DomainResult<Export> {
        let workflow = self.workflow(id).await?;
        Ok(Export {
            yaml: exporter::export(&workflow, Some(&self.schema_url())),
            fingerprint: exporter::fingerprint(&workflow),
            filename: exporter::filename(&workflow),
        })
    }

    /// Dry run: every error the document has, nothing written.
    pub async fn parse(
        &self,
        id: Option<WorkflowId>,
        yaml: &str,
    ) -> DomainResult<Vec<DefinitionError>> {
        let existing = match id {
            Some(id) => Some(existing_steps(&self.workflow(id).await?)),
            None => None,
        };
        Ok(parser::parse(yaml, existing.as_deref())
            .err()
            .unwrap_or_default())
    }

    /// Stale fingerprint → Conflict before any change; errors roll back.
    pub async fn apply(
        &self,
        id: WorkflowId,
        yaml: &str,
        fingerprint: Option<&str>,
    ) -> DomainResult<Mutation<String>> {
        let catalog = self.catalog.view().await?;
        let now = self.clock.now();
        let mut tx = self.store.begin().await?;
        let mut workflow = tx
            .lock_workflow(id)
            .await?
            .ok_or(DomainError::NotFound("workflow"))?;
        if let Some(expected) = fingerprint.filter(|f| !f.is_empty())
            && expected != exporter::fingerprint(&workflow)
        {
            return Err(DomainError::Conflict);
        }
        let document = parser::parse(yaml, Some(&existing_steps(&workflow))).map_err(violations)?;
        let mut events = applier::apply(&mut workflow, &document, now);
        let (issues, more) = workflow.revalidate(&catalog);
        events.extend(more);
        tx.save_workflow(&workflow).await.map_err(as_violation)?;
        tx.append_events(&events).await?;
        let workflow = tx
            .load_workflow(id)
            .await?
            .ok_or(DomainError::NotFound("workflow"))?;
        tx.commit().await?;
        let value = exporter::fingerprint(&workflow);
        Ok(Mutation {
            workflow,
            issues,
            value,
        })
    }

    /// Creates a draft workflow from a document; any failure creates nothing.
    pub async fn import(&self, yaml: &str) -> DomainResult<Mutation> {
        let document = parser::parse(yaml, None).map_err(violations)?;
        let catalog = self.catalog.view().await?;
        let now = self.clock.now();
        let (mut workflow, mut events) = Workflow::create(&document.name, None, false, now);
        events.extend(applier::apply(&mut workflow, &document, now));
        let (_, more) = workflow.revalidate(&catalog);
        events.extend(more);
        let mut tx = self.store.begin().await?;
        tx.save_workflow(&workflow).await.map_err(as_violation)?;
        tx.append_events(&events).await?;
        let workflow = tx
            .load_workflow(workflow.id)
            .await?
            .ok_or(DomainError::NotFound("workflow"))?;
        tx.commit().await?;
        let issues = validator::validate(&workflow, &catalog);
        Ok(Mutation {
            workflow,
            issues,
            value: (),
        })
    }
}
