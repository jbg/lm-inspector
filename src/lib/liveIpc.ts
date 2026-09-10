// Typed wrappers for the live (mlx) command surface.

import { Channel, invoke } from "@tauri-apps/api/core";
import type { I64 } from "./lossless";
import type { RunEventEnvelope } from "./types";

export interface LoadPlan {
  device: "cpu" | "accelerator";
  drafting?: Drafting;
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
  effectiveModelType: string;
  eosTokenIds: number[];
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
  snapshotSupport?: string;
}

export interface VocabPage {
  total: number;
  entries: { id: number; text: string }[];
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
};
