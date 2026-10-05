//! `LiveService.WatchWorkflow`: server-streamed id-only notifications.

use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;

use chrono::Utc;
use futures_core::Stream;
use futures_util::StreamExt;
use tokio::sync::broadcast::error::RecvError;
use tokio_util::sync::CancellationToken;
use tonic::{Request, Response, Status};

use crate::features::live::domain::{LiveEvent, LiveKind};
use crate::features::live::ports::LiveBus;
use crate::proto::convert::{parse_id, timestamp};
use crate::proto::pb;
use crate::proto::pb::live_service_server::LiveService;
use crate::shared::ids::WorkflowId;

#[derive(Clone)]
pub struct LiveGrpc {
    bus: Arc<dyn LiveBus>,
    heartbeat: Option<Duration>,
    stop: CancellationToken,
}

impl LiveGrpc {
    pub fn new(
        bus: Arc<dyn LiveBus>,
        heartbeat: Option<Duration>,
        stop: CancellationToken,
    ) -> Self {
        Self {
            bus,
            heartbeat,
            stop,
        }
    }
}

fn kind(k: LiveKind) -> pb::EventType {
    match k {
        LiveKind::WorkflowUpdated => pb::EventType::WorkflowUpdated,
        LiveKind::RunQueued => pb::EventType::RunQueued,
        LiveKind::RunStarted => pb::EventType::RunStarted,
        LiveKind::RunSucceeded => pb::EventType::RunSucceeded,
        LiveKind::RunFailed => pb::EventType::RunFailed,
        LiveKind::RunCancelled => pb::EventType::RunCancelled,
        LiveKind::RunDeleted => pb::EventType::RunDeleted,
        LiveKind::StepRunQueued => pb::EventType::StepRunQueued,
        LiveKind::StepRunStarted => pb::EventType::StepRunStarted,
        LiveKind::StepRunProgress => pb::EventType::StepRunProgress,
        LiveKind::StepRunSucceeded => pb::EventType::StepRunSucceeded,
        LiveKind::StepRunFailed => pb::EventType::StepRunFailed,
        LiveKind::StepRunSkipped => pb::EventType::StepRunSkipped,
        LiveKind::StepRunCancelled => pb::EventType::StepRunCancelled,
        LiveKind::Resync => pb::EventType::Resync,
        LiveKind::Heartbeat => pb::EventType::Heartbeat,
    }
}

fn message(workflow: &str, event: &LiveEvent) -> pb::WatchWorkflowResponse {
    pb::WatchWorkflowResponse {
        event: Some(pb::WorkflowEvent {
            r#type: kind(event.kind) as i32,
            workflow_id: workflow.to_string(),
            run_id: event.run_id.clone(),
            step_run_id: event.step_run_id.clone(),
            occurred_at: Some(timestamp(event.occurred_at)),
        }),
    }
}

fn synthetic(kind: LiveKind, workflow: &str) -> LiveEvent {
    LiveEvent {
        kind,
        workflow_id: workflow.to_string(),
        run_id: None,
        step_run_id: None,
        occurred_at: Utc::now(),
    }
}

pub type EventStream =
    Pin<Box<dyn Stream<Item = Result<pb::WatchWorkflowResponse, Status>> + Send>>;

struct State {
    rx: tokio::sync::broadcast::Receiver<LiveEvent>,
    workflow: String,
    heartbeat: Option<tokio::time::Interval>,
    stop: CancellationToken,
}

/// Events for `workflow` (and broadcast RESYNCs); a lagging subscriber gets a
/// RESYNC instead of the events it missed. Ends when the bus closes or on
/// server shutdown. The stream opens with a HEARTBEAT so clients can mark
/// the connection live without waiting for an event — a quiet workflow may
/// go minutes between events.
pub fn watch(
    bus: &dyn LiveBus,
    workflow: WorkflowId,
    heartbeat: Option<Duration>,
    stop: CancellationToken,
) -> EventStream {
    let greeting = message(
        &workflow.to_string(),
        &synthetic(LiveKind::Heartbeat, &workflow.to_string()),
    );
    let state = State {
        rx: bus.subscribe(),
        workflow: workflow.to_string(),
        heartbeat: heartbeat.map(|every| {
            let mut i = tokio::time::interval_at(tokio::time::Instant::now() + every, every);
            i.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            i
        }),
        stop,
    };
    Box::pin(
        futures_util::stream::once(async move { Ok(greeting) }).chain(
            futures_util::stream::unfold(state, |mut s| async move {
                loop {
                    let beat = async {
                        match s.heartbeat.as_mut() {
                            Some(i) => {
                                i.tick().await;
                            }
                            None => std::future::pending::<()>().await,
                        }
                    };
                    let event = tokio::select! {
                        _ = s.stop.cancelled() => return None,
                        _ = beat => synthetic(LiveKind::Heartbeat, &s.workflow),
                        received = s.rx.recv() => match received {
                            Ok(e) if e.workflow_id == s.workflow || (e.kind == LiveKind::Resync && e.workflow_id.is_empty()) => e,
                            Ok(_) => continue,
                            Err(RecvError::Lagged(_)) => synthetic(LiveKind::Resync, &s.workflow),
                            Err(RecvError::Closed) => return None,
                        },
                    };
                    let msg = message(&s.workflow, &event);
                    return Some((Ok(msg), s));
                }
            }),
        ),
    )
}

#[tonic::async_trait]
impl LiveService for LiveGrpc {
    async fn watch_workflow(
        &self,
        request: Request<pb::WatchWorkflowRequest>,
    ) -> Result<Response<EventStream>, Status> {
        let workflow = parse_id(&request.get_ref().workflow_id, "workflow_id")?;
        Ok(Response::new(watch(
            self.bus.as_ref(),
            workflow,
            self.heartbeat,
            self.stop.clone(),
        )))
    }
}
