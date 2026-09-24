// Exact-prefix reconstruction for component-analysis replay: the token ids
// whose last row scores a given prediction. Pure over DerivedRun so it is
// testable without IPC.

import type { DerivedRun } from "./reconcile";

/** Exact prefix token IDs whose last row scores prediction `index`:
 * prompt + inherited (branch) tokens + committed tokens before `index`.
 * Undefined when the journal cannot supply them completely — an incomplete
 * prefix must never be replayed as if it were the run's history. */
export function prefixForPrediction(derived: DerivedRun, index: number): number[] | undefined {
  if (derived.promptTokenIds.length === 0) return undefined;
  const prefix = [...derived.promptTokenIds];
  if (derived.inherited) {
    // Inherited tokens cover predictions before the divergence point.
    for (let i = 0; i < derived.inherited.tokenIds.length && i < index; i++) {
      prefix.push(derived.inherited.tokenIds[i]);
    }
  }
  for (const token of derived.tokens) {
    if (token.predictionIndex < index) prefix.push(token.tokenId);
  }
  // The committed view must reach the analyzed prediction exactly.
  const expected = derived.promptTokenIds.length + index;
  return prefix.length === expected ? prefix : undefined;
}
