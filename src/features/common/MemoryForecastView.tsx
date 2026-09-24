// One memory forecast, rendered the same way in the composer (loaded model,
// loading excluded) and on the model screen (cold, loading included):
// eredu's verdict, per-pool peaks against observed capacity, the peak
// phase's contribution breakdown, cheaper alternatives, and the estimator's
// own assumptions/uncertainties verbatim. Intervals stay intervals — an
// unknown upper end is shown as such, never as a number.

import { useMemo, useState } from "react";
import { Eyebrow, Tag } from "../../goose/ui";
import { formatBytes, formatCount } from "../../lib/format";
import { i64ToNumber } from "../../lib/lossless";
import type { MemoryForecast } from "../../lib/liveIpc";
import {
  CONTRIBUTIONS,
  domainLabel,
  FIT_LABEL,
  fitTone,
  formatRange,
  headroomFraction,
  lowerBytes,
  parseEstimate,
  peakPhase,
  PHASE_LABEL,
  type DomainMemoryEstimate,
  type PhaseMemoryEstimate,
} from "../../lib/memory";
import { ACCENT, HAIRLINE, INK, MUTED } from "../../viz/viz";

const mono: React.CSSProperties = { fontFamily: "var(--font-code)", fontSize: 11 };
const muted: React.CSSProperties = { ...mono, color: "var(--text-muted)" };

export function MemoryForecastView({ forecast }: { forecast: MemoryForecast }) {
  const estimate = useMemo(() => parseEstimate(forecast), [forecast]);
  const [details, setDetails] = useState(false);
  const loaded = forecast.alreadyResidentBytes !== undefined;
  const horizon =
    forecast.maxOutputTokens !== undefined
      ? `${formatCount(forecast.maxOutputTokens)} output tokens`
      : `${formatCount(forecast.forecastOutputTokens)}-token forecast horizon (no token limit set)`;
  const chunk =
    forecast.fullPass !== undefined
      ? `one complete prefill pass`
      : forecast.requestedChunkTokens === 0
        ? "one complete prefill pass (requested)"
        : `prefill chunks of ${formatCount(forecast.effectiveChunkTokens)}`;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <Tag color={fitTone(forecast.fit)} filled={forecast.fit === "likely_shortfall"}>
          {FIT_LABEL[forecast.fit]}
        </Tag>
        <span style={muted}>
          {formatCount(forecast.inputPositions)} prompt positions · {horizon} · {chunk} ·{" "}
          {forecast.placement} memory ·{" "}
          {forecast.logits === "final_position" ? "final-row logits" : "all-row logits"}
          {forecast.speculative ? " · speculative phases projected" : ""}
          {forecast.continuation
            ? " · continuation from the installed state"
            : loaded
              ? " · model loaded, loading peak excluded"
              : " · loading included"}
        </span>
      </div>
      {forecast.fullPass !== undefined && (
        <div style={muted} title={forecast.fullPass}>
          Full prefill pass: {forecast.fullPass}
        </div>
      )}

      {estimate.domains.map((domain) => (
        <DomainRows
          key={domainLabel(domain.domain)}
          domain={domain}
          forecast={forecast}
          loaded={loaded}
        />
      ))}

      {forecast.candidates.length > 0 && (
        <div>
          <Eyebrow style={{ marginBottom: 4 }}>Cheaper alternatives</Eyebrow>
          {forecast.candidates.map((c, i) => (
            <div key={i} style={mono}>
              {c.label}: generation peak up to {formatBytes(c.generationPeakUpperBytes)} (−
              {formatBytes(c.savingBytes)}) · {FIT_LABEL[c.fit].toLowerCase()} · {c.domain}
            </div>
          ))}
        </div>
      )}

      {forecast.recommendations.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          {forecast.recommendations.map((r, i) => (
            <div key={i} style={muted}>
              · {r}
            </div>
          ))}
        </div>
      )}

      <button
        type="button"
        onClick={() => setDetails((d) => !d)}
        style={{ ...muted, background: "none", border: 0, padding: 0, cursor: "pointer", textAlign: "left" }}
      >
        {details ? "▾" : "▸"} estimator assumptions ({estimate.assumptions.length}) and uncertainties (
        {estimate.uncertainties.length})
      </button>
      {details && (
        <div style={{ display: "flex", flexDirection: "column", gap: 2, paddingLeft: 12 }}>
          {estimate.uncertainties.map((u, i) => (
            <div key={`u${i}`} style={{ ...mono, color: "var(--color-text-info)" }}>
              ? {u}
            </div>
          ))}
          {estimate.assumptions.map((a, i) => (
            <div key={`a${i}`} style={muted}>
              · {a}
            </div>
          ))}
          {forecast.allocatorCacheLimitBytes !== undefined && (
            <div style={muted}>
              · allocator-cache limit: {formatBytes(forecast.allocatorCacheLimitBytes)}
              {forecast.allocatorCachePolicy ? ` (${forecast.allocatorCachePolicy.replace(/_/g, " ")})` : ""}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function DomainRows({
  domain,
  forecast,
  loaded,
}: {
  domain: DomainMemoryEstimate;
  forecast: MemoryForecast;
  loaded: boolean;
}) {
  const peak = peakPhase(domain);
  const fraction = headroomFraction(domain, forecast.availableBytes, forecast.reserveBytes);
  const growth = i64ToNumber(domain.state_growth_bytes_per_position);
  return (
    <div style={{ borderTop: `1px solid ${HAIRLINE}`, paddingTop: 8, display: "flex", flexDirection: "column", gap: 4 }}>
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <Eyebrow>{domainLabel(domain.domain)}</Eyebrow>
        {domain.fit !== forecast.fit && (
          <Tag size="sm" color={fitTone(domain.fit)}>
            {FIT_LABEL[domain.fit]}
          </Tag>
        )}
      </div>
      <Row label="Generation peak" value={formatRange(domain.generation_peak)} detail={domain.generation_peak.detail} />
      {forecast.applicationLimitBytes !== undefined && (
        <Row
          label="Budget"
          value={`${formatBytes(forecast.applicationLimitBytes)} for total modeled memory (reserve ${formatBytes(forecast.reserveBytes)})`}
        />
      )}
      {loaded ? (
        <Row
          label="Additional to resident"
          value={`${formatRange(domain.additional_generation_peak)}${
            forecast.availableBytes !== undefined
              ? ` of ${formatBytes(forecast.availableBytes)} available (reserve ${formatBytes(forecast.reserveBytes)})`
              : " · available capacity unobserved"
          }`}
          detail={domain.additional_generation_peak.detail}
        />
      ) : (
        <Row
          label="Lifecycle peak"
          value={`${formatRange(domain.overall_peak)}${
            forecast.availableBytes !== undefined
              ? ` vs ${formatBytes(forecast.availableBytes)} available (reserve ${formatBytes(forecast.reserveBytes)})`
              : " · available capacity unobserved"
          }`}
          detail={domain.overall_peak.detail}
        />
      )}
      {fraction !== undefined && <HeadroomBar fraction={fraction} />}
      {growth > 0 && (
        <Row label="State growth" value={`${formatBytes(growth)} per generated position`} />
      )}
      {peak && <PhaseBreakdown phase={peak} phases={domain.phases} />}
    </div>
  );
}

function Row({ label, value, detail }: { label: string; value: string; detail?: string }) {
  return (
    <div style={{ display: "flex", gap: 12, justifyContent: "space-between" }} title={detail}>
      <span style={muted}>{label}</span>
      <span style={{ ...mono, textAlign: "right" }}>{value}</span>
    </div>
  );
}

/** Known lower end of the additional peak as a share of usable capacity.
 * Over 100% is drawn full with the overflow hatched in the label, never
 * clipped silently. */
function HeadroomBar({ fraction }: { fraction: number }) {
  const width = 240;
  const height = 8;
  const w = Math.max(0, Math.min(1, fraction)) * width;
  return (
    <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
      <svg className="viz" width={width} height={height} role="img" aria-label="share of usable capacity">
        <title>known lower end of the additional peak as a share of available capacity minus the reserve</title>
        <rect x={0} y={0} width={width} height={height} fill="none" stroke={HAIRLINE} strokeWidth={1} />
        <rect x={0} y={0} width={w} height={height} fill={fraction > 1 ? ACCENT : INK} />
      </svg>
      <span style={muted}>
        {(fraction * 100).toFixed(fraction < 0.1 ? 1 : 0)}% of usable capacity (known lower end)
      </span>
    </div>
  );
}

/** Peak phase contributions as one proportional bar (lower ends — the known
 * part), with the other phases' totals listed beneath. */
function PhaseBreakdown({ phase, phases }: { phase: PhaseMemoryEstimate; phases: PhaseMemoryEstimate[] }) {
  const width = 240;
  const height = 10;
  const parts = CONTRIBUTIONS.map((c) => ({ ...c, bytes: lowerBytes(phase[c.key]) })).filter((p) => p.bytes > 0);
  const total = parts.reduce((a, p) => a + p.bytes, 0);
  let x = 0;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
      <div style={muted}>
        peak phase {PHASE_LABEL[phase.phase] ?? phase.phase} at {formatCount(phase.positions)} positions · total{" "}
        {formatRange(phase.total)}
      </div>
      {total > 0 && (
        <svg className="viz" width={width} height={height} role="img" aria-label="peak phase contributions">
          <title>{parts.map((p) => `${p.label} ${formatBytes(p.bytes)}`).join(", ")}</title>
          {parts.map((p, i) => {
            const w = (p.bytes / total) * width;
            const rect = (
              <rect
                key={p.key}
                x={x}
                y={0}
                width={Math.max(w, 1)}
                height={height}
                fill={i % 2 === 0 ? INK : MUTED}
                stroke="var(--color-background-primary)"
                strokeWidth={1}
              />
            );
            x += w;
            return rect;
          })}
        </svg>
      )}
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
        {parts.map((p) => (
          <span key={p.key} style={mono} title={phase[p.key].detail}>
            {p.label} {formatBytes(p.bytes)}
            {phase[p.key].upper_bytes == null ? " +?" : ""}
          </span>
        ))}
      </div>
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
        {phases
          .filter((p) => p !== phase)
          .map((p) => (
            <span key={p.phase} style={muted} title={p.total.detail}>
              {PHASE_LABEL[p.phase] ?? p.phase} {formatRange(p.total)}
            </span>
          ))}
      </div>
    </div>
  );
}
