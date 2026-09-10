// Run statistics: token/timing StatBlocks, step-time sparkline, and in
// speculative mode the acceptance ledger (per-block dispositions).

import { StatBlock } from "../../../goose/ui";
import { Eyebrow } from "../../../goose/ui";
import { Tag } from "../../../goose/ui";
import { Sparkline } from "../../../viz/viz";
import { formatMs, formatPercent, UNKNOWN } from "../../../lib/format";
import type { RunJournal } from "../../../state/journal/journal";
import type { SpecBlock } from "../../../state/journal/reconcile";
import { TokenCell } from "../../common/TokenCell";
import { pieceFor, pieceVersion, subscribePieces } from "../../../lib/pieceCache";
import { useSyncExternalStore } from "react";

export function StatsView({ journal }: { journal: RunJournal }) {
  const derived = journal.derived;
  const stepTimes = derived.tokens.map((t) => t.stepSeconds).filter((s) => s > 0);
  const total = stepTimes.reduce((a, b) => a + b, 0);
  const ttftMs = derived.tokens.length > 0 ? derived.tokens[0].stepSeconds * 1000 : undefined;
  const tokPerSec = total > 0 ? stepTimes.length / total : undefined;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 16 }}>
        <StatBlock size={72} tone="accent" value={derived.tokens.length} label="Tokens" />
        <StatBlock size={72} tone="blue" value={ttftMs !== undefined ? formatMs(ttftMs) : UNKNOWN} label="TTFT*" />
        <StatBlock size={72} tone="gray" value={tokPerSec !== undefined ? tokPerSec.toFixed(1) : UNKNOWN} label="Tok/s" />
      </div>
      <p style={{ fontFamily: "var(--font-code)", fontSize: 10, color: "var(--text-muted)", margin: 0 }}>
        *first-step time — active generation only; pauses and inspection excluded
      </p>

      {stepTimes.length > 1 && (
        <div>
          <Eyebrow style={{ marginBottom: 4 }}>Step time</Eyebrow>
          <Sparkline values={stepTimes.slice(-80)} width={320} height={28} title="seconds per step" />
        </div>
      )}

      <div style={{ fontFamily: "var(--font-code)", fontSize: 11, color: "var(--text-muted)" }}>
        status {derived.status}
        {derived.finishReason ? ` · ■ ${derived.finishReason}` : ""}
        {derived.seed !== undefined ? ` · seed ${String(derived.seed)}` : ""}
        {` · epoch ${String(derived.epoch)}`}
      </div>

      {derived.speculative && <SpecStats journal={journal} />}
    </div>
  );
}

function SpecStats({ journal }: { journal: RunJournal }) {
  const derived = journal.derived;
  useSyncExternalStore(subscribePieces, pieceVersion);
  const blocks = derived.specBlocks;
  const withVerification = blocks.filter((b) => b.verification?.dispositions);
  const proposed = withVerification.reduce((a, b) => a + (b.verification?.dispositions?.length ?? 0), 0);
  const accepted = withVerification.reduce(
    (a, b) => a + (b.verification?.dispositions?.filter((d) => d === "accepted").length ?? 0),
    0,
  );
  const committed = blocks.reduce((a, b) => a + b.committedTokenIds.length, 0);
  const acceptRate = proposed > 0 ? accepted / proposed : undefined;
  const perBlockRate = withVerification.map((b) => {
    const d = b.verification!.dispositions!;
    return d.length ? d.filter((x) => x === "accepted").length / d.length : 0;
  });

  return (
    <div>
      <Eyebrow style={{ marginBottom: 8 }}>Speculation</Eyebrow>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 16, marginBottom: 8 }}>
        <StatBlock size={64} tone="accent" value={acceptRate !== undefined ? formatPercent(acceptRate, 0) : UNKNOWN} label="Accept rate" />
        <StatBlock
          size={64}
          tone="blue"
          value={withVerification.length ? (committed / withVerification.length).toFixed(1) : UNKNOWN}
          label="Tok / block"
        />
        <StatBlock size={64} tone="gray" value={blocks.length} label="Steps" />
      </div>
      {perBlockRate.length > 1 && (
        <Sparkline values={perBlockRate} width={320} height={24} title="acceptance rate per block" />
      )}

      <Eyebrow style={{ margin: "12px 0 6px" }}>Ledger (latest 6 blocks)</Eyebrow>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {blocks.slice(-6).reverse().map((block) => (
          <LedgerRow key={String(block.seq)} block={block} />
        ))}
      </div>
    </div>
  );
}

function LedgerRow({ block }: { block: SpecBlock }) {
  const drafted = extractDraftIds(block.drafted);
  const dispositions = block.verification?.dispositions ?? [];
  const resolved = block.verification?.resolved !== false;
  return (
    <div style={{ borderBottom: "1px solid var(--spiral-gray-200)", paddingBottom: 6, fontFamily: "var(--font-code)", fontSize: 11 }}>
      <div style={{ color: "var(--text-muted)" }}>
        step {String(block.seq)} · epoch {String(block.epoch)}
        {!resolved && <Tag size="sm" color="accent" style={{ marginLeft: 8 }}>Cancelled — decisions not applied</Tag>}
      </div>
      {drafted.length > 0 && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 3, margin: "4px 0" }}>
          {drafted.map((id, i) => {
            const d = dispositions[i];
            const color =
              d === "accepted" ? "var(--text)" : d === "rejected" ? "var(--accent)" : "var(--spiral-gray-400)";
            const deco = d === "rejected" || d === "discarded" ? "line-through" : "none";
            return (
              <span key={i} style={{ border: `1px solid ${color}`, color, textDecoration: deco, padding: "0 3px" }} title={d ?? "pending"}>
                <TokenCell piece={pieceFor(id) ?? `#${id}`} muted={d !== "accepted"} />
              </span>
            );
          })}
        </div>
      )}
      {block.committedTokenIds.length > 0 && (
        <div>
          → committed{" "}
          {block.committedTokenIds.map((id, i) => (
            <TokenCell key={i} piece={pieceFor(id) ?? `#${id}`} speculative />
          ))}
          {block.forcedToken != null && <Tag size="sm" color="accent" style={{ marginLeft: 6 }}>Forced</Tag>}
        </div>
      )}
    </div>
  );
}

export function extractDraftIds(drafted: unknown): number[] {
  if (!drafted || typeof drafted !== "object") return [];
  const o = drafted as Record<string, unknown>;
  for (const key of ["tokens", "token_ids", "proposals", "proposal_token_ids"]) {
    const v = o[key];
    if (Array.isArray(v) && v.every((x) => typeof x === "number")) return v as number[];
  }
  for (const v of Object.values(o)) {
    if (Array.isArray(v) && v.every((x) => typeof x === "number")) return v as number[];
  }
  return [];
}
