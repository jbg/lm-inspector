import { describe, expect, it } from "vitest";
import {
  domainLabel,
  formatRange,
  headroomFraction,
  parseEstimate,
  peakPhase,
  type DomainMemoryEstimate,
} from "./memory";
import type { MemoryForecast } from "./liveIpc";

const bytes = (lower: number, upper?: number | null, detail = "calculated payload") => ({
  lower_bytes: lower,
  upper_bytes: upper === undefined ? lower : upper,
  kind: "exact",
  detail,
});

const phase = (phaseName: "loading" | "prefill" | "decode", total: number) => ({
  phase: phaseName,
  positions: 10,
  query_positions: 10,
  parameters: bytes(total / 2),
  persistent_state: bytes(total / 4),
  retained_input: bytes(0),
  workspace: bytes(total / 4),
  staging: bytes(0),
  backend_overhead: bytes(0),
  total: bytes(total),
});

const domain: DomainMemoryEstimate = {
  domain: { kind: "unified" },
  phases: [phase("loading", 4096), phase("prefill", 2048), phase("decode", 1024)],
  generation_peak: bytes(2048, 3072),
  overall_peak: bytes(4096),
  additional_generation_peak: bytes(1024, 2048),
  state_growth_bytes_per_position: 16,
  generation_fit: "likely_fit",
  fit: "likely_fit",
};

describe("memory helpers", () => {
  it("formats exact values, intervals, and unknown upper ends distinctly", () => {
    expect(formatRange(bytes(1024))).toBe("1.00 KIB");
    expect(formatRange(bytes(1024, 2048))).toBe("1.00 KIB … 2.00 KIB");
    expect(formatRange(bytes(1024, null))).toBe("1.00 KIB + unestimated");
    expect(formatRange(undefined)).toBe("—");
  });

  it("labels physical pools", () => {
    expect(domainLabel({ kind: "unified" })).toBe("unified memory");
    expect(domainLabel({ kind: "host" })).toBe("host memory");
    expect(domainLabel({ kind: "device", device: "gpu:0" })).toBe("device gpu:0");
  });

  it("names the phase with the largest known total as the peak", () => {
    expect(peakPhase(domain)?.phase).toBe("loading");
  });

  it("compares the additional peak with available capacity minus the reserve", () => {
    expect(headroomFraction(domain, 4096 + 256, 256)).toBeCloseTo(0.25);
    expect(headroomFraction(domain, undefined, 256)).toBeUndefined();
    expect(headroomFraction(domain, 100, 256)).toBeUndefined();
  });

  it("parses the verbatim estimate losslessly, keeping big integers intact", () => {
    const forecast = {
      estimate: JSON.stringify({
        requested_positions: 12,
        is_forecast: true,
        domains: [],
        fit: "insufficient_information",
        assumptions: [],
        uncertainties: [],
      }).replace('"requested_positions":12', '"requested_positions":18446744073709551615'),
    } as MemoryForecast;
    const estimate = parseEstimate(forecast);
    expect(String(estimate.requested_positions)).toBe("18446744073709551615");
    expect(estimate.fit).toBe("insufficient_information");
  });
});
