// The tape: the run's transcript where every token is a live object.
// Prompt band (dimmed) → inherited prefix (branches) → generated stream with
// snapshot ticks, sampling seams, a thinking band, the speculative draft lane,
// and the confidence strip minimap underneath.

import { useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { Card } from "../../../goose/ui";
import { Eyebrow } from "../../../goose/ui";
import { TokenCell } from "../../common/TokenCell";
import { useUi } from "../../../state/ui";
import { useSession } from "../../../state/session";
import type { RunJournal } from "../../../state/journal/journal";
import type { TokenEntry } from "../../../state/journal/reconcile";
import { pieceFor, pieceVersion, prefetchPieces, subscribePieces } from "../../../lib/pieceCache";
import { confidenceStep } from "../../../viz/viz";
import { topkForPrediction, chosenProbability, chosenSignals } from "../dock/alternates";
import { DraftLane } from "./DraftLane";

export function Tape({ journal }: { journal: RunJournal }) {
  const derived = journal.derived;
  const selection = useUi((s) => s.selection);
  const select = useUi((s) => s.select);
  const follow = useUi((s) => s.follow);
  const clearSelection = useUi((s) => s.clearSelection);
  const scrollRef = useRef<HTMLDivElement>(null);
  useSyncExternalStore(subscribePieces, pieceVersion);

  useEffect(() => {
    prefetchPieces(derived.promptTokenIds);
  }, [derived.promptTokenIds]);

  // Follow the streaming head.
  useEffect(() => {
    if (follow && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [follow, derived.tokens.length]);

  // Keyboard: ←/→ moves the selection; Escape resumes follow.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.tagName === "Input" || (e.target as HTMLElement)?.tagName === "Textarea") return;
      if (e.key === "Escape") {
        clearSelection();
        return;
      }
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      const tokens = derived.tokens;
      if (tokens.length === 0) return;
      const delta = (e.key === "ArrowRight" ? 1 : -1) * (e.shiftKey ? 10 : 1);
      const current = selection?.runId === derived.runId ? selection.predictionIndex : undefined;
      const currentIdx =
        current !== undefined ? tokens.findIndex((t) => t.predictionIndex === current) : tokens.length - 1;
      const next = tokens[Math.max(0, Math.min(tokens.length - 1, currentIdx + delta))];
      if (next) select(derived.runId, next.predictionIndex);
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [derived, selection, select, clearSelection]);

  const snapshotTicks = useMemo(() => new Set(derived.snapshots.map((s) => s.nextPrediction)), [derived.snapshots]);
  const samplingMarksAt = useMemo(() => {
    const map = new Map<number, string>();
    for (const m of derived.samplingMarks) {
      const t = m.request["temperature"];
      const r = m.request["reseed"];
      map.set(m.nextPrediction, `⌁ ${t !== undefined && t !== null ? `temp→${t}` : ""}${r !== undefined && r !== null ? ` seed→${r}` : ""}`);
    }
    return map;
  }, [derived.samplingMarks]);

  const reasoningTokens = derived.tokens.filter((t) => t.reasoning);
  const bodyTokens = derived.tokens;

  return (
    <Card border padding={0} style={{ display: "flex", flexDirection: "column", minHeight: 0 }}>
      <div ref={scrollRef} style={{ flex: 1, overflow: "auto", padding: 20 }}>
        {/* prompt band */}
        <div
          style={{
            paddingBottom: 10,
            borderBottom: "1px solid var(--spiral-gray-200)",
            marginBottom: 12,
            lineHeight: 2,
          }}
        >
          <Eyebrow color="muted" style={{ marginBottom: 6 }}>
            Prompt · {derived.promptTokenIds.length} tokens
          </Eyebrow>
          {derived.promptTokenIds.map((id, i) => (
            <TokenCell
              key={i}
              piece={pieceFor(id) ?? "·"}
              muted
              title={`prompt token ${i} · id ${id} — no alternates recorded for prompt tokens`}
            />
          ))}
        </div>

        {/* inherited prefix (branches) */}
        {derived.inherited && (
          <>
            <div style={{ lineHeight: 2, opacity: 0.75, borderLeft: "2px solid var(--accent-2)", paddingLeft: 8 }}>
              {derived.inherited.tokenIds.map((id, i) => (
                <TokenCell key={i} piece={pieceFor(id) ?? "·"} muted title={`inherited · id ${id}`} />
              ))}
            </div>
            <div
              className="sp-eyebrow"
              style={{
                borderTop: "2px solid var(--accent)",
                color: "var(--accent)",
                margin: "10px 0",
                paddingTop: 4,
              }}
            >
              ── Diverged at {derived.inherited.divergencePrediction} ──
            </div>
          </>
        )}

        {/* thinking band */}
        {reasoningTokens.length > 0 && (
          <details open style={{ borderLeft: "2px solid var(--accent-2)", paddingLeft: 10, marginBottom: 10 }}>
            <summary className="sp-eyebrow" style={{ cursor: "pointer", color: "var(--accent-2)" }}>
              Thinking · {reasoningTokens.length} tokens
            </summary>
            <div style={{ lineHeight: 2, color: "var(--text-muted)" }}>
              <TapeTokens tokens={reasoningTokens} journal={journal} snapshotTicks={snapshotTicks} samplingMarks={samplingMarksAt} />
            </div>
          </details>
        )}

        {/* generated stream */}
        <div style={{ lineHeight: 2.2 }}>
          <TapeTokens
            tokens={bodyTokens.filter((t) => !t.reasoning)}
            journal={journal}
            snapshotTicks={snapshotTicks}
            samplingMarks={samplingMarksAt}
          />
          {derived.status === "running" && <span style={{ fontFamily: "var(--font-code)" }}>▌</span>}
        </div>

        {/* tool calls */}
        {derived.toolCalls.map((call) => (
          <div key={`${call.index}-${call.id}`} style={{ border: "2px solid var(--accent-2)", padding: 10, margin: "10px 0", fontFamily: "var(--font-code)", fontSize: 12 }}>
            <Eyebrow color="blue">Tool call · {call.name}{call.done ? "" : " …"}</Eyebrow>
            <pre style={{ margin: "6px 0 0", whiteSpace: "pre-wrap" }}>{call.argsJson}</pre>
          </div>
        ))}

        {/* speculative draft lane */}
        {derived.speculative && <DraftLane derived={derived} />}

        {/* abandoned segments (restores) */}
        {derived.abandoned.map((seg, i) => (
          <details key={i} style={{ marginTop: 12 }}>
            <summary className="sp-eyebrow" style={{ color: "var(--text-muted)", cursor: "pointer" }}>
              — Abandoned (epoch {String(seg.epoch)}) · {seg.tokens.length} tokens · show —
            </summary>
            <div style={{ lineHeight: 2, opacity: 0.5 }}>
              {seg.tokens.map((t, j) => (
                <TokenCell key={j} piece={t.text || (pieceFor(t.tokenId) ?? "·")} muted />
              ))}
            </div>
          </details>
        ))}

        {derived.failureMessage && (
          <div style={{ border: "1px solid var(--color-border-danger)", color: "var(--color-text-danger)", borderRadius: "var(--border-radius-md)", padding: 10, marginTop: 12, fontFamily: "var(--font-code)", fontSize: 12 }}>
            Failed: {derived.failureMessage}
          </div>
        )}
      </div>

      <ConfidenceStrip journal={journal} />
    </Card>
  );
}

function TapeTokens({
  tokens,
  journal,
  snapshotTicks,
  samplingMarks,
}: {
  tokens: TokenEntry[];
  journal: RunJournal;
  snapshotTicks: Set<number>;
  samplingMarks: Map<number, string>;
}) {
  const selection = useUi((s) => s.selection);
  const select = useUi((s) => s.select);
  const derived = journal.derived;
  return (
    <>
      {tokens.map((t) => {
        const selected =
          selection?.runId === derived.runId && selection.predictionIndex === t.predictionIndex;
        const mark = samplingMarks.get(t.predictionIndex);
        // Decision signals from the captured top-k (skip forced/replay tokens:
        // those decisions weren't the sampler's).
        const signals =
          t.forced || t.replay
            ? undefined
            : chosenSignals(derived, t.predictionIndex, t.tokenId);
        const offTop = (signals?.sampledRank ?? 1) > 1;
        const titleParts = [
          `#${t.predictionIndex}`,
          `id ${t.tokenId}`,
          ...(signals?.sampledRank !== undefined ? [`sampled rank ${signals.sampledRank}`] : []),
          ...(signals?.closeCall && signals.topMargin !== undefined
            ? [`close call — top-2 within ${(signals.topMargin * 100).toFixed(1)}%`]
            : []),
          ...(t.forced ? ["forced"] : []),
          ...(t.replay ? ["replayed"] : []),
        ];
        return (
          <span key={`${String(t.seq)}-${t.predictionIndex}`}>
            {mark && (
              <span className="sp-eyebrow" style={{ color: "var(--accent-2)", margin: "0 6px" }}>
                {mark}
              </span>
            )}
            {snapshotTicks.has(t.predictionIndex) && (
              <span title={`snapshot at position ${t.predictionIndex}`} style={{ color: "var(--accent)", fontSize: 9, verticalAlign: "top" }}>
                ◆
              </span>
            )}
            <TokenCell
              piece={t.text || (pieceFor(t.tokenId) ?? "·")}
              selected={selected}
              forced={t.forced}
              speculative={t.speculative}
              replay={t.replay}
              closeCall={signals?.closeCall}
              offTop={offTop}
              title={titleParts.join(" · ")}
              onClick={() => select(derived.runId, t.predictionIndex)}
            />
            {t.text.endsWith("\n") && <br />}
          </span>
        );
      })}
    </>
  );
}

/** The "where did it get weird" minimap: one cell per token, height stepped by
 * the chosen token's share of the captured top-k mass. */
function ConfidenceStrip({ journal }: { journal: RunJournal }) {
  const derived = journal.derived;
  const select = useUi((s) => s.select);
  const selection = useUi((s) => s.selection);
  const session = useSession();
  const surprise = true;
  if (!surprise || derived.tokens.length === 0) return null;
  void session;
  return (
    <div
      style={{
        display: "flex",
        gap: 1,
        alignItems: "flex-end",
        height: 14,
        padding: "0 20px 6px",
        flex: "none",
        overflow: "hidden",
      }}
      title="confidence strip — chosen-token share of captured top-k mass (pre-sampler)"
    >
      {derived.tokens.slice(-400).map((t) => {
        const topk = topkForPrediction(derived, t.predictionIndex);
        const p = topk ? chosenProbability(topk, t.tokenId) : undefined;
        const step = confidenceStep(p);
        const selected =
          selection?.runId === derived.runId && selection.predictionIndex === t.predictionIndex;
        return (
          <button
            key={`${String(t.seq)}-${t.predictionIndex}`}
            onClick={() => select(derived.runId, t.predictionIndex)}
            style={{
              width: 4,
              height: step === 0 ? 2 : step * 3,
              background: selected ? "var(--accent)" : step === 0 ? "var(--spiral-gray-200)" : "var(--text)",
              border: "none",
              padding: 0,
              cursor: "pointer",
              flex: "none",
            }}
            aria-label={`token ${t.predictionIndex}`}
          />
        );
      })}
    </div>
  );
}
