// The lineage strip: every run of the current model epoch as a subway track,
// branches departing at their divergence position. Click = view; ACTIVATE
// exchanges a parked branch in; only the active run advances.

import { useMemo } from "react";
import { Eyebrow } from "../../goose/ui";
import { Tag } from "../../goose/ui";
import { Button } from "../../goose/ui";
import { useSession } from "../../state/session";
import { useUi } from "../../state/ui";
import { allJournals, type RunJournal } from "../../state/journal/journal";
import { useJournalsVersion } from "../../state/journal/useJournal";
import { i64ToNumber } from "../../lib/lossless";

export function LineagePanel() {
  const session = useSession();
  const viewedRunId = useUi((s) => s.viewedRunId) ?? session.activeRunId;
  const viewRun = useUi((s) => s.viewRun);
  useJournalsVersion();

  const runs = useMemo(() => {
    const epoch = session.modelEpoch;
    return allJournals()
      .filter((j) => j.raw.length > 0 || j.derived.tokens.length > 0 || j.derived.speculative)
      .filter((j) => {
        const env = j.raw[0];
        void env;
        return true;
      })
      .map((j) => describeRun(j))
      .filter((r) => r !== undefined)
      .slice(-12) as RunRow[];
    void epoch;
  }, [session.modelEpoch, session.tree, session.activeRunId]);

  if (runs.length === 0) return null;
  const maxTokens = Math.max(1, ...runs.map((r) => r.divergence + r.tokenCount));

  return (
    <div style={{ background: "var(--surface)", border: "1px solid var(--border)", padding: "10px 16px", flex: "none" }}>
      <Eyebrow style={{ marginBottom: 8 }}>Tree · slots {session.tree?.slots.length ?? 0}</Eyebrow>
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {runs.map((run) => {
          const isActive = run.runId === session.activeRunId;
          const isViewed = run.runId === viewedRunId;
          const slot = session.tree?.slots.find((s) => s.parkedRunId === run.runId);
          return (
            <div key={run.runId} style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <button
                onClick={() => viewRun(run.runId)}
                className="sp-eyebrow"
                style={{
                  background: isViewed ? "var(--spiral-black)" : "none",
                  color: isViewed ? "#fff" : "var(--text)",
                  border: "none",
                  cursor: "pointer",
                  padding: "3px 8px",
                  width: 190,
                  textAlign: "left",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                  flex: "none",
                }}
                title={run.runId}
              >
                {run.statusGlyph} {run.label}
              </button>
              <div style={{ flex: 1, display: "flex", alignItems: "center", height: 10 }}>
                {run.divergence > 0 && (
                  <div style={{ width: `${(run.divergence / maxTokens) * 100}%`, borderTop: "2px dotted var(--spiral-gray-400)" }} />
                )}
                {run.divergence > 0 && <span style={{ color: "var(--accent)", fontSize: 10, lineHeight: 1 }}>◆</span>}
                <div
                  style={{
                    width: `${(run.tokenCount / maxTokens) * 100}%`,
                    minWidth: run.tokenCount > 0 ? 8 : 0,
                    borderTop: `2px solid ${isActive ? "var(--accent-2)" : "var(--text)"}`,
                  }}
                />
              </div>
              <span style={{ fontFamily: "var(--font-code)", fontSize: 11, color: "var(--text-muted)", width: 60, textAlign: "right", flex: "none" }}>
                {run.tokenCount} tok
              </span>
              {isActive ? (
                <Tag size="sm" color="blue" filled>
                  ▶ ACTIVE
                </Tag>
              ) : slot ? (
                <Button size="sm" variant="ghost" onClick={() => void session.activateBranch(slot.slotId)}>
                  Activate ▸
                </Button>
              ) : (
                <Tag size="sm">Parked</Tag>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

interface RunRow {
  runId: string;
  label: string;
  statusGlyph: string;
  tokenCount: number;
  divergence: number;
}

function describeRun(journal: RunJournal): RunRow | undefined {
  const d = journal.derived;
  const statusGlyph =
    d.status === "running"
      ? "●"
      : d.status === "paused" || d.status === "prepared"
        ? "‖"
        : d.status === "completed"
          ? "◼"
          : d.status === "failed" || d.status === "cancelled"
            ? "✕"
            : "·";
  const divergence = d.inherited ? d.inherited.divergencePrediction : 0;
  const forced = d.tokens.find((t) => t.forced && !t.replay);
  const label = d.inherited
    ? `└ ${forced ? `▸@${forced.predictionIndex}` : "branch"} ${shortId(d.runId)}`
    : `${d.speculative ? "spec " : ""}${shortId(d.runId)}`;
  return {
    runId: d.runId,
    label,
    statusGlyph,
    tokenCount: d.tokens.length,
    divergence: i64ToNumber(divergence),
  };
}

function shortId(id: string): string {
  return id.length > 14 ? `${id.slice(0, 6)}…${id.slice(-4)}` : id;
}
