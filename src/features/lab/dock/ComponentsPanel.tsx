// Components dock view — the paper's read → ablate → write loop for one
// prediction: signed score decomposition over every scalar component
// (activation × effective write column, via exact-prefix replay), causal
// deletion / keep-only mask trials, and reversible write-column overlays.

import { useState, useSyncExternalStore } from "react";
import { Button, Checkbox, Eyebrow, Select, Tag } from "../../../goose/ui";
import { UNKNOWN } from "../../../lib/format";
import { pieceFor, pieceVersion, subscribePieces } from "../../../lib/pieceCache";
import type { ComponentContribution, ComponentTrialResult } from "../../../lib/liveIpc";
import type { RunJournal } from "../../../state/journal/journal";
import { formatTokenScore, key, useComponents } from "../../../state/components";
import { useSession } from "../../../state/session";
import { useUi } from "../../../state/ui";
import { TokenCell } from "../../common/TokenCell";

const mono: React.CSSProperties = { fontFamily: "var(--font-code)", fontSize: 11 };
const monoMuted: React.CSSProperties = { ...mono, color: "var(--text-muted)" };

/** Trim the shared "decoder.layers.N." style prefix for display. */
function groupSuffix(groupId: string, layer: number): string {
  const marker = `.${layer}.`;
  const at = groupId.indexOf(marker);
  return at >= 0 ? groupId.slice(at + marker.length) : groupId;
}

function SignedBar({ value, max }: { value: number; max: number }) {
  const frac = max > 0 ? Math.min(1, Math.abs(value) / max) : 0;
  return (
    <span
      aria-hidden
      style={{
        display: "inline-block",
        width: 72,
        height: 8,
        background: "var(--color-background-secondary)",
        position: "relative",
      }}
    >
      <span
        style={{
          position: "absolute",
          insetBlock: 0,
          left: value >= 0 ? "50%" : `${50 - frac * 50}%`,
          width: `${frac * 50}%`,
          background: value >= 0 ? "var(--accent)" : "var(--color-text-info)",
        }}
      />
      <span
        style={{
          position: "absolute",
          insetBlock: 0,
          left: "50%",
          width: 1,
          background: "var(--color-border-primary)",
        }}
      />
    </span>
  );
}

export function ComponentsPanel({ journal }: { journal: RunJournal }) {
  useSyncExternalStore(subscribePieces, pieceVersion);
  const selection = useUi((s) => s.selection);
  const session = useSession();
  const components = useComponents();
  const [scope, setScope] = useState<"prediction" | "everywhere">("prediction");
  const [factor, setFactor] = useState("0");

  const derived = journal.derived;
  const loaded = session.load.phase === "loaded";
  const hasComponents = loaded; // the engine reports precisely on analyze

  if (!selection || selection.runId !== derived.runId) {
    return (
      <p style={monoMuted}>
        Select a committed token on the tape to decompose its prediction into
        per-component contributions.
      </p>
    );
  }
  const token = derived.tokens.find((t) => t.predictionIndex === selection.predictionIndex);
  if (!token) {
    return <p style={monoMuted}>No committed token at this position.</p>;
  }

  const analysis =
    components.analysis &&
    components.analysis.runId === selection.runId &&
    components.analysis.predictionIndex === selection.predictionIndex
      ? components.analysis
      : undefined;
  const result = analysis?.result;
  const decomposition = result?.margin ?? result?.score;

  const analyzeLabel = components.analyzing
    ? "Analyzing…"
    : analysis
      ? "Re-analyze"
      : "Analyze components";

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <Eyebrow>Prediction {selection.predictionIndex}</Eyebrow>
        <TokenCell piece={token.text || pieceFor(token.tokenId) || `#${token.tokenId}`} selected />
        <Button
          size="sm"
          disabled={components.analyzing || !hasComponents}
          onClick={() => void components.analyze(selection.runId, selection.predictionIndex, derived)}
        >
          {analyzeLabel}
        </Button>
        {components.overlayIdentity && <Tag color="var(--color-text-warning)">weights edited</Tag>}
      </div>
      <p style={{ ...monoMuted, margin: 0 }}>
        Replays the exact prefix ids on the idle model and decomposes the
        token's affine score into activation × effective write column per
        component (arXiv 2609.10210). Runs on the idle model, so an active
        session is ended first (its tape stays viewable); snapshots are not
        touched.
      </p>

      {components.blocked?.kind === "session" && (
        <div style={{ ...mono, color: "var(--color-text-warning)", display: "flex", gap: 10, alignItems: "center" }}>
          a session is active — component analysis needs the idle model
          <Button size="sm" onClick={() => void session.endSession()}>
            End session
          </Button>
        </div>
      )}
      {components.blocked?.kind === "other" && (
        <div style={{ ...mono, color: "var(--color-text-danger)" }}>{components.blocked.message}</div>
      )}

      {result && decomposition && (
        <>
          <div>
            <Eyebrow style={{ marginBottom: 4 }}>Reconstruction</Eyebrow>
            <div style={mono}>
              score {result.score.actual.toFixed(4)} · reconstructed{" "}
              {result.score.reconstructed.toFixed(4)} · error{" "}
              {result.score.absoluteError.toExponential(1)} over{" "}
              {result.score.componentCount.toLocaleString()} components
            </div>
            {result.margin && (
              <div style={monoMuted}>
                margin vs{" "}
                <TokenCell
                  piece={
                    (result.competitorToken !== undefined && result.competitorToken !== null
                      ? pieceFor(result.competitorToken)
                      : undefined) ?? `#${result.competitorToken ?? UNKNOWN}`
                  }
                  muted
                />{" "}
                {result.margin.actual.toFixed(4)} · error {result.margin.absoluteError.toExponential(1)}
              </div>
            )}
            <div style={monoMuted}>
              embedding {decomposition.embedding.toFixed(3)} · norm/readout offset{" "}
              {decomposition.offset.toFixed(3)} · biases {decomposition.biasTerms.toFixed(3)}
              {decomposition.projectionInputCorrection !== 0 &&
                ` · head-input correction ${decomposition.projectionInputCorrection.toFixed(3)}`}
              {decomposition.otherWrites.length > 0 &&
                ` · ${decomposition.otherWrites.length} whole writes ${decomposition.otherWrites
                  .reduce((a, [, v]) => a + v, 0)
                  .toFixed(3)}`}
              {decomposition.nestedComponents > 0 &&
                ` · nested ${decomposition.nestedComponentSum.toFixed(3)} (${decomposition.nestedComponents})`}
            </div>
            <p style={{ ...monoMuted, margin: "4px 0 0" }}>
              affine score before any output transform; margin decomposition
              ranks what separated the token from its strongest competitor
            </p>
          </div>

          <TopComponents
            top={decomposition.top}
            selected={components.selected}
            toggle={components.toggle}
          />

          <GroupTable decomposition={decomposition} />

          <div>
            <Eyebrow style={{ marginBottom: 4 }}>Causal trials</Eyebrow>
            <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
              <Select
                value={scope}
                onChange={(v) => setScope(v as "prediction" | "everywhere")}
                options={[
                  { value: "prediction", label: "This prediction only" },
                  { value: "everywhere", label: "All positions" },
                ]}
              />
              <Button
                size="sm"
                disabled={components.selected.size === 0}
                onClick={() => void components.runTrial(false, scope)}
              >
                Delete selected ({components.selected.size})
              </Button>
              <Button
                size="sm"
                disabled={components.selected.size === 0}
                onClick={() => void components.runTrial(true, scope)}
              >
                Keep only selected
              </Button>
              {components.selected.size > 0 && (
                <Button size="sm" variant="ghost" onClick={components.clearSelection}>
                  Clear
                </Button>
              )}
            </div>
            <p style={{ ...monoMuted, margin: "4px 0 0" }}>
              a fresh replay recomputes the forward with the selected
              components zeroed (survivors respond to the modified residual);
              the sampler then continues freely
            </p>
            {components.trials.map((trial, i) => (
              <TrialRow
                // Trials are append-only within one analysis.
                // eslint-disable-next-line react/no-array-index-key
                key={i}
                label={trial.label}
                running={trial.running}
                error={trial.error}
                result={trial.result}
                baselineTarget={formatTokenScore(result, result.targetToken)}
                targetToken={result.targetToken}
                competitorToken={result.competitorToken ?? undefined}
              />
            ))}
          </div>

          <div>
            <Eyebrow style={{ marginBottom: 4 }}>Write (edit weights)</Eyebrow>
            {components.overlayIdentity ? (
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                <div style={{ ...mono, color: "var(--color-text-warning)" }}>
                  overlay active: {components.overlayIdentity}
                </div>
                <p style={{ ...monoMuted, margin: 0 }}>
                  edited weights apply to every new run and analysis until
                  removed; re-analyze to measure the edited model
                </p>
                <div>
                  <Button
                    size="sm"
                    disabled={components.overlayBusy}
                    onClick={() => void components.removeOverlay()}
                  >
                    Remove overlay (restore originals)
                  </Button>
                </div>
              </div>
            ) : (
              <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                <span style={mono}>scale write columns by</span>
                <input
                  value={factor}
                  onChange={(e) => setFactor(e.target.value)}
                  style={{ ...mono, width: 48, padding: "2px 4px", border: "1px solid var(--color-border-primary)", background: "transparent", color: "var(--text)" }}
                />
                <Button
                  size="sm"
                  disabled={
                    components.selected.size === 0 ||
                    components.overlayBusy ||
                    !Number.isFinite(Number(factor))
                  }
                  onClick={() => void components.installScaleOverlay(Number(factor))}
                >
                  Install overlay ({components.selected.size})
                </Button>
              </div>
            )}
            <p style={{ ...monoMuted, margin: "4px 0 0" }}>
              installs a reversible parameter overlay on the idle model (0 =
              delete the component from the weights); installation and removal
              clear KV state and invalidate snapshots and prepared runs
            </p>
          </div>
        </>
      )}
    </div>
  );
}

function TopComponents({
  top,
  selected,
  toggle,
}: {
  top: ComponentContribution[];
  selected: Set<string>;
  toggle: (groupId: string, index: number) => void;
}) {
  const [shown, setShown] = useState(24);
  const max = top.length > 0 ? Math.abs(top[0].value) : 0;
  return (
    <div>
      <Eyebrow style={{ marginBottom: 4 }}>Strongest components</Eyebrow>
      <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
        {top.slice(0, shown).map((c) => {
          const k = key(c.group, c.index);
          return (
            <div key={k} style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <Checkbox checked={selected.has(k)} onChange={() => toggle(c.group, c.index)} />
              <span style={{ ...mono, flex: "1 1 auto", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                title={`${c.group}[${c.index}] · activation ${c.activation.toPrecision(4)}${c.nested ? " · nested in a whole write" : ""}`}
              >
                L{c.layer} {groupSuffix(c.group, c.layer)}[{c.index}]
                {c.nested ? " ◦" : ""}
              </span>
              <SignedBar value={c.value} max={max} />
              <span style={{ ...mono, width: 64, textAlign: "right" }}>{c.value.toFixed(3)}</span>
            </div>
          );
        })}
      </div>
      {shown < top.length && (
        <Button size="sm" variant="ghost" onClick={() => setShown(top.length)}>
          Show all {top.length}
        </Button>
      )}
      <p style={{ ...monoMuted, margin: "4px 0 0" }}>
        signed contribution to this score · ◦ = constituent of a whole
        residual write (not an additional term)
      </p>
    </div>
  );
}

function GroupTable({
  decomposition,
}: {
  decomposition: { groups: { group: string; layer: number; count: number; sum: number; sumAbs: number; nested: boolean; axisMismatch: boolean }[] };
}) {
  const groups = [...decomposition.groups].sort((a, b) => b.sumAbs - a.sumAbs).slice(0, 12);
  const max = groups.length > 0 ? Math.max(...groups.map((g) => Math.abs(g.sum))) : 0;
  return (
    <div>
      <Eyebrow style={{ marginBottom: 4 }}>Group totals</Eyebrow>
      <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
        {groups.map((g) => (
          <div key={g.group} style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ ...mono, flex: "1 1 auto", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={`${g.group} · ${g.count} components · Σ|v| ${g.sumAbs.toFixed(3)}${g.axisMismatch ? " · ranked over write rows, not maskable ids" : ""}`}>
              L{g.layer} {groupSuffix(g.group, g.layer)}
              {g.nested ? " ◦" : ""}
              {g.axisMismatch ? " ⚠" : ""}
            </span>
            <SignedBar value={g.sum} max={max} />
            <span style={{ ...mono, width: 64, textAlign: "right" }}>{g.sum.toFixed(3)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function TrialRow({
  label,
  running,
  error,
  result,
  baselineTarget,
  targetToken,
  competitorToken,
}: {
  label: string;
  running: boolean;
  error?: string;
  result?: ComponentTrialResult;
  baselineTarget?: number;
  targetToken: number;
  competitorToken?: number;
}) {
  useSyncExternalStore(subscribePieces, pieceVersion);
  if (running) {
    return <div style={{ ...mono, marginTop: 6 }}>{label} — running…</div>;
  }
  if (error || !result) {
    return (
      <div style={{ ...mono, marginTop: 6, color: "var(--color-text-danger)" }}>
        {label} — {error ?? "no result"}
      </div>
    );
  }
  const target = formatTokenScore(result, targetToken);
  const competitor = competitorToken !== undefined ? formatTokenScore(result, competitorToken) : undefined;
  const delta =
    target !== undefined && baselineTarget !== undefined ? target - baselineTarget : undefined;
  return (
    <div style={{ marginTop: 6, borderLeft: "2px solid var(--color-border-primary)", paddingLeft: 8 }}>
      <div style={mono}>
        {label} · target score{" "}
        {target !== undefined ? target.toFixed(4) : UNKNOWN}
        {delta !== undefined && (
          <span style={{ color: delta < 0 ? "var(--color-text-info)" : "var(--accent)" }}>
            {" "}
            ({delta >= 0 ? "+" : ""}
            {delta.toFixed(4)})
          </span>
        )}
        {competitor !== undefined && ` · competitor ${competitor.toFixed(4)}`}
        {result.status !== "completed" && ` · ${result.status}`}
      </div>
      {result.failure && (
        <div style={{ ...mono, color: "var(--color-text-danger)" }}>{result.failure}</div>
      )}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 2, marginTop: 2 }}>
        {result.generated.map((t, i) => (
          // eslint-disable-next-line react/no-array-index-key
          <TokenCell key={i} piece={t.text || pieceFor(t.id) || `#${t.id}`} muted />
        ))}
      </div>
    </div>
  );
}
