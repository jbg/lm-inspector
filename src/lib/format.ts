import { type I64, i64ToNumber, i64ToString } from "./lossless";

/** "—" is the app-wide glyph for unknown. Unknown is never rendered as 0. */
export const UNKNOWN = "—";

export function formatBytes(v: I64 | undefined | null): string {
  if (v === undefined || v === null) return UNKNOWN;
  const n = i64ToNumber(v);
  if (!Number.isFinite(n)) return i64ToString(v);
  if (n < 1024) return `${n} B`;
  const units = ["KIB", "MIB", "GIB", "TIB"];
  let x = n / 1024;
  let u = 0;
  while (x >= 1024 && u < units.length - 1) {
    x /= 1024;
    u++;
  }
  return `${x >= 100 ? x.toFixed(0) : x >= 10 ? x.toFixed(1) : x.toFixed(2)} ${units[u]}`;
}

export function formatCount(v: I64 | undefined | null): string {
  if (v === undefined || v === null) return UNKNOWN;
  const s = i64ToString(v);
  // Group thousands without locale surprises.
  return s.replace(/\B(?=(\d{3})+(?!\d))/g, " ");
}

export function formatMs(ms: number | undefined | null): string {
  if (ms === undefined || ms === null || !Number.isFinite(ms)) return UNKNOWN;
  if (ms < 1000) return `${Math.round(ms)} MS`;
  return `${(ms / 1000).toFixed(2)} S`;
}

export function formatDateMs(v: I64 | undefined | null): string {
  if (v === undefined || v === null) return UNKNOWN;
  const n = i64ToNumber(v);
  if (n <= 0) return UNKNOWN;
  const d = new Date(n);
  const pad = (x: number) => String(x).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function formatPercent(x: number | undefined | null, digits = 1): string {
  if (x === undefined || x === null || !Number.isFinite(x)) return UNKNOWN;
  return `${(x * 100).toFixed(digits)}%`;
}

/** Conventional display name for an artifact format wire value
 * ("safe_tensors" → "safetensors", "gguf" → "GGUF"). */
export function formatArtifactFormat(wire: string): string {
  if (wire === "safe_tensors" || wire === "safeTensors") return "safetensors";
  if (wire === "gguf") return "GGUF";
  return wire;
}

/** Short display name from a repo id, in its original case:
 * "Qwen/Qwen3-4B-Instruct" -> "Qwen3-4B-Instruct". */
export function repoDisplayName(repoId: string): string {
  return repoId.split("/").pop() || repoId;
}
