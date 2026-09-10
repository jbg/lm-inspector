// Real speculative step records captured from a Muse-Glimmer-30B + DFlash
// assistant run (spec_smoke example) — the ghost pipeline must place the
// rejected/discarded proposals at the committed positions that displaced them.

import { describe, expect, it } from "vitest";
import { emptyDerived, applySpecStep, type SpecStepRecord } from "../../../state/journal/reconcile";
import { computeDraftGhosts } from "./ghosts";

const RECORDS: unknown[] = [
  { sequence: 0, run_id: 0, epoch: 0, status: "ready_to_draft", committed_token_ids: [328] },
  { sequence: 1, run_id: 0, epoch: 0, status: "ready_to_submit_verification", drafted: { position: 1, token_ids: [76976, 200023, 179195, 117611], assumed_prefix: null }, committed_token_ids: [] },
  { sequence: 2, run_id: 0, epoch: 0, status: "target_verification_in_flight", committed_token_ids: [] },
  { sequence: 3, run_id: 0, epoch: 0, status: "ready_to_draft", verification: { resolved: true, proposals: { position: 1, token_ids: [76976, 200023, 179195, 117611], assumed_prefix: null }, dispositions: ["rejected", "discarded", "discarded", "discarded"], committed_token_ids: [19669], optimistic: null }, committed_token_ids: [19669] },
  { sequence: 4, run_id: 0, epoch: 0, status: "ready_to_submit_verification", drafted: { position: 2, token_ids: [200023, 31084, 117611, 124785], assumed_prefix: null }, committed_token_ids: [] },
  { sequence: 5, run_id: 0, epoch: 0, status: "target_verification_in_flight", committed_token_ids: [] },
  { sequence: 6, run_id: 0, epoch: 0, status: "ready_to_draft", verification: { resolved: true, proposals: { position: 2, token_ids: [200023, 31084, 117611, 124785], assumed_prefix: null }, dispositions: ["accepted", "rejected", "discarded", "discarded"], committed_token_ids: [200023, 17375], optimistic: null }, committed_token_ids: [200023, 17375] },
];

describe("speculative rejection ghosts (real Muse/DFlash records)", () => {
  it("keeps the pending draft through verification and places ghosts", () => {
    const derived = emptyDerived("spec:1:0", true);
    for (const r of RECORDS.slice(0, 3)) applySpecStep(derived, r as SpecStepRecord);
    // In-flight verification must not clear the tentative draft.
    expect(derived.pendingDraft).toBeDefined();
    expect(derived.specPhase).toBe("verifying");

    for (const r of RECORDS.slice(3)) applySpecStep(derived, r as SpecStepRecord);
    // Tokens: 328@0, 19669@1, 200023@2, 17375@3
    expect(derived.tokens.map((t) => t.predictionIndex)).toEqual([0, 1, 2, 3]);

    const ghosts = computeDraftGhosts(derived);
    // Round 1: 0 accepted -> ghosts (all 4 non-accepted) before position 1.
    expect(ghosts.get(1)?.map((g) => g.disposition)).toEqual([
      "rejected",
      "discarded",
      "discarded",
      "discarded",
    ]);
    expect(ghosts.get(1)?.[0].tokenId).toBe(76976);
    // Round 2: 1 accepted -> 3 ghosts before position 3 (the replacement).
    expect(ghosts.get(3)?.map((g) => g.tokenId)).toEqual([31084, 117611, 124785]);
  });
});
