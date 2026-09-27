use tonic::{Request, Response, Status};

use crate::features::definition::application::DefinitionService;
use crate::features::workflows::workflow_to_pb;
use crate::proto::convert::{issues, parse_id, parse_opt_id};
use crate::proto::pb;
use crate::proto::pb::definition_service_server::DefinitionService as Rpc;

#[derive(Clone)]
pub struct DefinitionGrpc {
    service: DefinitionService,
}

impl DefinitionGrpc {
    pub fn new(service: DefinitionService) -> Self {
        Self { service }
    }
}

type Rsp<T> = Result<Response<T>, Status>;

#[tonic::async_trait]
impl Rpc for DefinitionGrpc {
    async fn export_definition(&self, r: Request<pb::ExportDefinitionRequest>) -> Rsp<pb::ExportDefinitionResponse> {
        let export = self
            .service
            .export(parse_id(&r.get_ref().workflow_id, "workflow_id")?)
            .await?;
        Ok(Response::new(pb::ExportDefinitionResponse {
            yaml: export.yaml,
            fingerprint: export.fingerprint,
            filename: export.filename,
        }))
    }

    async fn get_schema_url(&self, _r: Request<pb::GetSchemaUrlRequest>) -> Rsp<pb::GetSchemaUrlResponse> {
        Ok(Response::new(pb::GetSchemaUrlResponse {
            url: self.service.schema_url(),
        }))
    }

    async fn parse_definition(&self, r: Request<pb::ParseDefinitionRequest>) -> Rsp<pb::ParseDefinitionResponse> {
        let r = r.into_inner();
        let id = parse_opt_id(r.workflow_id.as_deref(), "workflow_id")?;
        let errors = self.service.parse(id, &r.yaml).await?;
        Ok(Response::new(pb::ParseDefinitionResponse {
            errors: errors
                .into_iter()
                .map(|e| pb::DefinitionError {
                    path: e.path,
                    line: e.line,
                    message: e.message,
                })
                .collect(),
        }))
    }

    async fn apply_definition(&self, r: Request<pb::ApplyDefinitionRequest>) -> Rsp<pb::ApplyDefinitionResponse> {
        let r = r.into_inner();
        let m = self
            .service
            .apply(parse_id(&r.workflow_id, "workflow_id")?, &r.yaml, Some(&r.fingerprint))
            .await?;
        Ok(Response::new(pb::ApplyDefinitionResponse {
            workflow: Some(workflow_to_pb(&m.workflow)),
            issues: issues(&m.issues),
            new_fingerprint: m.value,
        }))
    }

    async fn import_workflow(&self, r: Request<pb::ImportWorkflowRequest>) -> Rsp<pb::ImportWorkflowResponse> {
        let m = self.service.import(&r.get_ref().yaml).await?;
        Ok(Response::new(pb::ImportWorkflowResponse {
            workflow: Some(workflow_to_pb(&m.workflow)),
            issues: issues(&m.issues),
        }))
    }
}
