//! Live commands (mlx feature): model lifecycle, event streaming, controlled
//! and speculative session control. Worker replies are blocking rendezvous —
//! every command goes through spawn_blocking.

use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use inspector_engine::error::IpcError;
use inspector_engine::journal::JournalStore;
use inspector_engine::stream::{DeliveryGate, RunEventEnvelope};
use inspector_engine::worker::speculative::{SpecCommand, SpecStatusDto};
use inspector_engine::worker::{
    BranchOptionsDto, Command, CounterfactualOptionsDto, CounterfactualResultDto, LoadPlanDto,
    LoadedModelInfoDto, RunStartedDto, SessionCommand, SharedControl, SnapshotMetaDto,
    StartRunSpecDto, StatusDto, TreeStatusDto, VocabPageDto, WorkerHandle,
};
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager, State, Window, WindowEvent};

use crate::sink::ChannelSink;

pub struct LiveState {
    pub worker: Mutex<Option<WorkerHandle>>,
    pub epoch: AtomicU64,
    pub sink: Arc<ChannelSink>,
    pub gate: Mutex<Arc<DeliveryGate>>,
    pub shared: Arc<SharedControl>,
}

impl Default for LiveState {
    fn default() -> Self {
        Self {
            worker: Mutex::new(None),
            epoch: AtomicU64::new(0),
            sink: Arc::new(ChannelSink::default()),
            gate: Mutex::new(Arc::new(DeliveryGate::default())),
            shared: Arc::new(SharedControl::default()),
        }
    }
}

impl LiveState {
    fn check_epoch(&self, model_epoch: u64) -> Result<(), IpcError> {
        let current = self.epoch.load(Ordering::SeqCst);
        if current != model_epoch {
            return Err(IpcError::StaleEpoch {
                expected: model_epoch.to_string(),
                actual: current.to_string(),
            });
        }
        Ok(())
    }

    fn with_worker<T: Send + 'static>(
        &self,
        model_epoch: u64,
        make: impl FnOnce(inspector_engine::worker::Reply<T>) -> Command,
    ) -> Result<WorkerRequest<T>, IpcError> {
        self.check_epoch(model_epoch)?;
        let guard = self.worker.lock().expect("live state poisoned");
        let worker = guard.as_ref().ok_or(IpcError::NotLoaded)?;
        let (tx, rx) = std::sync::mpsc::sync_channel(1);
        worker.send(make(tx))?;
        Ok(WorkerRequest { rx })
    }
}

pub struct WorkerRequest<T> {
    rx: std::sync::mpsc::Receiver<Result<T, IpcError>>,
}

impl<T: Send + 'static> WorkerRequest<T> {
    async fn wait(self) -> Result<T, IpcError> {
        tauri::async_runtime::spawn_blocking(move || {
            self.rx.recv().map_err(|_| IpcError::Worker {
                detail: "model owner dropped the reply".into(),
            })?
        })
        .await
        .map_err(|e| IpcError::Internal { message: format!("blocking task: {e}") })?
    }
}

/// Cancel/teardown on window close so no MLX model outlives the app.
pub fn window_event_hook(window: &Window, event: &WindowEvent) {
    if matches!(event, WindowEvent::Destroyed) {
        if let Some(state) = window.app_handle().try_state::<LiveState>() {
            state.shared.cancel();
            state.gate.lock().expect("gate poisoned").close();
            let worker = state.worker.lock().expect("live state poisoned").take();
            if let Some(worker) = worker {
                // Detached: give the owner thread a chance to settle natively.
                std::thread::spawn(move || worker.shutdown());
            }
        }
    }
}

// ---------- lifecycle ----------

#[tauri::command]
pub async fn load_model(
    app: AppHandle,
    path: String,
    plan: LoadPlanDto,
) -> Result<LoadedModelInfoDto, IpcError> {
    let state = app.state::<LiveState>();
    // Retire the previous worker (one loaded model at a time).
    let previous = {
        let mut guard = state.worker.lock().expect("live state poisoned");
        guard.take()
    };
    let journal: Arc<JournalStore> = Arc::clone(&app.state::<Arc<JournalStore>>());
    let epoch = state.epoch.fetch_add(1, Ordering::SeqCst) + 1;
    journal.retire_epochs_before(epoch);
    let gate = Arc::new(DeliveryGate::default());
    *state.gate.lock().expect("gate poisoned") = gate.clone();
    let sink = state.sink.clone();
    let shared = state.shared.clone();

    let handle = tauri::async_runtime::spawn_blocking(move || {
        if let Some(previous) = previous {
            previous.shutdown();
        }
        inspector_engine::worker::spawn(
            PathBuf::from(path),
            plan,
            epoch,
            sink,
            gate,
            journal,
            shared,
        )
    })
    .await
    .map_err(|e| IpcError::Internal { message: format!("blocking task: {e}") })??;

    let info = handle.info.clone();
    *state.worker.lock().expect("live state poisoned") = Some(handle);
    Ok(info)
}

#[tauri::command]
pub async fn unload_model(state: State<'_, LiveState>) -> Result<(), IpcError> {
    state.shared.cancel();
    let worker = state.worker.lock().expect("live state poisoned").take();
    state.epoch.fetch_add(1, Ordering::SeqCst);
    if let Some(worker) = worker {
        tauri::async_runtime::spawn_blocking(move || worker.shutdown())
            .await
            .map_err(|e| IpcError::Internal { message: format!("blocking task: {e}") })?;
    }
    Ok(())
}

#[tauri::command]
pub fn open_event_stream(
    state: State<'_, LiveState>,
    channel: Channel<RunEventEnvelope>,
) -> Result<(), IpcError> {
    state.sink.set_channel(channel);
    Ok(())
}

#[tauri::command]
pub fn ack_events(state: State<'_, LiveState>, model_epoch: u64, envelope_seq: u64) -> Result<(), IpcError> {
    state.check_epoch(model_epoch)?;
    state.gate.lock().expect("gate poisoned").ack_through(envelope_seq);
    Ok(())
}

// ---------- model info / tokenizer ----------

#[tauri::command]
pub async fn get_capture_discovery(state: State<'_, LiveState>) -> Result<String, IpcError> {
    describe(&state).await.map(|i| i.capture_discovery)
}

#[tauri::command]
pub async fn get_intervention_discovery(state: State<'_, LiveState>) -> Result<String, IpcError> {
    describe(&state).await.map(|i| i.intervention_discovery)
}

#[tauri::command]
pub async fn get_speculative_intervention_discovery(
    state: State<'_, LiveState>,
) -> Result<Option<String>, IpcError> {
    describe(&state).await.map(|i| i.speculative_intervention_discovery)
}

async fn describe(state: &State<'_, LiveState>) -> Result<LoadedModelInfoDto, IpcError> {
    let epoch = state.epoch.load(Ordering::SeqCst);
    state.with_worker(epoch, Command::Describe)?.wait().await
}

// Tokenizer/vocabulary access is served from shared slots published at load,
// NOT through the worker queue — token text must resolve even while the owner
// thread is blocked inside session.run().

fn shared_emitter(
    state: &State<'_, LiveState>,
) -> Result<Arc<inspector_engine::worker::Emitter>, IpcError> {
    let guard = state.worker.lock().expect("live state poisoned");
    guard
        .as_ref()
        .map(|w| w.emitter.clone())
        .ok_or(IpcError::NotLoaded)
}

#[tauri::command]
pub fn get_vocabulary_page(
    state: State<'_, LiveState>,
    offset: u32,
    limit: u32,
    query: Option<String>,
) -> Result<VocabPageDto, IpcError> {
    let emitter = shared_emitter(&state)?;
    let vocab = emitter
        .vocabulary
        .lock()
        .expect("vocab poisoned")
        .clone()
        .ok_or(IpcError::NotLoaded)?;
    Ok(inspector_engine::vocab::page(vocab.as_slice(), offset, limit, query.as_deref()))
}

#[tauri::command]
pub fn encode_text(state: State<'_, LiveState>, text: String) -> Result<Vec<u32>, IpcError> {
    let emitter = shared_emitter(&state)?;
    let tokenizer = emitter
        .tokenizer
        .lock()
        .expect("tokenizer poisoned")
        .clone()
        .ok_or(IpcError::NotLoaded)?;
    let encoding = tokenizer
        .encode(text, false)
        .map_err(|e| IpcError::Internal { message: e.to_string() })?;
    Ok(encoding.get_ids().to_vec())
}

#[tauri::command]
pub fn decode_tokens(
    state: State<'_, LiveState>,
    ids: Vec<u32>,
    skip_special: bool,
) -> Result<String, IpcError> {
    let emitter = shared_emitter(&state)?;
    let tokenizer = emitter
        .tokenizer
        .lock()
        .expect("tokenizer poisoned")
        .clone()
        .ok_or(IpcError::NotLoaded)?;
    tokenizer
        .decode(&ids, skip_special)
        .map_err(|e| IpcError::Internal { message: e.to_string() })
}

#[tauri::command]
pub async fn get_telemetry(state: State<'_, LiveState>) -> Result<String, IpcError> {
    // Placeholder for allocator/residency telemetry surfaces.
    state.check_epoch(state.epoch.load(Ordering::SeqCst))?;
    Ok("{}".into())
}

// ---------- controlled runs ----------

#[tauri::command]
pub async fn start_run(
    state: State<'_, LiveState>,
    model_epoch: u64,
    spec: StartRunSpecDto,
) -> Result<RunStartedDto, IpcError> {
    state
        .with_worker(model_epoch, |reply| Command::StartRun { spec: Box::new(spec), reply })?
        .wait()
        .await
}

macro_rules! session_command {
    ($name:ident, $variant:ident, $ret:ty $(, ($($arg:ident : $ty:ty),*))?) => {
        #[tauri::command]
        pub async fn $name(
            state: State<'_, LiveState>,
            model_epoch: u64,
            $($($arg: $ty),*)?
        ) -> Result<$ret, IpcError> {
            state
                .with_worker(model_epoch, |reply| {
                    Command::Session(SessionCommand::$variant { $($($arg,)*)? reply })
                })?
                .wait()
                .await
        }
    };
}

session_command!(step_run, Step, StatusDto, (steps: u32));
session_command!(continue_run, Continue, StatusDto);
session_command!(resume_run, Resume, StatusDto);
session_command!(force_token, ForceToken, (), (token_id: u32));
session_command!(clear_forced_token, ClearForcedToken, bool);
session_command!(override_sampling, OverrideSampling, String, (temperature: Option<f32>, reseed: Option<u64>));
session_command!(get_sampling_state, SamplingState, String);
session_command!(create_snapshot, CreateSnapshot, SnapshotMetaDto, (pinned: bool));
session_command!(restore_snapshot, RestoreSnapshot, StatusDto, (snapshot_id: String));
session_command!(fork_branch, Fork, String, (snapshot_id: String, options: BranchOptionsDto));
session_command!(activate_branch, ActivateBranch, TreeStatusDto, (slot_id: String));
session_command!(release_snapshot, ReleaseSnapshot, (), (snapshot_id: String));
session_command!(release_branch, ReleaseBranch, (), (slot_id: String));
session_command!(get_tree_status, TreeStatus, TreeStatusDto);
session_command!(end_session, EndSession, ());

#[tauri::command]
pub async fn counterfactual_from_step(
    state: State<'_, LiveState>,
    model_epoch: u64,
    run_id: String,
    prediction_index: u64,
    token_id: u32,
    options: CounterfactualOptionsDto,
) -> Result<CounterfactualResultDto, IpcError> {
    state
        .with_worker(model_epoch, |reply| {
            Command::Session(SessionCommand::Counterfactual {
                run_id,
                prediction_index,
                token_id,
                options,
                reply,
            })
        })?
        .wait()
        .await
}

/// Pause and cancel bypass the command queue entirely: they act through the
/// cross-thread control handle so they work while the worker is blocked.
#[tauri::command]
pub fn pause_run(state: State<'_, LiveState>, model_epoch: u64) -> Result<bool, IpcError> {
    state.check_epoch(model_epoch)?;
    Ok(state.shared.pause())
}

#[tauri::command]
pub async fn cancel_run(state: State<'_, LiveState>, model_epoch: u64) -> Result<StatusDto, IpcError> {
    state.check_epoch(model_epoch)?;
    state.shared.cancel();
    // Also settle through the queue so status reflects the cancellation.
    state
        .with_worker(model_epoch, |reply| Command::Session(SessionCommand::Cancel { reply }))?
        .wait()
        .await
}

// ---------- speculative runs ----------

#[tauri::command]
pub async fn start_speculative_run(
    state: State<'_, LiveState>,
    model_epoch: u64,
    spec: StartRunSpecDto,
) -> Result<RunStartedDto, IpcError> {
    state
        .with_worker(model_epoch, |reply| Command::StartSpeculativeRun {
            spec: Box::new(spec),
            reply,
        })?
        .wait()
        .await
}

macro_rules! spec_command {
    ($name:ident, $variant:ident, $ret:ty $(, ($($arg:ident : $ty:ty),*))?) => {
        #[tauri::command]
        pub async fn $name(
            state: State<'_, LiveState>,
            model_epoch: u64,
            $($($arg: $ty),*)?
        ) -> Result<$ret, IpcError> {
            state
                .with_worker(model_epoch, |reply| {
                    Command::Spec(SpecCommand::$variant { $($($arg,)*)? reply })
                })?
                .wait()
                .await
        }
    };
}

spec_command!(spec_step, Step, SpecStatusDto, (actions: u32));
spec_command!(spec_run, Run, SpecStatusDto);
spec_command!(spec_force_token, ForceToken, (), (token_id: u32));
spec_command!(spec_clear_forced, ClearForced, bool);
spec_command!(spec_override_sampling, OverrideSampling, String, (temperature: Option<f32>, reseed: Option<u64>));
spec_command!(spec_intervene, Intervene, (), (target: Option<serde_json::Value>, draft: Option<serde_json::Value>));
spec_command!(spec_snapshot, Snapshot, String);
spec_command!(spec_restore, Restore, SpecStatusDto, (snapshot_id: String));
spec_command!(spec_fork, Fork, String, (snapshot_id: String));
spec_command!(spec_exchange, Exchange, SpecStatusDto, (branch_id: String));
spec_command!(spec_release_snapshot, ReleaseSnapshot, (), (snapshot_id: String));
spec_command!(spec_release_branch, ReleaseBranch, (), (branch_id: String));
spec_command!(spec_snapshot_support, SnapshotSupport, String);
spec_command!(end_speculative_run, End, ());

/// spec_pause acts through the engine-level pause flag (cross-thread) so it
/// lands even while the spec loop is stepping.
#[tauri::command]
pub fn spec_pause(state: State<'_, LiveState>, model_epoch: u64) -> Result<(), IpcError> {
    state.check_epoch(model_epoch)?;
    state
        .shared
        .spec_pause
        .store(true, std::sync::atomic::Ordering::SeqCst);
    Ok(())
}
