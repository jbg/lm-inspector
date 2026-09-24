//! Headless reproduction of the load-time controlled-execution probe
//! (worker/load.rs) against a real cached model, printing each stage's
//! outcome so a wrong verdict can be traced. Run with:
//!   cargo run -p inspector-engine --features metal --example control_probe -- <snapshot dir>

#[cfg(not(feature = "mlx"))]
fn main() {
    eprintln!("build with --features metal (or mlx)");
}

#[cfg(feature = "mlx")]
fn main() {
    use std::ops::ControlFlow;

    use eredu::api::{local_device_plan, LoadedModel, LocalDevice, PreparedChatGenerationSettings};
    use eredu::runtime::chat::{ChatTemplateRequest, SemanticSupport};
    use eredu_backend_mlx::MlxBackendFactory;
    use eredu_core::execution_control::GenerationControlHandle;
    use eredu_core::capture::CapturePlan;
    use eredu_core::{DraftingPlan, ExecutionPlan, SessionCapabilities};

    let path = std::env::args().nth(1).expect("usage: control_probe <snapshot dir>");
    let device_plan = local_device_plan(LocalDevice::Accelerator(0)).expect("device plan");
    let execution = ExecutionPlan::fully_resident(device_plan)
        .with_required_session_capabilities(SessionCapabilities::new(true, true, true))
        .with_drafting(DraftingPlan::Disabled);

    println!("== loading {path}");
    let planned = LoadedModel::load_execution_plan(
        &MlxBackendFactory::default(),
        std::path::Path::new(&path),
        &execution,
    )
    .expect("load");
    let (mut model, _drafting) = planned.into_parts();

    // Same call order as worker/load.rs before the probe.
    println!("== capture_discovery: {:?}", model.capture_discovery().map(|_| "ok").map_err(|e| e.to_string()));
    println!("== intervention_discovery: {:?}", model.intervention_discovery().map(|_| "ok").map_err(|e| e.to_string()));

    let request = || ChatTemplateRequest {
        messages: vec![serde_json::json!({"role": "user", "content": "probe"})],
        add_generation_prompt: true,
        ..Default::default()
    };

    for attempt in 1..=2 {
        println!("---- attempt {attempt} ----");
        let chat = match model.prepare_chat(request()) {
            Ok(c) => c,
            Err(e) => {
                println!("prepare_chat failed: {e}");
                return;
            }
        };
        match chat.semantic_support() {
            SemanticSupport::Supported => println!("semantic_support: supported"),
            SemanticSupport::Unsupported { reason } => {
                println!("semantic_support: UNSUPPORTED: {reason}")
            }
        }
        let resolved = inspector_engine::budgets::resolve(&Default::default());
        let prepared = match model.prepare_observed_chat(
            &chat,
            PreparedChatGenerationSettings {
                overrides: Default::default(),
                strategy: eredu_core::TextSamplingStrategy::Standard,
                seed: 0,
                prefill: Default::default(),
            },
            CapturePlan::none(),
            resolved.trace,
        ) {
            Ok(p) => p,
            Err(e) => {
                println!("prepare_observed_chat failed: {e}");
                return;
            }
        };
        match model.start_controlled_text(
            prepared,
            &[],
            GenerationControlHandle::default(),
            |_| ControlFlow::Continue(()),
        ) {
            Ok(mut session) => {
                println!("start_controlled_text: OK");
                let cancel = session.cancel(|_| ControlFlow::Continue(()));
                println!("cancel: {:?}", cancel.map(|_| "ok").map_err(|e| e.to_string()));
            }
            Err(e) => {
                println!("start_controlled_text: ERR variant={e:?}");
                println!("start_controlled_text: display={e}");
            }
        }
    }
}
