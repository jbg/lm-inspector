import { create } from "zustand";
import { inTauri, scanModelCache } from "../lib/ipc";
import { ipcErrorMessage } from "../lib/types";
import type { CacheSnapshot } from "../lib/types";

interface LibraryState {
  snapshot?: CacheSnapshot;
  loading: boolean;
  error?: string;
  search: string;
  formatFilter: "" | "safeTensors" | "gguf";
  sort: "recent" | "size" | "name";
  refresh: () => Promise<void>;
  setSearch: (s: string) => void;
  setFormatFilter: (f: "" | "safeTensors" | "gguf") => void;
  setSort: (s: "recent" | "size" | "name") => void;
}

export const useLibrary = create<LibraryState>((set) => ({
  snapshot: undefined,
  loading: false,
  error: undefined,
  search: "",
  formatFilter: "",
  sort: "name",
  refresh: async () => {
    if (!inTauri()) {
      set({ error: "not running inside Tauri — no cache access", loading: false });
      return;
    }
    set({ loading: true, error: undefined });
    try {
      const snapshot = await scanModelCache();
      set({ snapshot, loading: false });
    } catch (e) {
      set({ error: ipcErrorMessage(e), loading: false });
    }
  },
  setSearch: (search) => set({ search }),
  setFormatFilter: (formatFilter) => set({ formatFilter }),
  setSort: (sort) => set({ sort }),
}));
