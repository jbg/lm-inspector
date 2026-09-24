// eredu's `GenerationMemoryEstimate` as it arrives inside a MemoryForecast
// (snake_case, parsed losslessly), plus the small helpers the views share.
// Intervals are planning estimates: a missing upper end means coverage is
// unavailable, never zero.

import type { I64 } from "./lossless";
import { i64ToNumber, parseLossless } from "./lossless";
import { formatBytes, UNKNOWN } from "./format";
import type { MemoryFit, MemoryForecast } from "./liveIpc";

export interface MemoryBytes {
  lower_bytes: I64;
  upper_bytes?: I64 | null;
  kind: string;
  detail: string;
}

/** Tagged pool identity: `{kind:"device"}` keeps the backend's device id. */
export type MemoryDomainId =
  | { kind: "unified" }
  | { kind: "host" }
  | { kind: "device"; device: string };
export type MemoryPhaseId =
  | "continuation_start"
  | "loading"
  | "prefill"
  | "decode"
  | "speculative_draft"
  | "speculative_verification"
  | "speculative_commit";

export interface PhaseMemoryEstimate {
  phase: MemoryPhaseId;
  positions: I64;
  query_positions: I64;
  parameters: MemoryBytes;
  persistent_state: MemoryBytes;
  retained_input: MemoryBytes;
  workspace: MemoryBytes;
  staging: MemoryBytes;
  backend_overhead: MemoryBytes;
  total: MemoryBytes;
}

export interface DomainMemoryEstimate {
  domain: MemoryDomainId;
  phases: PhaseMemoryEstimate[];
  generation_peak: MemoryBytes;
  overall_peak: MemoryBytes;
  additional_generation_peak: MemoryBytes;
  state_growth_bytes_per_position: I64;
  generation_fit: MemoryFit;
  fit: MemoryFit;
}

export interface GenerationMemoryEstimate {
  requested_positions: I64;
  is_forecast: boolean;
  domains: DomainMemoryEstimate[];
  fit: MemoryFit;
  assumptions: string[];
  uncertainties: string[];
}

export function parseEstimate(forecast: MemoryForecast): GenerationMemoryEstimate {
  return parseLossless(forecast.estimate) as GenerationMemoryEstimate;
}

export function domainLabel(domain: MemoryDomainId): string {
  switch (domain.kind) {
    case "unified":
      return "unified memory";
    case "host":
      return "host memory";
    case "device":
      return `device ${domain.device}`;
  }
}

export const FIT_LABEL: Record<MemoryFit, string> = {
  likely_fit: "Likely fit",
  likely_shortfall: "Likely shortfall",
  insufficient_information: "Insufficient information",
};

/** Tag color for a verdict: shortfall is the danger case, fit is ink, and
 * insufficient information stays neutral (it is not a warning). */
export function fitTone(fit: MemoryFit): "accent" | "ink" | "blue" {
  return fit === "likely_shortfall" ? "accent" : fit === "likely_fit" ? "ink" : "blue";
}

/** "1.20 GIB" (exact), "1.20 GIB … 1.50 GIB" (interval), or
 * "1.20 GIB + unestimated" (no upper end). */
export function formatRange(bytes: MemoryBytes | undefined | null): string {
  if (!bytes) return UNKNOWN;
  const lower = i64ToNumber(bytes.lower_bytes);
  const upper = bytes.upper_bytes == null ? undefined : i64ToNumber(bytes.upper_bytes);
  if (upper === undefined) return `${formatBytes(lower)} + unestimated`;
  if (upper === lower) return formatBytes(lower);
  return `${formatBytes(lower)} … ${formatBytes(upper)}`;
}

export function lowerBytes(bytes: MemoryBytes | undefined | null): number {
  return bytes ? i64ToNumber(bytes.lower_bytes) : 0;
}

export function upperBytes(bytes: MemoryBytes | undefined | null): number | undefined {
  return bytes && bytes.upper_bytes != null ? i64ToNumber(bytes.upper_bytes) : undefined;
}

export const PHASE_LABEL: Record<MemoryPhaseId, string> = {
  continuation_start: "Now",
  loading: "Loading",
  prefill: "Prefill",
  decode: "Decode",
  speculative_draft: "Draft",
  speculative_verification: "Verify",
  speculative_commit: "Commit",
};

export interface Contribution {
  key: keyof Pick<
    PhaseMemoryEstimate,
    "parameters" | "persistent_state" | "retained_input" | "workspace" | "staging" | "backend_overhead"
  >;
  label: string;
}

/** Contribution order matches eredu's phase breakdown. */
export const CONTRIBUTIONS: Contribution[] = [
  { key: "parameters", label: "parameters" },
  { key: "persistent_state", label: "state" },
  { key: "retained_input", label: "input" },
  { key: "workspace", label: "workspace" },
  { key: "staging", label: "staging" },
  { key: "backend_overhead", label: "overhead" },
];

/** The phase with the largest known (lower-end) total — the one the
 * forecast's peak is named after. */
export function peakPhase(domain: DomainMemoryEstimate): PhaseMemoryEstimate | undefined {
  let best: PhaseMemoryEstimate | undefined;
  for (const phase of domain.phases) {
    if (!best || lowerBytes(phase.total) > lowerBytes(best.total)) best = phase;
  }
  return best;
}

/** Fraction of the available capacity (minus the reserve) the additional
 * generation peak's lower end would use; undefined when either is unknown. */
export function headroomFraction(
  domain: DomainMemoryEstimate,
  availableBytes: number | undefined,
  reserveBytes: number,
): number | undefined {
  if (availableBytes === undefined) return undefined;
  const usable = availableBytes - reserveBytes;
  if (usable <= 0) return undefined;
  return lowerBytes(domain.additional_generation_peak) / usable;
}
