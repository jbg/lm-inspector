//! Model loading on the owner thread: execution-plan construction, discovery
//! caching, and the tokenizer-derived vocabulary table.

use std::path::Path;

use eredu::api::{local_device_plan, LoadedModel, LocalDevice, PreparedChatGenerationSettings};
use eredu_backend_mlx::MlxBackendFactory;
use eredu_core::{DraftPlacementPlan, DraftingPlan, ExecutionPlan, SessionCapabilities};

use crate::error::{error_chain, IpcError};
use crate::worker::{DeviceDto, DraftingDto, LoadPlanDto, LoadedModelInfoDto, WorkerContext};

pub type Backend = eredu_backend_mlx::backend::MlxBackend<'static>;
pub type Drafter = <MlxBackendFactory as eredu_core::ExecutionPlanBackendFactory>::Drafter;

pub struct LoadedWorkerModel {
    pub model: LoadedModel<Backend>,
    pub drafting: eredu_core::RealizedDrafting<Drafter>,
    pub drafting_plan: DraftingPlan,
    pub speculative_options: Option<eredu::api::PreparedChatSpeculativeGenerationOptions>,
    pub info: LoadedModelInfoDto,
    pub vocabulary: std::sync::Arc<Vec<(u32, String)>>,
}

impl LoadedWorkerModel {
    pub fn encode(&self, text: &str) -> Result<Vec<u32>, IpcError> {
        self.model
            .encode(text, false)
            .map_err(|e| IpcError::Internal { message: e.to_string() })
    }

    pub fn decode(&self, ids: &[u32], skip_special: bool) -> Result<String, IpcError> {
        self.model
            .decode(ids, skip_special)
            .map_err(|e| IpcError::Internal { message: e.to_string() })
    }
}

fn drafting_plan(dto: &Option<DraftingDto>) -> DraftingPlan {
    match dto {
        None | Some(DraftingDto::Disabled) => DraftingPlan::Disabled,
        Some(DraftingDto::Embedded { max_draft_tokens, lookahead, adaptive_lookahead }) => {
            DraftingPlan::Embedded {
                max_draft_tokens: *max_draft_tokens as usize,
                lookahead: *lookahead,
                adaptive_lookahead: *adaptive_lookahead,
            }
        }
        Some(DraftingDto::External { model_path, max_draft_tokens, lookahead, adaptive_lookahead }) => {
            DraftingPlan::External {
                model: model_path.clone(),
                placement: DraftPlacementPlan::Target,
                max_draft_tokens: *max_draft_tokens as usize,
                lookahead: *lookahead,
                adaptive_lookahead: *adaptive_lookahead,
            }
        }
    }
}

pub fn load_model(
    artifact_path: &Path,
    plan: &LoadPlanDto,
    model_epoch: u64,
    context: &WorkerContext,
) -> Result<LoadedWorkerModel, IpcError> {
    let started = std::time::Instant::now();
    let mut last = std::time::Instant::now();
    let mut stage = |name: &str| {
        let now = std::time::Instant::now();
        eprintln!(
            "[load-stage] {name} (previous stage took {:.2}s, total {:.2}s)",
            (now - last).as_secs_f32(),
            (now - started).as_secs_f32()
        );
        last = now;
        context.emitter.emit_system(&serde_json::json!({
            "kind": "load_stage", "stage": name, "modelEpoch": model_epoch.to_string(),
        }));
    };

    stage("planning");
    let device = match plan.device {
        DeviceDto::Cpu => LocalDevice::Cpu,
        DeviceDto::Accelerator => LocalDevice::Accelerator(0),
    };
    let device_plan = local_device_plan(device).map_err(|e| IpcError::Load {
        stage: "device".into(),
        message: e.to_string(),
        chain: error_chain(&e),
    })?;
    let drafting_plan_value = drafting_plan(&plan.drafting);
    let execution = ExecutionPlan::fully_resident(device_plan)
        .with_required_session_capabilities(SessionCapabilities::new(true, true, true))
        .with_drafting(drafting_plan_value.clone());

    stage("loading_weights");
    let planned = LoadedModel::load_execution_plan(
        &MlxBackendFactory::default(),
        artifact_path,
        &execution,
    )
    .map_err(|e| IpcError::Load {
        stage: "weights".into(),
        message: e.to_string(),
        chain: error_chain(&e),
    })?;

    let speculative_options = planned
        .speculative_generation_options()
        .map_err(|e| IpcError::Load {
            stage: "drafting".into(),
            message: e.to_string(),
            chain: error_chain(&e),
        })?;
    let (mut model, drafting) = planned.into_parts();

    // The first discovery call resolves the checkpoint's content fingerprint
    // (a hash over the full weight payload, cached afterwards) — by far the
    // longest part of a load, so it gets its own stage label.
    stage("fingerprint");
    let capture_discovery = model
        .capture_discovery()
        .map_err(|e| IpcError::Load {
            stage: "capture discovery".into(),
            message: e.to_string(),
            chain: error_chain(&e),
        })
        .and_then(|d| {
            serde_json::to_string(&d).map_err(|e| IpcError::Internal { message: e.to_string() })
        })?;

    stage("discovery");
    let intervention_discovery = model
        .intervention_discovery()
        .map_err(|e| IpcError::Load {
            stage: "intervention discovery".into(),
            message: e.to_string(),
            chain: error_chain(&e),
        })
        .and_then(|d| {
            serde_json::to_string(&d).map_err(|e| IpcError::Internal { message: e.to_string() })
        })?;
    let speculative_intervention_discovery = if speculative_options.is_some() {
        model
            .speculative_intervention_discovery()
            .ok()
            .and_then(|d| serde_json::to_string(&d).ok())
    } else {
        None
    };

    stage("vocabulary");
    let vocabulary = std::sync::Arc::new(
        eredu_text::tokenizer::token_id_vocabulary(model.tokenizer())
            .into_iter()
            .collect::<Vec<(u32, String)>>(),
    );
    *context.emitter.vocabulary.lock().expect("vocab poisoned") = Some(vocabulary.clone());
    {
        use std::ops::Deref;
        let tokenizer: &tokenizers::Tokenizer = model.tokenizer().deref();
        *context.emitter.tokenizer.lock().expect("tokenizer poisoned") =
            Some(std::sync::Arc::new(tokenizer.clone()));
    }

    let drafting_label = match &drafting_plan_value {
        DraftingPlan::Disabled => "disabled".to_string(),
        DraftingPlan::Embedded { max_draft_tokens, .. } => format!("embedded({max_draft_tokens})"),
        DraftingPlan::External { model, max_draft_tokens, .. } => {
            let name = Path::new(model)
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_else(|| model.clone());
            format!("external({name}, {max_draft_tokens})")
        }
        _ => "unknown".to_string(),
    };

    // Probe controlled-execution support once: eredu only reports it at
    // start_controlled_* (backend support is separate from chat admission),
    // so attempt a throwaway controlled-text session and discard its records.
    // Only the exact capture-unsupported gate counts as a verdict; any other
    // failure is not evidence and controlled runs stay offered.
    let control_support: Option<String> = (|| {
        use std::ops::ControlFlow;
        let request = eredu::runtime::chat::ChatTemplateRequest {
            messages: vec![serde_json::json!({"role": "user", "content": "probe"})],
            add_generation_prompt: true,
            ..Default::default()
        };
        let chat = model.prepare_chat(request).ok()?;
        let resolved = crate::budgets::resolve(&Default::default());
        let prepared = model
            .prepare_observed_chat(
                &chat,
                PreparedChatGenerationSettings {
                    overrides: Default::default(),
                    strategy: eredu_core::TextSamplingStrategy::Standard,
                    seed: 0,
                },
                eredu_core::capture::CapturePlan::none(),
                resolved.trace,
            )
            .ok()?;
        match model.start_controlled_text(
            prepared,
            &[],
            eredu_core::execution_control::GenerationControlHandle::default(),
            |_| ControlFlow::Continue(()),
        ) {
            Ok(mut session) => {
                let _ = session.cancel(|_| ControlFlow::Continue(()));
                None
            }
            Err(eredu::api::ControlledGenerationError::Capture(
                eredu_core::capture::CaptureError::Unsupported(reason),
            )) => Some(reason),
            Err(_) => None,
        }
    })();

    let info = LoadedModelInfoDto {
        model_epoch,
        artifact_path: artifact_path.display().to_string(),
        model_label: context.emitter.model_label.clone(),
        effective_model_type: model.effective_model_type().to_string(),
        eos_token_ids: model.eos_token_ids().to_vec(),
        has_chat_template: model.has_chat_template(),
        drafting: drafting_label,
        vocabulary_size: vocabulary.len() as u32,
        chat_template_kwargs: model.chat_template_kwargs().unwrap_or_default(),
        checkpoint_generation_config: model
            .checkpoint_generation_config()
            .and_then(|c| serde_json::to_value(c).ok()),
        capture_discovery,
        intervention_discovery,
        speculative_intervention_discovery,
        control_support,
    };
    stage("ready");

    Ok(LoadedWorkerModel {
        model,
        drafting,
        drafting_plan: drafting_plan_value,
        speculative_options,
        info,
        vocabulary,
    })
}
