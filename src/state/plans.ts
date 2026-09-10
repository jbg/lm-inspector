// Composer state: prompt, sampling, capture recipes, interventions, drafting.
// Builds the StartRunSpec the backend admits (eredu is the authority).

import { create } from "zustand";
import type { Drafting, StartRunSpec } from "../lib/liveIpc";

export interface MessageDraft {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface SamplingDraft {
  temperature?: number;
  topK?: number;
  topP?: number;
  minP?: number;
  repetitionPenalty?: number;
  maxNewTokens?: number;
  seed: number;
  strategy: "standard" | "mirostatV2";
  tau: number;
  eta: number;
}

export interface CaptureRecipeState {
  topK: { enabled: boolean; count: number };
  layerTrajectory: { enabled: boolean; every: number };
  histogram: { enabled: boolean; path?: string; bins: number; lo: number; hi: number };
  moeRouting: { enabled: boolean };
  custom: CustomSelection[];
}

export interface CustomSelection {
  id: string;
  path: string;
  transform: "summary" | "preview" | "histogram" | "topCandidates" | "fullTensor";
  param: number;
  prefill: boolean;
  decode: boolean;
  every: number;
}

export interface InterventionDraft {
  id: string;
  target: string;
  action:
    | { kind: "zero"; dtype: string }
    | { kind: "scale"; dtype: string; factor: number }
    | { kind: "maskLogits"; dtype: string; tokenIds: number[] };
  every: number;
  evidence: "none" | "preview" | "summary";
}

interface PlansState {
  /** Artifact chosen in the Library for loading in the Lab. */
  targetArtifact?: { path: string; label: string };
  messages: MessageDraft[];
  rawText: string;
  textMode: boolean;
  /** Session mode: controlled (step/force/branch) or observed (free-run). */
  execution: "controlled" | "observed";
  /** Tool declarations as JSON source text (edited raw, parsed at start). */
  toolsJson: string;
  toolChoice: "auto" | "none" | "required";
  enableThinking?: boolean;
  sampling: SamplingDraft;
  capture: CaptureRecipeState;
  interventions: InterventionDraft[];
  device: "cpu" | "accelerator";
  drafting: Drafting;

  setMessages: (messages: MessageDraft[]) => void;
  setRawText: (text: string) => void;
  setTextMode: (on: boolean) => void;
  setExecution: (execution: "controlled" | "observed") => void;
  setToolsJson: (json: string) => void;
  setToolChoice: (choice: "auto" | "none" | "required") => void;
  setThinking: (on: boolean | undefined) => void;
  setSampling: (patch: Partial<SamplingDraft>) => void;
  setCapture: (patch: Partial<CaptureRecipeState>) => void;
  setInterventions: (list: InterventionDraft[]) => void;
  setDevice: (device: "cpu" | "accelerator") => void;
  setDrafting: (drafting: Drafting) => void;
  setTargetArtifact: (target?: { path: string; label: string }) => void;
}

export const usePlans = create<PlansState>((set) => ({
  messages: [{ role: "user", content: "" }],
  rawText: "",
  textMode: false,
  execution: "controlled" as const,
  toolsJson: "",
  toolChoice: "auto",
  enableThinking: undefined,
  // Sampling fields start unset: eredu resolves unset overrides from the
  // checkpoint's generation_config. Only the seed is ours (request-level;
  // checkpoints carry no seed).
  sampling: {
    seed: 42,
    strategy: "standard",
    tau: 5,
    eta: 0.1,
  },
  capture: {
    topK: { enabled: true, count: 16 },
    layerTrajectory: { enabled: false, every: 1 },
    histogram: { enabled: false, bins: 32, lo: -20, hi: 20 },
    moeRouting: { enabled: false },
    custom: [],
  },
  interventions: [],
  device: "accelerator",
  drafting: { kind: "disabled" },

  setMessages: (messages) => set({ messages }),
  setRawText: (rawText) => set({ rawText }),
  setTextMode: (textMode) => set({ textMode }),
  setExecution: (execution) => set({ execution }),
  setToolsJson: (toolsJson) => set({ toolsJson }),
  setToolChoice: (toolChoice) => set({ toolChoice }),
  setThinking: (enableThinking) => set({ enableThinking }),
  setSampling: (patch) => set((s) => ({ sampling: { ...s.sampling, ...patch } })),
  setCapture: (patch) => set((s) => ({ capture: { ...s.capture, ...patch } })),
  setInterventions: (interventions) => set({ interventions }),
  setDevice: (device) => set({ device }),
  setDrafting: (drafting) => set({ drafting }),
  setTargetArtifact: (targetArtifact) => set({ targetArtifact }),
}));

// ---- spec building ----

/** Parse the tools editor. Empty text = no tools. */
export function parseTools(toolsJson: string): { tools: unknown[]; error?: string } {
  const trimmed = toolsJson.trim();
  if (!trimmed) return { tools: [] };
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    const tools = Array.isArray(parsed) ? parsed : [parsed];
    if (!tools.every((t) => typeof t === "object" && t !== null)) {
      return { tools: [], error: "tools must be JSON objects" };
    }
    return { tools };
  } catch (e) {
    return { tools: [], error: e instanceof Error ? e.message : String(e) };
  }
}

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;

function captureUsage(captures: number, retained: number, host: number, encoded: number) {
  return { captures, retained_bytes: retained, host_bytes: host, encoded_bytes: encoded };
}

export function buildCapturePlan(
  capture: CaptureRecipeState,
  layerOutputPaths: string[],
  routingPaths: string[],
  speculative: boolean,
): unknown {
  const selections: unknown[] = [];
  const schedule = (every: number, prefill = false) => ({
    prefill,
    decode: true,
    first_prediction: 0,
    end_prediction: null,
    every,
  });
  if (capture.topK.enabled) {
    selections.push({
      id: "inspector-topk",
      path: "model.logits",
      schedule: schedule(1),
      slices: [],
      transform: { kind: "top_candidates", count: capture.topK.count },
    });
  }
  if (!speculative) {
    if (capture.layerTrajectory.enabled) {
      for (const path of layerOutputPaths) {
        selections.push({
          id: `traj-${path}`,
          path,
          schedule: schedule(capture.layerTrajectory.every),
          slices: [],
          transform: { kind: "summary" },
        });
      }
    }
    if (capture.histogram.enabled && capture.histogram.path) {
      const { bins, lo, hi } = capture.histogram;
      const edges = Array.from({ length: bins + 1 }, (_, i) => lo + ((hi - lo) * i) / bins);
      selections.push({
        id: "histogram",
        path: capture.histogram.path,
        schedule: schedule(1),
        slices: [],
        transform: { kind: "histogram", edges },
      });
    }
    if (capture.moeRouting.enabled) {
      for (const path of routingPaths) {
        selections.push({
          id: `routing-${path}`,
          path,
          schedule: schedule(1),
          slices: [],
          transform: { kind: "full_tensor" },
        });
      }
    }
    for (const c of capture.custom) {
      const transform =
        c.transform === "summary"
          ? { kind: "summary" }
          : c.transform === "fullTensor"
            ? { kind: "full_tensor" }
            : c.transform === "preview"
              ? { kind: "preview", max_elements: c.param }
              : c.transform === "topCandidates"
                ? { kind: "top_candidates", count: c.param }
                : { kind: "histogram", edges: Array.from({ length: 33 }, (_, i) => -20 + (40 * i) / 32) };
      selections.push({
        id: c.id,
        path: c.path,
        schedule: { prefill: c.prefill, decode: c.decode, first_prediction: 0, end_prediction: null, every: c.every },
        slices: [],
        transform,
      });
    }
  }
  if (selections.length === 0) return undefined;
  return {
    schema_version: 1,
    selections,
    limits: {
      per_step: captureUsage(32, 32 * MIB, 8 * MIB, 2 * MIB),
      cumulative: captureUsage(8192, 2 * GIB, 512 * MIB, 96 * MIB),
      physical_native_bytes: null,
      on_limit: "skip",
    },
  };
}

export function buildInterventionPlan(list: InterventionDraft[]): unknown {
  if (list.length === 0) return undefined;
  return {
    schema_version: 1,
    operations: list.map((op) => ({
      id: op.id,
      target: op.target,
      schedule: { prefill: false, decode: true, first_prediction: 0, end_prediction: null, every: op.every },
      slices: [],
      action:
        op.action.kind === "zero"
          ? { kind: "zero", dtype: op.action.dtype }
          : op.action.kind === "scale"
            ? { kind: "scale", dtype: op.action.dtype, factor: op.action.factor }
            : { kind: "mask_logits", dtype: op.action.dtype, token_ids: op.action.tokenIds },
      evidence:
        op.evidence === "none"
          ? { kind: "none" }
          : op.evidence === "preview"
            ? { kind: "preview", max_elements: 32 }
            : { kind: "summary" },
    })),
  };
}

export function buildStartSpec(
  state: Pick<
    PlansState,
    | "messages"
    | "rawText"
    | "textMode"
    | "execution"
    | "toolsJson"
    | "toolChoice"
    | "enableThinking"
    | "sampling"
    | "capture"
    | "interventions"
  >,
  layerOutputPaths: string[],
  routingPaths: string[],
  speculative: boolean,
): StartRunSpec {
  const s = state.sampling;
  const overrides: Record<string, unknown> = {};
  if (s.temperature !== undefined) overrides.temperature = s.temperature;
  if (s.topK !== undefined) overrides.top_k = s.topK;
  if (s.topP !== undefined) overrides.top_p = s.topP;
  if (s.minP !== undefined) overrides.min_p = s.minP;
  if (s.repetitionPenalty !== undefined) overrides.repetition_penalty = s.repetitionPenalty;
  if (s.maxNewTokens !== undefined) overrides.max_new_tokens = s.maxNewTokens;
  // Only steer do_sample when the user explicitly chose a temperature;
  // otherwise the checkpoint's own configuration governs.
  if (s.temperature !== undefined && s.temperature > 0) overrides.do_sample = true;

  const { tools } = parseTools(state.toolsJson);
  return {
    messages: state.textMode
      ? []
      : state.messages
          .filter((m) => m.content.trim().length > 0)
          .map((m) => ({ role: m.role, content: m.content })),
    // Text admission rejects tool declarations, so tools only ride chat mode.
    tools: state.textMode ? [] : tools,
    toolChoice: !state.textMode && tools.length > 0 ? state.toolChoice : undefined,
    mode: state.textMode ? "text" : "auto",
    rawText: state.textMode ? state.rawText : undefined,
    enableThinking: state.enableThinking,
    overrides,
    strategy:
      s.strategy === "mirostatV2"
        ? { kind: "mirostatV2", tau: s.tau, eta: s.eta }
        : { kind: "standard" },
    seed: s.seed,
    stops: [],
    capture: buildCapturePlan(state.capture, layerOutputPaths, routingPaths, speculative),
    intervention: buildInterventionPlan(state.interventions),
    createdMs: Date.now(),
    // Speculative runs have their own session shape; the choice rides
    // controlled starts only.
    execution: speculative ? undefined : state.execution,
  };
}
