//! Request memory forecasts for a run spec against the loaded model, through
//! eredu's prepared-request forecasts: controlled/observed runs forecast the
//! very `PreparedObservedGeneration` a start would consume (prompt rendered
//! or exact prefix, capture/intervention admission bounded by its own
//! limits, resolved settings); speculative runs forecast the same token
//! prefix with the load's realized drafter (both models, rollback,
//! verification and lookahead copies). Nothing is executed. eredu derives
//! the full-pass/logits contract, resident-parameter deduction, allocator
//! policy and available capacity.

use crate::error::IpcError;
use crate::memory::{forecast_options, summarize, ForecastDto};
use crate::worker::controlled::{prepare_observed, prepare_spec, raw_prefix};
use crate::worker::load::LoadedWorkerModel;
use crate::worker::StartRunSpecDto;

fn forecast_error(e: impl std::fmt::Display) -> IpcError {
    IpcError::Capability {
        operation: "memory forecast".into(),
        reason: e.to_string(),
    }
}

pub fn forecast_run(
    loaded: &mut LoadedWorkerModel,
    spec: &StartRunSpecDto,
    speculative: bool,
    application_limit_bytes: Option<u64>,
) -> Result<ForecastDto, IpcError> {
    let prepared_spec = prepare_spec(spec)?;
    let raw = raw_prefix(loaded, spec)?;
    let toolless = eredu::runtime::chat::ChatTemplateRequest {
        tools: vec![],
        tool_choice: eredu::runtime::chat::ToolChoice::Auto,
        ..prepared_spec.chat_request.clone()
    };
    let chat = match loaded.prepare_chat(prepared_spec.chat_request.clone()) {
        Ok(chat) => chat,
        Err(_) if prepared_spec.injected_dummy_tools => loaded.prepare_chat(toolless)?,
        Err(e) => return Err(e),
    };
    // Forecasts describe a fresh request; leftover state (a component
    // replay, an ended tree) would otherwise leave the workspace unbounded.
    loaded
        .model
        .reset()
        .map_err(|e| IpcError::Internal { message: format!("model reset: {e}") })?;
    let options = forecast_options(application_limit_bytes);
    let forecast = if speculative {
        let Some(spec_options) = loaded.speculative_options else {
            return Err(IpcError::Capability {
                operation: "speculative run".into(),
                reason: "drafting is disabled for this load".into(),
            });
        };
        let token_ids = match raw {
            Some(ids) => ids,
            None => loaded
                .model
                .encode(chat.rendered_prompt(), false)
                .map_err(|e| IpcError::Internal { message: e.to_string() })?,
        };
        let Some(draft) = loaded.drafting.as_speculative_draft() else {
            return Err(IpcError::Capability {
                operation: "speculative run".into(),
                reason: "drafting is disabled for this load".into(),
            });
        };
        loaded
            .model
            .forecast_speculative_token_ids(
                &token_ids,
                prepared_spec.settings,
                &draft,
                spec_options,
                &options,
            )
            .map_err(forecast_error)?
    } else {
        let prepared = prepare_observed(&mut loaded.model, &chat, &prepared_spec, raw.as_deref())
            .map_err(|e| IpcError::Control {
                op: "prepare_observed".into(),
                class: crate::error::ControlErrorClass::Capture,
                message: e.to_string(),
                chain: crate::error::error_chain(&e),
            })?;
        loaded
            .model
            .forecast_observed_generation(&prepared, &options)
            .map_err(forecast_error)?
    };
    let physical = eredu::api::discover_local_hardware()
        .physical_memory_bytes
        .value()
        .copied();
    summarize(forecast, physical, crate::worker::load::allocator_sample(), true)
}
