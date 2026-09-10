// The speculative draft lane: the current in-flight proposal block as
// tentative outline chips; resolved blocks show dispositions (accepted flows
// into the committed stream, rejected strikes through and falls away).

import { useSyncExternalStore } from "react";
import { Eyebrow } from "../../../goose/ui";
import { TokenCell } from "../../common/TokenCell";
import { pieceFor, pieceVersion, subscribePieces } from "../../../lib/pieceCache";
import type { DerivedRun } from "../../../state/journal/reconcile";
import { extractDraftIds } from "../dock/StatsView";

export function DraftLane({ derived }: { derived: DerivedRun }) {
  useSyncExternalStore(subscribePieces, pieceVersion);
  const pending = extractDraftIds(derived.pendingDraft);
  const lastBlock = derived.specBlocks[derived.specBlocks.length - 1];

  if (pending.length === 0 && !lastBlock) return null;

  return (
    <div style={{ borderTop: "2px solid var(--accent-2)", marginTop: 12, paddingTop: 8 }}>
      <Eyebrow color="blue" style={{ marginBottom: 6 }}>
        Speculation lane
      </Eyebrow>
      {pending.length > 0 && (
        <div style={{ display: "flex", gap: 4, flexWrap: "wrap", alignItems: "center" }}>
          <span className="sp-eyebrow" style={{ color: "var(--text-muted)" }}>
            Drafted (tentative)
          </span>
          {pending.map((id, i) => (
            <span key={i} style={{ border: "1px dashed var(--accent-2)", padding: "0 3px", opacity: 0.7 }}>
              <TokenCell piece={pieceFor(id) ?? `#${id}`} muted />
            </span>
          ))}
        </div>
      )}
      {lastBlock?.verification?.dispositions && (
        <div style={{ display: "flex", gap: 4, flexWrap: "wrap", alignItems: "center", marginTop: 6 }}>
          <span className="sp-eyebrow" style={{ color: "var(--text-muted)" }}>
            Last verify
          </span>
          {extractDraftIds(lastBlock.drafted).map((id, i) => {
            const d = lastBlock.verification!.dispositions![i];
            const accepted = d === "accepted";
            return (
              <span
                key={i}
                title={d}
                style={{
                  border: `1px solid ${accepted ? "var(--text)" : "var(--accent)"}`,
                  background: accepted ? "var(--text)" : "transparent",
                  color: accepted ? "#fff" : "var(--accent)",
                  textDecoration: accepted ? "none" : "line-through",
                  padding: "0 3px",
                  opacity: d === "discarded" ? 0.4 : 1,
                }}
              >
                <TokenCell piece={pieceFor(id) ?? `#${id}`} />
              </span>
            );
          })}
          {lastBlock.committedTokenIds
            .filter((id) => !extractDraftIds(lastBlock.drafted).includes(id))
            .map((id, i) => (
              <span key={`bonus-${i}`} title="target's pick (bonus/replacement)" style={{ border: "1px solid var(--accent-2)", background: "var(--accent-2)", color: "#fff", padding: "0 3px" }}>
                <TokenCell piece={pieceFor(id) ?? `#${id}`} />
              </span>
            ))}
        </div>
      )}
    </div>
  );
}
