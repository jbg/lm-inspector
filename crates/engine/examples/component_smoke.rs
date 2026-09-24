//! Headless component-analysis smoke against a real cached model: exact-prefix
//! replay analysis (signed score decomposition + ranking), deletion/keep-only
//! mask trials, and a reversible write-column overlay — the paper's
//! read → ablate → write loop through the worker command surface.
//!
//! Run: cargo run -p inspector-engine --features metal --example component_smoke [artifact-path]

#[cfg(not(feature = "mlx"))]
fn main() {
    eprintln!("build with --features mlx or metal");
}

#[cfg(feature = "mlx")]
fn main() {
    use inspector_engine::journal::JournalStore;
    use inspector_engine::stream::{DeliveryGate, EventSink, RunEventEnvelope, SinkClosed};
    use inspector_engine::worker::component::{
        AnalyzeRequestDto, ComponentCommand, ComponentEditActionDto, ComponentEditDto, MaskDto,
        MaskTrialRequestDto, OverlayRequestDto,
    };
    use inspector_engine::worker::{self, Command, DeviceDto, LoadPlanDto, SharedControl};
    use std::sync::{Arc, Mutex};

    struct CollectingSink(Mutex<Vec<RunEventEnvelope>>);
    impl EventSink for CollectingSink {
        fn send(&self, envelope: RunEventEnvelope) -> Result<bool, SinkClosed> {
            self.0.lock().unwrap().push(envelope);
            Ok(false) // undelivered → gate self-acks (no UI attached)
        }
    }

    let artifact = std::env::args().nth(1).unwrap_or_else(|| {
        let snapshot = inspector_engine::cache::scan_model_cache(&[]).expect("scan");
        // Prefer the verified dense live model; fall back to the smallest artifact.
        let mut candidates: Vec<_> = snapshot
            .models
            .iter()
            .flat_map(|m| {
                m.revisions
                    .first()
                    .into_iter()
                    .flat_map(|r| r.artifacts.clone())
                    .map(move |a| (m.repo_id.clone(), a))
            })
            .collect();
        if let Some((_, a)) = candidates.iter().find(|(repo, _)| repo.contains("LFM2.5-1.2B")) {
            return a.path.clone();
        }
        candidates.sort_by_key(|(_, a)| a.size_bytes);
        candidates.first().expect("no artifacts in cache").1.path.clone()
    });
    println!("artifact: {artifact}");

    let sink = Arc::new(CollectingSink(Mutex::new(Vec::new())));
    let gate = Arc::new(DeliveryGate::default());
    let journal = Arc::new(JournalStore::default());
    let shared = Arc::new(SharedControl::default());

    let start = std::time::Instant::now();
    let handle = worker::spawn(
        artifact.clone().into(),
        LoadPlanDto { device: DeviceDto::Accelerator, drafting: None, allocator_cache_limit_bytes: None },
        1,
        sink.clone(),
        gate,
        journal.clone(),
        shared,
    )
    .expect("load failed");
    println!(
        "loaded {} ({}) in {:.1}s",
        handle.info.model_label,
        handle.info.effective_model_type,
        start.elapsed().as_secs_f32(),
    );

    let prefix = handle
        .request(|reply| Command::Encode { text: "The capital of France is".into(), reply })
        .expect("encode");
    println!("prefix ids: {prefix:?}");

    let analyze = |target: u32, competitor: Option<u32>| -> serde_json::Value {
        let json = handle
            .request(|reply| {
                Command::Component(ComponentCommand::Analyze {
                    req: Box::new(AnalyzeRequestDto {
                        prefix_ids: prefix.clone(),
                        target_token: target,
                        competitor_token: competitor,
                        top_components: Some(16),
                    }),
                    reply,
                })
            })
            .expect("analyze");
        serde_json::from_str(&json).expect("analysis json")
    };

    // Pass 1: target 0 just to discover the actual argmax token.
    let probe = analyze(0, None);
    let argmax = {
        let s = &probe["tokenScores"]["scores"][0];
        let target_id = s["target"]["token_id"].as_u64().unwrap() as u32;
        let alt = &s["strongest_alternative"];
        let alt_id = alt["token_id"].as_u64().unwrap() as u32;
        if s["rank"].as_u64() == Some(1) { target_id } else { alt_id }
    };
    println!("argmax token: {argmax}");

    // Pass 2: the real analysis of the argmax prediction.
    let started = std::time::Instant::now();
    let analysis = analyze(argmax, None);
    println!("analysis took {:.1}s", started.elapsed().as_secs_f32());
    let score = &analysis["score"];
    let actual = score["actual"].as_f64().unwrap();
    let error = score["absoluteError"].as_f64().unwrap();
    let count = score["componentCount"].as_u64().unwrap();
    println!(
        "score {actual:.4} reconstructed {:.4} (error {error:.2e}) from {count} components",
        score["reconstructed"].as_f64().unwrap()
    );
    assert!(count > 0, "no components decomposed");
    // Reduced-precision (bf16/f16) activation evidence bounds reconstruction
    // agreement; the engine reports the measured error and the UI shows it.
    assert!(
        error <= 5e-2 + 5e-3 * actual.abs(),
        "reconstruction error too large: {error}"
    );
    let margin = &analysis["margin"];
    assert!(!margin.is_null(), "margin decomposition missing");
    println!(
        "margin vs {}: {:.4} (error {:.2e})",
        analysis["competitorToken"],
        margin["actual"].as_f64().unwrap(),
        margin["absoluteError"].as_f64().unwrap()
    );
    let top = score["top"].as_array().unwrap();
    assert!(!top.is_empty());
    let strongest = &top[0];
    let group = strongest["group"].as_str().unwrap().to_string();
    let index = strongest["index"].as_u64().unwrap() as u32;
    println!(
        "strongest component: {group}[{index}] = {:.4} (activation {:.4})",
        strongest["value"].as_f64().unwrap(),
        strongest["activation"].as_f64().unwrap()
    );
    let dtype = analysis["sourceDtypes"][&group]
        .as_str()
        .expect("source dtype for strongest group")
        .to_string();

    // Deletion trial: remove the strongest component at the tested prediction.
    let trial = |masks: Vec<MaskDto>| -> serde_json::Value {
        let json = handle
            .request(|reply| {
                Command::Component(ComponentCommand::MaskTrial {
                    req: Box::new(MaskTrialRequestDto {
                        prefix_ids: prefix.clone(),
                        target_token: argmax,
                        competitor_token: analysis["competitorToken"].as_u64().map(|v| v as u32),
                        masks,
                        max_new_tokens: Some(4),
                        seed: Some(17),
                    }),
                    reply,
                })
            })
            .expect("mask trial");
        serde_json::from_str(&json).expect("trial json")
    };
    let baseline_score = analysis["tokenScores"]["scores"][0]["target"]["score"]
        .as_f64()
        .unwrap();
    let deletion = trial(vec![MaskDto {
        group_id: group.clone(),
        indices: vec![index],
        keep_selected: false,
        dtype: dtype.clone(),
        scope: None,
    }]);
    let deleted_score = deletion["tokenScores"]["scores"][0]["target"]["score"]
        .as_f64()
        .unwrap();
    println!(
        "deletion trial: target score {baseline_score:.4} -> {deleted_score:.4} · continuation {:?}",
        deletion["generated"]
            .as_array()
            .unwrap()
            .iter()
            .map(|t| t["text"].as_str().unwrap_or("").to_string())
            .collect::<String>()
    );
    assert_eq!(deletion["status"].as_str(), Some("completed"));
    assert!(deletion["failure"].is_null(), "trial failure: {:?}", deletion["failure"]);
    assert!(
        (deleted_score - baseline_score).abs() > 0.0,
        "deleting the strongest component left the score bit-identical"
    );

    // Keep-only trial: keep just the strongest component in its group.
    let keep_only = trial(vec![MaskDto {
        group_id: group.clone(),
        indices: vec![index],
        keep_selected: true,
        dtype: dtype.clone(),
        scope: None,
    }]);
    println!(
        "keep-only trial: target score -> {:.4}",
        keep_only["tokenScores"]["scores"][0]["target"]["score"].as_f64().unwrap()
    );
    assert_eq!(keep_only["status"].as_str(), Some("completed"));

    // Overlay: zero the strongest component's write column, re-analyze, restore.
    let overlay = handle
        .request(|reply| {
            Command::Component(ComponentCommand::InstallOverlay {
                req: Box::new(OverlayRequestDto {
                    provenance: "component_smoke zero-column trial".into(),
                    edits: vec![ComponentEditDto {
                        group_id: group.clone(),
                        component: index,
                        action: ComponentEditActionDto::Scale { factor: 0.0 },
                    }],
                    raw_edits: None,
                }),
                reply,
            })
        })
        .expect("install overlay");
    let overlay: serde_json::Value = serde_json::from_str(&overlay).unwrap();
    println!("overlay active: {}", overlay["overlayIdentity"]);
    assert!(!overlay["overlayIdentity"].is_null());

    let edited = analyze(argmax, None);
    let edited_contribution = edited["score"]["top"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["group"].as_str() == Some(group.as_str()) && c["index"].as_u64() == Some(index as u64));
    println!(
        "with overlay: score {:.4}, strongest-component contribution now {:?}",
        edited["score"]["actual"].as_f64().unwrap(),
        edited_contribution.map(|c| c["value"].as_f64().unwrap())
    );
    // A zeroed write column contributes exactly nothing, so the component
    // should have dropped out of the top list (or appear with ~0 value).
    if let Some(c) = edited_contribution {
        assert!(c["value"].as_f64().unwrap().abs() < 1e-9);
    }
    assert!(
        edited["score"]["absoluteError"].as_f64().unwrap()
            <= 5e-2 + 5e-3 * edited["score"]["actual"].as_f64().unwrap().abs(),
        "edited reconstruction error too large"
    );

    let removed = handle
        .request(|reply| Command::Component(ComponentCommand::RemoveOverlay { reply }))
        .expect("remove overlay");
    let removed: serde_json::Value = serde_json::from_str(&removed).unwrap();
    assert!(removed["overlayIdentity"].is_null());

    let restored = analyze(argmax, None);
    let restored_score = restored["score"]["actual"].as_f64().unwrap();
    println!("restored score: {restored_score:.4} (baseline {actual:.4})");
    assert!(
        (restored_score - actual).abs() < 1e-4 + 1e-4 * actual.abs(),
        "restored score differs from baseline"
    );

    handle.shutdown();
    println!("component smoke PASSED");
}
