// Run archive across models (journals survive unload) and a two-run
// comparison: settings diff, aligned tapes with a divergence strip, and the
// selected position's alternates from both runs.

import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { Card } from "../../goose/ui";
import { Eyebrow } from "../../goose/ui";
import { Heading } from "../../goose/ui";
import { Tag } from "../../goose/ui";
import { Button } from "../../goose/ui";
import { Checkbox } from "../../goose/ui";
import { getRunJournal, listRuns, inTauri } from "../../lib/ipc";
import { formatDateMs, formatPercent, UNKNOWN } from "../../lib/format";
import type { RunSummary } from "../../lib/types";
import { getJournal, hydrateFromEnvelopes } from "../../state/journal/journal";
import { useJournalsVersion } from "../../state/journal/useJournal";
import { TokenCell } from "../common/TokenCell";
import { pieceFor, pieceVersion, subscribePieces } from "../../lib/pieceCache";
import { topkForPrediction } from "../lab/dock/alternates";
import { ProbBar } from "../../viz/viz";
import type { DerivedRun } from "../../state/journal/reconcile";

export function RunsScreen() {
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [compare, setCompare] = useState<[string, string]>();
  useJournalsVersion();

  const refresh = async () => {
    if (!inTauri()) return;
    try {
      setRuns(await listRuns());
    } catch {
      // cold build or backend unavailable
    }
  };

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const hydrate = async (runId: string) => {
    if (getJournal(runId)) return;
    try {
      let from = 0;
      for (;;) {
        const page = await getRunJournal(runId, from, 2048);
        hydrateFromEnvelopes(page.envelopes);
        if (page.done) break;
        from += page.envelopes.length;
      }
    } catch {
      // journal may have been evicted
    }
  };

  const toggle = (runId: string, on: boolean) => {
    void hydrate(runId);
    setSelected((prev) => {
      const next = on ? [...prev, runId] : prev.filter((r) => r !== runId);
      return next.slice(-2);
    });
  };

  if (compare) {
    return <CompareView a={compare[0]} b={compare[1]} onBack={() => setCompare(undefined)} />;
  }

  return (
    <div style={{ maxWidth: 1280, margin: "0 auto" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 16, marginBottom: 16 }}>
        <Heading size="md" color="ink" as="h1">
          Runs
        </Heading>
        <div style={{ flex: 1 }} />
        <Button size="sm" variant="ghost" onClick={() => void refresh()}>
          ⟳ Refresh
        </Button>
        <Button
          size="sm"
          disabled={selected.length !== 2}
          onClick={() => selected.length === 2 && setCompare([selected[0], selected[1]])}
        >
          Compare 2 ▸
        </Button>
      </div>

      {runs.length === 0 ? (
        <p style={{ fontFamily: "var(--font-code)", fontSize: 13, color: "var(--text-muted)" }}>
          No runs recorded yet — generate something in the LAB.
        </p>
      ) : (
        <Card border padding={0}>
          {runs.map((run) => (
            <div
              key={run.runId}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 12,
                padding: "10px 16px",
                borderBottom: "1px solid var(--spiral-gray-200)",
                fontFamily: "var(--font-code)",
                fontSize: 12,
              }}
            >
              <Checkbox
                checked={selected.includes(run.runId)}
                onChange={(on) => toggle(run.runId, on)}
              />
              <span style={{ width: 170, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={run.runId}>
                {run.lineage ? "└ " : ""}
                {run.runId}
              </span>
              <Tag size="sm" color={run.status === "failed" || run.status === "cancelled" ? "accent" : "ink"}>
                {run.status.toUpperCase()}
              </Tag>
              {run.speculative && <Tag size="sm">Spec</Tag>}
              {!run.resumable && <Tag size="sm" color="ink">Unloaded</Tag>}
              <span style={{ color: "var(--text-muted)", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {run.modelLabel}
              </span>
              <span style={{ color: "var(--text-muted)" }}>{formatDateMs(run.createdMs)}</span>
              <span>{String(run.envelopeCount)} records</span>
            </div>
          ))}
        </Card>
      )}
    </div>
  );
}

function CompareView({ a, b, onBack }: { a: string; b: string; onBack: () => void }) {
  useJournalsVersion();
  useSyncExternalStore(subscribePieces, pieceVersion);
  const ja = getJournal(a)?.derived;
  const jb = getJournal(b)?.derived;
  const [position, setPosition] = useState<number>();

  const alignment = useMemo(() => {
    if (!ja || !jb) return undefined;
    return alignRuns(ja, jb);
  }, [ja, jb]);

  if (!ja || !jb || !alignment) {
    return (
      <div>
        <Button size="sm" variant="ghost" onClick={onBack}>
          ◀ Back
        </Button>
        <p style={{ fontFamily: "var(--font-code)", fontSize: 12 }}>loading journals…</p>
      </div>
    );
  }

  return (
    <div style={{ maxWidth: 1280, margin: "0 auto" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 16, marginBottom: 12 }}>
        <Button size="sm" variant="ghost" onClick={onBack}>
          ◀ Back
        </Button>
        <Heading size="sm" color="ink" style={{ fontSize: 18 }}>
          Compare
        </Heading>
        <span style={{ fontFamily: "var(--font-code)", fontSize: 11, color: "var(--text-muted)" }}>
          {a} vs {b}
        </span>
      </div>

      <SettingsDiff a={ja} b={jb} />

      {/* divergence strip */}
      <Card border padding={16} style={{ marginTop: 12 }}>
        <Eyebrow style={{ marginBottom: 6 }}>
          DIVERGENCE · first at {alignment.firstDivergence ?? "—"}
        </Eyebrow>
        <div style={{ display: "flex", gap: 1, flexWrap: "wrap" }}>
          {alignment.positions.slice(0, 400).map((p) => (
            <button
              key={p.index}
              onClick={() => setPosition(p.index)}
              title={`position ${p.index}`}
              style={{
                width: 6,
                height: 12,
                border: "none",
                cursor: "pointer",
                padding: 0,
                background:
                  p.state === "same" ? "var(--text)" : p.state === "diff" ? "var(--accent)" : "var(--spiral-gray-200)",
                outline: position === p.index ? "2px solid var(--accent-2)" : "none",
              }}
            />
          ))}
        </div>
        <p style={{ fontFamily: "var(--font-code)", fontSize: 10, color: "var(--text-muted)", margin: "6px 0 0" }}>
          black = same token · magenta = differs · gray = only one run — click a
          cell to compare alternates at that position
        </p>
      </Card>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginTop: 12 }}>
        <MiniTape derived={ja} position={position} onSelect={setPosition} />
        <MiniTape derived={jb} position={position} onSelect={setPosition} />
      </div>

      {position !== undefined && (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginTop: 12 }}>
          <MiniAlternates derived={ja} position={position} />
          <MiniAlternates derived={jb} position={position} />
        </div>
      )}
    </div>
  );
}

function specOf(derived: DerivedRun): Record<string, unknown> {
  return (derived.generationConfig ?? {}) as Record<string, unknown>;
}

function SettingsDiff({ a, b }: { a: DerivedRun; b: DerivedRun }) {
  const sa = specOf(a);
  const sb = specOf(b);
  const keys = [...new Set([...Object.keys(sa), ...Object.keys(sb)])].sort();
  const rows = keys.filter((k) => JSON.stringify(sa[k]) !== JSON.stringify(sb[k]));
  const same = keys.length - rows.length;
  return (
    <Card border padding={16}>
      <Eyebrow style={{ marginBottom: 6 }}>Settings diff (resolved generation config)</Eyebrow>
      {rows.length === 0 ? (
        <span style={{ fontFamily: "var(--font-code)", fontSize: 12, color: "var(--text-muted)" }}>
          identical resolved settings
        </span>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          {rows.map((k) => (
            <div key={k} style={{ display: "grid", gridTemplateColumns: "160px 1fr 1fr", gap: 12, fontFamily: "var(--font-code)", fontSize: 12 }}>
              <span style={{ color: "var(--text-muted)" }}>{k}</span>
              <span style={{ color: "var(--accent)" }}>{JSON.stringify(sa[k]) ?? UNKNOWN}</span>
              <span style={{ color: "var(--accent)" }}>{JSON.stringify(sb[k]) ?? UNKNOWN}</span>
            </div>
          ))}
        </div>
      )}
      <p style={{ fontFamily: "var(--font-code)", fontSize: 10, color: "var(--text-muted)", margin: "6px 0 0" }}>
        = {same} identical · seeds {String(a.seed ?? "—")} | {String(b.seed ?? "—")}
      </p>
    </Card>
  );
}

interface Alignment {
  positions: { index: number; state: "same" | "diff" | "single" }[];
  firstDivergence?: number;
}

function tokenAt(derived: DerivedRun, index: number): number | undefined {
  if (derived.inherited) {
    const div = derived.inherited.divergencePrediction;
    if (index < div) {
      const inheritedIdx = index - (div - derived.inherited.tokenIds.length);
      return inheritedIdx >= 0 ? derived.inherited.tokenIds[inheritedIdx] : undefined;
    }
  }
  return derived.tokens.find((t) => t.predictionIndex === index)?.tokenId;
}

function maxPosition(derived: DerivedRun): number {
  return derived.tokens.length > 0 ? derived.tokens[derived.tokens.length - 1].predictionIndex : -1;
}

function alignRuns(a: DerivedRun, b: DerivedRun): Alignment {
  const n = Math.max(maxPosition(a), maxPosition(b));
  const positions: Alignment["positions"] = [];
  let firstDivergence: number | undefined;
  for (let i = 0; i <= n; i++) {
    const ta = tokenAt(a, i);
    const tb = tokenAt(b, i);
    let state: "same" | "diff" | "single";
    if (ta !== undefined && tb !== undefined) {
      state = ta === tb ? "same" : "diff";
      if (state === "diff" && firstDivergence === undefined) firstDivergence = i;
    } else {
      state = "single";
    }
    positions.push({ index: i, state });
  }
  return { positions, firstDivergence };
}

function MiniTape({
  derived,
  position,
  onSelect,
}: {
  derived: DerivedRun;
  position?: number;
  onSelect: (i: number) => void;
}) {
  return (
    <Card border padding={16} style={{ maxHeight: 320, overflow: "auto" }}>
      <Eyebrow style={{ marginBottom: 6 }}>{derived.runId}</Eyebrow>
      <div style={{ lineHeight: 2 }}>
        {derived.tokens.map((t) => (
          <TokenCell
            key={`${String(t.seq)}-${t.predictionIndex}`}
            piece={t.text || (pieceFor(t.tokenId) ?? "·")}
            selected={position === t.predictionIndex}
            forced={t.forced}
            title={`#${t.predictionIndex} · id ${t.tokenId}`}
            onClick={() => onSelect(t.predictionIndex)}
          />
        ))}
      </div>
    </Card>
  );
}

function MiniAlternates({ derived, position }: { derived: DerivedRun; position: number }) {
  useSyncExternalStore(subscribePieces, pieceVersion);
  const topk = topkForPrediction(derived, position);
  const chosen = derived.tokens.find((t) => t.predictionIndex === position)?.tokenId;
  return (
    <Card border padding={16}>
      <Eyebrow style={{ marginBottom: 6 }}>ALTERNATES @ {position}</Eyebrow>
      {!topk ? (
        <span style={{ fontFamily: "var(--font-code)", fontSize: 11, color: "var(--text-muted)" }}>
          no candidates captured
        </span>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
          {topk.entries.slice(0, 6).map((e) => (
            <div key={e.tokenId} style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ width: 90, overflow: "hidden", whiteSpace: "nowrap", textOverflow: "ellipsis" }}>
                <TokenCell piece={pieceFor(e.tokenId) ?? `#${e.tokenId}`} selected={e.tokenId === chosen} />
              </span>
              <ProbBar fraction={e.probability} accent={e.tokenId === chosen} width={100} />
              <span style={{ fontFamily: "var(--font-code)", fontSize: 11 }}>{formatPercent(e.probability)}</span>
              {e.tokenId === chosen && <Tag size="sm" color="accent">Chosen</Tag>}
            </div>
          ))}
          <span style={{ fontFamily: "var(--font-code)", fontSize: 9, color: "var(--text-muted)" }}>
            softmax over top-{topk.entries.length} raw logits — pre-sampler
          </span>
        </div>
      )}
    </Card>
  );
}
