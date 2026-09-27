use crate::proto::pb::catalog_service_server::CatalogService;

#[derive(Clone)]
pub struct CatalogGrpc;

#[tonic::async_trait]
impl CatalogService for CatalogGrpc {}
