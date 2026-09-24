//! Cold commands: cache scanning, weight-free inspection, journal paging.
//! Everything here works in a build with no MLX backend.

use std::path::PathBuf;

use inspector_engine::cache::CacheSnapshotDto;
use inspector_engine::error::IpcError;
use std::sync::Arc;

use inspector_engine::journal::{JournalPageDto, JournalStore, RunSummaryDto};
use serde::Serialize;
use tauri::State;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackendAvailabilityDto {
    pub live: bool,
    pub metal: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenPieceDto {
    pub id: u32,
    pub text: String,
}

#[tauri::command]
pub async fn scan_model_cache(extra_dirs: Vec<String>) -> Result<CacheSnapshotDto, IpcError> {
    run_blocking(move || inspector_engine::cache::scan_model_cache(&extra_dirs)).await
}

/// Returns the full inspection bundle as a JSON string (parsed losslessly on
/// the frontend). `probe_chat` renders the chat template against a canned
/// request to verify semantic/tool readiness behaviorally.
#[tauri::command]
pub async fn inspect_model(path: String, probe_chat: bool) -> Result<String, IpcError> {
    run_blocking(move || {
        inspector_engine::inspect::inspect_bundle_json(&PathBuf::from(path), probe_chat)
    })
    .await
}

#[tauri::command]
pub async fn tokenize_preview(path: String, text: String) -> Result<Vec<TokenPieceDto>, IpcError> {
    run_blocking(move || {
        inspector_engine::inspect::tokenize_preview(&PathBuf::from(path), &text).map(|pieces| {
            pieces
                .into_iter()
                .map(|(id, text)| TokenPieceDto { id, text })
                .collect()
        })
    })
    .await
}

/// Cold memory forecast for an artifact (nothing is loaded): loading
/// included, for `input_positions` prompt positions on the inspector's fully
/// resident plan. Live builds only — the projection needs the backend's
/// mechanism facts.
#[tauri::command]
pub async fn estimate_model_memory(
    path: String,
    device: String,
    input_positions: u64,
    max_output_tokens: Option<u64>,
    prefill_chunk_tokens: u64,
    budget_bytes: Option<u64>,
    cache_limit_bytes: Option<u64>,
) -> Result<serde_json::Value, IpcError> {
    #[cfg(feature = "mlx")]
    {
        run_blocking(move || {
            let device = match device.as_str() {
                "cpu" => inspector_engine::worker::DeviceDto::Cpu,
                _ => inspector_engine::worker::DeviceDto::Accelerator,
            };
            let forecast = inspector_engine::memory::estimate_cold(
                &PathBuf::from(path),
                device,
                input_positions,
                max_output_tokens,
                prefill_chunk_tokens,
                budget_bytes,
                cache_limit_bytes,
            )?;
            serde_json::to_value(forecast)
                .map_err(|e| IpcError::Internal { message: format!("forecast serialization: {e}") })
        })
        .await
    }
    #[cfg(not(feature = "mlx"))]
    {
        let _ = (path, device, input_positions, max_output_tokens, prefill_chunk_tokens, budget_bytes, cache_limit_bytes);
        Err(IpcError::BackendUnavailable {
            requires: "mlx".into(),
        })
    }
}

#[tauri::command]
pub fn backend_availability() -> BackendAvailabilityDto {
    BackendAvailabilityDto {
        live: cfg!(feature = "mlx"),
        metal: cfg!(feature = "metal"),
    }
}

#[tauri::command]
pub fn list_runs(journals: State<'_, Arc<JournalStore>>) -> Vec<RunSummaryDto> {
    journals.list()
}

#[tauri::command]
pub fn get_run_journal(
    journals: State<'_, Arc<JournalStore>>,
    run_id: String,
    from_index: u64,
    limit: u64,
) -> Result<JournalPageDto, IpcError> {
    journals
        .page(&run_id, from_index, limit.min(4096))
        .ok_or(IpcError::RunNotFound { run_id })
}

#[tauri::command]
pub fn pin_run(
    journals: State<'_, Arc<JournalStore>>,
    run_id: String,
    pinned: bool,
) -> Result<(), IpcError> {
    if journals.set_pinned(&run_id, pinned) {
        Ok(())
    } else {
        Err(IpcError::RunNotFound { run_id })
    }
}

#[tauri::command]
pub fn delete_run(journals: State<'_, Arc<JournalStore>>, run_id: String) -> Result<(), IpcError> {
    if journals.delete(&run_id) {
        Ok(())
    } else {
        Err(IpcError::RunNotFound { run_id })
    }
}

async fn run_blocking<T, F>(f: F) -> Result<T, IpcError>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, IpcError> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| IpcError::Internal { message: format!("blocking task: {e}") })?
}
