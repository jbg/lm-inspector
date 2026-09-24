// Typed wrappers for the live (mlx) command surface.

import { Channel, invoke } from "@tauri-apps/api/core";
import type { I64 } from "./lossless";
import type { RunEventEnvelope } from "./types";

export interface LoadPlan {
  device: "cpu" | "accelerator";
  drafting?: Drafting;
  /** Process-global MLX allocator-cache limit applied before loading. Absent =
   * eredu's managed default (an untouched native default capped at 256 MiB). */
  allocatorCacheLimitBytes?: number;
}

export type Drafting =
  | { kind: "disabled" }
  | { kind: "embedded"; maxDraftTokens: number; lookahead: boolean; adaptiveLookahead: boolean }
  | {
      kind: "external";
      modelPath: string;
      maxDraftTokens: number;
      lookahead: boolean;
      adaptiveLookahead: boolean;
    };

export interface LoadedModelInfo {
  modelEpoch: I64;
  artifactPath: string;
  modelLabel: string;
  /** Full HF repo id parsed from the cache path, when available. */
  repoId?: string;
  effectiveModelType: string;
  eosTokenIds: number[];
  /** Why this executable cannot chunk ordinary plain-text prefill (every run
   * then prefills in one pass); absent = bounded prefill chunks work.
   * Captures, interventions, media and speculative runs keep a full pass
   * regardless. */
  prefillChunkingUnsupported?: string;
  /** The process's native allocator-cache limit in force after this load
   * (eredu reads it from MLX); absent only when the query failed. */
  allocatorCacheLimitBytes?: number;
  /** Its provenance; eredu caps an untouched native default at 256 MiB. */
  allocatorCachePolicy?: string;
  /** The tokenizer's special (control) tokens, ascending by id. Raw-text
   * prompts add nothing automatically; the composer offers these to insert. */
  specialTokens: { id: number; text: string }[];
  hasChatTemplate: boolean;
  drafting: string;
  vocabularySize: number;
  chatTemplateKwargs: string[];
  checkpointGenerationConfig?: Record<string, unknown>;
  captureDiscovery: string;
  interventionDiscovery: string;
  speculativeInterventionDiscovery?: string;
  /** Why controlled execution is unavailable for this architecture (probed
   * at load); absent = controlled runs work. */
  controlSupport?: string;
  /** Why observed (free-run) generation is unavailable: it runs the semantic
   * pipeline only, so a chat template with no recognized format can never
   * run observed. Absent = observed runs work. */
  observedSupport?: string;
  /** Judged draft window (max_draft_tokens) when drafting was realized. */
  draftCapacity?: number;
}

export interface StartRunSpec {
  messages: unknown[];
  tools?: unknown[];
  toolChoice?: "auto" | "none" | "required";
  enableThinking?: boolean;
  reasoningEffort?: string;
  mode?: "auto" | "chat" | "text";
  rawText?: string;
  overrides: Record<string, unknown>;
  strategy?: { kind: "standard" } | { kind: "mirostatV2"; tau: number; eta: number };
  seed?: number;
  stops?: string[];
  capture?: unknown;
  intervention?: unknown;
  interventionDraft?: unknown;
  budgets?: Record<string, unknown>;
  createdMs?: number;
  /** "controlled" (fail if unsupported), "observed" (free-run), or absent =
   * controlled with automatic observed fallback. */
  execution?: "controlled" | "observed";
  /** Prefill chunking for this run. Absent = eredu's default (512). */
  inference?: InferencePolicy;
}

export interface InferencePolicy {
  /** Maximum prompt positions per prefill pass; 0 = one complete pass.
   * Only ordinary text runs on chunk-capable executables honor it. */
  prefillChunkPositions?: number;
}

/** eredu's `GenerationMemoryEstimate` plus the engine's summary of it. The
 * estimate rides as verbatim JSON (snake_case, 64-bit safe when parsed with
 * `parseLossless`); see `lib/memory.ts` for its shape and helpers. */
export interface MemoryForecast {
  estimate: string;
  fit: MemoryFit;
  inputPositions: number;
  maxOutputTokens?: number;
  forecastOutputTokens: number;
  requestedChunkTokens: number;
  effectiveChunkTokens: number;
  /** Why the request keeps a complete prefill pass; absent = chunked. */
  fullPass?: string;
  /** Rows one prefill invocation projects. */
  logits: "final_position" | "every_position";
  /** Speculative draft/verification/commit phases were projected. */
  speculative: boolean;
  /** Mid-session outlook: decode-only phases from the installed frontier. */
  continuation: boolean;
  placement: "unified" | "host" | "separate" | "unknown";
  reserveBytes: number;
  /** Application budget the forecast was compared with, when one was set. */
  applicationLimitBytes?: number;
  availableBytes?: number;
  physicalMemoryBytes?: number;
  /** Present for loaded-model forecasts (loading peak excluded). */
  alreadyResidentBytes?: number;
  allocatorCacheLimitBytes?: number;
  /** "native_default" | "managed_default" | "explicit" | "preserved" | "proposed" */
  allocatorCachePolicy?: string;
  allocator?: AllocatorSample;
  recommendations: string[];
  candidates: MemoryCandidate[];
}

/** eredu's snake_case wire spelling of the verdict. */
export type MemoryFit = "likely_fit" | "likely_shortfall" | "insufficient_information";

export interface MemoryCandidate {
  label: string;
  chunkTokens?: number;
  maxOutputTokens?: number;
  domain: string;
  generationPeakUpperBytes: number;
  savingBytes: number;
  fit: MemoryFit;
}

/** Bytes the MLX allocator holds right now: a physical measurement, unlike
 * eredu's logical admission budgets. */
export interface AllocatorSample {
  activeBytes: number;
  cachedBytes: number;
  peakBytes: number;
}

export interface RunStarted {
  runId: string;
  speculative: boolean;
  clampNotes: { field: string; requested: string; clampedTo: string }[];
  capabilities?: string;
  snapshotSupport?: string;
  /** Set on observed-only runs: why controls (step/pause/force/snapshots)
   * are unavailable for this model. */
  controlSupport?: string;
}

export interface RunStatusResult {
  status: string;
  nextPrediction: I64;
  tokenCount: number;
  finishReason?: string;
  allocator?: AllocatorSample;
}

export interface SnapshotMeta {
  snapshotId: string;
  nextPrediction: I64;
  pinned: boolean;
  retainedBytes: I64;
}

export interface TreeStatus {
  activeRun: string;
  snapshots: SnapshotMeta[];
  slots: { slotId: string; parkedRunId: string }[];
  capabilities?: string;
  sampling?: string;
  snapshotUsage?: string;
  emittedBytes: I64;
}

export interface CounterfactualResult {
  childRunId: string;
  slotId: string;
  forkedFromSnapshot: string;
  replayedSteps: I64;
}

export interface SpecStatus {
  status: string;
  runId: string;
  epoch: I64;
  tokenCount: number;
  terminal: boolean;
  allocator?: AllocatorSample;
  snapshotSupport?: string;
}

export interface VocabPage {
  total: number;
  entries: { id: number; text: string }[];
}

// ---------- component analysis ----------
// Engine DTOs are camelCase; verbatim eredu payloads inside them (token
// scores, parameter discovery) keep eredu's snake_case serialization.

export interface CapturedTokenScore {
  target: { token_id: number; score: number; allowed?: boolean };
  log_probability: number;
  rank: I64;
  strongest_alternative?: { token_id: number; score: number } | null;
  [key: string]: unknown;
}

export interface CapturedTokenScores {
  stage: string;
  source: string;
  vocabulary: I64;
  log_partition: number;
  scores: CapturedTokenScore[];
  domain?: { allowed_tokens: I64; vocabulary: I64; constrained: boolean } | null;
  [key: string]: unknown;
}

export interface ComponentContribution {
  group: string;
  nodeId: string;
  layer: number;
  index: number;
  value: number;
  activation: number;
  nested: boolean;
}

export interface GroupAggregate {
  group: string;
  nodeId: string;
  layer: number;
  count: number;
  sum: number;
  sumAbs: number;
  maxAbs: number;
  argmaxIndex: number;
  nested: boolean;
  /** Ranked indices address write rows, not maskable component IDs. */
  axisMismatch: boolean;
}

export interface ScoreDecomposition {
  margin: boolean;
  actual: number;
  reconstructed: number;
  absoluteError: number;
  offset: number;
  projectionInputCorrection: number;
  embedding: number;
  otherWrites: [string, number][];
  biasTerms: number;
  componentCount: number;
  nestedComponents: number;
  nestedComponentSum: number;
  top: ComponentContribution[];
  groups: GroupAggregate[];
}

export interface ComponentAnalysis {
  targetToken: number;
  competitorToken?: number | null;
  tokenScores: CapturedTokenScores;
  outputTransform: { kind: string; [key: string]: unknown };
  /** Measured source precision per component group id, for mask trials. */
  sourceDtypes: Record<string, string>;
  score: ScoreDecomposition;
  margin?: ScoreDecomposition | null;
  parameterUsage: unknown;
}

export interface AnalyzeRequest {
  prefixIds: number[];
  targetToken: number;
  competitorToken?: number;
  topComponents?: number;
}

export interface ComponentMask {
  groupId: string;
  indices: number[];
  keepSelected: boolean;
  /** Measured source precision word from a prior analysis. */
  dtype: string;
  /** "prediction" (last prefix row only, default) or "everywhere". */
  scope?: "prediction" | "everywhere";
}

export interface MaskTrialRequest {
  prefixIds: number[];
  targetToken: number;
  competitorToken?: number;
  masks: ComponentMask[];
  maxNewTokens?: number;
  seed?: number;
}

export interface ComponentTrialResult {
  tokenScores: CapturedTokenScores;
  generated: { id: number; text: string }[];
  status: string;
  failure?: string | null;
}

export interface LoadedParameterInfo {
  id: string;
  shared_id: string;
  shape: I64[];
  dtype?: string | null;
  supported: boolean;
  access?: { query: boolean; projection: boolean; replacement: boolean } | null;
  condition: string;
  input_transform: unknown;
  [key: string]: unknown;
}

export interface ParameterDiscoveryInfo {
  identity: string;
  artifact_identity: string;
  overlay_identity?: string | null;
  parameters: LoadedParameterInfo[];
  usage: Record<string, unknown>;
  [key: string]: unknown;
}

export type ComponentEditAction =
  | { kind: "scale"; factor: number }
  | { kind: "add"; values: number[] }
  | { kind: "replace"; values: number[] };

export interface ComponentEdit {
  groupId: string;
  component: number;
  action: ComponentEditAction;
}

export interface OverlayRequest {
  provenance: string;
  edits: ComponentEdit[];
  rawEdits?: unknown;
}

export interface OverlayResult {
  overlayIdentity?: string | null;
  discovery: ParameterDiscoveryInfo;
}

export function openEventStream(onEnvelope: (env: RunEventEnvelope) => void): Promise<void> {
  const channel = new Channel<RunEventEnvelope>();
  channel.onmessage = onEnvelope;
  return invoke("open_event_stream", { channel });
}

export const live = {
  loadModel: (path: string, plan: LoadPlan) =>
    invoke<LoadedModelInfo>("load_model", { path, plan }),
  unloadModel: () => invoke<void>("unload_model"),
  ackEvents: (modelEpoch: number, envelopeSeq: number) =>
    invoke<void>("ack_events", { modelEpoch, envelopeSeq }),
  getVocabularyPage: (offset: number, limit: number, query?: string) =>
    invoke<VocabPage>("get_vocabulary_page", { offset, limit, query }),
  decodeTokens: (ids: number[], skipSpecial: boolean) =>
    invoke<string>("decode_tokens", { ids, skipSpecial }),
  startRun: (modelEpoch: number, spec: StartRunSpec) =>
    invoke<RunStarted>("start_run", { modelEpoch, spec }),
  stepRun: (modelEpoch: number, steps: number) =>
    invoke<RunStatusResult>("step_run", { modelEpoch, steps }),
  continueRun: (modelEpoch: number) => invoke<RunStatusResult>("continue_run", { modelEpoch }),
  pauseRun: (modelEpoch: number) => invoke<boolean>("pause_run", { modelEpoch }),
  cancelRun: (modelEpoch: number) => invoke<RunStatusResult>("cancel_run", { modelEpoch }),
  forceToken: (modelEpoch: number, tokenId: number) =>
    invoke<void>("force_token", { modelEpoch, tokenId }),
  clearForcedToken: (modelEpoch: number) => invoke<boolean>("clear_forced_token", { modelEpoch }),
  overrideSampling: (modelEpoch: number, temperature?: number, reseed?: number) =>
    invoke<string>("override_sampling", { modelEpoch, temperature, reseed }),
  createSnapshot: (modelEpoch: number, pinned: boolean) =>
    invoke<SnapshotMeta>("create_snapshot", { modelEpoch, pinned }),
  restoreSnapshot: (modelEpoch: number, snapshotId: string) =>
    invoke<RunStatusResult>("restore_snapshot", { modelEpoch, snapshotId }),
  forkBranch: (
    modelEpoch: number,
    snapshotId: string,
    options: { temperature?: number; reseed?: number; intervention?: unknown },
  ) => invoke<string>("fork_branch", { modelEpoch, snapshotId, options }),
  activateBranch: (modelEpoch: number, slotId: string) =>
    invoke<TreeStatus>("activate_branch", { modelEpoch, slotId }),
  releaseSnapshot: (modelEpoch: number, snapshotId: string) =>
    invoke<void>("release_snapshot", { modelEpoch, snapshotId }),
  releaseBranch: (modelEpoch: number, slotId: string) =>
    invoke<void>("release_branch", { modelEpoch, slotId }),
  counterfactual: (
    modelEpoch: number,
    runId: string,
    predictionIndex: number,
    tokenId: number,
    options: {
      temperature?: number;
      reseed?: number;
      intervention?: unknown;
      autoContinue: boolean;
    },
  ) =>
    invoke<CounterfactualResult>("counterfactual_from_step", {
      modelEpoch,
      runId,
      predictionIndex,
      tokenId,
      options,
    }),
  getTreeStatus: (modelEpoch: number) => invoke<TreeStatus>("get_tree_status", { modelEpoch }),
  /** Memory outlook for more predictions from the paused session's state. */
  forecastRemaining: (modelEpoch: number, additionalTokens: number, budgetBytes: number | undefined) =>
    invoke<MemoryForecast>("forecast_remaining", {
      modelEpoch,
      additionalTokens,
      budgetBytes: budgetBytes ?? null,
    }),
  endSession: (modelEpoch: number) => invoke<void>("end_session", { modelEpoch }),
  // speculative
  startSpeculativeRun: (modelEpoch: number, spec: StartRunSpec) =>
    invoke<RunStarted>("start_speculative_run", { modelEpoch, spec }),
  specStep: (modelEpoch: number, actions: number) =>
    invoke<SpecStatus>("spec_step", { modelEpoch, actions }),
  specRun: (modelEpoch: number) => invoke<SpecStatus>("spec_run", { modelEpoch }),
  specPause: (modelEpoch: number) => invoke<void>("spec_pause", { modelEpoch }),
  specForceToken: (modelEpoch: number, tokenId: number) =>
    invoke<void>("spec_force_token", { modelEpoch, tokenId }),
  specClearForced: (modelEpoch: number) => invoke<boolean>("spec_clear_forced", { modelEpoch }),
  specOverrideSampling: (modelEpoch: number, temperature?: number, reseed?: number) =>
    invoke<string>("spec_override_sampling", { modelEpoch, temperature, reseed }),
  specSnapshot: (modelEpoch: number) => invoke<string>("spec_snapshot", { modelEpoch }),
  specRestore: (modelEpoch: number, snapshotId: string) =>
    invoke<SpecStatus>("spec_restore", { modelEpoch, snapshotId }),
  specFork: (modelEpoch: number, snapshotId: string) =>
    invoke<string>("spec_fork", { modelEpoch, snapshotId }),
  specExchange: (modelEpoch: number, branchId: string) =>
    invoke<SpecStatus>("spec_exchange", { modelEpoch, branchId }),
  specSnapshotSupport: (modelEpoch: number) =>
    invoke<string>("spec_snapshot_support", { modelEpoch }),
  endSpeculativeRun: (modelEpoch: number) => invoke<void>("end_speculative_run", { modelEpoch }),
  /** Memory outlook for a settled speculative lane (after prefill or a commit). */
  specForecastRemaining: (modelEpoch: number, additionalTokens: number, budgetBytes: number | undefined) =>
    invoke<MemoryForecast>("spec_forecast_remaining", {
      modelEpoch,
      additionalTokens,
      budgetBytes: budgetBytes ?? null,
    }),
  // component analysis (idle model only; SessionActive while a run is live)
  getParameterDiscovery: async (modelEpoch: number) =>
    JSON.parse(await invoke<string>("get_parameter_discovery", { modelEpoch })) as ParameterDiscoveryInfo,
  componentAnalyze: async (modelEpoch: number, req: AnalyzeRequest) =>
    JSON.parse(await invoke<string>("component_analyze", { modelEpoch, req })) as ComponentAnalysis,
  componentMaskTrial: async (modelEpoch: number, req: MaskTrialRequest) =>
    JSON.parse(await invoke<string>("component_mask_trial", { modelEpoch, req })) as ComponentTrialResult,
  queryParameter: async (
    modelEpoch: number,
    req: { parameter: string; starts: number[]; shape: number[] },
  ) => JSON.parse(await invoke<string>("query_parameter", { modelEpoch, req })) as {
    values: number[];
    [key: string]: unknown;
  },
  installParameterOverlay: async (modelEpoch: number, req: OverlayRequest) =>
    JSON.parse(await invoke<string>("install_parameter_overlay", { modelEpoch, req })) as OverlayResult,
  removeParameterOverlay: async (modelEpoch: number) =>
    JSON.parse(await invoke<string>("remove_parameter_overlay", { modelEpoch })) as OverlayResult,
  /** Memory forecast for a run spec against the loaded selection (idle model
   * only; SessionActive while a run is live). */
  forecastRunMemory: (
    modelEpoch: number,
    spec: StartRunSpec,
    speculative: boolean,
    budgetBytes: number | undefined,
  ) =>
    invoke<MemoryForecast>("forecast_run_memory", {
      modelEpoch,
      spec,
      speculative,
      budgetBytes: budgetBytes ?? null,
    }),
};
