// Transport bar: STEP / RUN / PAUSE / CANCEL, status word, mid-run sampling
// override, snapshot pins, pending forced-token chip. Pause and cancel act
// through the cross-thread control handle so they land immediately.

import { useState } from "react";
import { Button } from "../../goose/ui";
import { Input } from "../../goose/ui";
import { Tooltip } from "../../goose/ui";
import { Dialog } from "../../goose/ui";
import { useSession } from "../../state/session";
import { useUi } from "../../state/ui";
import { useJournal } from "../../state/journal/useJournal";
import { formatBytes } from "../../lib/format";
import { pieceFor } from "../../lib/pieceCache";

export function Transport() {
  const session = useSession();
  const viewedRunId = useUi((s) => s.viewedRunId) ?? session.activeRunId;
  const journal = useJournal(viewedRunId);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [tuneOpen, setTuneOpen] = useState(false);
  const [temp, setTemp] = useState("");
  const [reseed, setReseed] = useState("");

  const status = session.transport.status;
  const viewingParked = viewedRunId !== session.activeRunId;
  const terminal = ["completed", "cancelled", "failed"].includes(status);
  const snapshotUsage = parseUsage(session.tree?.snapshotUsage);
  const derived = journal?.derived;
  const tokensPerSecond = derived ? rate(derived.tokens.map((t) => t.stepSeconds)) : undefined;

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 12,
        background: "var(--surface)",
        border: "1px solid var(--border)",
        padding: "10px 16px",
        flex: "none",
      }}
    >
      {session.observedOnly && !viewingParked ? (
        <>
          <Tooltip label={session.observedOnly}>
            <span className="sp-eyebrow" style={{ color: "var(--text-muted)" }}>
              Free-running — controls unavailable for this model
            </span>
          </Tooltip>
          <Button size="sm" variant="ghost" disabled={terminal} onClick={() => setConfirmCancel(true)}>
            ✕ Cancel
          </Button>
        </>
      ) : viewingParked ? (
        <>
          <span className="sp-eyebrow" style={{ color: "var(--text-muted)" }}>
            Parked run — view only
          </span>
          <Button size="sm" variant="blue" onClick={() => viewedRunId && activate(viewedRunId)}>
            Activate ▸
          </Button>
        </>
      ) : (
        <>
          <Button size="sm" variant="ink" disabled={terminal || session.transport.busy} onClick={() => void session.step(1)}>
            ▸ Step
          </Button>
          <Button size="sm" disabled={terminal || session.transport.busy} onClick={() => void session.run()}>
            ⏵ Run
          </Button>
          <Button size="sm" variant="secondary" disabled={!session.transport.busy} onClick={() => void session.pause()}>
            ⏸ Pause
          </Button>
          <Button size="sm" variant="ghost" disabled={terminal} onClick={() => setConfirmCancel(true)}>
            ✕ Cancel
          </Button>
        </>
      )}

      <span
        className="sp-display"
        style={{
          fontSize: 14,
          color: status === "failed" || status === "cancelled" ? "var(--color-text-danger)" : "var(--text)",
          marginLeft: 8,
        }}
      >
        {status.charAt(0).toUpperCase() + status.slice(1)}
        {session.transport.busy && <span style={{ animation: "none" }}> ▮</span>}
      </span>
      {session.transport.finishReason && (
        <span className="sp-eyebrow" style={{ color: "var(--text-muted)" }}>
          ■ {session.transport.finishReason.replace(/_/g, " ")}
        </span>
      )}

      <span style={{ fontFamily: "var(--font-code)", fontSize: 12, color: "var(--text-muted)" }}>
        {derived ? `${derived.tokens.length} TOK` : ""}
        {tokensPerSecond ? ` · ${tokensPerSecond.toFixed(1)} TOK/S` : ""}
      </span>

      {session.pendingForcedToken !== undefined && (
        <span
          className="sp-eyebrow"
          style={{ border: "1px solid var(--accent)", color: "var(--accent)", padding: "4px 8px", display: "inline-flex", gap: 8, alignItems: "center" }}
        >
          NEXT: ▸{pieceFor(session.pendingForcedToken) ?? `#${session.pendingForcedToken}`} FORCED
          <button
            onClick={() => void session.clearForced()}
            style={{ background: "none", border: "none", color: "var(--accent)", cursor: "pointer", padding: 0, fontFamily: "inherit" }}
          >
            ×
          </button>
        </span>
      )}

      <div style={{ flex: 1 }} />

      {!session.speculative && !session.observedOnly && (
        <Tooltip label="pin a snapshot at this boundary">
          <Button size="sm" variant="ghost" disabled={session.transport.busy} onClick={() => void session.pinSnapshot()}>
            ◆ PIN {session.tree ? `${session.tree.snapshots.length}` : ""}
            {snapshotUsage ? ` · ${formatBytes(snapshotUsage.retained)}` : ""}
          </Button>
        </Tooltip>
      )}

      <Button size="sm" variant="ghost" onClick={() => setTuneOpen((v) => !v)}>
        Sampling ▾
      </Button>
      <Tooltip label="compose another prompt — this run stays in Runs">
        <Button size="sm" variant="ghost" onClick={() => useUi.getState().openComposer()}>
          ✎ New prompt
        </Button>
      </Tooltip>
      <Button
        size="sm"
        variant="ghost"
        onClick={() => {
          void session.endSession();
          useUi.getState().openComposer();
        }}
      >
        End session
      </Button>

      {tuneOpen && (
        <div
          style={{
            position: "absolute",
            bottom: 64,
            right: 24,
            background: "var(--surface)",
            border: "2px solid var(--accent-2)",
            padding: 16,
            display: "flex",
            gap: 10,
            alignItems: "flex-end",
            zIndex: 100,
          }}
        >
          <Input label="Temperature" type="number" value={temp} onChange={(e) => setTemp((e.target as HTMLInputElement).value)} style={{ width: 130 }} />
          <Input label="Reseed" type="number" value={reseed} onChange={(e) => setReseed((e.target as HTMLInputElement).value)} hint="blank keeps inherited RNG" style={{ width: 130 }} />
          <Button
            size="sm"
            onClick={() => {
              void session.overrideSampling(
                temp === "" ? undefined : Number(temp),
                reseed === "" ? undefined : Number(reseed),
              );
              setTuneOpen(false);
            }}
          >
            Apply
          </Button>
        </div>
      )}

      <Dialog
        open={confirmCancel}
        title="Cancel run"
        onClose={() => setConfirmCancel(false)}
        actions={
          <>
            <Button size="sm" variant="ghost" onClick={() => setConfirmCancel(false)}>
              Keep running
            </Button>
            <Button
              size="sm"
              onClick={() => {
                setConfirmCancel(false);
                void session.cancel();
              }}
            >
              ✕ Cancel run
            </Button>
          </>
        }
      >
        Cancelled runs are permanent — they cannot be resumed, restored, or
        branched afterwards.
      </Dialog>
    </div>
  );

  function activate(runId: string) {
    const slot = session.tree?.slots.find((s) => s.parkedRunId === runId);
    if (slot) void session.activateBranch(slot.slotId);
  }
}

function parseUsage(json?: string): { retained: number } | undefined {
  if (!json) return undefined;
  try {
    const u = JSON.parse(json) as { retained_bytes?: number };
    return { retained: u.retained_bytes ?? 0 };
  } catch {
    return undefined;
  }
}

function rate(stepSeconds: number[]): number | undefined {
  const total = stepSeconds.reduce((a, b) => a + b, 0);
  if (total <= 0) return undefined;
  return stepSeconds.length / total;
}
