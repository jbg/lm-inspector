// Live session state: the loaded model, load progress, the active tree, and
// transport status. Journal contents live outside (state/journal).

import { create } from "zustand";
import { i64ToNumber } from "../lib/lossless";
import { ipcErrorMessage } from "../lib/types";
import { usePlans } from "./plans";
import {
  live,
  type AllocatorSample,
  type Drafting,
  type MemoryForecast,
  type LoadedModelInfo,
  type RunStarted,
  type StartRunSpec,
  type TreeStatus,
} from "../lib/liveIpc";
import { ensureEventStream } from "../lib/channel";
import { backendAvailability } from "../lib/ipc";

export type LoadState =
  | { phase: "none" }
  | { phase: "loading"; stage: string; path: string }
  | { phase: "loaded"; info: LoadedModelInfo }
  | { phase: "error"; message: string; path: string };

export interface ObservationPointInfo {
  path: string;
  node_id?: string;
  dtype?: string;
  prefill?: unknown;
  decode?: unknown;
  axes?: { name: string }[];
  [key: string]: unknown;
}

interface SessionState {
  load: LoadState;
  modelEpoch: number;
  /** Parsed capture/intervention discovery (from LoadedModelInfo JSON). */
  captureDiscovery?: { catalog?: { points?: ObservationPointInfo[] }; support?: unknown };
  interventionDiscovery?: { points?: Record<string, unknown>[] };
  specInterventionDiscovery?: { points?: Record<string, unknown>[] };
  /** Active run/tree. */
  activeRunId?: string;
  speculative: boolean;
  runStarted?: RunStarted;
  /** Reason the active run has no controls (observed-only fallback). */
  observedOnly?: string;
  transport: { status: string; busy: boolean; finishReason?: string };
  /** Latest MLX allocator sample, refreshed with every status result. */
  allocator?: AllocatorSample;
  /** Mid-session memory outlook, refreshed whenever a run pauses. */
  outlook?: MemoryForecast;
  /** Committed tokens per the latest status result (for the outlook horizon). */
  tokenCount?: number;
  tree?: TreeStatus;
  pendingForcedToken?: number;
  notices: string[];
  specFinished: boolean;

  setLoadStage: (stage: string) => void;
  setObservedFinished: (status: string, message?: string) => void;
  pushNotice: (message: string) => void;
  setSpecFinished: () => void;
  dismissNotice: (index: number) => void;

  loadModel: (
    path: string,
    device: "cpu" | "accelerator",
    drafting?: Drafting,
    allocatorCacheLimitBytes?: number,
  ) => Promise<boolean>;
  unloadModel: () => Promise<void>;
  startRun: (spec: StartRunSpec, speculative: boolean) => Promise<RunStarted | undefined>;
  refreshTree: () => Promise<void>;
  /** Forecast memory for more predictions from the paused session. */
  refreshOutlook: (additionalTokens: number, budgetBytes?: number) => Promise<void>;
  step: (steps: number) => Promise<void>;
  run: () => Promise<void>;
  pause: () => Promise<void>;
  cancel: () => Promise<void>;
  forceHead: (tokenId: number) => Promise<void>;
  clearForced: () => Promise<void>;
  overrideSampling: (temperature?: number, reseed?: number) => Promise<void>;
  pinSnapshot: () => Promise<void>;
  counterfactual: (
    runId: string,
    predictionIndex: number,
    tokenId: number,
    options: { temperature?: number; reseed?: number; intervention?: unknown; autoContinue: boolean },
  ) => Promise<string | undefined>;
  activateBranch: (slotId: string) => Promise<void>;
  restoreSnapshot: (snapshotId: string) => Promise<void>;
  endSession: () => Promise<void>;
}

function parseJson<T>(json: string | undefined): T | undefined {
  if (!json) return undefined;
  try {
    return JSON.parse(json) as T;
  } catch {
    return undefined;
  }
}

/** Horizon of the transport's memory outlook. */
export const OUTLOOK_TOKENS = 64;

export const useSession = create<SessionState>((set, get) => {
  const epoch = () => get().modelEpoch;
  const spec = () => get().speculative;

  const guard = async <T>(op: () => Promise<T>): Promise<T | undefined> => {
    try {
      return await op();
    } catch (e) {
      get().pushNotice(ipcErrorMessage(e));
      return undefined;
    }
  };

  const applyStatus = (status?: {
    status: string;
    finishReason?: string;
    allocator?: AllocatorSample;
    tokenCount?: number;
  }) => {
    if (status) {
      set((s) => ({
        transport: {
          status: status.status,
          busy: status.status === "running",
          finishReason: status.finishReason,
        },
        allocator: status.allocator ?? s.allocator,
        tokenCount: status.tokenCount ?? s.tokenCount,
      }));
    }
  };

  // Outlook horizon: OUTLOOK_TOKENS, clamped to the run's remaining token
  // allowance. eredu projects capture geometry only inside the admitted
  // range; a horizon past the run's limit falls back to the admitted
  // capture ceilings and reads far more pessimistic than the run can be.
  const outlookHorizon = () => {
    const state = get();
    const plans = usePlans.getState();
    const checkpoint =
      state.load.phase === "loaded" ? state.load.info.checkpointGenerationConfig : undefined;
    const checkpointLimit = Number(checkpoint?.max_new_tokens);
    const limit =
      plans.sampling.maxNewTokens ?? (Number.isFinite(checkpointLimit) ? checkpointLimit : 256);
    const remaining = limit - (state.tokenCount ?? 0);
    return Math.max(1, Math.min(OUTLOOK_TOKENS, Math.floor(remaining)));
  };

  return {
    load: { phase: "none" },
    modelEpoch: 0,
    speculative: false,
    transport: { status: "idle", busy: false },
    notices: [],
    specFinished: false,

    setLoadStage: (stage) =>
      set((s) =>
        s.load.phase === "loading" ? { load: { ...s.load, stage } } : s,
      ),
    pushNotice: (message) => set((s) => ({ notices: [...s.notices.slice(-4), message] })),
    setSpecFinished: () => set({ specFinished: true, transport: { status: "completed", busy: false } }),
    setObservedFinished: (status, message) => {
      if (message) get().pushNotice(`run ${status}: ${message}`);
      set({ transport: { status, busy: false } });
    },
    dismissNotice: (index) =>
      set((s) => ({ notices: s.notices.filter((_, i) => i !== index) })),

    loadModel: async (path, device, drafting, allocatorCacheLimitBytes) => {
      // Preflight: a cold build has no live commands at all — say so plainly
      // instead of surfacing "Command load_model not found".
      try {
        const availability = await backendAvailability();
        if (!availability.live) {
          set({
            load: {
              phase: "error",
              message:
                "this build has no live backend — it can inspect but not generate. Relaunch with: npm run app (tauri dev --features metal)",
              path,
            },
          });
          return false;
        }
      } catch {
        // If the probe itself fails we fall through; load_model will report.
      }
      await ensureEventStream();
      set({ load: { phase: "loading", stage: "requesting", path } });
      try {
        const info = await live.loadModel(path, { device, drafting, allocatorCacheLimitBytes });
        set({
          load: { phase: "loaded", info },
          modelEpoch: i64ToNumber(info.modelEpoch),
          captureDiscovery: parseJson(info.captureDiscovery),
          interventionDiscovery: parseJson(info.interventionDiscovery),
          specInterventionDiscovery: parseJson(info.speculativeInterventionDiscovery),
          activeRunId: undefined,
          runStarted: undefined,
          tree: undefined,
          transport: { status: "idle", busy: false },
        });
        return true;
      } catch (e) {
        set({ load: { phase: "error", message: ipcErrorMessage(e), path } });
        return false;
      }
    },

    unloadModel: async () => {
      await guard(() => live.unloadModel());
      set({
        load: { phase: "none" },
        activeRunId: undefined,
        runStarted: undefined,
        tree: undefined,
        transport: { status: "idle", busy: false },
      });
    },

    startRun: async (runSpec, speculative) => {
      set({ specFinished: false });
      const started = await guard(() =>
        speculative
          ? live.startSpeculativeRun(epoch(), runSpec)
          : live.startRun(epoch(), runSpec),
      );
      if (started) {
        set({
          activeRunId: started.runId,
          outlook: undefined,
          speculative,
          runStarted: started,
          observedOnly: started.controlSupport,
          // Observed-only runs are already generating when the reply lands.
          transport: started.controlSupport
            ? { status: "running", busy: true }
            : { status: "prepared", busy: false },
        });
        for (const note of started.clampNotes) {
          get().pushNotice(`clamped ${note.field}: ${note.requested} → ${note.clampedTo}`);
        }
        if (!started.controlSupport) void get().refreshTree();
      }
      return started;
    },

    refreshTree: async () => {
      if (spec()) return; // tree status is a controlled-session surface
      const tree = await guard(() => live.getTreeStatus(epoch()));
      if (tree) {
        set({ tree, activeRunId: tree.activeRun });
      }
    },

    refreshOutlook: async (additionalTokens, budgetBytes) => {
      // Continuation forecasts need a paused, advanced session at a settled
      // boundary (controlled: a decode boundary; speculative: after prefill
      // or a canonical commit). Observed, prepared and terminal runs have none;
      // a mid-transaction speculative boundary is rejected and shows nothing.
      if (get().observedOnly || get().transport.status !== "paused") {
        set({ outlook: undefined });
        return;
      }
      try {
        const outlook = spec()
          ? await live.specForecastRemaining(epoch(), additionalTokens, budgetBytes)
          : await live.forecastRemaining(epoch(), additionalTokens, budgetBytes);
        set({ outlook });
      } catch {
        set({ outlook: undefined });
      }
    },

    step: async (steps) => {
      if (spec()) {
        const status = await guard(() => live.specStep(epoch(), steps));
        if (status)
          applyStatus({
            status: status.terminal ? "completed" : "paused",
            allocator: status.allocator,
            tokenCount: status.tokenCount,
          });
        void get().refreshOutlook(outlookHorizon());
        return;
      }
      applyStatus(await guard(() => live.stepRun(epoch(), steps)));
      void get().refreshTree();
      void get().refreshOutlook(outlookHorizon());
    },

    run: async () => {
      set((s) => ({ transport: { ...s.transport, status: "running", busy: true } }));
      if (spec()) {
        const status = await guard(() => live.specRun(epoch()));
        if (status)
          applyStatus({
            status: status.terminal ? "completed" : "paused",
            allocator: status.allocator,
            tokenCount: status.tokenCount,
          });
        void get().refreshOutlook(outlookHorizon());
        return;
      }
      applyStatus(await guard(() => live.continueRun(epoch())));
      void get().refreshTree();
      void get().refreshOutlook(outlookHorizon());
    },

    pause: async () => {
      if (spec()) {
        await guard(() => live.specPause(epoch()));
        return;
      }
      await guard(() => live.pauseRun(epoch()));
    },

    cancel: async () => {
      applyStatus(await guard(() => live.cancelRun(epoch())));
    },

    forceHead: async (tokenId) => {
      const op = spec()
        ? () => live.specForceToken(epoch(), tokenId)
        : () => live.forceToken(epoch(), tokenId);
      const ok = await guard(op);
      if (ok !== undefined) set({ pendingForcedToken: tokenId });
    },

    clearForced: async () => {
      const op = spec()
        ? () => live.specClearForced(epoch())
        : () => live.clearForcedToken(epoch());
      await guard(op);
      set({ pendingForcedToken: undefined });
    },

    overrideSampling: async (temperature, reseed) => {
      const op = spec()
        ? () => live.specOverrideSampling(epoch(), temperature, reseed)
        : () => live.overrideSampling(epoch(), temperature, reseed);
      await guard(op);
    },

    pinSnapshot: async () => {
      if (spec()) {
        await guard(() => live.specSnapshot(epoch()));
        return;
      }
      await guard(() => live.createSnapshot(epoch(), true));
      void get().refreshTree();
    },

    counterfactual: async (runId, predictionIndex, tokenId, options) => {
      const result = await guard(() =>
        live.counterfactual(epoch(), runId, predictionIndex, tokenId, options),
      );
      if (result) {
        set({ activeRunId: result.childRunId });
        void get().refreshTree();
        return result.childRunId;
      }
      return undefined;
    },

    activateBranch: async (slotId) => {
      const tree = await guard(() => live.activateBranch(epoch(), slotId));
      if (tree) set({ tree, activeRunId: tree.activeRun });
    },

    restoreSnapshot: async (snapshotId) => {
      applyStatus(await guard(() => live.restoreSnapshot(epoch(), snapshotId)));
      void get().refreshTree();
    },

    endSession: async () => {
      const op = spec() ? () => live.endSpeculativeRun(epoch()) : () => live.endSession(epoch());
      await guard(op);
      set({
        activeRunId: undefined,
        runStarted: undefined,
        tree: undefined,
        transport: { status: "idle", busy: false },
      });
    },
  };
});
