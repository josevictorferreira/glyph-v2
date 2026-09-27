use crate::proto::pb::definition_service_server::DefinitionService;

#[derive(Clone)]
pub struct DefinitionGrpc;

#[tonic::async_trait]
impl DefinitionService for DefinitionGrpc {}
