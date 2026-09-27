use tonic::{Request, Response, Status};

use crate::features::catalog::{AvailableModel, ListModels, RefreshModels, ToolDefinition};
use crate::proto::convert;
use crate::proto::pb;
use crate::proto::pb::catalog_service_server::CatalogService;

#[derive(Clone)]
pub struct CatalogGrpc {
    list: ListModels,
    refresh: RefreshModels,
}

impl CatalogGrpc {
    pub fn new(list: ListModels, refresh: RefreshModels) -> Self {
        Self { list, refresh }
    }
}

fn model(m: &AvailableModel) -> pb::AvailableModel {
    pb::AvailableModel {
        provider: m.provider.clone(),
        model_id: m.model_id.clone(),
        full_id: m.full_id(),
        display_name: m.display_name.clone().unwrap_or_else(|| m.model_id.clone()),
        available: m.available,
        capabilities: m
            .capabilities
            .keys()
            .map(|k| (k.clone(), m.capability(k)))
            .collect(),
        fetched_at: convert::opt_timestamp(m.fetched_at),
    }
}

fn tool(t: &ToolDefinition) -> pb::ToolDefinition {
    pb::ToolDefinition {
        key: t.key.clone(),
        display_name: t.display_name.clone(),
        description: t.description.clone().unwrap_or_default(),
        pi_tool_name: t.pi_tool_name.clone(),
        enabled: t.enabled,
    }
}

#[tonic::async_trait]
impl CatalogService for CatalogGrpc {
    async fn list_models(
        &self,
        request: Request<pb::ListModelsRequest>,
    ) -> Result<Response<pb::ListModelsResponse>, Status> {
        let list = self
            .list
            .models(request.into_inner().include_unavailable)
            .await?;
        Ok(Response::new(pb::ListModelsResponse {
            models: list.models.iter().map(model).collect(),
            stale: list.stale,
        }))
    }

    async fn list_tools(
        &self,
        _request: Request<pb::ListToolsRequest>,
    ) -> Result<Response<pb::ListToolsResponse>, Status> {
        let tools = self.list.tools().await?;
        Ok(Response::new(pb::ListToolsResponse {
            tools: tools.iter().map(tool).collect(),
        }))
    }

    async fn refresh_models(
        &self,
        _request: Request<pb::RefreshModelsRequest>,
    ) -> Result<Response<pb::RefreshModelsResponse>, Status> {
        let results = self.refresh.refresh_all().await;
        Ok(Response::new(pb::RefreshModelsResponse {
            results: results
                .into_iter()
                .map(|r| pb::ProviderRefreshResult {
                    provider: r.provider.as_str().to_string(),
                    refreshed: r.refreshed,
                    model_count: r.count as i32,
                    became_unavailable: r.became_unavailable,
                    error: r.error,
                })
                .collect(),
        }))
    }
}
