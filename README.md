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

eredu is pinned to rev `19069a8cb1ef63088a62747fedf7e1688575c37f`.
