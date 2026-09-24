//! Request memory forecasts through eredu's facade: the cold estimator over
//! the exact selection a load would admit, and the loaded-model forecast of
//! a prepared request. eredu owns the calibration (`ForecastCalibration`),
//! the execution contract (full pass / logits rows), residency deduction,
//! allocator-cache policy and available-capacity observation; the engine
//! only chooses budgets and summarizes. Planning estimates — never allocation
//! limits, never execution gates — covering model/request payloads plus the
//! declared backend allowance, not the process footprint.

use std::path::Path;

use eredu::api::{
    forecast_inspected_generation, ContinuationForecast, ForecastCalibration, GenerationForecast,
    GenerationForecastOptions, GenerationMemoryEstimate, GenerationMemoryOptions,
    GenerationMemoryRequest, LocalRuntimeConfiguration, MemoryBudget, MemoryDomain, MemoryFit,
    SpeculativeContinuationForecast,
};
use eredu_architectures::ModelInspectionOutcome;
use eredu_backend_mlx::MlxBackendFactory;
use eredu_core::{ExecutionPlan, InputTokenCount};
use serde::Serialize;

use crate::budgets;
use crate::error::IpcError;
use crate::worker::AllocatorDto;

/// Smaller prefill chunks recomputed as alternatives.
const CANDIDATE_CHUNKS: [u64; 3] = [512, 256, 128];

/// One forecast, for the UI. `estimate` is eredu's `GenerationMemoryEstimate`
/// serialized verbatim (snake_case; phases, intervals, assumptions and
/// uncertainties) — the summaries beside it are derived from it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ForecastDto {
    pub estimate: String,
    /// "likely_fit" | "likely_shortfall" | "insufficient_information" (eredu's
    /// combined verdict; loading included unless the model is already loaded).
    pub fit: String,
    pub input_positions: u64,
    /// Output allowance the forecast evaluated; absent = the labeled horizon.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_output_tokens: Option<u64>,
    pub forecast_output_tokens: u64,
    /// Requested prefill chunk; 0 = one complete pass.
    pub requested_chunk_tokens: u64,
    /// Chunk the projection actually used (the full prompt on uncovered paths).
    pub effective_chunk_tokens: u64,
    /// Why this request keeps a complete prefill pass; absent = chunked.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub full_pass: Option<String>,
    /// Rows one prefill invocation projects: "final_position" | "every_position".
    pub logits: String,
    /// Speculative draft/verification/commit phases were projected (both
    /// models, rollback and lookahead copies) rather than left unknown.
    pub speculative: bool,
    /// Continuation forecast of a paused run: decode-only phases from the
    /// installed cache frontier, no loading or prefill.
    pub continuation: bool,
    /// "unified" | "host" | "separate" | "unknown"
    pub placement: String,
    pub reserve_bytes: u64,
    /// Application budget the forecast was compared with, when one was set.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub application_limit_bytes: Option<u64>,
    /// Observed available capacity of the execution pool (point-in-time,
    /// reclaimable estimate), compared with additional request memory.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub available_bytes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub physical_memory_bytes: Option<u64>,
    /// Loaded models: parameter bytes eredu deducted as already resident
    /// (loading peak excluded). Absent for cold forecasts.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub already_resident_bytes: Option<u64>,
    /// Allocator-cache limit the overhead allowance was derived from: the
    /// process's current native limit (loaded), or the proposed policy (cold).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub allocator_cache_limit_bytes: Option<u64>,
    /// Provenance of that limit: "native_default" | "managed_default" |
    /// "explicit" | "preserved".
    #[serde(skip_serializing_if = "Option::is_none")]
    pub allocator_cache_policy: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub allocator: Option<AllocatorDto>,
    pub recommendations: Vec<String>,
    /// Recomputed alternatives whose modeled generation peak is lower.
    pub candidates: Vec<CandidateDto>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CandidateDto {
    /// "prefill chunk 256" / "max tokens 128"
    pub label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub chunk_tokens: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_output_tokens: Option<u64>,
    pub domain: String,
    pub generation_peak_upper_bytes: u64,
    pub saving_bytes: u64,
    pub fit: String,
}

fn capability(operation: &str, error: impl std::fmt::Display) -> IpcError {
    IpcError::Capability {
        operation: operation.into(),
        reason: error.to_string(),
    }
}

/// Cold inspection retaining the exact selection an execution plan admits.
/// No device, stream or tensor is created and no payload is read.
pub fn inspect_for_plan(path: &Path, plan: &ExecutionPlan) -> Result<ModelInspectionOutcome, IpcError> {
    let load = MlxBackendFactory::default()
        .load_request_for_plan(plan)
        .map_err(|e| capability("memory inspection plan", e))?;
    eredu_backend_mlx::native::inspect_model_preparation(
        path,
        eredu_backend_mlx::native::MlxInspectionOptions::new(load),
    )
    .map_err(|e| capability("memory inspection", e))
}

/// The fully resident plan the inspector loads with, for a device.
pub fn inspector_plan(device: eredu::api::LocalDevice) -> Result<ExecutionPlan, IpcError> {
    let device_plan = eredu::api::local_device_plan(device).map_err(|e| capability("device", e))?;
    Ok(ExecutionPlan::fully_resident(device_plan).with_required_session_capabilities(
        eredu_core::SessionCapabilities::new(true, true, true),
    ))
}

fn domain_label(domain: &MemoryDomain) -> String {
    match domain {
        MemoryDomain::Unified => "unified".into(),
        MemoryDomain::Host => "host".into(),
        MemoryDomain::Device(id) => format!("device {id}"),
    }
}

/// eredu's wire spelling of the verdict ("likely_fit", ...).
fn fit_word(fit: MemoryFit) -> String {
    serde_json::to_value(fit)
        .ok()
        .and_then(|v| v.as_str().map(String::from))
        .unwrap_or_else(|| format!("{fit:?}"))
}

/// The physical pools eredu placed the request in, as one word.
fn placement_word(request: &GenerationMemoryRequest) -> &'static str {
    if request.domains.iter().any(|d| matches!(d.domain, MemoryDomain::Device(_))) {
        "separate"
    } else if request.domains.iter().all(|d| matches!(d.domain, MemoryDomain::Host)) {
        "host"
    } else if request.domains.iter().any(|d| matches!(d.domain, MemoryDomain::Unified)) {
        "unified"
    } else {
        "unknown"
    }
}

/// The process's allocator-cache policy: limit and provenance.
pub fn allocator_cache_policy() -> (Option<u64>, Option<String>) {
    match eredu::api::local_allocator_cache_policy() {
        Ok(report) => (
            Some(report.limit_bytes),
            serde_json::to_value(report.source)
                .ok()
                .and_then(|v| v.as_str().map(String::from)),
        ),
        Err(_) => (None, None),
    }
}

/// The application budgets eredu compares with. Available bytes are left for
/// eredu to observe (loaded) or filled from the hardware profile (cold).
pub fn forecast_options(application_limit_bytes: Option<u64>) -> GenerationForecastOptions {
    GenerationForecastOptions {
        budget: MemoryBudget {
            application_limit_bytes,
            reserve_bytes: budgets::MEMORY_RESERVE_BYTES,
            ..MemoryBudget::default()
        },
        host_budget: MemoryBudget {
            reserve_bytes: budgets::MEMORY_RESERVE_BYTES,
            ..MemoryBudget::default()
        },
        ..GenerationForecastOptions::default()
    }
}

fn candidate(
    original: &GenerationMemoryEstimate,
    candidate: &GenerationMemoryEstimate,
    label: &str,
    chunk_tokens: Option<u64>,
    max_output_tokens: Option<u64>,
    out: &mut Vec<CandidateDto>,
) {
    for (before, after) in original.domains.iter().zip(&candidate.domains) {
        if let (Some(before_peak), Some(after_peak)) = (
            before.generation_peak.upper_bytes,
            after.generation_peak.upper_bytes,
        ) {
            if after_peak < before_peak {
                out.push(CandidateDto {
                    label: label.into(),
                    chunk_tokens,
                    max_output_tokens,
                    domain: domain_label(&after.domain),
                    generation_peak_upper_bytes: after_peak,
                    saving_bytes: before_peak - after_peak,
                    fit: fit_word(after.fit),
                });
            }
        }
    }
}

/// Summarize an eredu forecast for the UI: verdict, contract, capacity facts
/// eredu resolved, recomputed alternatives and advice.
pub fn summarize(
    forecast: GenerationForecast,
    physical_memory_bytes: Option<u64>,
    allocator: Option<AllocatorDto>,
    loaded: bool,
) -> Result<ForecastDto, IpcError> {
    let request = &forecast.request;
    let estimate = &forecast.estimate;
    let (allocator_cache_limit_bytes, allocator_cache_policy) = allocator_cache_policy();
    // The executing pool's budget and residency, as eredu resolved them.
    let executing = request
        .domains
        .iter()
        .find(|d| !d.executions.is_empty())
        .or_else(|| request.domains.first());
    let available = executing.and_then(|d| d.budget.available_bytes);
    let application_limit = executing.and_then(|d| d.budget.application_limit_bytes);
    let already_resident = executing.map(|d| d.already_resident_bytes).filter(|_| loaded);

    let mut recommendations = Vec::new();
    if available.is_none() && application_limit.is_none() {
        recommendations.push("Available capacity was not observed; set a memory budget to get a fit verdict against it.".into());
    }
    // MLX's native default cache limit can exceed physical memory; eredu
    // honestly folds it into the overhead allowance, which then swamps the
    // forecast. The load gate's limit is the fix, so say so.
    if let (Some(limit), Some(physical)) = (allocator_cache_limit_bytes, physical_memory_bytes) {
        if limit > physical {
            recommendations.push(format!(
                "The allocator-cache limit in force ({limit} bytes) exceeds physical memory ({physical} bytes), so the overhead allowance is pessimistic; load with an allocator-cache limit (0 disables caching) for a bounded forecast."
            ));
        }
    }
    for domain in &estimate.domains {
        if let Some(phase) = domain.phases.iter().max_by_key(|p| p.total.lower_bytes) {
            let contributions = [
                ("parameters", phase.parameters.lower_bytes),
                ("persistent state", phase.persistent_state.lower_bytes),
                ("retained input", phase.retained_input.lower_bytes),
                ("execution workspace", phase.workspace.lower_bytes),
                ("materialization/loading staging", phase.staging.lower_bytes),
            ];
            if let Some((name, bytes)) = contributions.into_iter().max_by_key(|(_, n)| *n) {
                recommendations.push(format!(
                    "{}: the dominant modeled contributor is {name} ({bytes} bytes) in the {} phase.",
                    domain_label(&domain.domain),
                    serde_json::to_value(phase.phase)
                        .ok()
                        .and_then(|v| v.as_str().map(String::from))
                        .unwrap_or_default()
                ));
            }
        }
    }

    let mut candidates = Vec::new();
    if forecast.execution.full_pass_reason.is_none() {
        for chunk in CANDIDATE_CHUNKS {
            if chunk < request.prefill_chunk_tokens {
                let alt = forecast
                    .with_prefill_chunk(chunk)
                    .map_err(|e| capability("memory candidate", e))?;
                candidate(estimate, &alt.estimate, &format!("prefill chunk {chunk}"), Some(chunk), None, &mut candidates);
            }
        }
    } else if let Some(reason) = &forecast.execution.full_pass_reason {
        recommendations.push(format!(
            "This request keeps a complete prefill pass ({reason}); a smaller chunk gives no estimated saving here."
        ));
    }
    if let Some(output) = request.max_output_tokens.filter(|n| *n > 1) {
        let alt = forecast
            .with_max_output_tokens(output / 2)
            .map_err(|e| capability("memory candidate", e))?;
        candidate(estimate, &alt.estimate, &format!("max tokens {}", output / 2), None, Some(output / 2), &mut candidates);
    }
    if !matches!(estimate.fit, MemoryFit::LikelyFit) {
        recommendations.push("When parameters dominate, a different quantization or residency plan needs its own forecast; conversion and transfer costs change the peak.".into());
    }

    Ok(ForecastDto {
        fit: fit_word(estimate.fit),
        estimate: serde_json::to_string(estimate)
            .map_err(|e| IpcError::Internal { message: format!("estimate serialization: {e}") })?,
        input_positions: request.input.model_positions,
        max_output_tokens: request.max_output_tokens,
        forecast_output_tokens: request.forecast_output_tokens,
        requested_chunk_tokens: forecast.requested_chunk_tokens,
        effective_chunk_tokens: request.prefill_chunk_tokens,
        full_pass: forecast.execution.full_pass_reason.clone(),
        logits: serde_json::to_value(forecast.execution.logits)
            .ok()
            .and_then(|v| v.as_str().map(String::from))
            .unwrap_or_default(),
        speculative: forecast.speculative.is_some(),
        continuation: false,
        placement: placement_word(request).into(),
        reserve_bytes: budgets::MEMORY_RESERVE_BYTES,
        application_limit_bytes: application_limit,
        available_bytes: available,
        physical_memory_bytes,
        already_resident_bytes: already_resident,
        allocator_cache_limit_bytes,
        allocator_cache_policy,
        allocator,
        recommendations,
        candidates,
    })
}

/// Summarize a mid-session continuation forecast: decode-only phases from
/// the installed cache frontier for `additional_tokens` more predictions.
/// No chunk or output alternatives: eredu's native bounds are horizon
/// specific and cannot be extrapolated by editing the request.
pub fn summarize_continuation(
    forecast: ContinuationForecast,
    additional_tokens: u64,
    physical_memory_bytes: Option<u64>,
    allocator: Option<AllocatorDto>,
) -> Result<ForecastDto, IpcError> {
    let ContinuationForecast { estimate, request, continuation, .. } = forecast;
    continuation_dto(
        estimate,
        request,
        continuation.current_positions,
        continuation.current_state.lower_bytes,
        continuation.peak_state.upper_bytes,
        false,
        additional_tokens,
        physical_memory_bytes,
        allocator,
    )
}

/// Summarize a settled speculative session's outlook (target frontier plus
/// the draft/embedded lane, transaction ceilings kept).
pub fn summarize_speculative_continuation(
    forecast: SpeculativeContinuationForecast,
    additional_tokens: u64,
    physical_memory_bytes: Option<u64>,
    allocator: Option<AllocatorDto>,
) -> Result<ForecastDto, IpcError> {
    let SpeculativeContinuationForecast { estimate, request, continuation, .. } = forecast;
    let positions = request.input.model_positions;
    let (state_now, state_peak) = (
        continuation.target.current_state.lower_bytes,
        continuation.target.peak_state.upper_bytes,
    );
    continuation_dto(
        estimate,
        request,
        positions,
        state_now,
        state_peak,
        true,
        additional_tokens,
        physical_memory_bytes,
        allocator,
    )
}

#[allow(clippy::too_many_arguments)]
fn continuation_dto(
    estimate: GenerationMemoryEstimate,
    request: GenerationMemoryRequest,
    current_positions: u64,
    state_now_bytes: u64,
    state_peak_upper: Option<u64>,
    speculative: bool,
    additional_tokens: u64,
    physical_memory_bytes: Option<u64>,
    allocator: Option<AllocatorDto>,
) -> Result<ForecastDto, IpcError> {
    let request = &request;
    let estimate = &estimate;
    let (allocator_cache_limit_bytes, allocator_cache_policy) = allocator_cache_policy();
    let executing = request
        .domains
        .iter()
        .find(|d| !d.executions.is_empty())
        .or_else(|| request.domains.first());
    let mut recommendations = vec![format!(
        "Continuation from {current_positions} installed positions: state {state_now_bytes} bytes now, {} peak over the horizon.",
        state_peak_upper.map_or_else(|| "unbounded".to_string(), |n| n.to_string())
    )];
    if !matches!(estimate.fit, MemoryFit::LikelyFit) {
        recommendations.push("Reserved snapshot/branch retention counts as an upper allowance here, never as resident credit; releasing snapshots lowers it.".into());
    }
    Ok(ForecastDto {
        fit: fit_word(estimate.fit),
        estimate: serde_json::to_string(estimate)
            .map_err(|e| IpcError::Internal { message: format!("estimate serialization: {e}") })?,
        input_positions: current_positions,
        max_output_tokens: Some(additional_tokens),
        forecast_output_tokens: additional_tokens,
        requested_chunk_tokens: 0,
        effective_chunk_tokens: request.prefill_chunk_tokens,
        full_pass: None,
        logits: if speculative { "every_position" } else { "final_position" }.into(),
        speculative,
        continuation: true,
        placement: placement_word(request).into(),
        reserve_bytes: budgets::MEMORY_RESERVE_BYTES,
        application_limit_bytes: executing.and_then(|d| d.budget.application_limit_bytes),
        available_bytes: executing.and_then(|d| d.budget.available_bytes),
        physical_memory_bytes,
        already_resident_bytes: executing.map(|d| d.already_resident_bytes),
        allocator_cache_limit_bytes,
        allocator_cache_policy,
        allocator,
        recommendations,
        candidates: Vec::new(),
    })
}

/// Cold forecast for the Model screen: what loading this artifact with the
/// inspector's plan on `device` and running `input_positions` prompt
/// positions would need, loading included. Nothing is loaded. Placement,
/// availability and chunk eligibility come from eredu's device-aware
/// options and the cold selection. `proposed_cache_limit_bytes` describes
/// the allocator-cache policy the load will apply; absent = the managed
/// default eredu applies at realization (a 256 MiB cap on an untouched
/// native default), initialized here so the cold forecast sees it too.
pub fn estimate_cold(
    path: &Path,
    device: crate::worker::DeviceDto,
    input_positions: u64,
    max_output_tokens: Option<u64>,
    prefill_chunk_tokens: u64,
    application_limit_bytes: Option<u64>,
    proposed_cache_limit_bytes: Option<u64>,
) -> Result<ForecastDto, IpcError> {
    let plan = inspector_plan(match device {
        crate::worker::DeviceDto::Cpu => eredu::api::LocalDevice::Cpu,
        crate::worker::DeviceDto::Accelerator => eredu::api::LocalDevice::Accelerator(0),
    })?;
    let inspection = inspect_for_plan(path, &plan)?;
    if proposed_cache_limit_bytes.is_none() {
        // Idempotent: caps only an untouched native default, never an
        // explicit setting or an earlier initialization.
        eredu::api::configure_local_runtime(&LocalRuntimeConfiguration::default())
            .map_err(|e| capability("allocator-cache policy", e))?;
    }
    let input = InputTokenCount::text(input_positions.max(1));
    let calibration = ForecastCalibration::default();
    let mut options = GenerationMemoryOptions::for_local_device(input, plan.device())
        .map_err(|e| capability("memory forecast options", e))?;
    if let Some(limit) = proposed_cache_limit_bytes {
        options.backend_overhead = calibration.allocator_overhead(limit, 0);
    }
    options.max_output_tokens = max_output_tokens;
    options.forecast_output_tokens = budgets::FORECAST_OUTPUT_TOKENS;
    options.prefill_chunk_tokens = if prefill_chunk_tokens == 0 {
        input.model_positions
    } else {
        prefill_chunk_tokens
    };
    options.budget.application_limit_bytes = application_limit_bytes;
    options.budget.reserve_bytes = budgets::MEMORY_RESERVE_BYTES;
    options.host_budget.reserve_bytes = budgets::MEMORY_RESERVE_BYTES;
    let forecast = forecast_inspected_generation(&inspection, &options, &calibration)
        .map_err(|e| capability("memory forecast", e))?;
    let physical = eredu::api::discover_local_hardware()
        .physical_memory_bytes
        .value()
        .copied();
    let mut dto = summarize(forecast, physical, None, false)?;
    if let Some(limit) = proposed_cache_limit_bytes {
        dto.allocator_cache_limit_bytes = Some(limit);
        dto.allocator_cache_policy = Some("proposed".into());
    }
    Ok(dto)
}
