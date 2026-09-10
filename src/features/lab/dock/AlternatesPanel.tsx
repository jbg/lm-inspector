// The centerpiece: per-token top-k candidates with the chosen token pinned
// first, honest softmax(raw logits) labeling, FORCE→ counterfactual branching,
// and a vocabulary search for forcing arbitrary tokens.

import { useEffect, useState, useSyncExternalStore } from "react";
import { Eyebrow } from "../../../goose/ui";
import { Tag } from "../../../goose/ui";
import { Button } from "../../../goose/ui";
import { Input } from "../../../goose/ui";
import { Switch } from "../../../goose/ui";
import { TokenCell } from "../../common/TokenCell";
import { ProbBar } from "../../../viz/viz";
import { useUi } from "../../../state/ui";
import { useSession } from "../../../state/session";
import { formatPercent, UNKNOWN } from "../../../lib/format";
import { live, type VocabPage } from "../../../lib/liveIpc";
import { pieceFor, pieceVersion, subscribePieces } from "../../../lib/pieceCache";
import type { RunJournal } from "../../../state/journal/journal";
import { CLOSE_CALL_MARGIN, chosenRank, closeCallMargin, topkForPrediction } from "./alternates";

export function AlternatesPanel({ journal }: { journal: RunJournal }) {
  const derived = journal.derived;
  const selection = useUi((s) => s.selection);
  const follow = useUi((s) => s.follow);
  useSyncExternalStore(subscribePieces, pieceVersion);

  const predictionIndex =
    selection?.runId === derived.runId
      ? selection.predictionIndex
      : follow && derived.tokens.length > 0
        ? derived.tokens[derived.tokens.length - 1].predictionIndex
        : undefined;

  if (predictionIndex === undefined) {
    return (
      <p style={{ fontFamily: "var(--font-code)", fontSize: 12, color: "var(--text-muted)" }}>
        Select a token on the tape (or generate) to see its alternatives.
      </p>
    );
  }

  const token = derived.tokens.find((t) => t.predictionIndex === predictionIndex);
  const topk = topkForPrediction(derived, predictionIndex);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <Eyebrow>
          Position {predictionIndex}
          {follow && selection === undefined ? " · Following ⏵" : ""}
        </Eyebrow>
        {token?.forced && <Tag size="sm" color="accent">Forced</Tag>}
        {token?.replay && <Tag size="sm">Replayed</Tag>}
      </div>

      {!topk ? (
        <MissingCapture derived={derived} predictionIndex={predictionIndex} />
      ) : (
        <CandidateRows journal={journal} predictionIndex={predictionIndex} chosenId={token?.tokenId} />
      )}

      <VocabSearch journal={journal} predictionIndex={predictionIndex} />
    </div>
  );
}

function MissingCapture({ derived, predictionIndex }: { derived: RunJournal["derived"]; predictionIndex: number }) {
  const step = derived.capturesByPrediction.get(predictionIndex);
  const reason = step
    ? "no top-candidates selection captured at this position"
    : "no captures recorded at this position (capture off, budget skip, or a prompt token)";
  return (
    <p style={{ fontFamily: "var(--font-code)", fontSize: 12, color: "var(--text-muted)" }}>
      No alternates — {reason}
    </p>
  );
}

function CandidateRows({
  journal,
  predictionIndex,
  chosenId,
}: {
  journal: RunJournal;
  predictionIndex: number;
  chosenId?: number;
}) {
  const derived = journal.derived;
  const topk = topkForPrediction(derived, predictionIndex)!;
  const [expanded, setExpanded] = useState(false);
  const [forceTarget, setForceTarget] = useState<number>();

  const rank = chosenId !== undefined ? chosenRank(topk, chosenId) : undefined;
  const rows = expanded ? topk.entries : topk.entries.slice(0, 8);
  // Higher-ranked candidates the constraint ruled out: the honest explanation
  // for a rank-N pick is the grammar, not the dice, when all of them were
  // forbidden.
  const forbiddenAbove =
    rank !== undefined && rank > 1 ? topk.entries.slice(0, rank - 1).filter((e) => e.forbidden).length : 0;
  const margin = closeCallMargin(topk);

  return (
    <div>
      <p style={{ fontFamily: "var(--font-code)", fontSize: 10, color: "var(--text-muted)", margin: "0 0 8px" }}>
        softmax over top-{topk.entries.length} RAW logits — before temperature,
        penalties and the sampler. Not the sampler's final distribution.
        {topk.source === "effective" ? " · effective (post-intervention)" : ""}
      </p>
      {topk.domain?.constrained && (
        <p className="sp-eyebrow" style={{ color: "var(--accent-2)", margin: "0 0 8px" }}>
          Grammar constrained — {topk.domain.allowedTokens.toLocaleString()} of{" "}
          {topk.domain.vocabulary.toLocaleString()} token ids sampleable
        </p>
      )}
      {rank !== undefined && rank > 1 && (
        <p className="sp-eyebrow" style={{ color: "var(--accent)", margin: "0 0 8px" }}>
          {forbiddenAbove === rank - 1
            ? `Sampled rank ${rank} — every higher-scoring candidate forbidden by the constraint`
            : `Sampled rank ${rank} — the dice rolled`}
        </p>
      )}
      {margin !== undefined && margin < CLOSE_CALL_MARGIN && (
        <p className="sp-eyebrow" style={{ color: "var(--accent)", margin: "0 0 8px" }}>
          Close call — top two sampleable within {(margin * 100).toFixed(1)}%
        </p>
      )}
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        {rows.map((entry, i) => {
          const chosen = entry.tokenId === chosenId;
          const piece = pieceFor(entry.tokenId) ?? `#${entry.tokenId}`;
          const detail =
            `"${piece}" · id ${entry.tokenId} · raw logit ${entry.score.toFixed(2)} · ${formatPercent(entry.probability)} of top-k mass` +
            (entry.forbidden ? " · forbidden by the tokenizer/grammar domain — never sampleable here" : "");
          return (
            <div key={entry.tokenId}>
              <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }} title={detail}>
                <span style={{ fontFamily: "var(--font-code)", fontSize: 10, color: "var(--text-muted)", width: 16, textAlign: "right", flex: "none" }}>
                  {i + 1}
                </span>
                {/* Token text is the primary, flexible column — long tokens
                    take the room; detail numbers live in the row tooltip. */}
                <span style={{ flex: "1 1 auto", minWidth: 70, overflow: "hidden", whiteSpace: "nowrap", textOverflow: "ellipsis" }}>
                  <TokenCell piece={piece} selected={chosen} forbidden={entry.forbidden} />
                </span>
                <span style={{ flex: "none" }}>
                  <ProbBar fraction={entry.probability} accent={chosen} width={90} title={detail} />
                </span>
                <span style={{ fontFamily: "var(--font-code)", fontSize: 11, width: 48, textAlign: "right", flex: "none" }}>
                  {formatPercent(entry.probability)}
                </span>
                {chosen ? (
                  <span className="sp-eyebrow" style={{ color: "var(--accent)", flex: "none" }}>
                    ▶ Chosen
                  </span>
                ) : (
                  <Button size="sm" variant="ghost" style={{ flex: "none" }} onClick={() => setForceTarget(entry.tokenId)}>
                    Force →
                  </Button>
                )}
              </div>
              {forceTarget === entry.tokenId && (
                <ForceCard
                  journal={journal}
                  predictionIndex={predictionIndex}
                  tokenId={entry.tokenId}
                  onClose={() => setForceTarget(undefined)}
                />
              )}
            </div>
          );
        })}
      </div>
      {topk.entries.length > 8 && (
        <Button size="sm" variant="ghost" onClick={() => setExpanded((v) => !v)}>
          {expanded ? "Show fewer" : `Show all ${topk.entries.length}`}
        </Button>
      )}
      <p style={{ fontFamily: "var(--font-code)", fontSize: 10, color: "var(--text-muted)", margin: "6px 0 0" }}>
        residual mass outside top-{topk.entries.length}: unknown
      </p>
    </div>
  );
}

export function ForceCard({
  journal,
  predictionIndex,
  tokenId,
  onClose,
}: {
  journal: RunJournal;
  predictionIndex: number;
  tokenId: number;
  onClose: () => void;
}) {
  const session = useSession();
  const derived = journal.derived;
  const [autoRun, setAutoRun] = useState(true);
  const [temp, setTemp] = useState("");
  const [reseed, setReseed] = useState("");
  useSyncExternalStore(subscribePieces, pieceVersion);

  const isHead = derived.tokens.length === 0 || predictionIndex >= (derived.nextPrediction ?? derived.tokens.length);
  const nearest = [...derived.snapshots]
    .filter((s) => s.nextPrediction <= predictionIndex)
    .sort((a, b) => b.nextPrediction - a.nextPrediction)[0];
  const replayCount = nearest ? predictionIndex - nearest.nextPrediction : undefined;
  const unreachable = !isHead && !nearest;
  const piece = pieceFor(tokenId) ?? `#${tokenId}`;

  const go = async () => {
    if (isHead) {
      await session.forceHead(tokenId);
      if (autoRun) await session.step(1);
      onClose();
      return;
    }
    await session.counterfactual(derived.runId, predictionIndex, tokenId, {
      temperature: temp === "" ? undefined : Number(temp),
      reseed: reseed === "" ? undefined : Number(reseed),
      autoContinue: autoRun,
    });
    onClose();
  };

  return (
    <div style={{ border: "2px solid var(--accent)", padding: 12, margin: "6px 0 6px 24px", display: "flex", flexDirection: "column", gap: 8 }}>
      <Eyebrow>
        {isHead ? "Force next token" : `Branch from position ${predictionIndex}`}
      </Eyebrow>
      <div style={{ fontFamily: "var(--font-code)", fontSize: 12 }}>
        ▸ force <TokenCell piece={piece} /> {isHead ? "as the next decision" : "instead of the committed token"}
      </div>
      {!isHead && nearest && (
        <div style={{ fontFamily: "var(--font-code)", fontSize: 11, color: "var(--text-muted)" }}>
          from snapshot ◆ @ {nearest.nextPrediction} · replays {replayCount} token
          {replayCount === 1 ? "" : "s"} (exact inherited RNG)
        </div>
      )}
      {unreachable && (
        <div style={{ fontFamily: "var(--font-code)", fontSize: 11, color: "var(--accent)" }}>
          NO SNAPSHOT COVERAGE at or before this position — earlier positions
          only become branchable where ◆ pins exist
        </div>
      )}
      {!isHead && (
        <div style={{ display: "flex", gap: 8, alignItems: "flex-end" }}>
          <Input label="Temp" type="number" value={temp} onChange={(e) => setTemp((e.target as HTMLInputElement).value)} hint="blank = inherit" style={{ width: 100 }} />
          <Input label="Reseed" type="number" value={reseed} onChange={(e) => setReseed((e.target as HTMLInputElement).value)} hint="blank = exact RNG" style={{ width: 100 }} />
        </div>
      )}
      <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
        <Switch label="Auto-run after" checked={autoRun} onChange={setAutoRun} />
        <div style={{ flex: 1 }} />
        <Button size="sm" variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button size="sm" disabled={unreachable} onClick={() => void go()}>
          ■ {isHead ? "Force" : "Create branch"}
        </Button>
      </div>
    </div>
  );
}

function VocabSearch({ journal, predictionIndex }: { journal: RunJournal; predictionIndex: number }) {
  const [query, setQuery] = useState("");
  const [page, setPage] = useState<VocabPage>();
  const [forceTarget, setForceTarget] = useState<number>();

  useEffect(() => {
    if (!query) {
      setPage(undefined);
      return;
    }
    let cancelled = false;
    const handle = setTimeout(async () => {
      try {
        const result = await live.getVocabularyPage(0, 24, query);
        if (!cancelled) setPage(result);
      } catch {
        if (!cancelled) setPage(undefined);
      }
    }, 200);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [query]);

  return (
    <details style={{ marginTop: 8 }}>
      <summary className="sp-eyebrow" style={{ cursor: "pointer" }}>
        Force other token… (vocabulary search)
      </summary>
      <Input
        placeholder="Search text or token ID"
        value={query}
        onChange={(e) => setQuery((e.target as HTMLInputElement).value)}
        style={{ margin: "8px 0" }}
        hint={page ? `${page.total} matches` : undefined}
      />
      <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
        {page?.entries.map((entry) => (
          <span key={entry.id}>
            <button
              onClick={() => setForceTarget(entry.id)}
              style={{ background: "none", border: "1px solid var(--border)", cursor: "pointer", padding: 2 }}
              title={`id ${entry.id} · vocab piece "${entry.text}"`}
            >
              <TokenCell piece={pieceFor(entry.id) ?? entry.text} />
            </button>
          </span>
        ))}
      </div>
      {forceTarget !== undefined && (
        <ForceCard
          journal={journal}
          predictionIndex={predictionIndex}
          tokenId={forceTarget}
          onClose={() => setForceTarget(undefined)}
        />
      )}
      <p style={{ fontFamily: "var(--font-code)", fontSize: 10, color: "var(--text-muted)" }}>
        forcing validates against the vocabulary and any active grammar — invalid
        choices are rejected with eredu's exact reason
      </p>
    </details>
  );
}

export const UNKNOWN_LABEL = UNKNOWN;
