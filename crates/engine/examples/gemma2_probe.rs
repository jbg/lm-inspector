// Reproduces the backdoor-gemma2 failures: controlled probe, dummy-tool
// prepare, tool-less prepare, and an observed run attempt.
use std::ops::ControlFlow;
use eredu::api::{local_device_plan, LoadedModel, LocalDevice, PreparedChatGenerationSettings};
use eredu::runtime::chat::{ChatTemplateRequest, SemanticSupport, ToolChoice};
use eredu_backend_mlx::MlxBackendFactory;
use eredu_core::{ExecutionPlan, GenerationCancellationToken, SessionCapabilities, TextSamplingStrategy};

fn settings() -> PreparedChatGenerationSettings {
    PreparedChatGenerationSettings {
        overrides: Default::default(),
        strategy: TextSamplingStrategy::Standard,
        seed: 0,
    }
}

fn main() {
    let path = std::env::args().nth(1).expect("path");
    let device_plan = local_device_plan(LocalDevice::Accelerator(0)).expect("device");
    let execution = ExecutionPlan::fully_resident(device_plan)
        .with_required_session_capabilities(SessionCapabilities::new(true, true, true));
    let planned = LoadedModel::load_execution_plan(
        &MlxBackendFactory::default(),
        std::path::Path::new(&path),
        &execution,
    )
    .expect("load");
    let (mut model, _drafting) = planned.into_parts();
    let resolved = inspector_engine::budgets::resolve(&Default::default());

    // 1. dummy-tool prepare (worker's snapshot-coverage injection)
    let with_dummy = ChatTemplateRequest {
        messages: vec![serde_json::json!({"role":"user","content":"Hello"})],
        tools: vec![serde_json::json!({"type":"function","function":{"name":"lookup","parameters":{"type":"object","properties":{},"additionalProperties":false}}})],
        tool_choice: ToolChoice::None,
        add_generation_prompt: true,
        ..Default::default()
    };
    match model.prepare_chat(with_dummy) {
        Ok(_) => println!("1. dummy-tool prepare_chat: OK"),
        Err(e) => println!("1. dummy-tool prepare_chat: ERR {e}"),
    }

    // 2. tool-less prepare
    let toolless = ChatTemplateRequest {
        messages: vec![serde_json::json!({"role":"user","content":"Hello"})],
        add_generation_prompt: true,
        ..Default::default()
    };
    let chat = match model.prepare_chat(toolless) {
        Ok(c) => {
            println!("2. tool-less prepare_chat: OK; semantic_support = {:?}", matches!(c.semantic_support(), SemanticSupport::Supported));
            c
        }
        Err(e) => {
            println!("2. tool-less prepare_chat: ERR {e}");
            return;
        }
    };

    // 3. controlled-text start (the load-time control probe path)
    let prepared = model
        .prepare_observed_chat(&chat, settings(), eredu_core::capture::CapturePlan::none(), resolved.trace)
        .expect("prepare_observed");
    match model.start_controlled_text(
        prepared,
        &[],
        eredu_core::execution_control::GenerationControlHandle::default(),
        |_| ControlFlow::Continue(()),
    ) {
        Ok(mut s) => {
            println!("3. start_controlled_text: OK (control supported)");
            let _ = s.cancel(|_| ControlFlow::Continue(()));
        }
        Err(e) => println!("3. start_controlled_text: ERR {e}"),
    }

    // 4. observed generate (semantic path — the observed fallback today)
    let prepared = model
        .prepare_observed_chat(&chat, settings(), eredu_core::capture::CapturePlan::none(), resolved.trace)
        .expect("prepare_observed 2");
    let mut n = 0u32;
    match model.generate_observed_chat(prepared, &[], GenerationCancellationToken::new(), |_r| {
        n += 1;
        if n > 8 { ControlFlow::Break(()) } else { ControlFlow::Continue(()) }
    }) {
        Ok(_) => println!("4. generate_observed_chat: OK ({n} records)"),
        Err(e) => println!("4. generate_observed_chat: ERR {e}"),
    }
}
