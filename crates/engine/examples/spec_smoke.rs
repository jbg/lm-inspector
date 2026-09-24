//! Headless speculative smoke: loads a target with an external drafter and
//! dumps the raw speculative step payloads for record-shape inspection.
//!
//! Run: cargo run -p inspector-engine --release --features metal --example spec_smoke <target> <drafter> [steps]

#[cfg(not(feature = "mlx"))]
fn main() {
    eprintln!("build with --features mlx or metal");
}

#[cfg(feature = "mlx")]
fn main() {
    use inspector_engine::journal::JournalStore;
    use inspector_engine::stream::{DeliveryGate, EventSink, RunEventEnvelope, SinkClosed};
    use inspector_engine::worker::{self, Command, DeviceDto, DraftingDto, LoadPlanDto, SessionCommand, SharedControl, StartRunSpecDto};
    use std::sync::{Arc, Mutex};

    struct CollectingSink(Mutex<Vec<RunEventEnvelope>>);
    impl EventSink for CollectingSink {
        fn send(&self, envelope: RunEventEnvelope) -> Result<bool, SinkClosed> {
            self.0.lock().unwrap().push(envelope);
            Ok(false)
        }
    }

    let target = std::env::args().nth(1).expect("target path");
    let drafter = std::env::args().nth(2).filter(|s| s != "-");
    let embedded = drafter.as_deref() == Some("embedded");
    let steps: u32 = std::env::args().nth(3).and_then(|s| s.parse().ok()).unwrap_or(12);

    let sink = Arc::new(CollectingSink(Mutex::new(Vec::new())));
    let gate = Arc::new(DeliveryGate::default());
    let journal = Arc::new(JournalStore::default());
    let shared = Arc::new(SharedControl::default());

    let start = std::time::Instant::now();
    let handle = worker::spawn(
        target.clone().into(),
        LoadPlanDto {
            device: DeviceDto::Accelerator,
            drafting: if embedded {
                Some(DraftingDto::Embedded { max_draft_tokens: 1, lookahead: false, adaptive_lookahead: false })
            } else {
                drafter.clone().filter(|s| s != "embedded").map(|model_path| DraftingDto::External {
                    model_path,
                    max_draft_tokens: 4,
                    lookahead: true,
                    adaptive_lookahead: false,
                })
            },
            allocator_cache_limit_bytes: None,
        },
        1,
        sink.clone(),
        gate,
        journal.clone(),
        shared,
    )
    .expect("load failed");
    println!(
        "loaded {} in {:.1}s · drafting {} · draft_capacity {:?}",
        handle.info.model_label,
        start.elapsed().as_secs_f32(),
        handle.info.drafting,
        handle.info.draft_capacity,
    );

    let spec = StartRunSpecDto {
        execution: None,
        inference: None,
        messages: vec![serde_json::json!({"role": "user", "content": "Why is the sky blue?"})],
        tools: vec![],
        tool_choice: None,
        enable_thinking: None,
        reasoning_effort: None,
        mode: None,
        raw_text: None,
        overrides: serde_json::json!({"max_new_tokens": 24}),
        strategy: None,
        seed: Some(42),
        stops: vec![],
        capture: None,
        intervention: None,
        intervention_draft: None,
        budgets: None,
        created_ms: None,
    };
    if drafter.is_some() {  // embedded or external -> speculative session
        handle
            .request(|reply| Command::ForecastMemory { spec: Box::new(spec.clone()), speculative: true, budget_bytes: None, reply })
            .map(|forecast| {
                let estimate: serde_json::Value = serde_json::from_str(&forecast.estimate).unwrap();
                println!(
                    "speculative forecast: {} · {} positions · speculative phases projected: {} · full pass: {:?} · generation peak {}..{:?} · phases {:?}",
                    forecast.fit,
                    forecast.input_positions,
                    forecast.speculative,
                    forecast.full_pass,
                    estimate["domains"][0]["generation_peak"]["lower_bytes"],
                    estimate["domains"][0]["generation_peak"]["upper_bytes"],
                    estimate["domains"][0]["phases"].as_array().map(|p| p.iter().map(|x| x["phase"].to_string()).collect::<Vec<_>>()),
                );
            })
            .unwrap_or_else(|e| println!("speculative forecast unavailable: {e}"));
        let started = handle
            .request(|reply| Command::StartSpeculativeRun { spec: Box::new(spec), reply })
            .expect("start failed");
        println!("spec run {} started", started.run_id);
        let mut outlook_shown = false;
        for _ in 0..steps {
            let status = handle
                .request(|reply| Command::Spec(inspector_engine::worker::speculative::SpecCommand::Step { actions: 1, reply }))
                .expect("step failed");
            if status.terminal { break; }
            // Settled-lane outlook: eligible after prefill or a canonical commit
            // (rejected mid-transaction, which is a boundary fact, not a failure).
            if !outlook_shown {
                match handle.request(|reply| Command::Spec(inspector_engine::worker::speculative::SpecCommand::ForecastRemaining { additional_tokens: 32, budget_bytes: None, reply })) {
                    Ok(outlook) => {
                        let estimate: serde_json::Value = serde_json::from_str(&outlook.estimate).unwrap();
                        println!(
                            "speculative outlook: {} · from {} positions · +32 tokens · generation peak {}..{:?} · additional {}..{:?} · phases {:?}",
                            outlook.fit,
                            outlook.input_positions,
                            estimate["domains"][0]["generation_peak"]["lower_bytes"],
                            estimate["domains"][0]["generation_peak"]["upper_bytes"],
                            estimate["domains"][0]["additional_generation_peak"]["lower_bytes"],
                            estimate["domains"][0]["additional_generation_peak"]["upper_bytes"],
                            estimate["domains"][0]["phases"].as_array().map(|p| p.iter().map(|x| x["phase"].to_string()).collect::<Vec<_>>()),
                        );
                        outlook_shown = true;
                    }
                    Err(e) => println!("speculative outlook not available at this boundary: {e}"),
                }
            }
        }
    } else {
        let started = handle
            .request(|reply| Command::StartRun { spec: Box::new(spec), reply })
            .expect("start failed");
        println!("ordinary run {} started", started.run_id);
        let _ = handle.request(|reply| Command::Session(SessionCommand::Continue { reply }));
    }

    let envelopes = sink.0.lock().unwrap();
    println!("--- {} envelopes ---", envelopes.len());
    for env in envelopes.iter() {
        if env.stream == inspector_engine::stream::StreamKind::Controlled {
            let payload: serde_json::Value = serde_json::from_str(&env.payload).unwrap_or_default();
            if let Some(tid) = payload.pointer("/generation/event/token_id") {
                print!("{tid} ");
            }
            continue;
        }
        if env.stream == inspector_engine::stream::StreamKind::Speculative {
            let payload: serde_json::Value = serde_json::from_str(&env.payload).unwrap_or_default();
            // Compact: drop nulls, truncate long arrays for readability.
            println!("SPEC seq={} :: {}", payload.get("sequence").cloned().unwrap_or_default(), summarize(&payload));
        }
    }

    fn summarize(v: &serde_json::Value) -> String {
        let mut out = serde_json::Map::new();
        for key in ["status", "drafted", "verification", "committed_token_ids", "forced_token"] {
            if let Some(val) = v.get(key) {
                if !val.is_null() {
                    out.insert(key.into(), val.clone());
                }
            }
        }
        serde_json::to_string(&serde_json::Value::Object(out)).unwrap_or_default()
    }
}
