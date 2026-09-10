// Reproduces the external-drafting load path: target + assistant plan build.
use eredu::api::{local_device_plan, LoadedModel, LocalDevice};
use eredu_backend_mlx::MlxBackendFactory;
use eredu_core::{DraftPlacementPlan, DraftingPlan, ExecutionPlan, SessionCapabilities};

fn main() {
    let target = std::env::args().nth(1).expect("target path");
    let drafter = std::env::args().nth(2).expect("drafter path");
    let device_plan = local_device_plan(LocalDevice::Accelerator(0)).expect("device");
    let execution = ExecutionPlan::fully_resident(device_plan)
        .with_required_session_capabilities(SessionCapabilities::new(true, true, true))
        .with_drafting(DraftingPlan::External {
            model: drafter,
            placement: DraftPlacementPlan::Target,
            max_draft_tokens: 4,
            lookahead: true,
            adaptive_lookahead: false,
        });
    match LoadedModel::load_execution_plan(
        &MlxBackendFactory::default(),
        std::path::Path::new(&target),
        &execution,
    ) {
        Ok(_) => println!("PLAN+WEIGHTS OK"),
        Err(e) => {
            println!("ERROR: {e}");
            let mut src: Option<&dyn std::error::Error> = std::error::Error::source(&e);
            while let Some(s) = src {
                println!("  caused by: {s}");
                src = s.source();
            }
        }
    }
}
