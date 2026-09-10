//! Manual smoke test: scan the real HF cache and cold-inspect the first model.
//! Run: cargo run -p inspector-engine --example cold_smoke

fn main() {
    let snapshot = inspector_engine::cache::scan_model_cache().expect("scan failed");
    println!(
        "cache: {} · {} models · {} warnings",
        snapshot.cache_dir,
        snapshot.models.len(),
        snapshot.warnings.len()
    );
    for model in snapshot.models.iter().take(10) {
        let artifacts: Vec<String> = model
            .revisions
            .first()
            .map(|r| {
                r.artifacts
                    .iter()
                    .map(|a| format!("{:?}({})", a.format, a.label))
                    .collect()
            })
            .unwrap_or_default();
        println!("  {} → {:?}", model.repo_id, artifacts);
    }
    let arg = std::env::args().nth(1);
    let path = arg.unwrap_or_else(|| {
        snapshot
            .models
            .iter()
            .find_map(|m| m.revisions.first().and_then(|r| r.artifacts.first()))
            .expect("no loadable artifact found")
            .path
            .clone()
    });
    println!("\ninspecting {path} …");
    let json = inspector_engine::inspect::inspect_bundle_json(std::path::Path::new(&path), true)
        .expect("inspection failed");
    let value: serde_json::Value = serde_json::from_str(&json).unwrap();
    println!(
        "family={} type={} tensors={} nodes={} points={} issues={}",
        value["family"],
        value["effectiveModelType"],
        value["tensors"].as_array().map(|a| a.len()).unwrap_or(0),
        value["architecture"]["nodes"].as_array().map(|a| a.len()).unwrap_or(0),
        value["architecture"]["observations"]["points"].as_array().map(|a| a.len()).unwrap_or(0),
        value["report"]["issues"].as_array().map(|a| a.len()).unwrap_or(0),
    );
    println!("drafting: {}", value["drafting"]);
    println!(
        "readiness: loadability={} requested_load={} tokenizer={} text_generation={}",
        value["report"]["model_loadability"],
        value["report"]["requested_load"],
        value["report"]["tokenizer"],
        value["report"]["text_generation"],
    );
    println!("bundle bytes: {}", json.len());
}
