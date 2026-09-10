//! Cold artifact inspection: everything eredu exposes without materializing
//! weights (and without any backend feature). The bundle is returned as a
//! pre-serialized JSON string so 64-bit integers reach the webview exactly
//! (the frontend re-parses with its lossless parser).

use std::path::Path;

use eredu::api::{inspect_architecture, inspect_text_model, TextInspectionOptions};
use eredu::api::TextModelOptions;
use eredu::runtime::chat::ChatTemplateRequest;
use serde::Serialize;
use serde_json::Value;

use crate::error::{error_chain, IpcError};

/// Drafting support computed cold, so the load gate only offers what the
/// model can actually do.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DraftingSupport {
    /// Embedded prediction-head capacity (max draft tokens). None = the
    /// report could not measure it (unknown ≠ 0); Some(0) = no heads.
    embedded_capacity: Option<u64>,
    /// Whether this family is an external-assistant target. Family-dispatched
    /// in eredu-architectures; at the pinned revision the targets are gemma4
    /// and muse_glimmer. Assistant-side compatibility is still proven by
    /// admission at load.
    external_target: bool,
}

/// External-assistant target families at the pinned eredu revision
/// (`ExternalAssistantTargetProfile` variants).
const EXTERNAL_TARGET_FAMILIES: &[&str] = &["gemma4", "muse_glimmer"];

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct InspectionBundle<'a> {
    /// Full `ModelInspectionReport` (readiness, resources, issues, ...).
    report: &'a eredu_core::ModelInspectionReport,
    /// Full `ArchitectureDescriptor` (schema 2).
    architecture: &'a eredu_core::ArchitectureDescriptor,
    /// Tensor catalog descriptors, in catalog order.
    tensors: Vec<&'a eredu_core::checkpoint::TensorDescriptor>,
    /// Raw config.json when the artifact carries one (SafeTensors).
    configuration: Option<&'a Value>,
    family: &'a str,
    effective_model_type: &'a str,
    drafting: DraftingSupport,
}

/// Inspect an artifact (SafeTensors snapshot directory or GGUF file) with no
/// weights and no backend. `probe_chat` renders/behaviorally probes the chat
/// template against a canned single-user-message request.
pub fn inspect_bundle_json(path: &Path, probe_chat: bool) -> Result<String, IpcError> {
    let chat_probe = probe_chat.then(|| ChatTemplateRequest {
        messages: vec![serde_json::json!({"role": "user", "content": "Hello"})],
        add_generation_prompt: true,
        ..Default::default()
    });
    inspect_bundle_json_with(path, chat_probe)
}

fn inspect_bundle_json_with(
    path: &Path,
    chat_probe: Option<ChatTemplateRequest>,
) -> Result<String, IpcError> {
    let artifact = eredu_architectures::configuration::inspect_artifact(path)
        .map_err(|e| inspection_error(&e, path))?;
    let architecture = inspect_architecture(path).map_err(|e| inspection_error(&e, path))?;

    // Live builds validate an actual execution plan against the backend
    // (still without materializing weights), upgrading model_loadability /
    // requested_load — and therefore text_generation — to real verdicts.
    // Cold builds, or a failed backend probe, fall back to the header-only
    // unverified report.
    let base_report = backend_report(path).unwrap_or_else(|| {
        let mut report = eredu_core::ModelInspectionReport::unverified(path, artifact.format());
        report.record_artifact_inspection(&artifact);
        report
    });
    let report = inspect_text_model(
        base_report,
        &TextModelOptions::default(),
        TextInspectionOptions { chat_request: chat_probe },
    );

    let configuration = artifact.configuration();
    let family = configuration.family();
    let effective = configuration.effective_model_type();
    let drafting = DraftingSupport {
        embedded_capacity: report
            .resources
            .embedded_draft_capacity
            .value()
            .map(|c| *c as u64),
        external_target: EXTERNAL_TARGET_FAMILIES
            .iter()
            .any(|f| *f == family || *f == effective),
    };
    let bundle = InspectionBundle {
        report: &report,
        architecture: &architecture,
        tensors: artifact.tensors().descriptors().collect(),
        configuration: configuration.json(),
        family,
        effective_model_type: effective,
        drafting,
    };
    serde_json::to_string(&bundle)
        .map_err(|e| IpcError::Internal { message: format!("bundle serialization: {e}") })
}

/// Tokenize preview for the cold-side sandbox: encodes text with the artifact's
/// tokenizer (no weights) and returns per-token (id, text) pairs.
pub fn tokenize_preview(path: &Path, text: &str) -> Result<Vec<(u32, String)>, IpcError> {
    let tokenizer = eredu::api::load_tokenizer(path).map_err(|e| IpcError::Inspection {
        message: e.to_string(),
        path: Some(path.display().to_string()),
        chain: error_chain(&e),
    })?;
    let encoding = tokenizer
        .encode(text, false)
        .map_err(|e| IpcError::Inspection {
            message: e.to_string(),
            path: Some(path.display().to_string()),
            chain: Vec::new(),
        })?;
    let ids = encoding.get_ids();
    let mut out = Vec::with_capacity(ids.len());
    for &id in ids {
        let piece = tokenizer.decode(&[id], false).unwrap_or_default();
        out.push((id, piece));
    }
    Ok(out)
}

/// Backend-validated inspection for the default fully-resident plan on the
/// default local device. Returns None when unavailable (cold build) or when
/// the backend probe itself fails — the caller falls back to the cold report.
#[cfg(feature = "mlx")]
fn backend_report(path: &Path) -> Option<eredu_core::ModelInspectionReport> {
    use eredu::api::{default_local_device, inspect_local_model, local_device_plan, LocalInspectionOptions};
    use eredu_backend_mlx::MlxBackendFactory;
    use eredu_core::{ExecutionPlan, SessionCapabilities};

    let device = local_device_plan(default_local_device()).ok()?;
    let plan = ExecutionPlan::fully_resident(device)
        .with_required_session_capabilities(SessionCapabilities::new(true, true, true));
    let options = LocalInspectionOptions::for_execution_plan(&MlxBackendFactory::default(), &plan).ok()?;
    inspect_local_model(path, options).ok()
}

#[cfg(not(feature = "mlx"))]
fn backend_report(_path: &Path) -> Option<eredu_core::ModelInspectionReport> {
    None
}

fn inspection_error(err: &dyn std::error::Error, path: &Path) -> IpcError {
    IpcError::Inspection {
        message: err.to_string(),
        path: Some(path.display().to_string()),
        chain: error_chain(err),
    }
}

#[cfg(test)]
mod tests {
    use super::EXTERNAL_TARGET_FAMILIES;

    /// The external-target set mirrors `ExternalAssistantTargetProfile`'s
    /// variants at the pinned eredu revision; revisit on every rev bump.
    #[test]
    fn external_target_families_match_pinned_revision() {
        assert_eq!(EXTERNAL_TARGET_FAMILIES, &["gemma4", "muse_glimmer"]);
        assert!(EXTERNAL_TARGET_FAMILIES.contains(&"gemma4"));
        assert!(!EXTERNAL_TARGET_FAMILIES.contains(&"lfm2"));
        assert!(!EXTERNAL_TARGET_FAMILIES.contains(&"nanbeige"));
    }
}
