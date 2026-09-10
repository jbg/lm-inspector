// Speculative rejection ghosts: where the target overrode the draft, keyed by
// the prediction index of the replacement token that displaced them.

import type { DerivedRun } from "../../../state/journal/reconcile";
import { extractDraftIds } from "../dock/StatsView";

export interface DraftGhost {
  tokenId: number;
  disposition: string;
}

export function computeDraftGhosts(derived: DerivedRun): Map<number, DraftGhost[]> {
  const map = new Map<number, DraftGhost[]>();
  for (const b of derived.specBlocks) {
    const dispositions = b.verification?.dispositions;
    if (!dispositions) continue;
    // The verification record carries the judged proposal block itself; the
    // step's own drafted field is null when drafting happened in an earlier
    // phase record (stepping / lookahead).
    const ids = extractDraftIds(b.verification?.proposals ?? b.drafted);
    const accepted = dispositions.filter((d) => d === "accepted").length;
    const ghosts = ids
      .map((id, i) => ({ tokenId: id, disposition: dispositions[i] ?? "discarded" }))
      .filter((g) => g.disposition !== "accepted");
    if (ghosts.length === 0) continue;
    const at = b.firstPrediction + accepted;
    map.set(at, [...(map.get(at) ?? []), ...ghosts]);
  }
  return map;
}
