// Capture results, keyed to the tape selection: per-record outcome cards
// (Summary strips, histograms, candidate note), the across-run layer
// trajectory, and the MoE routing loom. Gaps render hatched, never as zeros.

import { useMemo } from "react";
import { Eyebrow } from "../../../goose/ui";
import { Tag } from "../../../goose/ui";
import { Select } from "../../../goose/ui";
import { useState } from "react";
import { HistogramChart, SquareGrid, SteppedLine } from "../../../viz/viz";
import { useUi } from "../../../state/ui";
import { formatCount, UNKNOWN } from "../../../lib/format";
import { i64ToNumber } from "../../../lib/lossless";
import type { RunJournal } from "../../../state/journal/journal";
import type {
  CaptureRecord,
  DerivedRun,
  HistogramPayload,
  SummaryPayload,
} from "../../../state/journal/reconcile";

export function SignalsView({ journal }: { journal: RunJournal }) {
  const derived = journal.derived;
  const selection = useUi((s) => s.selection);
  const predictionIndex =
    selection?.runId === derived.runId
      ? selection.predictionIndex
      : derived.tokens.length > 0
        ? derived.tokens[derived.tokens.length - 1].predictionIndex
        : undefined;

  if (derived.speculative) {
    return (
      <p style={{ fontFamily: "var(--font-code)", fontSize: 12, color: "var(--text-muted)" }}>
        Speculative runs capture one-row model.logits only (target and draft) —
        see ALTERNATES. Load without drafting for layer signals.
      </p>
    );
  }

  const step = predictionIndex !== undefined ? derived.capturesByPrediction.get(predictionIndex) : undefined;
  const nonCandidateRecords = step?.records.filter((r) => r.payload?.kind !== "candidates") ?? [];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div>
        <Eyebrow style={{ marginBottom: 8 }}>
          At token {predictionIndex ?? UNKNOWN}
        </Eyebrow>
        {nonCandidateRecords.length === 0 ? (
          <p style={{ fontFamily: "var(--font-code)", fontSize: 12, color: "var(--text-muted)", margin: 0 }}>
            no layer/tensor captures at this position — enable LAYER TRAJECTORY
            or MOE ROUTING in the composer
          </p>
        ) : (
          nonCandidateRecords.map((record, i) => <CaptureCard key={i} record={record} />)
        )}
      </div>

      <LayerTrajectory derived={derived} predictionIndex={predictionIndex} />
      <RoutingLoom derived={derived} />
    </div>
  );
}

function outcomeTag(outcome: unknown): { label: string; color: string } {
  const kind =
    typeof outcome === "object" && outcome !== null
      ? ((outcome as { kind?: string }).kind ?? "unknown")
      : String(outcome);
  switch (kind) {
    case "captured":
      return { label: "Captured", color: "ink" };
    case "truncated":
      return { label: "Truncated", color: "blue" };
    case "skipped":
      return { label: "Skipped (budget)", color: "blue" };
    case "missing":
      return { label: "Missing", color: "accent" };
    case "failed":
      return { label: "Failed", color: "accent" };
    default:
      return { label: kind.replace(/_/g, " "), color: "ink" };
  }
}

function CaptureCard({ record }: { record: CaptureRecord }) {
  const tag = outcomeTag(record.outcome);
  return (
    <div style={{ borderBottom: "1px solid var(--spiral-gray-200)", padding: "8px 0" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
        <Tag size="sm" color={tag.color}>{tag.label}</Tag>
        <span style={{ fontFamily: "var(--font-code)", fontSize: 11, wordBreak: "break-all" }}>{record.path}</span>
      </div>
      {record.payload?.kind === "summary" && <SummaryStrip summary={record.payload.value} />}
      {record.payload?.kind === "histogram" && <HistogramBlock histogram={record.payload.value} />}
      {record.payload?.kind === "tensor" && (
        <TensorPeek value={record.payload.value} shape={record.selected_shape} />
      )}
    </div>
  );
}

function SummaryStrip({ summary }: { summary: SummaryPayload }) {
  const stat = (label: string, v: number | null | undefined) => (
    <span style={{ fontFamily: "var(--font-code)", fontSize: 11 }}>
      <span style={{ color: "var(--text-muted)" }}>{label} </span>
      {v === null || v === undefined ? UNKNOWN : v.toPrecision(4)}
    </span>
  );
  const nan = i64ToNumber(summary.nan ?? 0);
  const inf = i64ToNumber(summary.positive_infinity ?? 0) + i64ToNumber(summary.negative_infinity ?? 0);
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 12 }}>
      {stat("min", summary.min)}
      {stat("max", summary.max)}
      {stat("mean", summary.mean)}
      {stat("rms", summary.rms)}
      <span style={{ fontFamily: "var(--font-code)", fontSize: 11, color: nan + inf > 0 ? "var(--accent)" : "var(--text-muted)" }}>
        finite {formatCount(summary.finite)} · nan {formatCount(summary.nan ?? 0)} · ±inf {inf}
      </span>
    </div>
  );
}

function HistogramBlock({ histogram }: { histogram: HistogramPayload }) {
  return (
    <HistogramChart
      edges={histogram.edges}
      counts={histogram.counts.map(i64ToNumber)}
      below={i64ToNumber(histogram.below ?? 0)}
      above={i64ToNumber(histogram.above ?? 0)}
      nonFinite={i64ToNumber(histogram.non_finite ?? 0)}
    />
  );
}

function TensorPeek({ value, shape }: { value: unknown; shape?: unknown }) {
  const values = extractNumbers(value).slice(0, 64);
  return (
    <div style={{ fontFamily: "var(--font-code)", fontSize: 10 }}>
      {shape != null && <div style={{ color: "var(--text-muted)" }}>shape {JSON.stringify(shape)}</div>}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginTop: 4 }}>
        {values.map((v, i) => (
          <span key={i} style={{ border: "1px solid var(--spiral-gray-200)", padding: "1px 3px" }}>
            {typeof v === "number" ? v.toPrecision(3) : String(v)}
          </span>
        ))}
      </div>
    </div>
  );
}

function extractNumbers(value: unknown): unknown[] {
  if (Array.isArray(value)) return value.flat(4).slice(0, 128);
  if (value && typeof value === "object") {
    const o = value as Record<string, unknown>;
    for (const key of ["data", "values", "f32", "F32"]) {
      if (Array.isArray(o[key])) return (o[key] as unknown[]).flat(4).slice(0, 128);
    }
    for (const inner of Object.values(o)) {
      if (Array.isArray(inner)) return inner.flat(4).slice(0, 128);
    }
  }
  return [];
}

/** Layer trajectory: x = layer order (from capture selection ids), y = the
 * chosen stat at the selected token; ghost = run median. */
function LayerTrajectory({ derived, predictionIndex }: { derived: DerivedRun; predictionIndex?: number }) {
  const [stat, setStat] = useState<"rms" | "mean" | "min" | "max">("rms");
  const data = useMemo(() => {
    // Collect layer-summary selections (ids "traj-<path>") in path order.
    const layerPaths = new Set<string>();
    for (const step of derived.capturesByPrediction.values()) {
      for (const r of step.records) {
        if (r.selection_id.startsWith("traj-") && r.payload?.kind === "summary") layerPaths.add(r.path);
      }
    }
    const paths = [...layerPaths].sort((a, b) => layerIndex(a) - layerIndex(b));
    if (paths.length === 0) return undefined;
    const at = (pi: number): (number | null)[] =>
      paths.map((p) => {
        const step = derived.capturesByPrediction.get(pi);
        const rec = step?.records.find((r) => r.path === p && r.payload?.kind === "summary");
        const v = rec?.payload?.kind === "summary" ? rec.payload.value[stat] : undefined;
        return typeof v === "number" ? v : null;
      });
    const selected = predictionIndex !== undefined ? at(predictionIndex) : paths.map(() => null);
    // Ghost: median across up to 32 captured positions.
    const positions = [...derived.capturesByPrediction.keys()].slice(-32);
    const ghost = paths.map((_, li) => {
      const vals = positions
        .map((pi) => at(pi)[li])
        .filter((v): v is number => v !== null)
        .sort((a, b) => a - b);
      return vals.length ? vals[Math.floor(vals.length / 2)] : null;
    });
    const nanMarkers = paths
      .map((p, i) => {
        const step = predictionIndex !== undefined ? derived.capturesByPrediction.get(predictionIndex) : undefined;
        const rec = step?.records.find((r) => r.path === p && r.payload?.kind === "summary");
        const nan = rec?.payload?.kind === "summary" ? i64ToNumber(rec.payload.value.nan ?? 0) : 0;
        return nan > 0 ? i : -1;
      })
      .filter((i) => i >= 0);
    return { selected, ghost, nanMarkers, count: paths.length };
  }, [derived, predictionIndex, stat]);

  if (!data) return null;
  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6 }}>
        <Eyebrow>Layer trajectory · {data.count} layers</Eyebrow>
        <Select
          options={["rms", "mean", "min", "max"]}
          value={stat}
          onChange={(v) => setStat(v as typeof stat)}
          style={{ width: 100 }}
        />
      </div>
      <SteppedLine
        values={data.selected}
        ghost={data.ghost}
        markers={data.nanMarkers}
        xLabel="layer →"
      />
      <p style={{ fontFamily: "var(--font-code)", fontSize: 10, color: "var(--text-muted)", margin: "4px 0 0" }}>
        magenta = selected token · gray ghost = run median · ✕ = NaN present
      </p>
    </div>
  );
}

function layerIndex(path: string): number {
  const m = path.match(/layers\.(\d+)/);
  return m ? Number(m[1]) : 1_000_000;
}

/** MoE routing loom: x = token position, y = expert id; filled square when
 * selected, size stepped by score; top-1 magenta. */
function RoutingLoom({ derived }: { derived: DerivedRun }) {
  const selection = useUi((s) => s.selection);
  const select = useUi((s) => s.select);
  const loom = useMemo(() => {
    const positions = [...derived.capturesByPrediction.keys()].sort((a, b) => a - b).slice(-64);
    const cells: { col: number; row: number; intensity: number; top?: boolean; title?: string }[] = [];
    let maxExpert = -1;
    positions.forEach((pi, col) => {
      const step = derived.capturesByPrediction.get(pi);
      if (!step) return;
      const experts = step.records.find(
        (r) => r.path.includes("routing.selected_experts") && r.payload?.kind === "tensor",
      );
      const scores = step.records.find(
        (r) => r.path.includes("routing.selected_scores") && r.payload?.kind === "tensor",
      );
      if (!experts) return;
      const ids = extractNumbers(experts.payload?.kind === "tensor" ? experts.payload.value : undefined)
        .map(Number)
        .filter((n) => Number.isFinite(n));
      const ws = scores
        ? extractNumbers(scores.payload?.kind === "tensor" ? scores.payload.value : undefined).map(Number)
        : [];
      const maxScore = Math.max(...ws.filter(Number.isFinite), 1e-9);
      ids.forEach((expert, i) => {
        maxExpert = Math.max(maxExpert, expert);
        const score = Number.isFinite(ws[i]) ? ws[i] : maxScore;
        cells.push({
          col,
          row: expert,
          intensity: score / maxScore,
          top: i === 0,
          title: `token ${pi} · expert ${expert}${Number.isFinite(ws[i]) ? ` · score ${ws[i].toFixed(3)}` : ""}`,
        });
      });
    });
    if (cells.length === 0) return undefined;
    return { positions, cells, rows: maxExpert + 1 };
  }, [derived]);

  if (!loom) return null;
  const highlightColumn =
    selection?.runId === derived.runId
      ? loom.positions.indexOf(selection.predictionIndex)
      : undefined;
  return (
    <div>
      <Eyebrow style={{ marginBottom: 6 }}>Expert loom · {loom.rows} experts</Eyebrow>
      <div style={{ overflow: "auto", maxHeight: 260 }} onClick={(e) => {
        void e;
      }}>
        <SquareGrid
          columns={loom.positions.length}
          rows={loom.rows}
          cells={loom.cells}
          highlightColumn={highlightColumn !== undefined && highlightColumn >= 0 ? highlightColumn : undefined}
          cellSize={8}
          rowLabel={(r) => (r % 8 === 0 ? String(r) : "")}
        />
      </div>
      <p style={{ fontFamily: "var(--font-code)", fontSize: 10, color: "var(--text-muted)", margin: "4px 0 0" }}>
        column = token · row = expert · size = routing score · magenta = top-1
      </p>
      {selection?.runId !== derived.runId && (
        <button
          onClick={() => derived.tokens.length && select(derived.runId, derived.tokens[derived.tokens.length - 1].predictionIndex)}
          style={{ display: "none" }}
        />
      )}
    </div>
  );
}
