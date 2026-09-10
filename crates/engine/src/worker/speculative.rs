//! The controlled speculative loop. `with_controlled_chat_speculative` lends a
//! `&mut dyn ControlledSpeculativeSession` to a FnOnce closure; the worker's
//! command loop runs INSIDE that closure. "Pause" means not calling `step()`;
//! cancel goes through the request's cancellation token (cross-thread).

use std::sync::atomic::Ordering;
use std::sync::mpsc::Receiver;
use std::collections::BTreeMap;

use eredu::api::{
    PreparedChatGenerationSettings, PreparedChatInput, PreparedChatSpeculativeGenerationRequest,
    SamplingOverride,
};
use eredu_core::capture::CapturePlan;
use eredu_core::intervention::InterventionPlan;
use eredu_core::speculative::{SpeculativeCaptureRole, SpeculativeInterventionPlan};
use eredu_core::GenerationCancellationToken;
use eredu_runtime::speculative::{
    ControlledSpeculativeOptions, ControlledSpeculativeSession, SpeculativeBranchHandle,
    SpeculativeSnapshotHandle,
};
use serde::Serialize;

use eredu::runtime::chat::{ChatTemplateRequest, ToolChoice};
use eredu_core::{GenerationConfigOverrides, TextSamplingStrategy};
use eredu_runtime::execution_control::TraceLimits;

use crate::budgets::{self, ClampNote};
use crate::error::{error_chain, IpcError};
use crate::journal::{RunMeta, RunStatus};
use crate::stream::StreamKind;
use crate::worker::load::LoadedWorkerModel;
use crate::worker::{Command, Emitter, Reply, RunStartedDto, StartRunSpecDto, WorkerContext};

/// Parsed speculative-run settings (parallel to controlled::prepare_spec but
/// with per-role interventions and speculative capture semantics).
pub struct PreparedSpecSettings {
    pub chat_request: ChatTemplateRequest,
    pub settings: PreparedChatGenerationSettings,
    pub stops: Vec<String>,
    pub trace: TraceLimits,
    pub snapshot_limits: eredu_core::execution_control::SnapshotLimits,
    pub capture: Option<CapturePlan>,
    pub intervention_target: Option<serde_json::Value>,
    pub intervention_draft: Option<serde_json::Value>,
    pub clamp_notes: Vec<ClampNote>,
}

impl PreparedSpecSettings {
    pub fn from_spec(spec: &StartRunSpecDto) -> Result<Self, IpcError> {
        let resolved = budgets::resolve(&spec.budgets.clone().unwrap_or_default());
        let messages = if let Some(raw) = &spec.raw_text {
            vec![serde_json::json!({"role": "user", "content": raw})]
        } else {
            spec.messages.clone()
        };
        let tool_choice = match spec.tool_choice.as_deref() {
            Some("none") => ToolChoice::None,
            Some("required") => ToolChoice::Required,
            _ => ToolChoice::Auto,
        };
        let chat_request = ChatTemplateRequest {
            messages,
            tools: spec.tools.clone(),
            tool_choice,
            enable_thinking: spec.enable_thinking,
            reasoning_effort: spec.reasoning_effort.clone(),
            add_generation_prompt: true,
            ..Default::default()
        };
        let overrides: GenerationConfigOverrides = serde_json::from_value(spec.overrides.clone())
            .map_err(|e| IpcError::Internal { message: format!("overrides: {e}") })?;
        let strategy = match &spec.strategy {
            Some(v) if v.get("kind").and_then(|k| k.as_str()) == Some("mirostatV2") => {
                TextSamplingStrategy::MirostatV2 {
                    tau: v.get("tau").and_then(|t| t.as_f64()).unwrap_or(5.0) as f32,
                    eta: v.get("eta").and_then(|t| t.as_f64()).unwrap_or(0.1) as f32,
                }
            }
            _ => TextSamplingStrategy::Standard,
        };
        let capture: Option<CapturePlan> = match &spec.capture {
            Some(value) if !value.is_null() => Some(
                serde_json::from_value(value.clone())
                    .map_err(|e| IpcError::Internal { message: format!("capture plan: {e}") })?,
            ),
            _ => None,
        };
        Ok(Self {
            chat_request,
            settings: PreparedChatGenerationSettings {
                overrides,
                strategy,
                seed: spec.seed.unwrap_or(42),
            },
            stops: spec.stops.clone(),
            trace: resolved.trace,
            snapshot_limits: resolved.snapshots,
            capture,
            intervention_target: spec.intervention.clone(),
            intervention_draft: spec.intervention_draft.clone(),
            clamp_notes: resolved.notes,
        })
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpecStatusDto {
    pub status: String,
    pub run_id: String,
    #[serde(with = "crate::lossless::u64_string")]
    pub epoch: u64,
    pub token_count: u64,
    pub terminal: bool,
    pub snapshot_support: Option<String>,
}

pub enum SpecCommand {
    Step { actions: u32, reply: Reply<SpecStatusDto> },
    Run { reply: Reply<SpecStatusDto> },
    Pause { reply: Reply<()> },
    ForceToken { token_id: u32, reply: Reply<()> },
    ClearForced { reply: Reply<bool> },
    OverrideSampling {
        temperature: Option<f32>,
        reseed: Option<u64>,
        reply: Reply<String>,
    },
    Intervene {
        target: Option<serde_json::Value>,
        draft: Option<serde_json::Value>,
        reply: Reply<()>,
    },
    Snapshot { reply: Reply<String> },
    Restore { snapshot_id: String, reply: Reply<SpecStatusDto> },
    Fork { snapshot_id: String, reply: Reply<String> },
    Exchange { branch_id: String, reply: Reply<SpecStatusDto> },
    ReleaseSnapshot { snapshot_id: String, reply: Reply<()> },
    ReleaseBranch { branch_id: String, reply: Reply<()> },
    SnapshotSupport { reply: Reply<String> },
    End { reply: Reply<()> },
}

pub fn reject(cmd: SpecCommand) {
    let err = || IpcError::NoActiveSession;
    match cmd {
        SpecCommand::Step { reply, .. } => drop(reply.send(Err(err()))),
        SpecCommand::Run { reply } => drop(reply.send(Err(err()))),
        SpecCommand::Pause { reply } => drop(reply.send(Err(err()))),
        SpecCommand::ForceToken { reply, .. } => drop(reply.send(Err(err()))),
        SpecCommand::ClearForced { reply } => drop(reply.send(Err(err()))),
        SpecCommand::OverrideSampling { reply, .. } => drop(reply.send(Err(err()))),
        SpecCommand::Intervene { reply, .. } => drop(reply.send(Err(err()))),
        SpecCommand::Snapshot { reply } => drop(reply.send(Err(err()))),
        SpecCommand::Restore { reply, .. } => drop(reply.send(Err(err()))),
        SpecCommand::Fork { reply, .. } => drop(reply.send(Err(err()))),
        SpecCommand::Exchange { reply, .. } => drop(reply.send(Err(err()))),
        SpecCommand::ReleaseSnapshot { reply, .. } => drop(reply.send(Err(err()))),
        SpecCommand::ReleaseBranch { reply, .. } => drop(reply.send(Err(err()))),
        SpecCommand::SnapshotSupport { reply } => drop(reply.send(Err(err()))),
        SpecCommand::End { reply } => drop(reply.send(Ok(()))),
    }
}

fn spec_error(op: &str, e: &dyn std::error::Error) -> IpcError {
    IpcError::Speculative {
        op: op.to_string(),
        message: e.to_string(),
        chain: error_chain(e),
    }
}

fn run_label(model_epoch: u64, run_id: u64) -> String {
    format!("spec:{model_epoch}:{run_id}")
}

fn status_dto(
    model_epoch: u64,
    session: &dyn ControlledSpeculativeSession,
    terminal: bool,
) -> SpecStatusDto {
    SpecStatusDto {
        status: serde_json::to_value(session.status())
            .ok()
            .and_then(|v| v.as_str().map(String::from))
            .unwrap_or_default(),
        run_id: run_label(model_epoch, session.run_id()),
        epoch: session.epoch(),
        token_count: session.token_ids().len() as u64,
        terminal,
        snapshot_support: serde_json::to_string(&session.snapshot_support()).ok(),
    }
}

/// Run one speculative tree. Returns a queued command that must be replayed.
pub fn run_speculative(
    loaded: &mut LoadedWorkerModel,
    spec: StartRunSpecDto,
    reply: Reply<RunStartedDto>,
    rx: &Receiver<Command>,
    context: &WorkerContext,
) -> Option<Command> {
    let Some(spec_options) = loaded.speculative_options.clone() else {
        let _ = reply.send(Err(IpcError::Capability {
            operation: "speculative run".into(),
            reason: "drafting is disabled for this load — reload the model with a drafter".into(),
        }));
        return None;
    };
    let prepared = match PreparedSpecSettings::from_spec(&spec) {
        Ok(p) => p,
        Err(e) => {
            let _ = reply.send(Err(e));
            return None;
        }
    };

    let chat = match loaded.model.prepare_chat(prepared.chat_request.clone()) {
        Ok(chat) => chat,
        Err(e) => {
            let _ = reply.send(Err(spec_error("prepare_chat", &e)));
            return None;
        }
    };

    // One-row model.logits capture admission (the only speculative capture).
    let admitted_capture = match &prepared.capture {
        Some(plan) => {
            match loaded
                .model
                .prepare_speculative_capture(prepared.settings.clone(), plan.clone())
            {
                Ok(admitted) => Some(admitted),
                Err(e) => {
                    let _ = reply.send(Err(spec_error("prepare_speculative_capture", &e)));
                    return None;
                }
            }
        }
        None => None,
    };
    let pending_interventions = match build_role_plans(
        &loaded.model,
        &admitted_capture,
        prepared.intervention_target.clone(),
        prepared.intervention_draft.clone(),
    ) {
        Ok(p) => p,
        Err(e) => {
            let _ = reply.send(Err(e));
            return None;
        }
    };

    let cancellation = GenerationCancellationToken::new();
    *context
        .shared
        .spec_cancellation
        .lock()
        .expect("control poisoned") = Some(cancellation.clone());
    context.shared.spec_pause.store(false, Ordering::SeqCst);

    let options = ControlledSpeculativeOptions {
        trace_limits: prepared.trace,
        capture: admitted_capture,
        snapshots: Some(prepared.snapshot_limits),
    };
    let emitter = context.emitter.clone();
    let model_epoch = emitter.model_epoch;
    let spec_json = serde_json::to_string(&spec).unwrap_or_else(|_| "{}".into());
    let created_ms = spec.created_ms.unwrap_or(0);

    // The semantic callback fires inside step(); it labels envelopes with the
    // active run id maintained by the drive loop.
    let active_run = std::rc::Rc::new(std::cell::Cell::new(0u64));
    let semantic_run = active_run.clone();
    let semantic_emitter = emitter.clone();
    let on_event = move |event: eredu_core::SemanticEvent| {
        let label = run_label(model_epoch, semantic_run.get());
        let _ = semantic_emitter.emit_serialize(StreamKind::SpeculativeSemantic, &label, &event);
    };

    let mut pending: Option<Command> = None;
    let mut start_reply = Some(reply);
    let drive_emitter = emitter.clone();
    let drive_journal = emitter.journal.clone();
    let drive_shared = context.shared.clone();
    let pending_ref = &mut pending;
    let (model, drafting) = (&mut loaded.model, &mut loaded.drafting);
    let Some(draft) = drafting.as_speculative_draft() else {
        let _ = start_reply.take().unwrap().send(Err(IpcError::Capability {
            operation: "speculative run".into(),
            reason: "drafting resources were not realized at load".into(),
        }));
        return None;
    };

    let request = PreparedChatSpeculativeGenerationRequest {
        input: PreparedChatInput::rendered_prompt(&chat),
        drafting: draft,
        settings: prepared.settings.clone(),
        options: spec_options,
        caller_stop_sequences: &prepared.stops,
        cancellation,
        on_event,
    };

    let clamp_notes = prepared.clamp_notes.clone();
    let result = model.with_controlled_chat_speculative(request, options, |session| {
        active_run.set(session.run_id());
        let root_label = run_label(model_epoch, session.run_id());
        drive_journal.register_run(RunMeta {
            run_id: root_label.clone(),
            model_epoch,
            artifact_path: drive_emitter.artifact_path.display().to_string(),
            model_label: drive_emitter.model_label.clone(),
            speculative: true,
            spec_json: spec_json.clone(),
            lineage: None,
            status: RunStatus::Active,
            resumable: true,
            pinned: false,
            created_ms,
        });
        if let Some(reply) = start_reply.take() {
            let _ = reply.send(Ok(RunStartedDto {
                run_id: root_label,
                speculative: true,
                clamp_notes: clamp_notes.clone(),
                capabilities: None,
                snapshot_support: serde_json::to_string(&session.snapshot_support()).ok(),
            }));
        }

        let mut snapshots: BTreeMap<String, SpeculativeSnapshotHandle> = BTreeMap::new();
        let mut branches: BTreeMap<String, SpeculativeBranchHandle> = BTreeMap::new();
        let mut next_id = 0u64;
        let mut installed_interventions = pending_interventions.clone();
        if !installed_interventions.is_empty() {
            if let Err(e) = session.intervene(installed_interventions.drain(..).collect()) {
                drive_emitter.emit_system(&serde_json::json!({
                    "kind": "speculative_intervention_rejected",
                    "message": e.to_string(),
                }));
            }
        }

        let mut terminal = false;
        loop {
            let command = match rx.recv() {
                Ok(c) => c,
                Err(_) => break,
            };
            match command {
                Command::Spec(cmd) => {
                    let end = handle_spec_command(
                        cmd,
                        session,
                        &drive_emitter,
                        &drive_shared,
                        &active_run,
                        &mut snapshots,
                        &mut branches,
                        &mut next_id,
                        &mut terminal,
                        model_epoch,
                    );
                    if end {
                        break;
                    }
                }
                Command::Session(cmd) => super::reject_session(cmd),
                Command::VocabPage { offset, limit, query, reply } => {
                    // Vocabulary access stays available mid-run for token forcing.
                    let vocab = drive_shared_vocab(&drive_emitter);
                    let page = match &vocab {
                        Some(v) => crate::vocab::page(v.as_slice(), offset, limit, query.as_deref()),
                        None => crate::worker::VocabPageDto { total: 0, entries: vec![] },
                    };
                    let _ = reply.send(Ok(page));
                }
                Command::Describe(reply) => {
                    let _ = reply.send(Err(IpcError::SessionActive {
                        active_run: run_label(model_epoch, session.run_id()),
                    }));
                }
                Command::Encode { reply, .. } => {
                    let _ = reply.send(Err(IpcError::SessionActive {
                        active_run: run_label(model_epoch, session.run_id()),
                    }));
                }
                Command::Decode { reply, .. } => {
                    let _ = reply.send(Err(IpcError::SessionActive {
                        active_run: run_label(model_epoch, session.run_id()),
                    }));
                }
                other @ (Command::StartRun { .. }
                | Command::StartSpeculativeRun { .. }
                | Command::Shutdown(_)) => {
                    *pending_ref = Some(other);
                    break;
                }
            }
        }
        // Returning ends the scope: unfinished native work is cancelled/settled.
        let _ = session.cancel();
        Ok(())
    });

    *context
        .shared
        .spec_cancellation
        .lock()
        .expect("control poisoned") = None;

    match result {
        Ok(_output) => {
            // Per-step verification records already carry acceptance data; the
            // frontend derives aggregate stats from them.
            emitter.emit_system(&serde_json::json!({ "kind": "speculative_finished" }));
        }
        Err(e) => {
            if start_reply.is_some() {
                let _ = start_reply.take().unwrap().send(Err(spec_error("start", &e)));
            } else {
                emitter.emit_system(&serde_json::json!({
                    "kind": "speculative_failed",
                    "message": e.to_string(),
                }));
            }
        }
    }
    pending
}

// The vocabulary is owned by LoadedWorkerModel which is mutably borrowed for
// the whole speculative scope; the emitter carries a weak copy instead.
fn drive_shared_vocab(emitter: &Emitter) -> Option<std::sync::Arc<Vec<(u32, String)>>> {
    emitter.vocabulary.lock().expect("vocab poisoned").clone()
}

#[allow(clippy::too_many_arguments)]
fn handle_spec_command(
    cmd: SpecCommand,
    session: &mut dyn ControlledSpeculativeSession,
    emitter: &Emitter,
    shared: &crate::worker::SharedControl,
    active_run: &std::rc::Rc<std::cell::Cell<u64>>,
    snapshots: &mut BTreeMap<String, SpeculativeSnapshotHandle>,
    branches: &mut BTreeMap<String, SpeculativeBranchHandle>,
    next_id: &mut u64,
    terminal: &mut bool,
    model_epoch: u64,
) -> bool {
    let emit_step = |session: &mut dyn ControlledSpeculativeSession,
                     emitter: &Emitter|
     -> Result<bool, IpcError> {
        match session.step() {
            Ok(Some(step)) => {
                let label = run_label(model_epoch, step.run_id);
                emitter.emit_serialize(StreamKind::Speculative, &label, &step);
                Ok(false)
            }
            Ok(None) => Ok(true),
            Err(e) => Err(spec_error("step", &e)),
        }
    };
    match cmd {
        SpecCommand::Step { actions, reply } => {
            let mut result = Ok(());
            for _ in 0..actions.max(1) {
                match emit_step(session, emitter) {
                    Ok(true) => {
                        *terminal = true;
                        break;
                    }
                    Ok(false) => {}
                    Err(e) => {
                        result = Err(e);
                        break;
                    }
                }
            }
            active_run.set(session.run_id());
            let _ = reply.send(result.map(|()| status_dto(model_epoch, session, *terminal)));
        }
        SpecCommand::Run { reply } => {
            shared.spec_pause.store(false, Ordering::SeqCst);
            let mut result = Ok(());
            loop {
                if shared.spec_pause.load(Ordering::SeqCst) {
                    break;
                }
                match emit_step(session, emitter) {
                    Ok(true) => {
                        *terminal = true;
                        break;
                    }
                    Ok(false) => {}
                    Err(e) => {
                        result = Err(e);
                        break;
                    }
                }
            }
            active_run.set(session.run_id());
            let _ = reply.send(result.map(|()| status_dto(model_epoch, session, *terminal)));
        }
        SpecCommand::Pause { reply } => {
            shared.spec_pause.store(true, Ordering::SeqCst);
            let _ = reply.send(Ok(()));
        }
        SpecCommand::ForceToken { token_id, reply } => {
            let _ = reply.send(
                session
                    .force_next_token(token_id)
                    .map_err(|e| spec_error("force_next_token", &e)),
            );
        }
        SpecCommand::ClearForced { reply } => {
            let _ = reply.send(
                session
                    .clear_forced_token()
                    .map_err(|e| spec_error("clear_forced_token", &e)),
            );
        }
        SpecCommand::OverrideSampling { temperature, reseed, reply } => {
            let _ = reply.send(
                session
                    .override_sampling(SamplingOverride { temperature, reseed })
                    .map(|facts| serde_json::to_string(&facts).unwrap_or_default())
                    .map_err(|e| spec_error("override_sampling", &e)),
            );
        }
        SpecCommand::Intervene { .. } => {
            // Re-admission requires the model, which the session borrow holds;
            // v1 installs role plans at run start only.
            if let SpecCommand::Intervene { reply, .. } = cmd {
                let _ = reply.send(Err(IpcError::Capability {
                    operation: "speculative intervene".into(),
                    reason: "attach speculative interventions when starting the run".into(),
                }));
            }
        }
        SpecCommand::Snapshot { reply } => {
            let result = session
                .snapshot()
                .map(|handle| {
                    let id = format!("spec-snap-{next_id}");
                    *next_id += 1;
                    snapshots.insert(id.clone(), handle);
                    id
                })
                .map_err(|e| spec_error("snapshot", &e));
            let _ = reply.send(result);
        }
        SpecCommand::Restore { snapshot_id, reply } => {
            let result = match snapshots.get(&snapshot_id) {
                Some(handle) => session
                    .restore(handle)
                    .map(|()| status_dto(model_epoch, session, *terminal))
                    .map_err(|e| spec_error("restore", &e)),
                None => Err(IpcError::RunNotFound { run_id: snapshot_id }),
            };
            active_run.set(session.run_id());
            let _ = reply.send(result);
        }
        SpecCommand::Fork { snapshot_id, reply } => {
            let result = match snapshots.get(&snapshot_id) {
                Some(handle) => session
                    .fork(handle)
                    .map(|branch| {
                        let id = format!("spec-branch-{next_id}");
                        *next_id += 1;
                        branches.insert(id.clone(), branch);
                        id
                    })
                    .map_err(|e| spec_error("fork", &e)),
                None => Err(IpcError::RunNotFound { run_id: snapshot_id }),
            };
            let _ = reply.send(result);
        }
        SpecCommand::Exchange { branch_id, reply } => {
            let result = match branches.get(&branch_id) {
                Some(branch) => session
                    .exchange(branch)
                    .map(|_info| status_dto(model_epoch, session, *terminal))
                    .map_err(|e| spec_error("exchange", &e)),
                None => Err(IpcError::RunNotFound { run_id: branch_id }),
            };
            active_run.set(session.run_id());
            let _ = reply.send(result);
        }
        SpecCommand::ReleaseSnapshot { snapshot_id, reply } => {
            let result = match snapshots.remove(&snapshot_id) {
                Some(handle) => session
                    .release_snapshot(&handle)
                    .map_err(|e| spec_error("release_snapshot", &e)),
                None => Err(IpcError::RunNotFound { run_id: snapshot_id }),
            };
            let _ = reply.send(result);
        }
        SpecCommand::ReleaseBranch { branch_id, reply } => {
            let result = match branches.remove(&branch_id) {
                Some(branch) => session
                    .release_branch(&branch)
                    .map_err(|e| spec_error("release_branch", &e)),
                None => Err(IpcError::RunNotFound { run_id: branch_id }),
            };
            let _ = reply.send(result);
        }
        SpecCommand::SnapshotSupport { reply } => {
            let _ = reply.send(Ok(serde_json::to_string(&session.snapshot_support())
                .unwrap_or_default()));
        }
        SpecCommand::End { reply } => {
            let _ = reply.send(Ok(()));
            return true;
        }
    }
    false
}

fn build_role_plans(
    model: &eredu::api::LoadedModel<crate::worker::load::Backend>,
    admitted: &Option<eredu_core::capture::AdmittedCapturePlan>,
    target: Option<serde_json::Value>,
    draft: Option<serde_json::Value>,
) -> Result<Vec<SpeculativeInterventionPlan>, IpcError> {
    let mut plans = Vec::new();
    let Some(admitted) = admitted else {
        if target.is_some() || draft.is_some() {
            return Err(IpcError::Capability {
                operation: "speculative intervention".into(),
                reason: "speculative interventions require a capture admission".into(),
            });
        }
        return Ok(plans);
    };
    for (role, value) in [
        (SpeculativeCaptureRole::Target, target),
        (SpeculativeCaptureRole::Draft, draft),
    ] {
        if let Some(v) = value {
            if v.is_null() {
                continue;
            }
            let plan: InterventionPlan = serde_json::from_value(v)
                .map_err(|e| IpcError::Internal { message: format!("intervention plan: {e}") })?;
            let prepared = model
                .prepare_speculative_intervention(admitted, role, plan)
                .map_err(|e| spec_error("prepare_speculative_intervention", &e))?;
            plans.push(prepared);
        }
    }
    Ok(plans)
}

