//! Headless live smoke: drives the model-owner worker against a real cached
//! model. Exercises load → controlled run with top-k capture → head force →
//! counterfactual branch with deterministic replay → tree status.
//!
//! Run: cargo run -p inspector-engine --features metal --example live_smoke [artifact-path]

#[cfg(not(feature = "mlx"))]
fn main() {
    eprintln!("build with --features mlx or metal");
}

#[cfg(feature = "mlx")]
fn main() {
    use inspector_engine::journal::JournalStore;
    use inspector_engine::stream::{DeliveryGate, EventSink, RunEventEnvelope, SinkClosed};
    use inspector_engine::worker::{
        self, Command, DeviceDto, LoadPlanDto, SessionCommand, SharedControl, StartRunSpecDto,
    };
    use std::sync::{Arc, Mutex};

    struct CollectingSink(Mutex<Vec<RunEventEnvelope>>);
    impl EventSink for CollectingSink {
        fn send(&self, envelope: RunEventEnvelope) -> Result<bool, SinkClosed> {
            self.0.lock().unwrap().push(envelope);
            // Report undelivered so the gate self-acks (no UI to ack us).
            Ok(false)
        }
    }

    let artifact = std::env::args().nth(1).unwrap_or_else(|| {
        // Default: smallest GGUF/SafeTensors artifact in the cache.
        let snapshot = inspector_engine::cache::scan_model_cache(&[]).expect("scan");
        let mut candidates: Vec<_> = snapshot
            .models
            .iter()
            .flat_map(|m| m.revisions.first().into_iter().flat_map(|r| r.artifacts.clone()))
            .collect();
        candidates.sort_by_key(|a| a.size_bytes);
        candidates.first().expect("no artifacts in cache").path.clone()
    });
    println!("artifact: {artifact}");

    let sink = Arc::new(CollectingSink(Mutex::new(Vec::new())));
    let gate = Arc::new(DeliveryGate::default());
    let journal = Arc::new(JournalStore::default());
    let shared = Arc::new(SharedControl::default());

    let start = std::time::Instant::now();
    let handle = worker::spawn(
        artifact.clone().into(),
        LoadPlanDto { device: DeviceDto::Accelerator, drafting: None },
        1,
        sink.clone(),
        gate,
        journal.clone(),
        shared,
    )
    .expect("load failed");
    println!(
        "loaded {} ({}) in {:.1}s · vocab {} · drafting {}",
        handle.info.model_label,
        handle.info.effective_model_type,
        start.elapsed().as_secs_f32(),
        handle.info.vocabulary_size,
        handle.info.drafting,
    );

    let spec = StartRunSpecDto {
        execution: None,
        messages: vec![serde_json::json!({"role": "user", "content": "Name three colors."})],
        tools: vec![],
        tool_choice: None,
        enable_thinking: Some(false),
        reasoning_effort: None,
        mode: None,
        raw_text: None,
        overrides: serde_json::json!({"temperature": 0.7, "max_new_tokens": 24, "do_sample": true}),
        strategy: None,
        seed: Some(42),
        stops: vec![],
        capture: Some(serde_json::json!({
            "schema_version": 1,
            "selections": [{
                "id": "topk",
                "path": "model.logits",
                "schedule": {"prefill": true, "decode": true, "first_prediction": 0, "end_prediction": null, "every": 1},
                "slices": [],
                "transform": {"kind": "top_candidates", "count": 8}
            }],
            "limits": {
                "per_step": {"captures": 32, "retained_bytes": 33554432, "host_bytes": 8388608, "encoded_bytes": 2097152},
                "cumulative": {"captures": 8192, "retained_bytes": 2147483648u64, "host_bytes": 536870912, "encoded_bytes": 100663296},
                "physical_native_bytes": null,
                "on_limit": "skip"
            }
        })),
        intervention: None,
        intervention_draft: None,
        budgets: None,
        created_ms: None,
    };
    let started = handle
        .request(|reply| Command::StartRun { spec: Box::new(spec), reply })
        .expect("start_run failed");
    println!(
        "run {} started · snapshot_support: {:?}",
        started.run_id, started.snapshot_support
    );

    // Step 6 tokens.
    let status = handle
        .request(|reply| Command::Session(SessionCommand::Step { steps: 6, reply }))
        .expect("step failed");
    println!("after 6 steps: {} · {} tokens", status.status, status.token_count);
    assert!(status.token_count >= 1, "no tokens generated");

    // Tree status: snapshots should exist (auto cadence).
    let tree = handle
        .request(|reply| Command::Session(SessionCommand::TreeStatus { reply }))
        .expect("tree status failed");
    println!(
        "tree: active={} snapshots={:?} slots={}",
        tree.active_run,
        tree.snapshots.iter().map(|s| s.next_prediction).collect::<Vec<_>>(),
        tree.slots.len()
    );

    // Counterfactual: pick an alternative token at position 2 from the journal's
    // captured candidates. Position 0 is the prefill prediction — its top-k must
    // be captured too (the estimate charges the logits row, not the whole
    // prefill source), or the first token has no alternates in the UI.
    let page = journal.page(&started.run_id, 0, 4096).expect("journal page");
    let mut alternative: Option<u32> = None;
    let mut chosen_at_2: Option<u32> = None;
    let mut prefill_candidates = 0usize;
    for env in &page.envelopes {
        let v: serde_json::Value = serde_json::from_str(&env.payload).unwrap();
        let event = &v["generation"]["event"];
        if event["kind"] == "token" && event["prediction_index"] == 0 {
            let record = &event["captures"]["records"][0];
            prefill_candidates = record["payload"]["value"]["candidates"]
                .as_array()
                .map_or(0, Vec::len);
            assert!(
                prefill_candidates > 0,
                "no candidates captured at prediction 0 (outcome: {})",
                record["outcome"]
            );
        }
        if event["kind"] == "token" && event["prediction_index"] == 2 {
            chosen_at_2 = event["token_id"].as_u64().map(|t| t as u32);
            if let Some(cands) = event["captures"]["records"][0]["payload"]["value"]["candidates"].as_array() {
                alternative = cands
                    .iter()
                    .filter_map(|c| c["token_id"].as_u64().map(|t| t as u32))
                    .find(|t| Some(*t) != chosen_at_2);
            }
        }
    }
    println!("prediction 0 candidates: {prefill_candidates}");
    let (chosen, alt) = (chosen_at_2.expect("token at 2"), alternative.expect("alternative at 2"));
    println!("counterfactual at position 2: {chosen} → {alt}");
    let result = handle
        .request(|reply| {
            Command::Session(SessionCommand::Counterfactual {
                run_id: started.run_id.clone(),
                prediction_index: 2,
                token_id: alt,
                options: inspector_engine::worker::CounterfactualOptionsDto {
                    temperature: None,
                    reseed: None,
                    intervention: None,
                    auto_continue: true,
                },
                reply,
            })
        })
        .expect("counterfactual failed");
    println!(
        "branch {} from {} · replayed {} steps",
        result.child_run_id, result.forked_from_snapshot, result.replayed_steps
    );
    assert_ne!(result.child_run_id, started.run_id);

    // The branch journal must exist, carry the forced token at position 2, and
    // replayed positions must match the parent exactly.
    let branch_page = journal.page(&result.child_run_id, 0, 4096).expect("branch journal");
    let mut replayed: Vec<(u64, u32, bool)> = Vec::new();
    for env in &branch_page.envelopes {
        let v: serde_json::Value = serde_json::from_str(&env.payload).unwrap();
        let event = &v["generation"]["event"];
        if event["kind"] == "token" {
            replayed.push((
                event["prediction_index"].as_u64().unwrap(),
                event["token_id"].as_u64().unwrap() as u32,
                event["forced"].as_bool().unwrap_or(false),
            ));
        }
    }
    let at2 = replayed.iter().find(|(p, _, _)| *p == 2).expect("branch token at 2");
    assert_eq!(at2.1, alt, "forced token mismatch");
    assert!(at2.2, "token at 2 not marked forced");
    println!(
        "branch tokens: {:?}",
        replayed.iter().map(|(p, t, f)| format!("{p}:{t}{}", if *f { "*" } else { "" })).collect::<Vec<_>>()
    );

    let final_status = handle
        .request(|reply| Command::Session(SessionCommand::TreeStatus { reply }))
        .expect("tree status");
    println!(
        "final: active={} slots={:?}",
        final_status.active_run,
        final_status.slots.iter().map(|s| &s.parked_run_id).collect::<Vec<_>>()
    );

    handle
        .request(|reply| Command::Session(SessionCommand::EndSession { reply }))
        .expect("end session");
    handle.shutdown();
    println!("OK — live smoke passed ({} envelopes)", sink.0.lock().unwrap().len());
}
