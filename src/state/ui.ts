import { create } from "zustand";

export type DockTab = "alternates" | "signals" | "edits" | "stats";

interface UiState {
  /** The one global selection every panel keys off. */
  selection?: { runId: string; predictionIndex: number };
  /** The run whose tape is displayed (may be a parked branch). */
  viewedRunId?: string;
  /** Follow the streaming head while nothing is selected. */
  follow: boolean;
  dockTab: DockTab;
  select: (runId: string, predictionIndex: number) => void;
  clearSelection: () => void;
  viewRun: (runId: string) => void;
  setDockTab: (tab: DockTab) => void;
}

export const useUi = create<UiState>((set) => ({
  follow: true,
  dockTab: "alternates",
  select: (runId, predictionIndex) =>
    set({ selection: { runId, predictionIndex }, viewedRunId: runId, follow: false, dockTab: "alternates" }),
  clearSelection: () => set({ selection: undefined, follow: true }),
  viewRun: (viewedRunId) => set({ viewedRunId }),
  setDockTab: (dockTab) => set({ dockTab }),
}));
