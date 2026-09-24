// Typed invoke wrappers. In a plain browser (vite dev without Tauri) the
// invoke shim throws, letting screens render their empty states.

import { invoke } from "@tauri-apps/api/core";
import { parseLossless } from "./lossless";
import type { MemoryForecast } from "./liveIpc";
import type {
  BackendAvailability,
  CacheSnapshot,
  InspectionBundle,
  JournalPage,
  RunSummary,
  TokenPiece,
} from "./types";

export function inTauri(): boolean {
  return "__TAURI_INTERNALS__" in window;
}

export async function scanModelCache(extraDirs: string[]): Promise<CacheSnapshot> {
  return invoke<CacheSnapshot>("scan_model_cache", { extraDirs });
}

export async function inspectModel(path: string, probeChat: boolean): Promise<InspectionBundle> {
  const json = await invoke<string>("inspect_model", { path, probeChat });
  return parseLossless(json) as InspectionBundle;
}

export async function tokenizePreview(path: string, text: string): Promise<TokenPiece[]> {
  return invoke<TokenPiece[]>("tokenize_preview", { path, text });
}

export async function backendAvailability(): Promise<BackendAvailability> {
  return invoke<BackendAvailability>("backend_availability");
}

export async function listRuns(): Promise<RunSummary[]> {
  return invoke<RunSummary[]>("list_runs");
}

export async function getRunJournal(
  runId: string,
  fromIndex: number,
  limit: number,
): Promise<JournalPage> {
  return invoke<JournalPage>("get_run_journal", { runId, fromIndex, limit });
}

export async function pinRun(runId: string, pinned: boolean): Promise<void> {
  return invoke("pin_run", { runId, pinned });
}

export async function deleteRun(runId: string): Promise<void> {
  return invoke("delete_run", { runId });
}

/** Cold memory forecast (nothing is loaded): loading included, for
 * `inputPositions` prompt positions on the inspector's fully resident plan.
 * Rejected in cold builds (the projection needs the backend's facts). */
export async function estimateModelMemory(
  path: string,
  device: "cpu" | "accelerator",
  inputPositions: number,
  maxOutputTokens: number | undefined,
  prefillChunkTokens: number,
  budgetBytes: number | undefined,
  cacheLimitBytes: number | undefined,
): Promise<MemoryForecast> {
  return invoke<MemoryForecast>("estimate_model_memory", {
    path,
    device,
    inputPositions,
    maxOutputTokens: maxOutputTokens ?? null,
    prefillChunkTokens,
    budgetBytes: budgetBytes ?? null,
    cacheLimitBytes: cacheLimitBytes ?? null,
  });
}
