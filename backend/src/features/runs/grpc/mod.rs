use crate::proto::pb::run_service_server::RunService;

#[derive(Clone)]
pub struct RunGrpc;

#[tonic::async_trait]
impl RunService for RunGrpc {}
