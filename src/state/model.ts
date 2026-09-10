import { create } from "zustand";
import { inspectModel } from "../lib/ipc";
import { ipcErrorMessage } from "../lib/types";
import type { InspectionBundle } from "../lib/types";

interface InspectionEntry {
  bundle?: InspectionBundle;
  loading: boolean;
  error?: string;
}

interface ModelState {
  /** Cold inspections cached by artifact path. */
  inspections: Record<string, InspectionEntry>;
  inspect: (path: string) => Promise<void>;
}

export const useModel = create<ModelState>((set, get) => ({
  inspections: {},
  inspect: async (path) => {
    const existing = get().inspections[path];
    if (existing && (existing.loading || existing.bundle)) return;
    set((s) => ({ inspections: { ...s.inspections, [path]: { loading: true } } }));
    try {
      const bundle = await inspectModel(path, true);
      set((s) => ({ inspections: { ...s.inspections, [path]: { bundle, loading: false } } }));
    } catch (e) {
      set((s) => ({
        inspections: { ...s.inspections, [path]: { loading: false, error: ipcErrorMessage(e) } },
      }));
    }
  },
}));
