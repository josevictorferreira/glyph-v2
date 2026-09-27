use crate::proto::pb::workflow_service_server::WorkflowService;

#[derive(Clone)]
pub struct WorkflowGrpc;

#[tonic::async_trait]
impl WorkflowService for WorkflowGrpc {}
