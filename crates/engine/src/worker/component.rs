//! Component analysis ("Through the Looking Glass: Directly Reading and
//! Writing Transformers"): signed score decomposition, causal deletion /
//! keep-only mask trials, bounded parameter queries and reversible coordinated
//! weight overlays — all through eredu's public component-analysis surface.
//!
//! Every trial is an exact-prefix replay (`prepare_observed_token_ids` /
//! `prepare_intervened_token_ids`) on the idle model: the caller supplies the
//! exact prefix token IDs (prompt + committed tokens before the analyzed
//! prediction), the last prefix row scores the analyzed prediction, and the
//! ordinary sampler chooses the continuation. Nothing here runs while a
//! controlled or speculative session borrows the model.

use std::collections::BTreeMap;

use eredu::api::{
    ObservedGenerationEvent, ObservedGenerationRecord, PreparedChatGenerationSettings, TraceLimits,
};
use eredu::runtime::chat::SemanticSupport;
use std::ops::ControlFlow;
use eredu_core::capture::{
    CaptureLimitPolicy, CaptureLimits, CaptureOutcome, CapturePayload, CapturePlan,
    CaptureSchedule, CaptureSelection, CaptureSkipReason, CaptureSlice, CaptureTransform,
    CaptureUsage, CAPTURE_SCHEMA_VERSION,
};
use eredu_core::component::{ComponentGroup, ComponentNormalization};
use eredu_core::intervention::{
    InterventionAction, InterventionDtype, InterventionEvidence, InterventionOperation,
    InterventionPlan, INTERVENTION_SCHEMA_VERSION,
};
use eredu_core::parameters::{
    ParameterDiscovery, ParameterEdit, ParameterOverlayPlan, ParameterProjection, ParameterRegion,
    ParameterUpdate, ProjectionInputTransform, PARAMETER_SCHEMA_VERSION,
};
use eredu_core::{ArchitectureDescriptor, GenerationConfigOverrides};
use eredu_evaluation::component_attribution::{signed_sum, MeasuredReadout, ReadoutNormalization};
use serde::{Deserialize, Serialize};

use crate::error::{error_chain, IpcError};
use crate::worker::load::LoadedWorkerModel;
use crate::worker::{Reply, WorkerContext};

// ---------- worker-held state ----------

/// Component/parameter state owned by the worker across commands.
#[derive(Default)]
pub struct ComponentState {
    /// Cached architecture descriptor (cold inspection of the loaded artifact).
    pub architecture: Option<ArchitectureDescriptor>,
    /// Cached loaded-parameter catalog; refreshed after overlay operations
    /// (the discovery identity changes on every parameter publication).
    pub discovery: Option<ParameterDiscovery>,
    /// Active overlay identity, retained for removal.
    pub overlay: Option<String>,
}

// ---------- DTOs ----------

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnalyzeRequestDto {
    /// Exact prefix token IDs; the last row scores the analyzed prediction.
    pub prefix_ids: Vec<u32>,
    /// Token whose score is decomposed (usually the committed token).
    pub target_token: u32,
    /// Margin competitor. Absent = the captured strongest alternative.
    #[serde(default)]
    pub competitor_token: Option<u32>,
    /// Ranked components returned per decomposition (default 64, cap 512).
    #[serde(default)]
    pub top_components: Option<u32>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MaskDto {
    pub group_id: String,
    pub indices: Vec<u32>,
    pub keep_selected: bool,
    /// Measured source precision word from a prior analysis ("f32"|"f16"|"bf16").
    pub dtype: String,
    /// "prediction" (last prefix row only, default) or "everywhere".
    #[serde(default)]
    pub scope: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MaskTrialRequestDto {
    pub prefix_ids: Vec<u32>,
    pub target_token: u32,
    #[serde(default)]
    pub competitor_token: Option<u32>,
    pub masks: Vec<MaskDto>,
    /// Continuation length after the analyzed prediction (default 8, cap 64).
    #[serde(default)]
    pub max_new_tokens: Option<u32>,
    #[serde(default)]
    pub seed: Option<u64>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QueryParameterDto {
    pub parameter: String,
    pub starts: Vec<u64>,
    pub shape: Vec<u64>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum ComponentEditActionDto {
    /// Multiply the component's write column by `factor` (0 = delete).
    Scale { factor: f32 },
    /// Add `values` (length = residual width) to the write column.
    Add { values: Vec<f32> },
    /// Replace the write column with `values` (length = residual width).
    Replace { values: Vec<f32> },
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ComponentEditDto {
    pub group_id: String,
    pub component: u32,
    pub action: ComponentEditActionDto,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OverlayRequestDto {
    pub provenance: String,
    /// Convenience write-column edits resolved by the engine.
    #[serde(default)]
    pub edits: Vec<ComponentEditDto>,
    /// Full eredu `ParameterEdit` list passthrough (advanced use).
    #[serde(default)]
    pub raw_edits: Option<serde_json::Value>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ComponentContributionDto {
    group: String,
    node_id: String,
    layer: usize,
    index: usize,
    value: f64,
    activation: f64,
    nested: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct GroupAggregateDto {
    group: String,
    node_id: String,
    layer: usize,
    count: usize,
    sum: f64,
    sum_abs: f64,
    max_abs: f64,
    argmax_index: usize,
    nested: bool,
    /// Attribution ran over write-input rows whose width differs from the
    /// declared component count (grouped write projections); ranked indices
    /// then address write rows, not maskable component IDs.
    axis_mismatch: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ScoreDecompositionDto {
    /// True when this is the target-minus-competitor margin decomposition.
    margin: bool,
    actual: f64,
    reconstructed: f64,
    absolute_error: f64,
    /// Normalization + readout bias terms, once per score.
    offset: f64,
    /// Measured whole-head input correction (e.g. dynamic FP8), kept separate.
    projection_input_correction: f64,
    embedding: f64,
    /// Whole residual terms with no scalar decomposition (node id, value).
    other_writes: Vec<(String, f64)>,
    /// Per-group normalization offsets + write biases (non-nested groups).
    bias_terms: f64,
    component_count: usize,
    nested_components: usize,
    nested_component_sum: f64,
    top: Vec<ComponentContributionDto>,
    groups: Vec<GroupAggregateDto>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AnalysisResultDto {
    target_token: u32,
    /// Competitor actually used for the margin (requested or discovered).
    competitor_token: Option<u32>,
    /// Verbatim `CaptureTokenScores` payload for the analyzed row.
    token_scores: serde_json::Value,
    /// Declared nonlinear output transform following the affine score.
    output_transform: serde_json::Value,
    /// Measured source precision per group activation path, for mask trials.
    source_dtypes: BTreeMap<String, String>,
    score: ScoreDecompositionDto,
    margin: Option<ScoreDecompositionDto>,
    /// Cumulative parameter-side usage after this analysis.
    parameter_usage: serde_json::Value,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct TrialResultDto {
    token_scores: serde_json::Value,
    generated: Vec<TrialTokenDto>,
    status: String,
    failure: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct TrialTokenDto {
    id: u32,
    text: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct OverlayResultDto {
    overlay_identity: Option<String>,
    discovery: serde_json::Value,
}

// ---------- commands ----------

pub enum ComponentCommand {
    /// Serialized `ParameterDiscovery` (loaded parameter catalog + identity).
    Discovery { reply: Reply<String> },
    Analyze { req: Box<AnalyzeRequestDto>, reply: Reply<String> },
    MaskTrial { req: Box<MaskTrialRequestDto>, reply: Reply<String> },
    /// Bounded effective parameter region as F32 host values.
    QueryParameter { req: QueryParameterDto, reply: Reply<String> },
    InstallOverlay { req: Box<OverlayRequestDto>, reply: Reply<String> },
    RemoveOverlay { reply: Reply<String> },
}

/// Reject a component command while a session exclusively borrows the model.
pub fn reject(cmd: ComponentCommand, active_run: &str) {
    let err = || IpcError::SessionActive { active_run: active_run.to_string() };
    match cmd {
        ComponentCommand::Discovery { reply } => drop(reply.send(Err(err()))),
        ComponentCommand::Analyze { reply, .. } => drop(reply.send(Err(err()))),
        ComponentCommand::MaskTrial { reply, .. } => drop(reply.send(Err(err()))),
        ComponentCommand::QueryParameter { reply, .. } => drop(reply.send(Err(err()))),
        ComponentCommand::InstallOverlay { reply, .. } => drop(reply.send(Err(err()))),
        ComponentCommand::RemoveOverlay { reply } => drop(reply.send(Err(err()))),
    }
}

/// Handle a component command on the idle model (top loop only).
pub fn handle(cmd: ComponentCommand, loaded: &mut LoadedWorkerModel, context: &WorkerContext) {
    match cmd {
        ComponentCommand::Discovery { reply } => {
            let _ = reply.send(discovery_json(loaded));
        }
        ComponentCommand::Analyze { req, reply } => {
            let result = analyze(loaded, &req, context);
            let _ = reply.send(result);
        }
        ComponentCommand::MaskTrial { req, reply } => {
            let result = mask_trial(loaded, &req, context);
            let _ = reply.send(result);
        }
        ComponentCommand::QueryParameter { req, reply } => {
            let _ = reply.send(query_parameter_json(loaded, &req));
        }
        ComponentCommand::InstallOverlay { req, reply } => {
            let result = install_overlay(loaded, &req, context);
            let _ = reply.send(result);
        }
        ComponentCommand::RemoveOverlay { reply } => {
            let result = remove_overlay(loaded, context);
            let _ = reply.send(result);
        }
    }
}

// ---------- shared plumbing ----------

fn component_error(stage: &str, err: &dyn std::error::Error) -> IpcError {
    IpcError::Component {
        stage: stage.to_string(),
        message: err.to_string(),
        chain: error_chain(err),
    }
}

fn component_fail(stage: &str, message: impl Into<String>) -> IpcError {
    IpcError::Component { stage: stage.to_string(), message: message.into(), chain: Vec::new() }
}

/// Absolute cumulative parameter-side limits for the loaded session. These are
/// logical owned-array/transfer accounts (never refunded), not physical memory;
/// they exist to bound runaway work, so they are set far above one analysis.
fn parameter_limits() -> CaptureUsage {
    CaptureUsage {
        captures: 1 << 20,
        retained_bytes: 1 << 40,
        host_bytes: 16 << 30,
        encoded_bytes: 16 << 30,
    }
}

/// Per-trial capture budget, sized to the model rather than a fixed ceiling.
///
/// Every captured tensor is a single sequence row, so the dominant cost is the
/// total component width Σ`count` (one activation row per group), plus one row
/// per readout/write selection. eredu charges a Slice ~32 encoded and ~16 host
/// bytes per element, and a prefill source is charged at prompt length. A large
/// MoE has tens of millions of scalar components, which overruns any fixed
/// ceiling; these are logical accounting reservations (not physical memory —
/// the doc notes they can exceed peak host memory), so we reserve generously
/// against the actual plan and keep `on_limit: Fail` so a genuinely
/// pathological plan still surfaces its reason verbatim.
fn analysis_capture_limits(
    component_elements: u64,
    selection_count: u64,
    prefix_len: u64,
    vocabulary: u64,
) -> CaptureLimits {
    let mul = u64::saturating_mul;
    let add = u64::saturating_add;
    // Upper bound on selected elements across one step: two component rows per
    // group (activation + write-input) plus one vocabulary-width row per
    // remaining selection (readout/write columns are all ≤ vocabulary wide).
    let selected_upper = add(
        mul(component_elements, 2),
        mul(selection_count, vocabulary.max(1)),
    );
    // Prefill source is charged at prompt length; give it headroom.
    let source_upper = mul(mul(selected_upper, prefix_len.max(1)), 8);
    let usage = CaptureUsage {
        captures: add(selection_count, 4096),
        retained_bytes: add(add(source_upper, mul(selected_upper, 16)), 512 << 20).max(2 << 30),
        host_bytes: add(mul(selected_upper, 32), 256 << 20).max(512 << 20),
        encoded_bytes: add(mul(selected_upper, 64), 256 << 20).max(512 << 20),
    };
    CaptureLimits {
        per_step: usage,
        cumulative: usage,
        physical_native_bytes: None,
        // Fail loudly: analysis needs complete evidence, and eredu's reasons
        // reach the UI verbatim instead of silently missing terms.
        on_limit: CaptureLimitPolicy::Fail,
    }
}

fn trial_trace_limits(selection_count: u64, component_elements: u64) -> TraceLimits {
    let mul = u64::saturating_mul;
    // One JSON record per selection; component records carry a full row.
    let total = mul(add_u64(component_elements, mul(selection_count, 4096)), 48).max(256 << 20);
    TraceLimits {
        per_record_bytes: (32 << 20),
        total_bytes: total,
    }
}

fn add_u64(a: u64, b: u64) -> u64 {
    a.saturating_add(b)
}

#[cfg(test)]
mod budget_tests {
    use super::*;

    #[test]
    fn analysis_budget_scales_past_the_fixed_ceiling() {
        // A large MoE has tens of millions of scalar components; the former
        // fixed 512 MiB encoded ceiling rejected the plan (the reported bug).
        // The sized budget must comfortably exceed the plan's own estimate.
        let components: u64 = 16_000_000;
        let selections: u64 = 400;
        let vocab: u64 = 256_000;
        let limits = analysis_capture_limits(components, selections, 48, vocab);
        // eredu charges a Slice ~32 encoded bytes per selected element; the
        // dominant term is one activation row per component.
        let estimate = components * 32;
        assert!(
            limits.per_step.encoded_bytes > estimate,
            "encoded budget {} must exceed the plan estimate {estimate}",
            limits.per_step.encoded_bytes
        );
        assert!(limits.per_step.encoded_bytes > (512 << 20));
        // Retained scales with prompt length at prefill.
        assert!(limits.per_step.retained_bytes > components * 48 * 8);
        assert!(limits.per_step.captures >= selections);
    }

    #[test]
    fn analysis_budget_keeps_generous_floors_for_small_models() {
        let limits = analysis_capture_limits(0, 1, 8, 64_000);
        assert!(limits.per_step.encoded_bytes >= (512 << 20));
        assert!(limits.per_step.retained_bytes >= (2 << 30));
    }
}

fn architecture<'a>(
    loaded: &'a mut LoadedWorkerModel,
) -> Result<&'a ArchitectureDescriptor, IpcError> {
    if loaded.component.architecture.is_none() {
        let descriptor = eredu::api::inspect_architecture(&loaded.info.artifact_path)
            .map_err(|e| component_error("architecture inspection", &e))?;
        loaded.component.architecture = Some(descriptor);
    }
    Ok(loaded.component.architecture.as_ref().expect("just cached"))
}

fn refresh_discovery(loaded: &mut LoadedWorkerModel) -> Result<(), IpcError> {
    let discovery = loaded
        .model
        .parameter_discovery()
        .map_err(|e| component_error("parameter discovery", &e))?;
    loaded.component.discovery = Some(discovery);
    Ok(())
}

fn ensure_discovery(loaded: &mut LoadedWorkerModel) -> Result<(), IpcError> {
    if loaded.component.discovery.is_none() {
        refresh_discovery(loaded)?;
    }
    Ok(())
}

fn discovery_json(loaded: &mut LoadedWorkerModel) -> Result<String, IpcError> {
    ensure_discovery(loaded)?;
    serde_json::to_string(loaded.component.discovery.as_ref().expect("cached"))
        .map_err(|e| component_fail("discovery serialization", e.to_string()))
}

fn stage_event(context: &WorkerContext, stage: &str) {
    context
        .emitter
        .emit_system(&serde_json::json!({ "kind": "component_stage", "stage": stage }));
}

/// Throwaway prepared chat carrying the output/termination contract for
/// exact-token replay (the prefix IDs are never re-encoded).
fn replay_chat(
    loaded: &mut LoadedWorkerModel,
) -> Result<eredu::runtime::chat::PreparedChat, IpcError> {
    loaded.prepare_chat(eredu::runtime::chat::ChatTemplateRequest {
        messages: vec![serde_json::json!({"role": "user", "content": "component analysis"})],
        add_generation_prompt: true,
        ..Default::default()
    })
}

fn replay_settings(max_new_tokens: u64, seed: u64) -> PreparedChatGenerationSettings {
    PreparedChatGenerationSettings {
        overrides: GenerationConfigOverrides {
            temperature: Some(0.0),
            max_new_tokens: Some(max_new_tokens as usize),
            ..Default::default()
        },
        seed,
        ..Default::default()
    }
}

/// Word forms for `CaptureRecord::source_dtype`, reused by mask-trial dtypes.
fn dtype_word(dtype: &eredu_core::checkpoint::TensorDtype) -> Option<&'static str> {
    use eredu_core::checkpoint::TensorDtype;
    match dtype {
        TensorDtype::F32 => Some("f32"),
        TensorDtype::F16 => Some("f16"),
        TensorDtype::Bf16 => Some("bf16"),
        _ => None,
    }
}

fn intervention_dtype(word: &str) -> Result<InterventionDtype, IpcError> {
    match word {
        "f32" => Ok(InterventionDtype::Float32),
        "f16" => Ok(InterventionDtype::Float16),
        "bf16" => Ok(InterventionDtype::Bfloat16),
        other => Err(component_fail(
            "mask dtype",
            format!("unsupported measured source precision {other:?}; run an analysis first"),
        )),
    }
}

/// The last prefix row (the row that scores the analyzed prediction).
fn last_row_slice(prefix_len: usize) -> Vec<CaptureSlice> {
    vec![CaptureSlice {
        axis: "sequence".into(),
        start: prefix_len as u64 - 1,
        end: prefix_len as u64,
        stride: 1,
    }]
}

fn prefill_only() -> CaptureSchedule {
    CaptureSchedule { decode: false, ..Default::default() }
}

/// Paths captured for one component group's evidence.
fn group_evidence_paths(group: &ComponentGroup) -> Result<Vec<String>, IpcError> {
    let mut paths = vec![group.effective_activation.clone()];
    if let Some(input) = &group.write_input {
        paths.push(input.clone());
    }
    if group.output_normalization.is_some() {
        paths.push(group_write_evidence_path(group)?);
    }
    Ok(paths)
}

/// The affine write before output normalization (`.effective` observation).
/// Prefer the declared `write_output` relationship; older descriptors fall
/// back to the reference consumer's derivation from the group input path.
fn group_write_evidence_path(group: &ComponentGroup) -> Result<String, IpcError> {
    if let Some(write_output) = &group.write_output {
        return Ok(format!("{write_output}.effective"));
    }
    let base = group.input.trim_end_matches(".input");
    if base == group.input {
        return Err(component_fail(
            "write evidence",
            format!(
                "group {} declares output normalization but no write_output path",
                group.id
            ),
        ));
    }
    Ok(format!("{base}.write.effective"))
}

/// Fails on architecture shapes the v1 decomposition cannot represent
/// honestly. These are declared equations the reference arithmetic below does
/// not yet apply (whole-residual scalars change every preceding write).
fn gate_supported(architecture: &ArchitectureDescriptor) -> Result<(), IpcError> {
    let readout = architecture
        .component_readout
        .as_ref()
        .ok_or_else(|| component_fail("support", "no component readout is declared for this architecture"))?;
    if architecture.components.is_empty() {
        return Err(component_fail("support", "no component groups are declared for this architecture"));
    }
    if !readout.block_normalizations.is_empty() || !readout.block_transforms.is_empty() {
        return Err(component_fail(
            "support",
            "this architecture declares whole-residual block normalizations/transforms; \
             their redistribution over earlier writes is not implemented yet",
        ));
    }
    if readout.stream_residual.is_some() {
        return Err(component_fail(
            "support",
            "this architecture declares a multi-stream residual equation, which is not implemented yet",
        ));
    }
    if !readout.score_writes.is_empty() {
        return Err(component_fail(
            "support",
            "this architecture declares dynamic vocabulary-space score writes, which are not implemented yet",
        ));
    }
    Ok(())
}

// ---------- capture-driven replay ----------

struct ReplayEvidence {
    /// F32 row values per captured path at the analyzed (prefill) row.
    values: BTreeMap<String, Vec<f32>>,
    /// Measured native source precision per captured path.
    dtypes: BTreeMap<String, String>,
    /// Verbatim TokenScores payload at the analyzed row.
    token_scores: Option<serde_json::Value>,
    /// Decoded committed continuation.
    generated: Vec<u32>,
    status: String,
    failure: Option<String>,
}

/// Run one exact-prefix replay, collecting analyzed-row tensor evidence and
/// the TokenScores reduction. `intervention` masks apply to this replay only.
#[allow(clippy::too_many_arguments)]
fn run_replay(
    loaded: &mut LoadedWorkerModel,
    context: &WorkerContext,
    prefix_ids: &[u32],
    selections: Vec<CaptureSelection>,
    component_elements: u64,
    intervention: Option<InterventionPlan>,
    max_new_tokens: u64,
    seed: u64,
) -> Result<ReplayEvidence, IpcError> {
    if prefix_ids.is_empty() {
        return Err(component_fail("replay", "empty prefix"));
    }
    loaded
        .model
        .reset()
        .map_err(|e| component_error("model reset", &e))?;
    let chat = replay_chat(loaded)?;
    let selection_count = selections.len() as u64;
    let limits = analysis_capture_limits(
        component_elements,
        selection_count,
        prefix_ids.len() as u64,
        loaded.info.vocabulary_size as u64,
    );
    let trace = trial_trace_limits(selection_count, component_elements);
    let capture = CapturePlan {
        schema_version: CAPTURE_SCHEMA_VERSION,
        selections,
        limits,
    };
    let settings = replay_settings(max_new_tokens, seed);
    // Exact prefix, no template re-render; the chat only supplies the
    // output/termination contract (the replay reads the first prediction).
    let prepared = match intervention {
        Some(plan) => loaded.model.prepare_intervened_token_ids(
            &chat,
            prefix_ids.to_vec(),
            settings,
            capture,
            plan,
            trace,
        ),
        None => loaded
            .model
            .prepare_observed_token_ids(&chat, prefix_ids.to_vec(), settings, capture, trace),
    }
    .map_err(|e| component_error("replay admission", &e))?;

    // The shared cancel surface reaches this replay too (Cancel in the UI).
    let cancellation = eredu_core::GenerationCancellationToken::new();
    *context
        .shared
        .spec_cancellation
        .lock()
        .expect("control poisoned") = Some(cancellation.clone());

    let mut evidence = ReplayEvidence {
        values: BTreeMap::new(),
        dtypes: BTreeMap::new(),
        token_scores: None,
        generated: Vec::new(),
        status: "completed".into(),
        failure: None,
    };
    let mut capture_failure: Option<String> = None;
    // Only the analyzed (prefill) prediction's captures are evidence.
    let mut harvest = |step: &eredu_core::capture::CapturedStep| {
        for captured in &step.records {
            match &captured.outcome {
                CaptureOutcome::Captured => {}
                CaptureOutcome::Skipped { reason: CaptureSkipReason::Schedule } => continue,
                other => {
                    if capture_failure.is_none() {
                        capture_failure = Some(format!("{}: {:?}", captured.path, other));
                    }
                    continue;
                }
            }
            match &captured.payload {
                Some(CapturePayload::Tensor(tensor)) => {
                    if let eredu_core::TensorObservationData::F32(values) = tensor.data() {
                        evidence.values.insert(captured.path.clone(), values.clone());
                    }
                    if let Some(dtype) = captured.source_dtype.as_ref().and_then(dtype_word) {
                        evidence.dtypes.insert(captured.path.clone(), dtype.to_string());
                    }
                }
                Some(CapturePayload::TokenScores(scores)) => {
                    evidence.token_scores = serde_json::to_value(scores).ok();
                }
                _ => {}
            }
        }
    };
    let on_record = |record: ObservedGenerationRecord| -> ControlFlow<()> {
        match &record.event {
            ObservedGenerationEvent::Token { prediction_index: 0, captures: Some(step), .. }
            | ObservedGenerationEvent::CaptureFailure { prediction_index: 0, captures: step, .. } => {
                harvest(step);
            }
            _ => {}
        }
        ControlFlow::Continue(())
    };
    let result = if matches!(chat.semantic_support(), SemanticSupport::Supported) {
        loaded
            .model
            .generate_observed_chat(prepared, &[], cancellation.clone(), on_record)
    } else {
        loaded
            .model
            .generate_observed_text(prepared, &[], cancellation.clone(), on_record)
    }
    .map_err(|e| component_error("replay", &e));
    *context
        .shared
        .spec_cancellation
        .lock()
        .expect("control poisoned") = None;

    match result {
        Ok(output) => {
            evidence.generated = output.token_ids.iter().copied().collect();
            if cancellation.is_cancelled() {
                evidence.status = "cancelled".into();
            }
        }
        Err(e) => {
            evidence.status = "failed".into();
            evidence.failure = Some(e.to_string());
        }
    }
    if evidence.failure.is_none() {
        evidence.failure = capture_failure;
    }
    Ok(evidence)
}

// ---------- analysis ----------

fn analyze(
    loaded: &mut LoadedWorkerModel,
    req: &AnalyzeRequestDto,
    context: &WorkerContext,
) -> Result<String, IpcError> {
    architecture(loaded)?;
    {
        let descriptor = loaded.component.architecture.as_ref().expect("cached");
        gate_supported(descriptor)?;
    }
    ensure_discovery(loaded)?;
    stage_event(context, "capture");

    // The borrow checker requires the descriptor to be cloned out of the
    // worker state: the replay and parameter queries need &mut model.
    let descriptor = loaded.component.architecture.clone().expect("cached");
    let readout = descriptor.component_readout.as_ref().expect("gated");

    let mut selections = Vec::new();
    let push = |selections: &mut Vec<CaptureSelection>, path: String, prefix_len: usize| {
        if selections.iter().any(|s: &CaptureSelection| s.path == path) {
            return;
        }
        selections.push(CaptureSelection {
            id: format!("component:{path}"),
            path,
            schedule: prefill_only(),
            slices: last_row_slice(prefix_len),
            transform: CaptureTransform::Slice,
        });
    };
    let prefix_len = req.prefix_ids.len();
    for group in &descriptor.components {
        for path in group_evidence_paths(group)? {
            push(&mut selections, path, prefix_len);
        }
    }
    if let Some(path) = &readout.projection_input {
        push(&mut selections, path.clone(), prefix_len);
    }
    for write in &readout.other_writes {
        push(&mut selections, write.effective_output.clone(), prefix_len);
    }
    for path in [
        &readout.embedding,
        &readout.residual,
        &readout.normalized,
        &readout.linear_scores,
    ] {
        push(&mut selections, format!("{path}.effective"), prefix_len);
    }
    let mut score_ids = vec![req.target_token];
    if let Some(competitor) = req.competitor_token {
        if competitor != req.target_token {
            score_ids.push(competitor);
        }
    }
    selections.push(CaptureSelection {
        id: "component:token-scores".into(),
        path: "model.logits".into(),
        schedule: prefill_only(),
        slices: vec![],
        transform: CaptureTransform::TokenScores { token_ids: score_ids },
    });

    let component_elements: u64 = descriptor.components.iter().map(|g| g.count as u64).sum();
    let evidence = run_replay(
        loaded,
        context,
        &req.prefix_ids,
        selections,
        component_elements,
        None,
        1,
        17,
    )?;
    if let Some(failure) = &evidence.failure {
        return Err(component_fail("capture", failure.clone()));
    }
    let token_scores = evidence
        .token_scores
        .clone()
        .ok_or_else(|| component_fail("capture", "no TokenScores payload was captured"))?;

    // Competitor: requested, else the captured strongest alternative.
    let competitor = req.competitor_token.filter(|c| *c != req.target_token).or_else(|| {
        token_scores["scores"]
            .as_array()
            .and_then(|scores| scores.first())
            .and_then(|s| s["strongest_alternative"]["token_id"].as_u64())
            .map(|id| id as u32)
    });

    stage_event(context, "reconstruction");
    let top_n = req.top_components.unwrap_or(64).min(512) as usize;
    let score = reconstruct(loaded, &descriptor, &evidence.values, req.target_token, None, top_n)?;
    let margin = match competitor {
        Some(competitor) => Some(reconstruct(
            loaded,
            &descriptor,
            &evidence.values,
            req.target_token,
            Some(competitor),
            top_n,
        )?),
        None => None,
    };

    // Group-activation source precisions, keyed by the maskable original path.
    let mut source_dtypes = BTreeMap::new();
    for group in &descriptor.components {
        if let Some(word) = evidence.dtypes.get(&group.effective_activation) {
            source_dtypes.insert(group.id.clone(), word.clone());
        }
    }

    let parameter_usage = loaded
        .component
        .discovery
        .as_ref()
        .map(|d| serde_json::to_value(&d.usage).unwrap_or(serde_json::Value::Null))
        .unwrap_or(serde_json::Value::Null);
    let result = AnalysisResultDto {
        target_token: req.target_token,
        competitor_token: competitor,
        token_scores,
        output_transform: serde_json::to_value(&readout.output_transform)
            .unwrap_or(serde_json::Value::Null),
        source_dtypes,
        score,
        margin,
        parameter_usage,
    };
    serde_json::to_string(&result)
        .map_err(|e| component_fail("result serialization", e.to_string()))
}

fn values<'a>(
    evidence: &'a BTreeMap<String, Vec<f32>>,
    path: &str,
) -> Result<&'a [f32], IpcError> {
    evidence
        .get(path)
        .map(Vec::as_slice)
        .ok_or_else(|| component_fail("evidence", format!("missing effective evidence: {path}")))
}

/// Whether `node` sits at or below a whole residual write declared in
/// `other_writes` (its components are constituents, not additional terms).
fn contained_by_whole_write(
    architecture: &ArchitectureDescriptor,
    node: &str,
) -> bool {
    let Some(readout) = architecture.component_readout.as_ref() else {
        return false;
    };
    let mut current = Some(node);
    for _ in 0..=architecture.nodes.len() {
        let Some(node) = current else {
            return false;
        };
        if readout.other_writes.iter().any(|write| write.node_id == node) {
            return true;
        }
        current = architecture.node(node).and_then(|n| n.parent.as_deref());
    }
    false
}

fn query(
    loaded: &mut LoadedWorkerModel,
    parameter: &str,
    row: Option<u64>,
) -> Result<Vec<f32>, IpcError> {
    let (identity, mut region) = {
        let discovery = loaded.component.discovery.as_ref().expect("cached");
        let descriptor = discovery
            .parameters
            .iter()
            .find(|p| p.id == parameter)
            .ok_or_else(|| {
                component_fail("parameter query", format!("{parameter} is not a loaded parameter"))
            })?;
        (
            discovery.identity.clone(),
            ParameterRegion {
                starts: vec![0; descriptor.shape.len()],
                shape: descriptor.shape.clone(),
            },
        )
    };
    if let Some(row) = row {
        region.starts[0] = row;
        region.shape[0] = 1;
    }
    Ok(loaded
        .model
        .query_parameter(&identity, parameter, region, parameter_limits())
        .map_err(|e| component_error("parameter query", &e))?
        .values)
}

fn measured(
    loaded: &mut LoadedWorkerModel,
    residual: &[f32],
    direction: &[f64],
    bias: f64,
    norm: &ComponentNormalization,
) -> Result<MeasuredReadout, IpcError> {
    let residual: Vec<f64> = residual.iter().map(|x| *x as f64).collect();
    let gain: Vec<f64> = match &norm.gain {
        Some(id) => query(loaded, id, None)?
            .into_iter()
            .map(|x| x as f64 + norm.gain_offset.value() as f64)
            .collect(),
        None => vec![1.0 + norm.gain_offset.value() as f64; residual.len()],
    };
    let offset: Option<Vec<f64>> = match &norm.bias {
        Some(id) => Some(query(loaded, id, None)?.into_iter().map(f64::from).collect()),
        None => None,
    };
    MeasuredReadout::new(
        &residual,
        direction,
        bias,
        ReadoutNormalization {
            kind: norm.kind,
            epsilon: norm.epsilon.value() as f64,
            gain: &gain,
            bias: offset.as_deref(),
            groups: norm.groups,
        },
    )
    .map_err(|e| component_error("measured readout", &e))
}

/// Signed score (or margin) reconstruction: the reference consumer arithmetic
/// from eredu's component-analysis example, returning structured terms and a
/// ranked component list instead of asserting.
fn reconstruct(
    loaded: &mut LoadedWorkerModel,
    descriptor: &ArchitectureDescriptor,
    evidence: &BTreeMap<String, Vec<f32>>,
    target: u32,
    competitor: Option<u32>,
    top_n: usize,
) -> Result<ScoreDecompositionDto, IpcError> {
    let readout = descriptor.component_readout.as_ref().expect("gated").clone();

    // Readout input arithmetic requires actual-input evidence or a verified
    // identity transform (e.g. no silent dynamic FP8 at the head).
    if readout.projection_input.is_none() {
        let discovery = loaded.component.discovery.as_ref().expect("cached");
        let verified = discovery.parameters.iter().any(|p| {
            p.id == readout.weight && p.input_transform == ProjectionInputTransform::Identity
        });
        if !verified {
            return Err(component_fail(
                "reconstruction",
                "readout input arithmetic requires actual-input evidence or a verified identity transform",
            ));
        }
    }

    let target_row = query(loaded, &readout.weight, Some(target as u64))?;
    let competitor_row = match competitor {
        Some(competitor) => Some(query(loaded, &readout.weight, Some(competitor as u64))?),
        None => None,
    };
    let output_bias = match &readout.bias {
        Some(id) => Some(query(loaded, id, None)?),
        None => None,
    };

    let residual = values(evidence, &format!("{}.effective", readout.residual))?.to_vec();
    let embedding = values(evidence, &format!("{}.effective", readout.embedding))?.to_vec();
    let scores = values(evidence, &format!("{}.effective", readout.linear_scores))?.to_vec();

    let row: Vec<f64> = target_row
        .iter()
        .enumerate()
        .map(|(i, a)| {
            *a as f64 - competitor_row.as_ref().map_or(0.0, |b| b[i] as f64)
        })
        .collect();
    let bias = output_bias.as_ref().map_or(0.0, |v| {
        v[target as usize] as f64
            - competitor.map_or(0.0, |c| v[c as usize] as f64)
    });
    let final_readout = measured(loaded, &residual, &row, bias, &readout.normalization)?;

    // Whole-head input correction (e.g. dynamic FP8 at the output head): the
    // difference between the head's actual multiplication input and the
    // normalized residual, measured against the same direction.
    let projection_input_correction = match &readout.projection_input {
        Some(path) => {
            let actual_input = values(evidence, path)?;
            let normalized = values(evidence, &format!("{}.effective", readout.normalized))?;
            if actual_input.len() != row.len() || normalized.len() != row.len() {
                return Err(component_fail("reconstruction", "readout projection-input geometry"));
            }
            signed_sum(actual_input.iter().zip(normalized).zip(&row).map(
                |((actual, supplied), direction)| (*actual as f64 - *supplied as f64) * direction,
            ))
        }
        None => 0.0,
    };

    let embedding_term = signed_sum(
        embedding
            .iter()
            .zip(&final_readout.direction)
            .map(|(x, d)| *x as f64 * d),
    );

    let mut terms = vec![final_readout.offset, projection_input_correction, embedding_term];
    let mut other_write_terms = Vec::new();
    for write in &readout.other_writes {
        let output = values(evidence, &write.effective_output)?;
        if output.len() != final_readout.direction.len() {
            return Err(component_fail("reconstruction", "whole residual-write geometry"));
        }
        let value = write.residual_scale.value() as f64
            * signed_sum(
                output
                    .iter()
                    .zip(&final_readout.direction)
                    .map(|(value, direction)| *value as f64 * direction),
            );
        other_write_terms.push((write.node_id.clone(), value));
        terms.push(value);
    }

    let mut component_count = 0usize;
    let mut bias_terms = 0.0f64;
    let mut nested_terms: Vec<f64> = Vec::new();
    let mut top: Vec<ComponentContributionDto> = Vec::new();
    let mut groups_out: Vec<GroupAggregateDto> = Vec::new();
    for group in &descriptor.components {
        let nested = contained_by_whole_write(descriptor, &group.node_id);
        let direction = match &group.output_normalization {
            Some(norm) => {
                let write_values = values(evidence, &group_write_evidence_path(group)?)?.to_vec();
                measured(loaded, &write_values, &final_readout.direction, 0.0, norm)?
            }
            None => MeasuredReadout {
                direction: final_readout.direction.clone(),
                offset: 0.0,
            },
        };
        let (weight_id, weight_shape) = {
            let discovery = loaded.component.discovery.as_ref().expect("cached");
            let weight = discovery
                .parameters
                .iter()
                .find(|p| p.id == group.write_weight)
                .ok_or_else(|| {
                    component_fail(
                        "reconstruction",
                        format!("write parameter {} is not loaded", group.write_weight),
                    )
                })?;
            if group.write_input.is_none()
                && weight.input_transform != ProjectionInputTransform::Identity
            {
                return Err(component_fail(
                    "reconstruction",
                    format!(
                        "component input arithmetic for {} requires actual-input evidence \
                         or a verified identity transform",
                        group.id
                    ),
                ));
            }
            (weight.id.clone(), weight.shape.clone())
        };
        let projected = loaded
            .model
            .project_parameter(
                &loaded.component.discovery.as_ref().expect("cached").identity.clone(),
                &weight_id,
                ParameterProjection {
                    region: ParameterRegion {
                        starts: vec![0; weight_shape.len()],
                        shape: weight_shape.clone(),
                    },
                    axis: 0,
                    directions: 1,
                    coefficients: direction.direction.iter().map(|x| *x as f32).collect(),
                },
                parameter_limits(),
            )
            .map_err(|e| component_error("parameter projection", &e))?;
        let activations = values(
            evidence,
            group.write_input.as_deref().unwrap_or(&group.effective_activation),
        )?;
        if projected.values.len() != activations.len() {
            return Err(component_fail("reconstruction", "component projection geometry"));
        }
        let scale = group.residual_scale.value() as f64;
        let mut sum = Vec::with_capacity(activations.len());
        let mut sum_abs = 0.0f64;
        let mut max_abs = 0.0f64;
        let mut argmax_index = 0usize;
        for (index, (activation, projection)) in
            activations.iter().zip(&projected.values).enumerate()
        {
            let contribution = *activation as f64 * *projection as f64 * scale;
            if nested {
                nested_terms.push(contribution);
            } else {
                terms.push(contribution);
            }
            sum.push(contribution);
            sum_abs += contribution.abs();
            if contribution.abs() > max_abs {
                max_abs = contribution.abs();
                argmax_index = index;
            }
            component_count += 1;
            insert_top(
                &mut top,
                top_n,
                ComponentContributionDto {
                    group: group.id.clone(),
                    node_id: group.node_id.clone(),
                    layer: group.layer_index,
                    index,
                    value: contribution,
                    activation: *activation as f64,
                    nested,
                },
            );
        }
        if !nested {
            bias_terms += direction.offset * scale;
            terms.push(direction.offset * scale);
            if let Some(bias_id) = &group.write_bias {
                let bias_values = query(loaded, bias_id, None)?;
                let term = scale
                    * signed_sum(
                        direction
                            .direction
                            .iter()
                            .zip(bias_values)
                            .map(|(d, b)| d * b as f64),
                    );
                bias_terms += term;
                terms.push(term);
            }
        }
        groups_out.push(GroupAggregateDto {
            group: group.id.clone(),
            node_id: group.node_id.clone(),
            layer: group.layer_index,
            count: activations.len(),
            sum: signed_sum(sum),
            sum_abs,
            max_abs,
            argmax_index,
            nested,
            axis_mismatch: activations.len() != group.count,
        });
    }

    let actual = scores
        .get(target as usize)
        .map(|s| *s as f64)
        .ok_or_else(|| component_fail("reconstruction", "target outside captured score row"))?
        - competitor.map_or(0.0, |c| scores.get(c as usize).map_or(0.0, |s| *s as f64));
    let nested_component_count = nested_terms.len();
    let nested_component_sum = signed_sum(nested_terms);
    let reconstructed = signed_sum(terms);
    Ok(ScoreDecompositionDto {
        margin: competitor.is_some(),
        actual,
        reconstructed,
        absolute_error: (actual - reconstructed).abs(),
        offset: final_readout.offset,
        projection_input_correction,
        embedding: embedding_term,
        other_writes: other_write_terms,
        bias_terms,
        component_count,
        nested_components: nested_component_count,
        nested_component_sum,
        top,
        groups: groups_out,
    })
}

/// Keep the running top-N by absolute contribution (N is small; linear insert).
fn insert_top(
    top: &mut Vec<ComponentContributionDto>,
    top_n: usize,
    candidate: ComponentContributionDto,
) {
    let position = top
        .iter()
        .position(|entry| candidate.value.abs() > entry.value.abs())
        .unwrap_or(top.len());
    if position < top_n {
        top.insert(position, candidate);
        top.truncate(top_n);
    }
}

// ---------- mask trials ----------

fn mask_trial(
    loaded: &mut LoadedWorkerModel,
    req: &MaskTrialRequestDto,
    context: &WorkerContext,
) -> Result<String, IpcError> {
    architecture(loaded)?;
    let descriptor = loaded.component.architecture.clone().expect("cached");
    if req.masks.is_empty() {
        return Err(component_fail("mask trial", "no masks selected"));
    }
    stage_event(context, "mask trial");

    let prefix_len = req.prefix_ids.len();
    let mut operations = Vec::with_capacity(req.masks.len());
    for (i, mask) in req.masks.iter().enumerate() {
        let group = descriptor
            .components
            .iter()
            .find(|g| g.id == mask.group_id)
            .ok_or_else(|| {
                component_fail("mask trial", format!("unknown component group {}", mask.group_id))
            })?;
        for index in &mask.indices {
            if *index as usize >= group.count {
                return Err(component_fail(
                    "mask trial",
                    format!(
                        "component {index} outside group {} (count {})",
                        group.id, group.count
                    ),
                ));
            }
        }
        let everywhere = mask.scope.as_deref() == Some("everywhere");
        operations.push(InterventionOperation {
            id: format!("mask:{i}:{}", group.id),
            target: group.activation.clone(),
            schedule: if everywhere {
                CaptureSchedule::default()
            } else {
                prefill_only()
            },
            slices: if everywhere { vec![] } else { last_row_slice(prefix_len) },
            action: InterventionAction::MaskComponents {
                dtype: intervention_dtype(&mask.dtype)?,
                indices: mask.indices.clone(),
                keep_selected: mask.keep_selected,
            },
            evidence: InterventionEvidence::None,
        });
    }

    let mut score_ids = vec![req.target_token];
    if let Some(competitor) = req.competitor_token {
        if competitor != req.target_token {
            score_ids.push(competitor);
        }
    }
    let selections = vec![CaptureSelection {
        id: "component:trial-token-scores".into(),
        path: "model.logits".into(),
        schedule: prefill_only(),
        slices: vec![],
        transform: CaptureTransform::TokenScores { token_ids: score_ids },
    }];

    let max_new_tokens = req.max_new_tokens.unwrap_or(8).clamp(1, 64) as u64;
    let evidence = run_replay(
        loaded,
        context,
        &req.prefix_ids,
        selections,
        // Mask trials capture only the bounded TokenScores row, not component
        // activations, so the default budget floors apply.
        0,
        Some(InterventionPlan {
            schema_version: INTERVENTION_SCHEMA_VERSION,
            operations,
        }),
        max_new_tokens,
        req.seed.unwrap_or(17),
    )?;
    let token_scores = evidence
        .token_scores
        .clone()
        .ok_or_else(|| {
            component_fail(
                "mask trial",
                evidence
                    .failure
                    .clone()
                    .unwrap_or_else(|| "no TokenScores payload was captured".into()),
            )
        })?;
    let generated = evidence
        .generated
        .iter()
        .map(|id| TrialTokenDto {
            id: *id,
            text: loaded.decode(&[*id], false).unwrap_or_default(),
        })
        .collect();
    let result = TrialResultDto {
        token_scores,
        generated,
        status: evidence.status,
        failure: evidence.failure,
    };
    serde_json::to_string(&result)
        .map_err(|e| component_fail("result serialization", e.to_string()))
}

// ---------- bounded parameter access ----------

fn query_parameter_json(
    loaded: &mut LoadedWorkerModel,
    req: &QueryParameterDto,
) -> Result<String, IpcError> {
    ensure_discovery(loaded)?;
    let identity = loaded.component.discovery.as_ref().expect("cached").identity.clone();
    let region = ParameterRegion { starts: req.starts.clone(), shape: req.shape.clone() };
    let result = loaded
        .model
        .query_parameter(&identity, &req.parameter, region, parameter_limits())
        .map_err(|e| component_error("parameter query", &e))?;
    serde_json::to_string(&result)
        .map_err(|e| component_fail("result serialization", e.to_string()))
}

// ---------- overlays ----------

fn install_overlay(
    loaded: &mut LoadedWorkerModel,
    req: &OverlayRequestDto,
    context: &WorkerContext,
) -> Result<String, IpcError> {
    if loaded.component.overlay.is_some() {
        return Err(component_fail(
            "overlay",
            "an overlay is already active; remove it before installing another",
        ));
    }
    architecture(loaded)?;
    refresh_discovery(loaded)?;
    stage_event(context, "overlay install");
    let descriptor = loaded.component.architecture.clone().expect("cached");

    let mut edits: Vec<ParameterEdit> = match &req.raw_edits {
        Some(value) => serde_json::from_value(value.clone())
            .map_err(|e| component_fail("overlay edits", format!("raw edits: {e}")))?,
        None => Vec::new(),
    };
    for (i, edit) in req.edits.iter().enumerate() {
        edits.push(column_edit(loaded, &descriptor, edit, i)?);
    }
    if edits.is_empty() {
        return Err(component_fail("overlay", "no edits supplied"));
    }

    let plan = {
        let discovery = loaded.component.discovery.as_ref().expect("cached");
        ParameterOverlayPlan {
            schema_version: PARAMETER_SCHEMA_VERSION,
            base_identity: discovery.identity.clone(),
            provenance: req.provenance.clone(),
            edits,
        }
    };
    let admitted = loaded
        .model
        .admit_parameter_overlay(plan)
        .map_err(|e| component_error("overlay admission", &e))?;
    let active = loaded
        .model
        .activate_parameter_overlay(&admitted, parameter_limits())
        .map_err(|e| component_error("overlay activation", &e))?;
    loaded.component.overlay = Some(active.identity.clone());
    loaded.component.discovery = Some(active);
    overlay_result(loaded)
}

/// Resolve one convenience write-column edit into an exact `ParameterEdit`.
fn column_edit(
    loaded: &mut LoadedWorkerModel,
    descriptor: &ArchitectureDescriptor,
    edit: &ComponentEditDto,
    ordinal: usize,
) -> Result<ParameterEdit, IpcError> {
    let group = descriptor
        .components
        .iter()
        .find(|g| g.id == edit.group_id)
        .ok_or_else(|| {
            component_fail("overlay edits", format!("unknown component group {}", edit.group_id))
        })?;
    let (parameter, shape, dtype) = {
        let discovery = loaded.component.discovery.as_ref().expect("cached");
        let weight = discovery
            .parameters
            .iter()
            .find(|p| p.id == group.write_weight)
            .ok_or_else(|| {
                component_fail(
                    "overlay edits",
                    format!("write parameter {} is not loaded", group.write_weight),
                )
            })?;
        let dtype = weight.dtype.ok_or_else(|| {
            component_fail(
                "overlay edits",
                format!("{} has no described effective dtype", weight.id),
            )
        })?;
        (weight.id.clone(), weight.shape.clone(), dtype)
    };
    if shape.len() != 2 {
        return Err(component_fail(
            "overlay edits",
            format!("{parameter} is not a two-axis write matrix"),
        ));
    }
    let column = edit.component as u64;
    if column >= shape[1] {
        return Err(component_fail(
            "overlay edits",
            format!("component {column} outside {parameter} (width {})", shape[1]),
        ));
    }
    let rows = shape[0] as usize;
    let region = ParameterRegion { starts: vec![0, column], shape: vec![shape[0], 1] };
    let update = match &edit.action {
        ComponentEditActionDto::Scale { factor } => {
            let identity = loaded.component.discovery.as_ref().expect("cached").identity.clone();
            let current = loaded
                .model
                .query_parameter(&identity, &parameter, region.clone(), parameter_limits())
                .map_err(|e| component_error("overlay edits", &e))?;
            ParameterUpdate::Replace {
                values: current.values.iter().map(|v| v * factor).collect(),
            }
        }
        ComponentEditActionDto::Add { values } => {
            if values.len() != rows {
                return Err(component_fail(
                    "overlay edits",
                    format!("delta length {} != column height {rows}", values.len()),
                ));
            }
            ParameterUpdate::Add { values: values.clone() }
        }
        ComponentEditActionDto::Replace { values } => {
            if values.len() != rows {
                return Err(component_fail(
                    "overlay edits",
                    format!("replacement length {} != column height {rows}", values.len()),
                ));
            }
            ParameterUpdate::Replace { values: values.clone() }
        }
    };
    Ok(ParameterEdit {
        id: format!("component-edit:{ordinal}:{}:{}", edit.group_id, edit.component),
        parameter,
        parameter_shape: shape,
        dtype,
        region,
        update,
    })
}

fn remove_overlay(
    loaded: &mut LoadedWorkerModel,
    context: &WorkerContext,
) -> Result<String, IpcError> {
    let identity = loaded
        .component
        .overlay
        .clone()
        .ok_or_else(|| component_fail("overlay", "no overlay is active"))?;
    stage_event(context, "overlay removal");
    let discovery = loaded
        .model
        .remove_parameter_overlay(&identity)
        .map_err(|e| component_error("overlay removal", &e))?;
    loaded.component.overlay = None;
    loaded.component.discovery = Some(discovery);
    overlay_result(loaded)
}

fn overlay_result(loaded: &mut LoadedWorkerModel) -> Result<String, IpcError> {
    let discovery = loaded.component.discovery.as_ref().expect("cached");
    let result = OverlayResultDto {
        overlay_identity: loaded.component.overlay.clone(),
        discovery: serde_json::to_value(discovery)
            .map_err(|e| component_fail("result serialization", e.to_string()))?,
    };
    serde_json::to_string(&result)
        .map_err(|e| component_fail("result serialization", e.to_string()))
}
