use crate::proto::pb::live_service_server::LiveService;

#[derive(Clone)]
pub struct LiveGrpc;

#[tonic::async_trait]
impl LiveService for LiveGrpc {}
