// Hand-rolled SVG chart primitives on the goose palette: monochrome ink
// marks, teal = the one highlighted datum, info blue = reference/structure,
// hatch = unknown/overflow. Every mark carries a direct label or a <title>
// hover; grids are recessive hairlines.

import type { ReactNode } from "react";

export const INK = "var(--color-text-primary)";
export const ACCENT = "var(--accent)"; // teal — the highlighted datum
export const BLUE = "var(--color-text-info)"; // reference/structure
export const MUTED = "var(--color-text-tertiary)";
export const HAIRLINE = "var(--color-border-primary)";

export function Hatch({ id }: { id: string }) {
  return (
    <defs>
      <pattern id={id} width="4" height="4" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
        <line x1="0" y1="0" x2="0" y2="4" stroke={MUTED} strokeWidth="1" />
      </pattern>
    </defs>
  );
}

/** Horizontal probability bar (candidate rows). Width ∈ [0,1]. */
export function ProbBar({
  fraction,
  accent,
  width = 160,
  height = 14,
  title,
}: {
  fraction: number;
  accent?: boolean;
  width?: number;
  height?: number;
  title?: string;
}) {
  const w = Math.max(0, Math.min(1, fraction)) * width;
  return (
    <svg className="viz" width={width} height={height} role="img" aria-label={title}>
      {title && <title>{title}</title>}
      <rect x={0} y={0} width={width} height={height} fill="none" stroke={HAIRLINE} strokeWidth={1} />
      <rect x={0} y={0} width={Math.max(w, fraction > 0 ? 1 : 0)} height={height} fill={accent ? ACCENT : INK} />
    </svg>
  );
}

/** Histogram with hatched under/overflow end bars and a magenta non-finite bar. */
export function HistogramChart({
  edges,
  counts,
  below = 0,
  above = 0,
  nonFinite = 0,
  width = 360,
  height = 120,
}: {
  edges: number[];
  counts: number[];
  below?: number;
  above?: number;
  nonFinite?: number;
  width?: number;
  height?: number;
}) {
  const all = [below, ...counts, above, nonFinite];
  const max = Math.max(1, ...all);
  const n = counts.length + 2 + (nonFinite > 0 ? 1 : 0);
  const gap = 2;
  const bw = Math.max(2, Math.floor((width - gap * (n - 1)) / n));
  const bar = (i: number, count: number, fill: string, label: string) => {
    const h = Math.round((count / max) * (height - 14));
    return (
      <rect key={i} x={i * (bw + gap)} y={height - 12 - h} width={bw} height={Math.max(h, count > 0 ? 1 : 0)} fill={fill}>
        <title>{label}</title>
      </rect>
    );
  };
  const bars: ReactNode[] = [];
  bars.push(bar(0, below, "url(#hviz-hatch)", `< ${edges[0]} · ${below}`));
  counts.forEach((c, i) => {
    bars.push(bar(i + 1, c, INK, `[${fmt(edges[i])}, ${fmt(edges[i + 1])}) · ${c}`));
  });
  bars.push(bar(counts.length + 1, above, "url(#hviz-hatch)", `≥ ${fmt(edges[edges.length - 1])} · ${above}`));
  if (nonFinite > 0) {
    bars.push(bar(counts.length + 2, nonFinite, ACCENT, `non-finite · ${nonFinite}`));
  }
  return (
    <svg className="viz" width={width} height={height} role="img" aria-label="histogram">
      <Hatch id="hviz-hatch" />
      <line x1={0} y1={height - 12} x2={width} y2={height - 12} stroke={INK} strokeWidth={1} />
      {bars}
      <text x={0} y={height - 2}>{fmt(edges[0])}</text>
      <text x={width} y={height - 2} textAnchor="end">{fmt(edges[edges.length - 1])}</text>
    </svg>
  );
}

function fmt(x: number | undefined): string {
  if (x === undefined || !Number.isFinite(x)) return "—";
  if (Math.abs(x) >= 100) return x.toFixed(0);
  if (Math.abs(x) >= 1) return x.toFixed(1);
  return x.toPrecision(2);
}

/** Step-after line (layer trajectory). One highlighted series + optional ghost. */
export function SteppedLine({
  values,
  ghost,
  markers,
  width = 360,
  height = 120,
  xLabel,
}: {
  values: (number | null)[];
  ghost?: (number | null)[];
  /** x indices to flag (e.g. NaN layers) with a magenta tick. */
  markers?: number[];
  width?: number;
  height?: number;
  xLabel?: string;
}) {
  const finite = [...values, ...(ghost ?? [])].filter(
    (v): v is number => v !== null && Number.isFinite(v),
  );
  if (finite.length === 0) {
    return (
      <svg className="viz" width={width} height={height}>
        <text x={width / 2} y={height / 2} textAnchor="middle">no finite values</text>
      </svg>
    );
  }
  const lo = Math.min(...finite);
  const hi = Math.max(...finite);
  const pad = 12;
  const span = hi - lo || 1;
  const x = (i: number) => pad + (i / Math.max(1, values.length - 1)) * (width - 2 * pad);
  const y = (v: number) => height - 16 - ((v - lo) / span) * (height - 30);
  const path = (vs: (number | null)[]) => {
    let d = "";
    let started = false;
    vs.forEach((v, i) => {
      if (v === null || !Number.isFinite(v)) {
        started = false;
        return;
      }
      const px = x(i);
      const py = y(v);
      if (!started) {
        d += `M ${px} ${py}`;
        started = true;
      } else {
        d += ` H ${px} V ${py}`;
      }
    });
    return d;
  };
  return (
    <svg className="viz" width={width} height={height} role="img" aria-label={xLabel}>
      <line x1={pad} y1={height - 16} x2={width - pad} y2={height - 16} stroke={HAIRLINE} strokeWidth={1} />
      {ghost && <path d={path(ghost)} fill="none" stroke={MUTED} strokeWidth={1} />}
      <path d={path(values)} fill="none" stroke={ACCENT} strokeWidth={2} />
      {markers?.map((i) => (
        <text key={i} x={x(i)} y={12} textAnchor="middle" fill={ACCENT}>✕</text>
      ))}
      <text x={pad} y={height - 4}>{fmt(lo)}</text>
      <text x={pad} y={10}>{fmt(hi)}</text>
      {xLabel && (
        <text x={width - pad} y={height - 4} textAnchor="end">{xLabel}</text>
      )}
    </svg>
  );
}

/** Square-cell grid (MoE routing loom): x = position, y = row (expert). */
export function SquareGrid({
  columns,
  rows,
  cells,
  highlightColumn,
  cellSize = 10,
  rowLabel,
}: {
  columns: number;
  rows: number;
  /** col-major sparse cells: {col,row,intensity 0..1, top?}. */
  cells: { col: number; row: number; intensity: number; top?: boolean; title?: string }[];
  highlightColumn?: number;
  cellSize?: number;
  rowLabel?: (row: number) => string;
}) {
  const gap = 2;
  const labelW = rowLabel ? 34 : 0;
  const width = labelW + columns * (cellSize + gap);
  const height = rows * (cellSize + gap) + 4;
  return (
    <svg className="viz" width={width} height={height} role="img" aria-label="routing grid">
      {highlightColumn !== undefined && (
        <rect
          x={labelW + highlightColumn * (cellSize + gap) - 1}
          y={0}
          width={cellSize + 2}
          height={height}
          fill="none"
          stroke={BLUE}
          strokeWidth={1}
        />
      )}
      {rowLabel &&
        Array.from({ length: rows }, (_, r) => (
          <text key={r} x={0} y={r * (cellSize + gap) + cellSize - 1}>
            {rowLabel(r)}
          </text>
        ))}
      {cells.map((c, i) => {
        const size = Math.max(3, Math.round(cellSize * (0.45 + 0.55 * Math.min(1, c.intensity))));
        const off = Math.floor((cellSize - size) / 2);
        return (
          <rect
            key={i}
            x={labelW + c.col * (cellSize + gap) + off}
            y={c.row * (cellSize + gap) + off}
            width={size}
            height={size}
            fill={c.top ? ACCENT : INK}
          >
            {c.title && <title>{c.title}</title>}
          </rect>
        );
      })}
    </svg>
  );
}

/** Confidence strip cell heights: 4 discrete steps by probability. */
export function confidenceStep(p: number | undefined): number {
  if (p === undefined) return 0;
  if (p >= 0.75) return 4;
  if (p >= 0.4) return 3;
  if (p >= 0.15) return 2;
  return 1;
}

/** Tiny per-step sparkline (acceptance rate, step time). */
export function Sparkline({
  values,
  width = 120,
  height = 24,
  title,
}: {
  values: number[];
  width?: number;
  height?: number;
  title?: string;
}) {
  if (values.length === 0) return <svg className="viz" width={width} height={height} />;
  const max = Math.max(...values, 1e-9);
  const gap = 1;
  const bw = Math.max(1, Math.floor(width / values.length) - gap);
  return (
    <svg className="viz" width={width} height={height} role="img" aria-label={title}>
      {title && <title>{title}</title>}
      {values.map((v, i) => {
        const h = Math.max(1, Math.round((v / max) * (height - 2)));
        return <rect key={i} x={i * (bw + gap)} y={height - h} width={bw} height={h} fill={INK} />;
      })}
    </svg>
  );
}
