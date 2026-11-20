//! `SettingsService` gRPC edge.
use crate::features::settings::application::{Settings, SettingsService};
use crate::proto::pb;
use crate::proto::pb::settings_service_server::SettingsService as Rpc;
use tonic::{Request, Response, Status};

#[derive(Clone)]
pub struct SettingsGrpc {
    service: SettingsService,
}

impl SettingsGrpc {
    pub fn new(service: SettingsService) -> Self {
        Self { service }
    }
}

fn to_pb(settings: &Settings) -> pb::GetSettingsResponse {
    pb::GetSettingsResponse {
        chat_model_id: settings.chat_model_id.clone(),
    }
}

type Rsp<T> = Result<Response<T>, Status>;

#[tonic::async_trait]
impl Rpc for SettingsGrpc {
    async fn get_settings(
        &self,
        _r: Request<pb::GetSettingsRequest>,
    ) -> Rsp<pb::GetSettingsResponse> {
        Ok(Response::new(to_pb(&self.service.get().await?)))
    }
    async fn update_settings(
        &self,
        r: Request<pb::UpdateSettingsRequest>,
    ) -> Rsp<pb::UpdateSettingsResponse> {
        let settings = self.service.update(r.into_inner().chat_model_id).await?;
        Ok(Response::new(pb::UpdateSettingsResponse {
            chat_model_id: settings.chat_model_id.clone(),
        }))
    }
}
