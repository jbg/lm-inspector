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
  /** Extra HF cache roots (e.g. a second cache on an external drive). */
  extraDirs: string[];
  refresh: () => Promise<void>;
  addCacheDir: (dir: string) => Promise<void>;
  removeCacheDir: (dir: string) => Promise<void>;
  setSearch: (s: string) => void;
  setFormatFilter: (f: "" | "safeTensors" | "gguf") => void;
  setSort: (s: "recent" | "size" | "name") => void;
}

const EXTRA_DIRS_KEY = "lm-inspector.extra-cache-dirs";

function loadExtraDirs(): string[] {
  try {
    const raw = localStorage.getItem(EXTRA_DIRS_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(parsed) ? parsed.filter((d): d is string => typeof d === "string") : [];
  } catch {
    return [];
  }
}

function saveExtraDirs(dirs: string[]): void {
  try {
    localStorage.setItem(EXTRA_DIRS_KEY, JSON.stringify(dirs));
  } catch {
    // Persistence is best-effort.
  }
}

export const useLibrary = create<LibraryState>((set, get) => ({
  snapshot: undefined,
  loading: false,
  error: undefined,
  search: "",
  formatFilter: "",
  sort: "name",
  extraDirs: loadExtraDirs(),
  refresh: async () => {
    if (!inTauri()) {
      set({ error: "not running inside Tauri — no cache access", loading: false });
      return;
    }
    set({ loading: true, error: undefined });
    try {
      const snapshot = await scanModelCache(get().extraDirs);
      set({ snapshot, loading: false });
    } catch (e) {
      set({ error: ipcErrorMessage(e), loading: false });
    }
  },
  addCacheDir: async (dir) => {
    const trimmed = dir.trim();
    if (!trimmed || get().extraDirs.includes(trimmed)) return;
    const extraDirs = [...get().extraDirs, trimmed];
    saveExtraDirs(extraDirs);
    set({ extraDirs });
    await get().refresh();
  },
  removeCacheDir: async (dir) => {
    const extraDirs = get().extraDirs.filter((d) => d !== dir);
    saveExtraDirs(extraDirs);
    set({ extraDirs });
    await get().refresh();
  },
  setSearch: (search) => set({ search }),
  setFormatFilter: (formatFilter) => set({ formatFilter }),
  setSort: (sort) => set({ sort }),
}));
