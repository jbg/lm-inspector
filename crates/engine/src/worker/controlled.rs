//! The controlled-generation session loop: streaming, step/run/pause/cancel,
//! forced tokens, sampling overrides, the snapshot registry with automatic
//! cadence + gap-minimizing thinning, branch slots, and the counterfactual
//! composite (fork nearest snapshot → deterministic replay → force → continue).

use std::collections::BTreeMap;
use std::ops::ControlFlow;
use std::sync::mpsc::Receiver;

use eredu::api::{
    ControlledGenerationBranch, ControlledGenerationRecord, ControlledGenerationSession,
    ControlledGenerationSnapshot, GenerationBranchOptions, ObservedGenerationRecord,
    PreparedChatGenerationSettings, SamplingOverride, TraceLimits,
};
use eredu_core::GenerationCancellationToken;
use eredu_core::execution_control::GenerationControlHandle;
use eredu::runtime::chat::{ChatTemplateRequest, SemanticSupport, ToolChoice};
use eredu_core::capture::{CaptureLimits, CapturePlan};
use eredu_core::execution_control::GenerationStatus;
use eredu_core::intervention::InterventionPlan;
use eredu_core::{GenerationConfigOverrides, TextSamplingStrategy};

use crate::budgets::{self, ClampNote};
use crate::error::{error_chain, ControlErrorClass, IpcError};
use crate::journal::{RunLineage, RunMeta, RunStatus};
use crate::stream::StreamKind;
use crate::worker::load::{Backend, LoadedWorkerModel};
use crate::worker::{
    BranchOptionsDto, Command, CounterfactualOptionsDto, CounterfactualResultDto, Emitter,
    InferencePolicyDto, Reply, RunStartedDto, SessionCommand, SnapshotMetaDto, SlotDto,
    StartRunSpecDto, StatusDto, TreeStatusDto, WorkerContext,
};

type Session<'a> = ControlledGenerationSession<'a, Backend>;
type Snapshot = ControlledGenerationSnapshot<Backend>;
type Branch = ControlledGenerationBranch<Backend>;

struct SnapEntry {
    handle: Snapshot,
    pinned: bool,
}

fn snapshot_position(handle: &Snapshot) -> u64 {
    handle.metadata().output.next_prediction
}

struct TreeState {
    snapshots: BTreeMap<String, SnapEntry>,
    slots: BTreeMap<String, Branch>,
    active_run: String,
    snapshot_cadence: u64,
    max_auto_snapshots: u64,
    snapshots_enabled: bool,
    trace_limits: TraceLimits,
    capture_limits: CaptureLimits,
    next_slot: u64,
}

fn emit_of<'e>(
    emitter: &'e Emitter,
) -> impl FnMut(ControlledGenerationRecord) -> ControlFlow<()> + 'e {
    move |record| {
        let run_id = record.generation.run_id.clone();
        if emitter.emit_serialize(StreamKind::Controlled, &run_id, &record) {
            ControlFlow::Continue(())
        } else {
            ControlFlow::Break(())
        }
    }
}

fn control_error(op: &str, e: &eredu::api::ControlledGenerationError) -> IpcError {
    use eredu::api::ControlledGenerationError as E;
    let class = match e {
        E::Generation(_) => ControlErrorClass::Generation,
        E::Continuation(_) => ControlErrorClass::Continuation,
        E::Choice(_) => ControlErrorClass::Choice,
        E::Sampling(_) => ControlErrorClass::Sampling,
        E::Snapshot(_) => ControlErrorClass::Snapshot,
        E::Control(_) => ControlErrorClass::Control,
        E::Capture(_) => ControlErrorClass::Capture,
    };
    IpcError::Control {
        op: op.to_string(),
        class,
        message: e.to_string(),
        chain: error_chain(e),
    }
}

fn status_dto(session: &Session<'_>) -> StatusDto {
    StatusDto {
        status: status_word(session.status()),
        next_prediction: session.next_prediction(),
        token_count: session.token_ids().len() as u64,
        finish_reason: session
            .finish_reason()
            .and_then(|r| serde_json::to_value(r).ok())
            .and_then(|v| v.as_str().map(String::from)),
        allocator: crate::worker::load::allocator_sample(),
    }
}

fn status_word(status: GenerationStatus) -> String {
    serde_json::to_value(status)
        .ok()
        .and_then(|v| v.as_str().map(String::from))
        .unwrap_or_else(|| format!("{status:?}").to_lowercase())
}

fn serialize_string<T: serde::Serialize>(value: &T) -> String {
    serde_json::to_string(value).unwrap_or_else(|_| "null".into())
}

/// Parse spec fields into eredu types; every error is typed and user-visible.
pub(crate) struct PreparedSpec {
    pub(crate) chat_request: ChatTemplateRequest,
    pub(crate) settings: PreparedChatGenerationSettings,
    pub(crate) capture: CapturePlan,
    pub(crate) intervention: Option<InterventionPlan>,
    stops: Vec<String>,
    text_mode_requested: bool,
    trace: TraceLimits,
    capture_limits: CaptureLimits,
    snapshot_limits: eredu_core::execution_control::SnapshotLimits,
    snapshot_cadence: u64,
    clamp_notes: Vec<ClampNote>,
    /// The dummy forbidden-tool surface was injected for snapshot coverage;
    /// some native tool grammars reject a declared collection with zero
    /// permitted calls, so prepare_chat gets one tool-less retry.
    pub(crate) injected_dummy_tools: bool,
}

pub(crate) fn prepare_spec(spec: &StartRunSpecDto) -> Result<PreparedSpec, IpcError> {
    let budget_overrides = spec.budgets.clone().unwrap_or_default();
    let resolved = budgets::resolve(&budget_overrides);
    let mut clamp_notes = resolved.notes;

    let messages = if let Some(raw) = &spec.raw_text {
        vec![serde_json::json!({"role": "user", "content": raw})]
    } else {
        spec.messages.clone()
    };
    let text_mode = spec.mode.as_deref() == Some("text");
    let mut tools = spec.tools.clone();
    let mut tool_choice = match spec.tool_choice.as_deref() {
        Some("none") => ToolChoice::None,
        Some("required") => ToolChoice::Required,
        _ => ToolChoice::Auto,
    };
    // Snapshot coverage requires the forbidden-tool constraint owner: a
    // tool-less semantic chat still runs an active grammar with no complete
    // storage estimate, which rejects enable_snapshots. Declaring a dummy
    // tool surface and forbidding calls (exactly eredu's own controlled
    // example) makes counterfactual branching work by default.
    let mut injected_dummy_tools = false;
    if tools.is_empty() && !text_mode {
        tools = vec![serde_json::json!({"type": "function", "function": {
            "name": "lookup",
            "parameters": {"type": "object", "properties": {}, "additionalProperties": false}
        }})];
        tool_choice = ToolChoice::None;
        injected_dummy_tools = true;
    }
    let chat_request = ChatTemplateRequest {
        messages,
        tools,
        tool_choice,
        enable_thinking: spec.enable_thinking,
        reasoning_effort: spec.reasoning_effort.clone(),
        add_generation_prompt: true,
        ..Default::default()
    };

    let overrides: GenerationConfigOverrides = serde_json::from_value(spec.overrides.clone())
        .map_err(|e| IpcError::Internal { message: format!("overrides: {e}") })?;
    let strategy = match &spec.strategy {
        Some(v) => match v.get("kind").and_then(|k| k.as_str()) {
            Some("mirostatV2") => TextSamplingStrategy::MirostatV2 {
                tau: v.get("tau").and_then(|t| t.as_f64()).unwrap_or(5.0) as f32,
                eta: v.get("eta").and_then(|t| t.as_f64()).unwrap_or(0.1) as f32,
            },
            _ => TextSamplingStrategy::Standard,
        },
        None => TextSamplingStrategy::Standard,
    };
    let settings = PreparedChatGenerationSettings {
        overrides,
        strategy,
        seed: spec.seed.unwrap_or(42),
        prefill: InferencePolicyDto::prefill_policy(spec)?,
    };

    let mut capture: CapturePlan = match &spec.capture {
        Some(value) => serde_json::from_value(value.clone())
            .map_err(|e| IpcError::Internal { message: format!("capture plan: {e}") })?,
        None => CapturePlan {
            schema_version: eredu_core::capture::CAPTURE_SCHEMA_VERSION,
            selections: vec![],
            limits: resolved.capture.clone(),
        },
    };
    clamp_capture_limits(&mut capture.limits, &mut clamp_notes);
    let capture_limits = capture.limits.clone();

    let intervention: Option<InterventionPlan> = match &spec.intervention {
        Some(value) if !value.is_null() => Some(
            serde_json::from_value(value.clone())
                .map_err(|e| IpcError::Internal { message: format!("intervention plan: {e}") })?,
        ),
        _ => None,
    };

    Ok(PreparedSpec {
        chat_request,
        settings,
        capture,
        intervention,
        stops: spec.stops.clone(),
        text_mode_requested: text_mode,
        trace: resolved.trace,
        capture_limits,
        snapshot_limits: resolved.snapshots,
        snapshot_cadence: resolved.snapshot_cadence,
        clamp_notes,
        injected_dummy_tools,
    })
}

fn clamp_capture_limits(limits: &mut CaptureLimits, notes: &mut Vec<ClampNote>) {
    let ceiling = budgets::capture_ceiling();
    let mut clamp = |field: &str, value: &mut u64, max: u64| {
        if *value > max {
            notes.push(ClampNote {
                field: field.to_string(),
                requested: value.to_string(),
                clamped_to: max.to_string(),
            });
            *value = max;
        }
    };
    clamp("capture.perStep.captures", &mut limits.per_step.captures, ceiling.per_step.captures);
    clamp("capture.perStep.retainedBytes", &mut limits.per_step.retained_bytes, ceiling.per_step.retained_bytes);
    clamp("capture.perStep.hostBytes", &mut limits.per_step.host_bytes, ceiling.per_step.host_bytes);
    clamp("capture.perStep.encodedBytes", &mut limits.per_step.encoded_bytes, ceiling.per_step.encoded_bytes);
    clamp("capture.cumulative.captures", &mut limits.cumulative.captures, ceiling.cumulative.captures);
    clamp("capture.cumulative.retainedBytes", &mut limits.cumulative.retained_bytes, ceiling.cumulative.retained_bytes);
    clamp("capture.cumulative.hostBytes", &mut limits.cumulative.host_bytes, ceiling.cumulative.host_bytes);
    clamp("capture.cumulative.encodedBytes", &mut limits.cumulative.encoded_bytes, ceiling.cumulative.encoded_bytes);
    // MLX rejects a physical ceiling it cannot prove.
    limits.physical_native_bytes = None;
}

/// The model needs at least one token to predict from; raw mode never
/// supplies one behind the user's back.
pub const RAW_PROMPT_EMPTY: &str = "the raw prompt has no tokens — raw mode adds nothing automatically, so insert a start token (BOS or end-of-text) from the special-token picker or type some text";

/// Tokenize a raw-text prompt into the exact prefix that bypasses the chat
/// template. Nothing is added automatically; special tokens typed literally
/// encode to their ids. `None` when the run is not in raw-text mode.
pub(crate) fn raw_prefix(
    loaded: &LoadedWorkerModel,
    spec: &StartRunSpecDto,
) -> Result<Option<Vec<u32>>, IpcError> {
    let Some(raw) = spec.raw_text.as_deref() else {
        return Ok(None);
    };
    let ids = loaded.model.encode(raw, false).map_err(|e| IpcError::Control {
        op: "encode".into(),
        class: ControlErrorClass::Generation,
        message: e.to_string(),
        chain: error_chain(&e),
    })?;
    if ids.is_empty() {
        return Err(IpcError::Control {
            op: "encode".into(),
            class: ControlErrorClass::Generation,
            message: RAW_PROMPT_EMPTY.into(),
            chain: vec![],
        });
    }
    Ok(Some(ids))
}

/// Admit the run's capture/intervention plans over the prepared chat: the
/// rendered prompt, or in raw-text mode the exact token prefix (the chat then
/// only supplies the output/termination contract).
pub(crate) fn prepare_observed(
    model: &mut eredu::api::LoadedModel<Backend>,
    chat: &eredu::runtime::chat::PreparedChat,
    prepared_spec: &PreparedSpec,
    raw_prefix: Option<&[u32]>,
) -> Result<eredu::api::PreparedObservedGeneration, eredu::api::PreparedChatError> {
    let settings = prepared_spec.settings.clone();
    let capture = prepared_spec.capture.clone();
    let trace = prepared_spec.trace;
    match (&prepared_spec.intervention, raw_prefix) {
        (Some(plan), Some(ids)) => model.prepare_intervened_token_ids(
            chat,
            ids.to_vec(),
            settings,
            capture,
            plan.clone(),
            trace,
        ),
        (Some(plan), None) => {
            model.prepare_intervened_chat(chat, settings, capture, plan.clone(), trace)
        }
        (None, Some(ids)) => {
            model.prepare_observed_token_ids(chat, ids.to_vec(), settings, capture, trace)
        }
        (None, None) => model.prepare_observed_chat(chat, settings, capture, trace),
    }
}

/// Run one controlled tree to completion. Returns a queued command (new run /
/// shutdown) that arrived mid-session and must be replayed by the caller.
pub fn run_controlled(
    loaded: &mut LoadedWorkerModel,
    spec: StartRunSpecDto,
    reply: Reply<RunStartedDto>,
    rx: &Receiver<Command>,
    context: &WorkerContext,
) -> Option<Command> {
    let prepared_spec = match prepare_spec(&spec) {
        Ok(p) => p,
        Err(e) => {
            let _ = reply.send(Err(e));
            return None;
        }
    };

    let raw_prefix = match raw_prefix(loaded, &spec) {
        Ok(p) => p,
        Err(e) => {
            let _ = reply.send(Err(e));
            return None;
        }
    };

    // Prepare the chat (template render + capability probing). If the model's
    // native tool grammar rejects the injected dummy surface (e.g. Muse's ATEM
    // collection requires at least one call), retry genuinely tool-less —
    // snapshots may then be unavailable, but generation works.
    let toolless = || ChatTemplateRequest {
        tools: vec![],
        tool_choice: ToolChoice::Auto,
        ..prepared_spec.chat_request.clone()
    };
    let chat = match loaded.prepare_chat(prepared_spec.chat_request.clone()) {
        Ok(chat) => chat,
        Err(e) if prepared_spec.injected_dummy_tools => {
            match loaded.prepare_chat(toolless()) {
                Ok(chat) => chat,
                Err(_) => {
                    // Report the original rejection; the retry did not help.
                    let _ = reply.send(Err(e));
                    return None;
                }
            }
        }
        Err(e) => {
            let _ = reply.send(Err(e));
            return None;
        }
    };
    let semantic_supported = matches!(chat.semantic_support(), SemanticSupport::Supported);
    let use_text = prepared_spec.text_mode_requested || !semantic_supported;

    // The dummy tool exists only for semantic snapshot coverage, and text
    // admission rejects any tool declaration — so a template that falls back
    // to text mode must be re-prepared genuinely tool-less.
    let chat = if use_text && prepared_spec.injected_dummy_tools {
        match loaded.prepare_chat(toolless()) {
            Ok(c) => c,
            Err(e) => {
                let _ = reply.send(Err(e));
                return None;
            }
        }
    } else {
        chat
    };

    // Explicitly requested observed mode: never attempt a controlled start.
    if spec.execution.as_deref() == Some("observed") {
        return run_observed_fallback(
            loaded,
            &spec,
            &prepared_spec,
            |model| prepare_observed(model, &chat, &prepared_spec, raw_prefix.as_deref()),
            use_text,
            "observed mode was selected for this run".into(),
            reply,
            context,
        );
    }

    let prepared = {
        let result = prepare_observed(&mut loaded.model, &chat, &prepared_spec, raw_prefix.as_deref());
        match result {
            Ok(p) => p,
            Err(e) => {
                let _ = reply.send(Err(IpcError::Control {
                    op: "prepare_observed".into(),
                    class: ControlErrorClass::Capture,
                    message: e.to_string(),
                    chain: error_chain(&e),
                }));
                return None;
            }
        }
    };

    // Cloned out so the nested loop never touches `loaded` while the session
    // mutably borrows the model.
    let info_clone = loaded.info.clone();
    let vocabulary = loaded.vocabulary.clone();

    // Cross-thread control handle registered before the session starts.
    let control = GenerationControlHandle::default();
    *context.shared.handle.lock().expect("control poisoned") = Some(control.clone());

    let emitter = &context.emitter;
    let start = if use_text {
        loaded
            .model
            .start_controlled_text(prepared, &prepared_spec.stops, control, emit_of(emitter))
    } else {
        loaded
            .model
            .start_controlled_chat(prepared, &prepared_spec.stops, control, emit_of(emitter))
    };
    let mut session = match start {
        Ok(s) => s,
        Err(e) => {
            *context.shared.handle.lock().expect("control poisoned") = None;
            // Architectures without complete native state copying cannot run
            // controlled sessions at all (eredu gates start on execution
            // control support). Fall back to ordinary observed generation:
            // same records and captures, no step/pause/force/snapshots.
            if let eredu::api::ControlledGenerationError::Capture(
                eredu_core::capture::CaptureError::Unsupported(reason),
            ) = &e
            {
                if spec.execution.as_deref() == Some("controlled") {
                    let _ = reply.send(Err(control_error("start", &e)));
                    return None;
                }
                let reason = reason.clone();
                return run_observed_fallback(
                    loaded,
                    &spec,
                    &prepared_spec,
                    |model| prepare_observed(model, &chat, &prepared_spec, raw_prefix.as_deref()),
                    use_text,
                    reason,
                    reply,
                    context,
                );
            }
            let _ = reply.send(Err(control_error("start", &e)));
            return None;
        }
    };

    // Snapshots are best-effort; unsupported reasons flow to the UI verbatim.
    let mut tree = TreeState {
        snapshots: BTreeMap::new(),
        slots: BTreeMap::new(),
        active_run: session.output_checkpoint().run_id,
        snapshot_cadence: prepared_spec.snapshot_cadence,
        max_auto_snapshots: budgets::DEFAULT_AUTO_SNAPSHOTS
            .min(prepared_spec.snapshot_limits.max_snapshots),
        snapshots_enabled: false,
        trace_limits: prepared_spec.trace,
        capture_limits: prepared_spec.capture_limits.clone(),
        next_slot: 0,
    };
    // Attempt directly: capabilities().snapshot only reports Supported AFTER a
    // successful enable_snapshots, so gating on it first would never enable.
    let mut snapshot_support_note: Option<String> = None;
    match session.enable_snapshots(prepared_spec.snapshot_limits) {
        Ok(()) => tree.snapshots_enabled = true,
        Err(e) => snapshot_support_note = Some(e.to_string()),
    }

    // Register the run and answer the start request.
    let run_id = tree.active_run.clone();
    context.emitter.journal.register_run(RunMeta {
        run_id: run_id.clone(),
        model_epoch: context.emitter.model_epoch,
        artifact_path: context.emitter.artifact_path.display().to_string(),
        model_label: context.emitter.model_label.clone(),
        speculative: false,
        spec_json: serialize_string(&spec),
        lineage: None,
        status: RunStatus::Active,
        resumable: true,
        pinned: false,
        created_ms: spec.created_ms.unwrap_or(0),
    });
    let _ = reply.send(Ok(RunStartedDto {
        run_id: run_id.clone(),
        speculative: false,
        clamp_notes: prepared_spec.clamp_notes.clone(),
        capabilities: Some(serialize_string(&session.capabilities())),
        snapshot_support: snapshot_support_note,
        control_support: None,
    }));

    // Initial snapshot at the prepared boundary makes position 0 branchable.
    maybe_auto_snapshot(&mut session, &mut tree, emitter);

    // ---- nested command loop (the session exclusively borrows the model) ----
    let mut pending: Option<Command> = None;
    loop {
        let command = match rx.recv() {
            Ok(c) => c,
            Err(_) => break,
        };
        match command {
            Command::Session(cmd) => {
                if handle_session_command(cmd, &mut session, &mut tree, context) {
                    break; // EndSession
                }
            }
            Command::Describe(r) => {
                let _ = r.send(Ok(info_clone.clone()));
            }
            Command::VocabPage { offset, limit, query, reply } => {
                let _ = reply.send(Ok(crate::vocab::page(
                    vocabulary.as_slice(),
                    offset,
                    limit,
                    query.as_deref(),
                )));
            }
            Command::Encode { reply, .. } => {
                let _ = reply.send(Err(IpcError::SessionActive {
                    active_run: tree.active_run.clone(),
                }));
            }
            Command::Decode { reply, .. } => {
                let _ = reply.send(Err(IpcError::SessionActive {
                    active_run: tree.active_run.clone(),
                }));
            }
            Command::Spec(cmd) => super::speculative::reject(cmd),
            Command::Component(cmd) => super::component::reject(cmd, &tree.active_run),
            Command::ForecastMemory { reply, .. } => {
                let _ = reply.send(Err(IpcError::SessionActive {
                    active_run: tree.active_run.clone(),
                }));
            }
            other @ (Command::StartRun { .. }
            | Command::StartSpeculativeRun { .. }
            | Command::Shutdown(_)) => {
                pending = Some(other);
                break;
            }
        }
    }

    // Teardown: settle the session and record terminal state.
    let final_status = session.status();
    if matches!(final_status, GenerationStatus::Running | GenerationStatus::Paused | GenerationStatus::Prepared) {
        let _ = session.cancel(emit_of(emitter));
    }
    let journal_status = match session.status() {
        GenerationStatus::Completed => RunStatus::Completed,
        GenerationStatus::Failed => RunStatus::Failed,
        _ => RunStatus::Cancelled,
    };
    // Every run in this tree becomes non-resumable once the tree is torn down.
    context.emitter.journal.set_status(&tree.active_run, journal_status, false);
    for branch in tree.slots.values() {
        context
            .emitter
            .journal
            .set_status(branch.run_id(), RunStatus::Cancelled, false);
    }
    tree.slots.clear();
    tree.snapshots.clear();
    drop(session);
    *context.shared.handle.lock().expect("control poisoned") = None;
    pending
}

/// Observed-only run: the model generates to completion (or cancellation via
/// the shared token) while records stream through the same envelope path as
/// controlled runs — each ObservedGenerationRecord wrapped with a synthesized
/// monotone sequence and epoch 0, so the journal and frontend are unchanged.
/// The start reply is sent on the first record (that is when eredu assigns
/// the run id), carrying the control-unavailability reason. `use_text`
/// selects literal text decoding (templates without a recognized format).
#[allow(clippy::too_many_arguments)]
fn run_observed_fallback(
    loaded: &mut LoadedWorkerModel,
    spec: &StartRunSpecDto,
    prepared_spec: &PreparedSpec,
    prepare: impl FnOnce(
        &mut eredu::api::LoadedModel<Backend>,
    ) -> Result<eredu::api::PreparedObservedGeneration, eredu::api::PreparedChatError>,
    use_text: bool,
    control_note: String,
    reply: Reply<RunStartedDto>,
    context: &WorkerContext,
) -> Option<Command> {
    // The first prepared request was consumed by the failed controlled start.
    let prepared = match prepare(&mut loaded.model) {
        Ok(p) => p,
        Err(e) => {
            let _ = reply.send(Err(IpcError::Control {
                op: "prepare_observed".into(),
                class: ControlErrorClass::Capture,
                message: e.to_string(),
                chain: error_chain(&e),
            }));
            return None;
        }
    };

    let cancellation = GenerationCancellationToken::new();
    *context
        .shared
        .spec_cancellation
        .lock()
        .expect("control poisoned") = Some(cancellation.clone());

    let emitter = &context.emitter;
    let journal = emitter.journal.clone();
    let model_epoch = emitter.model_epoch;
    let artifact_path = emitter.artifact_path.display().to_string();
    let model_label = emitter.model_label.clone();
    let spec_json = serialize_string(spec);
    let created_ms = spec.created_ms.unwrap_or(0);
    let clamp_notes = prepared_spec.clamp_notes.clone();

    let mut reply_slot = Some(reply);
    let mut run_id_slot: Option<String> = None;
    let mut sequence: u64 = 0;
    let emit = |record: ObservedGenerationRecord| -> std::ops::ControlFlow<()> {
        let run_id = record.run_id.clone();
        if run_id_slot.is_none() {
            run_id_slot = Some(run_id.clone());
            journal.register_run(RunMeta {
                run_id: run_id.clone(),
                model_epoch,
                artifact_path: artifact_path.clone(),
                model_label: model_label.clone(),
                speculative: false,
                spec_json: spec_json.clone(),
                lineage: None,
                status: RunStatus::Active,
                resumable: false,
                pinned: false,
                created_ms,
            });
            if let Some(r) = reply_slot.take() {
                let _ = r.send(Ok(RunStartedDto {
                    run_id: run_id.clone(),
                    speculative: false,
                    clamp_notes: clamp_notes.clone(),
                    capabilities: None,
                    snapshot_support: Some(control_note.clone()),
                    control_support: Some(control_note.clone()),
                }));
            }
        }
        let wrapped = ControlledGenerationRecord {
            schema_version: record.schema_version,
            sequence,
            epoch: 0,
            timing: Default::default(),
            generation: record,
        };
        sequence += 1;
        if emitter.emit_serialize(StreamKind::Controlled, &run_id, &wrapped) {
            std::ops::ControlFlow::Continue(())
        } else {
            std::ops::ControlFlow::Break(())
        }
    };

    let result = if use_text {
        loaded
            .model
            .generate_observed_text(prepared, &prepared_spec.stops, cancellation.clone(), emit)
    } else {
        loaded
            .model
            .generate_observed_chat(prepared, &prepared_spec.stops, cancellation.clone(), emit)
    };
    *context
        .shared
        .spec_cancellation
        .lock()
        .expect("control poisoned") = None;

    let (journal_status, status_word) = match &result {
        Ok(_) if cancellation.is_cancelled() => (RunStatus::Cancelled, "cancelled"),
        Ok(_) => (RunStatus::Completed, "completed"),
        Err(_) => (RunStatus::Failed, "failed"),
    };
    if let Some(run_id) = &run_id_slot {
        journal.set_status(run_id, journal_status, false);
    }
    emitter.emit_system(&serde_json::json!({
        "kind": "observed_finished",
        "status": status_word,
        "message": result.as_ref().err().map(|e| e.to_string()),
    }));
    if let Some(r) = reply_slot {
        // Failed before any record was produced.
        let message = result
            .err()
            .map(|e| e.to_string())
            .unwrap_or_else(|| "observed generation produced no records".into());
        let _ = r.send(Err(IpcError::Control {
            op: "observed".into(),
            class: ControlErrorClass::Generation,
            message: message.clone(),
            chain: vec![message],
        }));
    }
    None
}

/// Returns true when the session should end.
fn handle_session_command(
    cmd: SessionCommand,
    session: &mut Session<'_>,
    tree: &mut TreeState,
    context: &WorkerContext,
) -> bool {
    let emitter = &context.emitter;
    match cmd {
        SessionCommand::Step { steps, reply } => {
            let mut result = Ok(());
            for _ in 0..steps.max(1) {
                if matches!(
                    session.status(),
                    GenerationStatus::Completed | GenerationStatus::Cancelled | GenerationStatus::Failed
                ) {
                    break;
                }
                if let Err(e) = session.step(emit_of(emitter)) {
                    result = Err(control_error("step", &e));
                    break;
                }
                maybe_auto_snapshot(session, tree, emitter);
            }
            let _ = reply.send(result.map(|()| status_dto(session)));
        }
        SessionCommand::Continue { reply } => {
            let run_result = if session.status() == GenerationStatus::Paused {
                session.resume(emit_of(emitter))
            } else {
                session.run(emit_of(emitter))
            };
            maybe_auto_snapshot(session, tree, emitter);
            let _ = reply.send(match run_result {
                Ok(_) => Ok(status_dto(session)),
                Err(e) => Err(control_error("run", &e)),
            });
        }
        SessionCommand::Resume { reply } => {
            let result = session.resume(emit_of(emitter));
            maybe_auto_snapshot(session, tree, emitter);
            let _ = reply.send(match result {
                Ok(_) => Ok(status_dto(session)),
                Err(e) => Err(control_error("resume", &e)),
            });
        }
        SessionCommand::Cancel { reply } => {
            let result = session.cancel(emit_of(emitter));
            let _ = reply.send(match result {
                Ok(_) => Ok(status_dto(session)),
                Err(e) => Err(control_error("cancel", &e)),
            });
        }
        SessionCommand::ForceToken { token_id, reply } => {
            let _ = reply.send(
                session
                    .force_next_token(token_id)
                    .map_err(|e| control_error("force_next_token", &e)),
            );
        }
        SessionCommand::ClearForcedToken { reply } => {
            let _ = reply.send(
                session
                    .clear_forced_token()
                    .map_err(|e| control_error("clear_forced_token", &e)),
            );
        }
        SessionCommand::OverrideSampling { temperature, reseed, reply } => {
            let request = SamplingOverride { temperature, reseed };
            let result = session
                .override_sampling(request, emit_of(emitter))
                .map_err(|e| control_error("override_sampling", &e))
                .and_then(|()| {
                    session
                        .sampling_state()
                        .map(|s| serialize_string(&s))
                        .map_err(|e| control_error("sampling_state", &e))
                });
            let _ = reply.send(result);
        }
        SessionCommand::SamplingState { reply } => {
            let _ = reply.send(
                session
                    .sampling_state()
                    .map(|s| serialize_string(&s))
                    .map_err(|e| control_error("sampling_state", &e)),
            );
        }
        SessionCommand::CreateSnapshot { pinned, reply } => {
            let _ = reply.send(create_snapshot(session, tree, emitter, pinned));
        }
        SessionCommand::RestoreSnapshot { snapshot_id, reply } => {
            let result = match tree.snapshots.get(&snapshot_id) {
                Some(entry) => session
                    .restore(&entry.handle, emit_of(emitter))
                    .map(|()| status_dto(session))
                    .map_err(|e| control_error("restore", &e)),
                None => Err(IpcError::RunNotFound { run_id: snapshot_id.clone() }),
            };
            let _ = reply.send(result);
        }
        SessionCommand::Fork { snapshot_id, options, reply } => {
            let result = fork_branch(session, tree, emitter, &snapshot_id, options, context);
            let _ = reply.send(result);
        }
        SessionCommand::ActivateBranch { slot_id, reply } => {
            let result = activate_branch(session, tree, emitter, &slot_id);
            let _ = reply.send(result.map(|()| tree_status(session, tree)));
        }
        SessionCommand::ReleaseSnapshot { snapshot_id, reply } => {
            let _ = reply.send(match tree.snapshots.remove(&snapshot_id) {
                Some(_) => Ok(()),
                None => Err(IpcError::RunNotFound { run_id: snapshot_id }),
            });
        }
        SessionCommand::ReleaseBranch { slot_id, reply } => {
            let _ = reply.send(match tree.slots.remove(&slot_id) {
                Some(branch) => {
                    context
                        .emitter
                        .journal
                        .set_status(branch.run_id(), RunStatus::Cancelled, false);
                    Ok(())
                }
                None => Err(IpcError::RunNotFound { run_id: slot_id }),
            });
        }
        SessionCommand::Counterfactual { run_id, prediction_index, token_id, options, reply } => {
            let result =
                counterfactual(session, tree, emitter, context, &run_id, prediction_index, token_id, options);
            let _ = reply.send(result);
        }
        SessionCommand::ForecastRemaining { additional_tokens, budget_bytes, reply } => {
            let result = session
                .forecast_remaining_generation(
                    additional_tokens,
                    &crate::memory::forecast_options(budget_bytes),
                )
                .map_err(|e| IpcError::Capability {
                    operation: "continuation forecast".into(),
                    reason: e.to_string(),
                })
                .and_then(|forecast| {
                    crate::memory::summarize_continuation(
                        forecast,
                        additional_tokens,
                        eredu::api::discover_local_hardware()
                            .physical_memory_bytes
                            .value()
                            .copied(),
                        crate::worker::load::allocator_sample(),
                    )
                });
            let _ = reply.send(result);
        }
        SessionCommand::TreeStatus { reply } => {
            let _ = reply.send(Ok(tree_status(session, tree)));
        }
        SessionCommand::EndSession { reply } => {
            let _ = reply.send(Ok(()));
            return true;
        }
    }
    false
}

fn create_snapshot(
    session: &mut Session<'_>,
    tree: &mut TreeState,
    emitter: &Emitter,
    pinned: bool,
) -> Result<SnapshotMetaDto, IpcError> {
    if !tree.snapshots_enabled {
        return Err(IpcError::Capability {
            operation: "snapshot".into(),
            reason: "snapshots are not enabled for this session".into(),
        });
    }
    let handle = session
        .snapshot(emit_of(emitter))
        .map_err(|e| control_error("snapshot", &e))?;
    let meta = handle.metadata();
    let dto = SnapshotMetaDto {
        snapshot_id: meta.snapshot_id.clone(),
        next_prediction: snapshot_position(&handle),
        pinned,
        retained_bytes: meta.retained_bytes,
    };
    tree.snapshots
        .insert(meta.snapshot_id.clone(), SnapEntry { handle, pinned });
    thin_auto_snapshots(tree);
    Ok(dto)
}

/// Automatic snapshots at settled boundaries: after prefill (prediction 0/1)
/// and every `cadence` predictions. Never inside run(); callers invoke this at
/// step/pause boundaries only.
fn maybe_auto_snapshot(session: &mut Session<'_>, tree: &mut TreeState, emitter: &Emitter) {
    if !tree.snapshots_enabled {
        return;
    }
    if !matches!(session.status(), GenerationStatus::Prepared | GenerationStatus::Paused) {
        return;
    }
    let next = session.next_prediction();
    let auto_positions: Vec<u64> = tree
        .snapshots
        .values()
        .map(|s| snapshot_position(&s.handle))
        .collect();
    if auto_positions.iter().any(|&p| p == next) {
        return;
    }
    let due = auto_positions.iter().max().map_or(true, |&latest| {
        next >= latest + tree.snapshot_cadence
    }) || auto_positions.is_empty();
    if !due {
        return;
    }
    if let Ok(handle) = session.snapshot(emit_of(emitter)) {
        let id = handle.metadata().snapshot_id.clone();
        tree.snapshots.insert(id, SnapEntry { handle, pinned: false });
        thin_auto_snapshots(tree);
    }
    // A failed auto snapshot (budget exhausted) is silent; user snapshots
    // report their errors explicitly.
}

/// Release the unpinned auto snapshot whose removal minimizes the largest
/// replay gap; the earliest snapshot (post-prefill anchor) is always kept.
fn thin_auto_snapshots(tree: &mut TreeState) {
    loop {
        let auto: Vec<(String, u64)> = tree
            .snapshots
            .iter()
            .filter(|(_, e)| !e.pinned)
            .map(|(id, e)| (id.clone(), snapshot_position(&e.handle)))
            .collect();
        if (auto.len() as u64) <= tree.max_auto_snapshots {
            return;
        }
        let mut sorted = auto.clone();
        sorted.sort_by_key(|(_, p)| *p);
        // Candidates exclude the first (anchor) and last (most recent).
        if sorted.len() <= 2 {
            return;
        }
        let mut best: Option<(String, u64)> = None;
        for i in 1..sorted.len() - 1 {
            let gap = sorted[i + 1].1 - sorted[i - 1].1;
            match &best {
                Some((_, g)) if *g <= gap => {}
                _ => best = Some((sorted[i].0.clone(), gap)),
            }
        }
        match best {
            Some((id, _)) => {
                tree.snapshots.remove(&id);
            }
            None => return,
        }
    }
}

fn branch_options(
    tree: &TreeState,
    temperature: Option<f32>,
    reseed: Option<u64>,
    intervention: Option<serde_json::Value>,
) -> Result<GenerationBranchOptions, IpcError> {
    let sampling = if temperature.is_some() || reseed.is_some() {
        Some(SamplingOverride { temperature, reseed })
    } else {
        None
    };
    let intervention = match intervention {
        Some(v) if !v.is_null() => Some(
            serde_json::from_value::<InterventionPlan>(v)
                .map_err(|e| IpcError::Internal { message: format!("intervention plan: {e}") })?,
        ),
        _ => None,
    };
    Ok(GenerationBranchOptions {
        trace_limits: tree.trace_limits,
        capture_limits: Some(tree.capture_limits.clone()),
        sampling,
        intervention,
    })
}

fn fork_branch(
    session: &mut Session<'_>,
    tree: &mut TreeState,
    emitter: &Emitter,
    snapshot_id: &str,
    options: BranchOptionsDto,
    context: &WorkerContext,
) -> Result<String, IpcError> {
    let opts = branch_options(tree, options.temperature, options.reseed, options.intervention)?;
    let entry = tree
        .snapshots
        .get(snapshot_id)
        .ok_or_else(|| IpcError::RunNotFound { run_id: snapshot_id.to_string() })?;
    let branch = session
        .fork(&entry.handle, opts, emit_of(emitter))
        .map_err(|e| control_error("fork", &e))?;
    register_branch_run(context, tree, &branch, snapshot_id);
    let slot_id = format!("slot-{}", tree.next_slot);
    tree.next_slot += 1;
    tree.slots.insert(slot_id.clone(), branch);
    Ok(slot_id)
}

fn register_branch_run(
    context: &WorkerContext,
    tree: &TreeState,
    branch: &Branch,
    snapshot_id: &str,
) {
    let divergence = tree
        .snapshots
        .get(snapshot_id)
        .map(|s| snapshot_position(&s.handle))
        .unwrap_or(0);
    context.emitter.journal.register_run(RunMeta {
        run_id: branch.run_id().to_string(),
        model_epoch: context.emitter.model_epoch,
        artifact_path: context.emitter.artifact_path.display().to_string(),
        model_label: context.emitter.model_label.clone(),
        speculative: false,
        spec_json: "{}".into(),
        lineage: Some(RunLineage {
            parent_run_id: tree.active_run.clone(),
            snapshot_id: snapshot_id.to_string(),
            divergence_prediction: divergence,
        }),
        status: RunStatus::Active,
        resumable: true,
        pinned: false,
        created_ms: 0,
    });
}

fn activate_branch(
    session: &mut Session<'_>,
    tree: &mut TreeState,
    emitter: &Emitter,
    slot_id: &str,
) -> Result<(), IpcError> {
    let branch = tree
        .slots
        .get_mut(slot_id)
        .ok_or_else(|| IpcError::RunNotFound { run_id: slot_id.to_string() })?;
    session
        .exchange(branch, emit_of(emitter))
        .map_err(|e| control_error("exchange", &e))?;
    // The slot now retains the previously active run; slot identity ≠ run
    // identity, so both sides are re-read after every exchange.
    tree.active_run = session.output_checkpoint().run_id;
    Ok(())
}

fn tree_status(session: &mut Session<'_>, tree: &TreeState) -> TreeStatusDto {
    let mut snapshots: Vec<SnapshotMetaDto> = tree
        .snapshots
        .iter()
        .map(|(id, e)| SnapshotMetaDto {
            snapshot_id: id.clone(),
            next_prediction: snapshot_position(&e.handle),
            pinned: e.pinned,
            retained_bytes: e.handle.metadata().retained_bytes,
        })
        .collect();
    snapshots.sort_by_key(|s| s.next_prediction);
    TreeStatusDto {
        active_run: tree.active_run.clone(),
        snapshots,
        slots: tree
            .slots
            .iter()
            .map(|(id, b)| SlotDto { slot_id: id.clone(), parked_run_id: b.run_id().to_string() })
            .collect(),
        capabilities: Some(serialize_string(&session.capabilities())),
        sampling: session.sampling_state().ok().map(|s| serialize_string(&s)),
        snapshot_usage: session.snapshot_usage().map(|u| serialize_string(&u)),
        emitted_bytes: session.emitted_bytes(),
    }
}

/// The counterfactual composite: fork the nearest snapshot at or before the
/// requested position, deterministically replay the committed tokens (exact
/// inherited RNG), then force the alternative token.
#[allow(clippy::too_many_arguments)]
fn counterfactual(
    session: &mut Session<'_>,
    tree: &mut TreeState,
    emitter: &Emitter,
    context: &WorkerContext,
    run_id: &str,
    prediction_index: u64,
    token_id: u32,
    options: CounterfactualOptionsDto,
) -> Result<CounterfactualResultDto, IpcError> {
    if matches!(session.status(), GenerationStatus::Cancelled | GenerationStatus::Failed) {
        return Err(IpcError::Capability {
            operation: "counterfactual".into(),
            reason: "cancelled or failed runs cannot be revived".into(),
        });
    }
    // The target run must be active (or parked — activate it first).
    if tree.active_run != run_id {
        let slot: Option<String> = tree
            .slots
            .iter()
            .find(|(_, b)| b.run_id() == run_id)
            .map(|(id, _)| id.clone());
        match slot {
            Some(slot_id) => activate_branch(session, tree, emitter, &slot_id)?,
            None => return Err(IpcError::RunNotFound { run_id: run_id.to_string() }),
        }
    }
    if prediction_index >= session.next_prediction() {
        // Forcing the head position needs no branch at all.
        session
            .force_next_token(token_id)
            .map_err(|e| control_error("force_next_token", &e))?;
        return Ok(CounterfactualResultDto {
            child_run_id: tree.active_run.clone(),
            slot_id: String::new(),
            forked_from_snapshot: String::new(),
            replayed_steps: 0,
        });
    }

    // Nearest snapshot at or before the position.
    let candidate = tree
        .snapshots
        .iter()
        .map(|(id, e)| (id.clone(), snapshot_position(&e.handle)))
        .filter(|(_, p)| *p <= prediction_index)
        .max_by_key(|(_, p)| *p);
    let (snapshot_id, _snap_prediction) = candidate.ok_or_else(|| {
        let earliest = tree
            .snapshots
            .values()
            .map(|e| snapshot_position(&e.handle))
            .min();
        IpcError::SnapshotUnreachable {
            requested_prediction: prediction_index.to_string(),
            earliest_reachable: earliest.map(|p| p.to_string()),
        }
    })?;

    // Committed tokens of the active run cover the replay span.
    let committed: Vec<u32> = session.token_ids().to_vec();
    let opts = branch_options(tree, options.temperature, options.reseed, options.intervention)?;
    let (branch, parked_slot) = {
        let entry = tree.snapshots.get(&snapshot_id).expect("candidate exists");
        let mut branch = session
            .fork(&entry.handle, opts, emit_of(emitter))
            .map_err(|e| control_error("fork", &e))?;
        register_branch_run(context, tree, &branch, &snapshot_id);
        session
            .exchange(&mut branch, emit_of(emitter))
            .map_err(|e| control_error("exchange", &e))?;
        // `branch` now parks the previous active run.
        let slot_id = format!("slot-{}", tree.next_slot);
        tree.next_slot += 1;
        (branch, slot_id)
    };
    tree.slots.insert(parked_slot.clone(), branch);
    tree.active_run = session.output_checkpoint().run_id;
    let child_run_id = tree.active_run.clone();

    // Deterministic replay: force each original committed token so the branch
    // reproduces the parent exactly (records carry phase=replay), then force
    // the alternative at the requested position.
    emitter.replay_phase.store(true, std::sync::atomic::Ordering::SeqCst);
    let replay_result = (|| {
        let mut replayed = 0u64;
        while session.next_prediction() < prediction_index {
            let position = session.next_prediction() as usize;
            let original = *committed.get(position).ok_or_else(|| IpcError::Internal {
                message: format!("replay ran past committed history at {position}"),
            })?;
            session
                .force_next_token(original)
                .map_err(|e| control_error("replay force", &e))?;
            session
                .step(emit_of(emitter))
                .map_err(|e| control_error("replay step", &e))?;
            replayed += 1;
        }
        Ok(replayed)
    })();
    emitter.replay_phase.store(false, std::sync::atomic::Ordering::SeqCst);
    let replayed_steps = replay_result?;

    session
        .force_next_token(token_id)
        .map_err(|e| control_error("force_next_token", &e))?;
    session
        .step(emit_of(emitter))
        .map_err(|e| control_error("step", &e))?;
    if options.auto_continue {
        session
            .run(emit_of(emitter))
            .map_err(|e| control_error("run", &e))?;
    }
    maybe_auto_snapshot(session, tree, emitter);

    Ok(CounterfactualResultDto {
        child_run_id,
        slot_id: parked_slot,
        forked_from_snapshot: snapshot_id.to_string(),
        replayed_steps,
    })
}
