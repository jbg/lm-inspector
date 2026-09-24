//! The model-owner worker. One OS thread owns the `LoadedModel` and every
//! session/snapshot/branch handle (none are Send). Commands arrive over a
//! bounded channel with per-command reply channels; pause/cancel bypass the
//! queue entirely through `SharedControl` (a `GenerationControlHandle` is the
//! only eredu type that crosses threads).

pub mod component;
pub mod controlled;
pub mod load;
pub mod memory;
pub mod speculative;

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{sync_channel, Receiver, SyncSender};
use std::sync::{Arc, Mutex};

use eredu_core::execution_control::GenerationControlHandle;
use eredu_core::GenerationCancellationToken;
use serde::{Deserialize, Serialize};

use crate::budgets::BudgetOverridesDto;
use crate::error::IpcError;
use crate::journal::JournalStore;
use crate::stream::{DeliveryGate, EventSink, GateSendError, Phase, RunEventEnvelope, StreamKind};

pub type Reply<T> = SyncSender<Result<T, IpcError>>;

/// Cross-thread control surface: pause/cancel stay responsive while the worker
/// is blocked inside `session.run(emit)` or the delivery gate.
#[derive(Default)]
pub struct SharedControl {
    pub handle: Mutex<Option<GenerationControlHandle>>,
    pub spec_cancellation: Mutex<Option<GenerationCancellationToken>>,
    /// Engine-level pause flag for the speculative loop ("pause" = stop
    /// calling step()).
    pub spec_pause: AtomicBool,
}

impl SharedControl {
    pub fn pause(&self) -> bool {
        self.spec_pause.store(true, Ordering::SeqCst);
        if let Some(handle) = self.handle.lock().expect("control poisoned").as_ref() {
            handle.request_pause();
            true
        } else {
            false
        }
    }

    pub fn cancel(&self) -> bool {
        let mut any = false;
        if let Some(handle) = self.handle.lock().expect("control poisoned").as_ref() {
            handle.cancel();
            any = true;
        }
        if let Some(token) = self
            .spec_cancellation
            .lock()
            .expect("control poisoned")
            .as_ref()
        {
            token.cancel();
            any = true;
        }
        any
    }
}

// ---------- DTOs ----------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", rename_all_fields = "camelCase", tag = "kind")]
pub enum DraftingDto {
    Disabled,
    Embedded {
        max_draft_tokens: u32,
        lookahead: bool,
        adaptive_lookahead: bool,
    },
    External {
        /// HF-cache artifact path of the drafter model.
        model_path: String,
        max_draft_tokens: u32,
        lookahead: bool,
        adaptive_lookahead: bool,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DeviceDto {
    Cpu,
    Accelerator,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoadPlanDto {
    pub device: DeviceDto,
    #[serde(default)]
    pub drafting: Option<DraftingDto>,
    /// Process-global MLX allocator-cache limit applied before loading. It
    /// bounds cache retention (so memory forecasts get a bounded overhead)
    /// at the cost of more allocator churn. Absent = leave MLX's limit as is.
    #[serde(default)]
    pub allocator_cache_limit_bytes: Option<u64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoadedModelInfoDto {
    #[serde(with = "crate::lossless::u64_string")]
    pub model_epoch: u64,
    pub artifact_path: String,
    pub model_label: String,
    /// Full HF repo id (e.g. "org/name") parsed from the cache path, when the
    /// artifact lives under a "models--org--name" cache directory.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub repo_id: Option<String>,
    pub effective_model_type: String,
    pub eos_token_ids: Vec<u32>,
    /// Why this executable cannot chunk ordinary plain-text prefill (every
    /// run then prefills in one pass); absent = bounded prefill chunks work.
    /// Captures, interventions, media and speculative runs keep a full pass
    /// regardless.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub prefill_chunking_unsupported: Option<String>,
    /// The process's native allocator-cache limit in force after this load
    /// (eredu reads it from MLX); absent only when the query failed.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub allocator_cache_limit_bytes: Option<u64>,
    /// Its provenance: "native_default" | "managed_default" | "explicit" |
    /// "preserved" (eredu caps an untouched native default at 256 MiB when a
    /// model is realized).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub allocator_cache_policy: Option<String>,
    /// The tokenizer's special (control) tokens, ascending by id. Raw-text
    /// prompts add nothing automatically, so the composer offers these for
    /// the user to insert literally (BOS, end-of-text, turn markers).
    pub special_tokens: Vec<SpecialTokenDto>,
    pub has_chat_template: bool,
    pub drafting: String,
    pub vocabulary_size: u32,
    /// Kwargs the chat template accepts (e.g. "enable_thinking",
    /// "reasoning_effort") — the UI offers only what the template understands.
    pub chat_template_kwargs: Vec<String>,
    /// The checkpoint's own generation_config (eredu resolves unset request
    /// overrides from this) — the UI shows these as inherited placeholders.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub checkpoint_generation_config: Option<serde_json::Value>,
    /// Serialized `CaptureDiscovery` / `InterventionDiscovery` JSON.
    pub capture_discovery: String,
    pub intervention_discovery: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub speculative_intervention_discovery: Option<String>,
    /// Why controlled execution (step/pause/force/snapshots) is unavailable
    /// for this architecture, probed at load; absent = controlled runs work.
    /// None must serialize as absent, not null — the frontend distinguishes
    /// "supported" from "unsupported" by the field's presence.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub control_support: Option<String>,
    /// Why observed (free-run) generation is unavailable: it runs the
    /// semantic pipeline only, so a chat template with no recognized format
    /// can never run observed. Absent = observed runs work.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub observed_support: Option<String>,
    /// Judged draft window (max_draft_tokens) when drafting was realized.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub draft_capacity: Option<u32>,
}

/// Per-run prefill policy. Absent = eredu's default (chunks of at most 512
/// prompt positions on eligible runs).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InferencePolicyDto {
    /// Maximum prompt positions per prefill pass; 0 = one complete pass.
    /// Only ordinary text runs on chunk-capable executables honor it —
    /// captures, interventions, media and speculative runs keep a full pass.
    #[serde(default)]
    pub prefill_chunk_positions: Option<u64>,
}

impl InferencePolicyDto {
    /// The prefill policy for a run spec (absent policy = eredu's default).
    pub fn prefill_policy(spec: &StartRunSpecDto) -> Result<eredu_core::PrefillChunkPolicy, IpcError> {
        let requested = spec.inference.as_ref().and_then(|p| p.prefill_chunk_positions);
        Ok(match requested {
            None => eredu_core::PrefillChunkPolicy::default(),
            Some(0) => eredu_core::PrefillChunkPolicy::Unchunked,
            Some(n) => eredu_core::PrefillChunkPolicy::Bounded(
                usize::try_from(n)
                    .ok()
                    .and_then(std::num::NonZeroUsize::new)
                    .ok_or_else(|| IpcError::Budget {
                        budget: "inference.prefillChunkPositions".into(),
                        detail: "must fit a native position count".into(),
                    })?,
            ),
        })
    }
}

/// Backend allocator sample: bytes the MLX allocator currently holds. A
/// physical measurement, distinct from eredu's logical admission budgets.
#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AllocatorDto {
    pub active_bytes: u64,
    pub cached_bytes: u64,
    pub peak_bytes: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpecialTokenDto {
    pub id: u32,
    pub text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartRunSpecDto {
    pub messages: Vec<serde_json::Value>,
    #[serde(default)]
    pub tools: Vec<serde_json::Value>,
    /// "auto" | "none" | "required"
    #[serde(default)]
    pub tool_choice: Option<String>,
    #[serde(default)]
    pub enable_thinking: Option<bool>,
    #[serde(default)]
    pub reasoning_effort: Option<String>,
    /// "auto" | "chat" | "text"
    #[serde(default)]
    pub mode: Option<String>,
    /// Raw text prompt used when mode = "text". Bypasses the chat template
    /// and adds no automatic tokens (no BOS): the text is tokenized exactly
    /// as written and submitted as the token prefix. Special tokens typed
    /// literally (e.g. "<|endoftext|>") encode to their single ids.
    #[serde(default)]
    pub raw_text: Option<String>,
    #[serde(default)]
    pub overrides: serde_json::Value,
    /// {"kind":"standard"} | {"kind":"mirostatV2","tau":..,"eta":..}
    #[serde(default)]
    pub strategy: Option<serde_json::Value>,
    #[serde(default)]
    pub seed: Option<u64>,
    #[serde(default)]
    pub stops: Vec<String>,
    /// Full eredu CapturePlan JSON (selections + limits).
    #[serde(default)]
    pub capture: Option<serde_json::Value>,
    /// Full eredu InterventionPlan JSON (target-role in speculative mode).
    #[serde(default)]
    pub intervention: Option<serde_json::Value>,
    /// Draft-role InterventionPlan JSON (speculative runs only).
    #[serde(default)]
    pub intervention_draft: Option<serde_json::Value>,
    #[serde(default)]
    pub budgets: Option<BudgetOverridesDto>,
    /// Millis since epoch, stamped by the frontend for run metadata.
    #[serde(default)]
    pub created_ms: Option<u64>,
    /// "controlled" (fail if unsupported), "observed" (free-run), or absent =
    /// controlled with automatic observed fallback.
    #[serde(default)]
    pub execution: Option<String>,
    /// Prefill chunking for this run.
    #[serde(default)]
    pub inference: Option<InferencePolicyDto>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunStartedDto {
    pub run_id: String,
    pub speculative: bool,
    pub clamp_notes: Vec<crate::budgets::ClampNote>,
    /// Serialized ExecutionControlCapabilities (controlled runs only).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub capabilities: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub snapshot_support: Option<String>,
    /// Set when the run is observed-only (no step/pause/force/snapshots):
    /// the backend's reason controlled execution is unavailable.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub control_support: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatusDto {
    pub status: String,
    #[serde(with = "crate::lossless::u64_string")]
    pub next_prediction: u64,
    pub token_count: u64,
    pub finish_reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub allocator: Option<AllocatorDto>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotMetaDto {
    pub snapshot_id: String,
    #[serde(with = "crate::lossless::u64_string")]
    pub next_prediction: u64,
    pub pinned: bool,
    #[serde(with = "crate::lossless::u64_string")]
    pub retained_bytes: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TreeStatusDto {
    pub active_run: String,
    pub snapshots: Vec<SnapshotMetaDto>,
    pub slots: Vec<SlotDto>,
    pub capabilities: Option<String>,
    pub sampling: Option<String>,
    pub snapshot_usage: Option<String>,
    #[serde(with = "crate::lossless::u64_string")]
    pub emitted_bytes: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SlotDto {
    pub slot_id: String,
    pub parked_run_id: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CounterfactualResultDto {
    pub child_run_id: String,
    pub slot_id: String,
    pub forked_from_snapshot: String,
    #[serde(with = "crate::lossless::u64_string")]
    pub replayed_steps: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CounterfactualOptionsDto {
    #[serde(default)]
    pub temperature: Option<f32>,
    #[serde(default)]
    pub reseed: Option<u64>,
    #[serde(default)]
    pub intervention: Option<serde_json::Value>,
    #[serde(default)]
    pub auto_continue: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchOptionsDto {
    #[serde(default)]
    pub temperature: Option<f32>,
    #[serde(default)]
    pub reseed: Option<u64>,
    #[serde(default)]
    pub intervention: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VocabPageDto {
    pub total: u32,
    pub entries: Vec<VocabEntryDto>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VocabEntryDto {
    pub id: u32,
    pub text: String,
}

// ---------- commands ----------

pub enum Command {
    Describe(Reply<LoadedModelInfoDto>),
    VocabPage {
        offset: u32,
        limit: u32,
        query: Option<String>,
        reply: Reply<VocabPageDto>,
    },
    Encode {
        text: String,
        reply: Reply<Vec<u32>>,
    },
    Decode {
        ids: Vec<u32>,
        skip_special: bool,
        reply: Reply<String>,
    },
    StartRun {
        spec: Box<StartRunSpecDto>,
        reply: Reply<RunStartedDto>,
    },
    StartSpeculativeRun {
        spec: Box<StartRunSpecDto>,
        reply: Reply<RunStartedDto>,
    },
    Session(SessionCommand),
    Spec(speculative::SpecCommand),
    /// Component analysis / parameter access; idle model only (top loop).
    Component(component::ComponentCommand),
    /// Request memory forecast for a run spec against the loaded selection;
    /// idle model only (rendering the prompt needs the model).
    ForecastMemory {
        spec: Box<StartRunSpecDto>,
        speculative: bool,
        /// Application budget for total modeled memory; the fit verdict
        /// needs it when the backend cannot observe available capacity.
        budget_bytes: Option<u64>,
        reply: Reply<crate::memory::ForecastDto>,
    },
    Shutdown(Reply<()>),
}

pub enum SessionCommand {
    Step { steps: u32, reply: Reply<StatusDto> },
    Continue { reply: Reply<StatusDto> },
    Resume { reply: Reply<StatusDto> },
    Cancel { reply: Reply<StatusDto> },
    ForceToken { token_id: u32, reply: Reply<()> },
    ClearForcedToken { reply: Reply<bool> },
    OverrideSampling {
        temperature: Option<f32>,
        reseed: Option<u64>,
        reply: Reply<String>,
    },
    SamplingState { reply: Reply<String> },
    CreateSnapshot { pinned: bool, reply: Reply<SnapshotMetaDto> },
    RestoreSnapshot { snapshot_id: String, reply: Reply<StatusDto> },
    Fork {
        snapshot_id: String,
        options: BranchOptionsDto,
        reply: Reply<String>,
    },
    ActivateBranch { slot_id: String, reply: Reply<TreeStatusDto> },
    ReleaseSnapshot { snapshot_id: String, reply: Reply<()> },
    ReleaseBranch { slot_id: String, reply: Reply<()> },
    Counterfactual {
        run_id: String,
        prediction_index: u64,
        token_id: u32,
        options: CounterfactualOptionsDto,
        reply: Reply<CounterfactualResultDto>,
    },
    TreeStatus { reply: Reply<TreeStatusDto> },
    /// Memory outlook for `additional_tokens` more predictions from the
    /// paused session's installed state (decode-only; no loading/prefill).
    ForecastRemaining {
        additional_tokens: u64,
        budget_bytes: Option<u64>,
        reply: Reply<crate::memory::ForecastDto>,
    },
    EndSession { reply: Reply<()> },
}

pub struct WorkerHandle {
    tx: SyncSender<Command>,
    join: Option<std::thread::JoinHandle<()>>,
    pub model_epoch: u64,
    pub info: LoadedModelInfoDto,
    /// Shared with the owner thread; carries the tokenizer/vocabulary slots
    /// the IPC layer reads without touching the command queue.
    pub emitter: Arc<Emitter>,
}

impl WorkerHandle {
    pub fn send(&self, command: Command) -> Result<(), IpcError> {
        self.tx.send(command).map_err(|_| IpcError::Worker {
            detail: "model owner thread is gone".into(),
        })
    }

    /// Send a command and wait for its typed reply.
    pub fn request<T>(
        &self,
        make: impl FnOnce(Reply<T>) -> Command,
    ) -> Result<T, IpcError> {
        let (tx, rx) = sync_channel(1);
        self.send(make(tx))?;
        rx.recv().map_err(|_| IpcError::Worker {
            detail: "model owner dropped the reply".into(),
        })?
    }

    pub fn shutdown(mut self) {
        let (tx, rx) = sync_channel(1);
        if self.tx.send(Command::Shutdown(tx)).is_ok() {
            let _ = rx.recv_timeout(std::time::Duration::from_secs(30));
        }
        if let Some(join) = self.join.take() {
            let _ = join.join();
        }
    }
}

// ---------- emitter ----------

/// Serializes eredu records into envelopes: journal append → sink send →
/// delivery-gate credit wait. Blocking here is eredu's intended backpressure;
/// a closed gate converts into `ControlFlow::Break` (permanent clean cancel).
pub struct Emitter {
    pub sink: Arc<dyn EventSink>,
    pub gate: Arc<DeliveryGate>,
    pub journal: Arc<JournalStore>,
    pub model_epoch: u64,
    pub artifact_path: PathBuf,
    pub model_label: String,
    /// Set around counterfactual replay so envelopes carry phase=Replay.
    pub replay_phase: AtomicBool,
    /// Vocabulary shared with loop scopes that cannot reach the model.
    pub vocabulary: Mutex<Option<Arc<Vec<(u32, String)>>>>,
    /// Tokenizer clone for decode/encode outside the owner thread — token
    /// text must resolve even while a session mutably borrows the model.
    pub tokenizer: Mutex<Option<Arc<tokenizers::Tokenizer>>>,
}

impl Emitter {
    pub fn emit_json(&self, stream: StreamKind, run_id: &str, payload: String) -> bool {
        let bytes = payload.len() as u64;
        let seq = self.gate.next_seq(bytes);
        let envelope = RunEventEnvelope {
            model_epoch: self.model_epoch,
            stream,
            run_id: run_id.to_string(),
            envelope_seq: seq,
            phase: self
                .replay_phase
                .load(Ordering::SeqCst)
                .then_some(Phase::Replay),
            payload,
        };
        let artifact = self.artifact_path.display().to_string();
        let label = self.model_label.clone();
        let epoch = self.model_epoch;
        let speculative = matches!(stream, StreamKind::Speculative | StreamKind::SpeculativeSemantic);
        self.journal.append(&envelope, || crate::journal::RunMeta {
            run_id: run_id.to_string(),
            model_epoch: epoch,
            artifact_path: artifact,
            model_label: label,
            speculative,
            spec_json: "{}".into(),
            lineage: None,
            status: crate::journal::RunStatus::Active,
            resumable: true,
            pinned: false,
            created_ms: 0,
        });
        match self.sink.send(envelope) {
            Ok(true) => match self.gate.wait_for_credit() {
                Ok(()) => true,
                Err(GateSendError::Disconnected | GateSendError::Stalled) => false,
            },
            Ok(false) => {
                // Undelivered (no consumer attached): self-ack so the gate
                // never accrues debt for envelopes nobody will acknowledge.
                self.gate.ack_through(seq);
                true
            }
            Err(_) => {
                self.gate.close();
                false
            }
        }
    }

    pub fn emit_serialize<T: serde::Serialize>(
        &self,
        stream: StreamKind,
        run_id: &str,
        value: &T,
    ) -> bool {
        match serde_json::to_string(value) {
            Ok(json) => self.emit_json(stream, run_id, json),
            Err(_) => true, // serialization failure must not kill the run
        }
    }

    pub fn emit_system(&self, event: &serde_json::Value) {
        let _ = self.emit_serialize(StreamKind::System, "system", event);
    }
}

// ---------- spawn ----------

pub struct WorkerContext {
    pub emitter: Arc<Emitter>,
    pub shared: Arc<SharedControl>,
}

/// Spawn the owner thread and synchronously wait for the model to load.
pub fn spawn(
    artifact_path: PathBuf,
    plan: LoadPlanDto,
    model_epoch: u64,
    sink: Arc<dyn EventSink>,
    gate: Arc<DeliveryGate>,
    journal: Arc<JournalStore>,
    shared: Arc<SharedControl>,
) -> Result<WorkerHandle, IpcError> {
    let (tx, rx) = sync_channel::<Command>(64);
    let (ready_tx, ready_rx) = sync_channel::<Result<LoadedModelInfoDto, IpcError>>(1);
    let emitter = Arc::new(Emitter {
        sink,
        gate,
        journal,
        model_epoch,
        artifact_path: artifact_path.clone(),
        model_label: artifact_path
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| artifact_path.display().to_string()),
        replay_phase: AtomicBool::new(false),
        vocabulary: Mutex::new(None),
        tokenizer: Mutex::new(None),
    });
    let context = WorkerContext { emitter: emitter.clone(), shared };
    let join = std::thread::Builder::new()
        .name("model-owner".into())
        .spawn(move || owner_thread(artifact_path, plan, model_epoch, rx, ready_tx, context))
        .map_err(|e| IpcError::Internal { message: format!("spawn: {e}") })?;
    let info = ready_rx
        .recv()
        .map_err(|_| IpcError::Worker { detail: "model owner died during load".into() })??;
    Ok(WorkerHandle { tx, join: Some(join), model_epoch, info, emitter })
}

fn owner_thread(
    artifact_path: PathBuf,
    plan: LoadPlanDto,
    model_epoch: u64,
    rx: Receiver<Command>,
    ready: SyncSender<Result<LoadedModelInfoDto, IpcError>>,
    context: WorkerContext,
) {
    let loaded = match load::load_model(&artifact_path, &plan, model_epoch, &context) {
        Ok(loaded) => {
            let _ = ready.send(Ok(loaded.info.clone()));
            loaded
        }
        Err(e) => {
            let _ = ready.send(Err(e));
            return;
        }
    };
    top_loop(loaded, rx, context);
}

fn top_loop(mut loaded: load::LoadedWorkerModel, rx: Receiver<Command>, context: WorkerContext) {
    // A queued Start command replayed after a session tears down.
    let mut pending: Option<Command> = None;
    loop {
        let command = match pending.take() {
            Some(c) => c,
            None => match rx.recv() {
                Ok(c) => c,
                Err(_) => break,
            },
        };
        match command {
            Command::Describe(reply) => {
                let _ = reply.send(Ok(loaded.info.clone()));
            }
            Command::VocabPage { offset, limit, query, reply } => {
                let _ = reply.send(Ok(crate::vocab::page(&loaded.vocabulary, offset, limit, query.as_deref())));
            }
            Command::Encode { text, reply } => {
                let _ = reply.send(loaded.encode(&text));
            }
            Command::Decode { ids, skip_special, reply } => {
                let _ = reply.send(loaded.decode(&ids, skip_special));
            }
            Command::StartRun { spec, reply } => {
                let exit = controlled::run_controlled(&mut loaded, *spec, reply, &rx, &context);
                if let Err(e) = loaded.model.reset() {
                    context.emitter.emit_system(&serde_json::json!({
                        "kind": "model_reset_failed", "message": e.to_string(),
                    }));
                }
                pending = exit;
            }
            Command::StartSpeculativeRun { spec, reply } => {
                let exit = speculative::run_speculative(&mut loaded, *spec, reply, &rx, &context);
                if let Err(e) = loaded.model.reset() {
                    context.emitter.emit_system(&serde_json::json!({
                        "kind": "model_reset_failed", "message": e.to_string(),
                    }));
                }
                pending = exit;
            }
            Command::Session(cmd) => reject_session(cmd),
            Command::Spec(cmd) => speculative::reject(cmd),
            Command::Component(cmd) => component::handle(cmd, &mut loaded, &context),
            Command::ForecastMemory { spec, speculative, budget_bytes, reply } => {
                let _ = reply.send(memory::forecast_run(&mut loaded, &spec, speculative, budget_bytes));
            }
            Command::Shutdown(reply) => {
                drop(loaded);
                let _ = reply.send(Ok(()));
                break;
            }
        }
    }
}

pub(crate) fn reject_session(cmd: SessionCommand) {
    let err = || IpcError::NoActiveSession;
    match cmd {
        SessionCommand::Step { reply, .. } => drop(reply.send(Err(err()))),
        SessionCommand::Continue { reply } => drop(reply.send(Err(err()))),
        SessionCommand::Resume { reply } => drop(reply.send(Err(err()))),
        SessionCommand::Cancel { reply } => drop(reply.send(Err(err()))),
        SessionCommand::ForceToken { reply, .. } => drop(reply.send(Err(err()))),
        SessionCommand::ClearForcedToken { reply } => drop(reply.send(Err(err()))),
        SessionCommand::OverrideSampling { reply, .. } => drop(reply.send(Err(err()))),
        SessionCommand::SamplingState { reply } => drop(reply.send(Err(err()))),
        SessionCommand::CreateSnapshot { reply, .. } => drop(reply.send(Err(err()))),
        SessionCommand::RestoreSnapshot { reply, .. } => drop(reply.send(Err(err()))),
        SessionCommand::Fork { reply, .. } => drop(reply.send(Err(err()))),
        SessionCommand::ActivateBranch { reply, .. } => drop(reply.send(Err(err()))),
        SessionCommand::ReleaseSnapshot { reply, .. } => drop(reply.send(Err(err()))),
        SessionCommand::ReleaseBranch { reply, .. } => drop(reply.send(Err(err()))),
        SessionCommand::Counterfactual { reply, .. } => drop(reply.send(Err(err()))),
        SessionCommand::TreeStatus { reply } => drop(reply.send(Err(err()))),
        SessionCommand::ForecastRemaining { reply, .. } => drop(reply.send(Err(err()))),
        SessionCommand::EndSession { reply } => drop(reply.send(Ok(()))),
    }
}
