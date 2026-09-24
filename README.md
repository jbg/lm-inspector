# LM INSPECTOR

A local Tauri desktop app for inspecting language models through
[eredu](https://github.com/jbg/eredu): browse your HuggingFace cache, inspect
architecture and readiness **without loading weights**, then load a model to
generate under full execution control — per-token top-k candidates, forced
tokens, counterfactual branches, bounded activation captures, interventions,
and controlled speculative decoding.

Styled with the Spiral design system: stone, white square panels, magenta
accent, pixel display type. No shadows, no rounded corners, no icons.

## Layout

- `crates/engine` — `inspector-engine`, all eredu integration. No Tauri
  dependency; testable headless. Cold path (cache scan + inspection) compiles
  with no backend; the `mlx` feature adds the model-owner worker, `metal`
  selects the Apple-GPU backend.
- `src-tauri` — thin Tauri glue: command surface, the event channel sink,
  window lifecycle.
- `src` — React 19 + TypeScript + zustand frontend. `src/spiral/` is the
  synced Spiral design system (do not hand-edit).

## Build & run

Live app (Apple Silicon; first build compiles vendored MLX — expect a long
first wait):

```sh
npm install
npm run app          # tauri dev --features metal
npm run bundle       # release bundle with the Metal backend
```

Cold build (no MLX toolchain; cache browsing + weight-free inspection only —
generation commands are absent by design):

```sh
npm run app:cold
```

Tests:

```sh
cargo test -p inspector-engine          # engine, cold path
npx vitest run                          # lossless parsing + journal engine
cargo run -p inspector-engine --example cold_smoke   # scan + inspect your real cache
```

## Architecture notes

- **One loaded model at a time.** One OS thread owns the `LoadedModel` and
  every session/snapshot/branch handle (none are `Send`); commands rendezvous
  over a bounded channel. Pause/cancel bypass the queue through
  `GenerationControlHandle` — the only eredu type that crosses threads.
- **Streaming**: eredu records are serialized to JSON strings and shipped in
  envelopes over one Tauri `Channel`; the frontend re-parses them losslessly
  (64-bit integers become strings) and folds them into per-run journals keyed
  `(run_id, sequence, epoch)`. An ack-window `DeliveryGate` turns UI consumption
  into backpressure on eredu's synchronous emit callback.
- **Counterfactuals**: automatic snapshots at settled boundaries (every 8
  predictions, gap-minimizing thinning, pinned snapshots exempt). Forcing a
  different token at position *i* forks the nearest snapshot ≤ *i*, replays the
  committed tokens with exact inherited RNG, then forces the alternative —
  committed history is never rewritten.
- **Honest numbers**: top-k candidates are raw logits before the sampler
  (softmaxed client-side and labeled as such); unknown values render as `—`,
  never zero; skipped/missing captures render their structured reasons.
- **Speculative decoding**: drafting is part of the execution plan (chosen at
  load). The worker's command loop runs inside
  `with_controlled_chat_speculative`; the UI shows drafted proposals,
  accept/reject/discard dispositions, committed blocks, and acceptance stats.
- **Component analysis** (["Through the Looking Glass: Directly Reading and
  Writing Transformers"](https://arxiv.org/pdf/2609.10210), via eredu's
  component-analysis surface): select any committed token, and the Components
  dock tab decomposes its affine score into signed per-component contributions
  (observed activation × effective write column, measured against the
  trial's own normalization denominator), reconstructed and checked against
  the captured score. From the ranked list you can run causal deletion /
  keep-only mask trials (a fresh exact-prefix replay with `MaskComponents`)
  and install reversible weight overlays that scale or zero a component's
  write column. Everything runs on the idle model by replaying the run's
  exact prefix token ids — session snapshots are never touched, and
  architectures the decomposition cannot represent honestly (whole-residual
  transforms, multi-stream residuals) are refused with the declared reason.
  Smoke: `cargo run -p inspector-engine --features metal --example component_smoke`.

eredu is pinned to rev `3d6fd6da` (main, 2026-09-24). eredu builds on
published crates only, so bumping the pin is: edit the revs in the workspace
`Cargo.toml`, then `cargo update` for the eredu crates.

**Memory.** eredu's generation-memory forecasts (`doc/generation-memory.md`)
are exposed in two places, both through `crates/engine/src/memory.rs` with the
same assumptions as `eredu --memory-report`: the model screen's Overview tab
forecasts a cold load (loading included) for a chosen prompt size and device,
and the composer forecasts exactly the run being composed against the loaded
selection (prompt rendered and tokenized as the run will be, loading peak
excluded, compared with additional memory against observed capacity). A
forecast is a planning estimate — phase peaks, intervals with an explicit
unknown upper end when coverage is missing, the estimator's assumptions and
uncertainties verbatim, and recomputed cheaper alternatives (smaller prefill
chunk, fewer tokens) — never an execution gate. Per run, the composer's Memory
card sets the prefill chunk (`PrefillChunkPolicy`; 0 = one pass); captures,
interventions and speculative runs keep a full pass, and the loaded model
reports whether its executable chunks at all. eredu observes available
memory on macOS, caps an untouched MLX allocator-cache default at 256 MiB when
a model is realized (the load gate can set an explicit limit instead; the cold
card proposes the same value; 0 disables caching), bounds captured runs by
their admitted capture limits, and projects speculative runs with the load's
realized drafter (both models, rollback, verification, lookahead) — so a
verdict needs no inputs on a dense model. An optional memory budget compares
total modeled memory with an application limit as well. While a controlled
run is paused (controlled or speculative), the transport shows eredu's
continuation outlook for the next 64 predictions from the installed cache
frontier (clamped to the run's remaining allowance, inside which eredu
projects capture geometry rather than falling back to admitted ceilings),
next to the live MLX allocator sample (active / peak).
Headless check: `INSPECTOR_CACHE_LIMIT=0 INSPECTOR_MEMORY_BUDGET=2147483648
cargo run -p inspector-engine --features metal --example live_smoke [artifact]`.

Building with the `metal` feature compiles MLX's Metal shaders and needs the
Xcode Metal toolchain component (`xcodebuild -downloadComponent
MetalToolchain`); the `mlx` feature alone builds CPU-only.
