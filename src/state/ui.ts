import { create } from "zustand";

export type DockTab = "alternates" | "signals" | "components" | "edits" | "stats";

interface UiState {
  /** The one global selection every panel keys off. */
  selection?: { runId: string; predictionIndex: number };
  /** The run whose tape is displayed (may be a parked branch). */
  viewedRunId?: string;
  /** Follow the streaming head while nothing is selected. */
  follow: boolean;
  /** Show the composer even while runs exist (the way back to a new prompt). */
  composing: boolean;
  dockTab: DockTab;
  select: (runId: string, predictionIndex: number) => void;
  clearSelection: () => void;
  viewRun: (runId: string) => void;
  openComposer: () => void;
  setDockTab: (tab: DockTab) => void;
}

export const useUi = create<UiState>((set) => ({
  follow: true,
  composing: false,
  dockTab: "alternates",
  select: (runId, predictionIndex) =>
    set({ selection: { runId, predictionIndex }, viewedRunId: runId, follow: false, dockTab: "alternates", composing: false }),
  clearSelection: () => set({ selection: undefined, follow: true }),
  viewRun: (viewedRunId) => set({ viewedRunId, composing: false }),
  openComposer: () => set({ composing: true, selection: undefined, follow: true }),
  setDockTab: (dockTab) => set({ dockTab }),
}));
