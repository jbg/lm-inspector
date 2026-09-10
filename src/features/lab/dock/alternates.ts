// Alternates math: extract the top-k candidates capture for a prediction and
// softmax over the captured k RAW logits. Always labeled pre-sampler — eredu
// exposes RawLogitsBeforeSampling, never the sampler's processed distribution.

import { i64ToNumber } from "../../../lib/lossless";
import type { CandidatesPayload, DerivedRun } from "../../../state/journal/reconcile";

export interface TopkView {
  stage?: string;
  source?: string;
  /** Exact pre-override sampling domain (eredu); undefined = unknown. */
  domain?: { allowedTokens: number; vocabulary: number; constrained: boolean };
  entries: { tokenId: number; score: number; probability: number; forbidden: boolean }[];
}

export function topkForPrediction(derived: DerivedRun, predictionIndex: number): TopkView | undefined {
  const step = derived.capturesByPrediction.get(predictionIndex);
  if (!step) return undefined;
  for (const record of step.records) {
    const payload = record.payload;
    if (payload && payload.kind === "candidates") {
      return toView(payload.value);
    }
  }
  return undefined;
}

function toView(value: CandidatesPayload): TopkView {
  const scores = value.candidates.map((c) => c.score);
  const max = Math.max(...scores);
  const exps = scores.map((s) => Math.exp(s - max));
  const sum = exps.reduce((a, b) => a + b, 0) || 1;
  const domain = value.domain
    ? {
        allowedTokens: i64ToNumber(value.domain.allowed_tokens),
        vocabulary: i64ToNumber(value.domain.vocabulary),
        constrained: value.domain.constrained,
      }
    : undefined;
  return {
    stage: value.stage,
    source: value.source,
    domain,
    entries: value.candidates.map((c, i) => ({
      tokenId: c.token_id,
      score: c.score,
      probability: exps[i] / sum,
      // allowed defaults true on old records/unknown domains — only a known
      // domain makes "forbidden" an honest claim.
      forbidden: domain !== undefined && c.allowed === false,
    })),
  };
}

export function chosenProbability(view: TopkView, tokenId: number): number | undefined {
  return view.entries.find((e) => e.tokenId === tokenId)?.probability;
}

export function chosenRank(view: TopkView, tokenId: number): number | undefined {
  const i = view.entries.findIndex((e) => e.tokenId === tokenId);
  return i >= 0 ? i + 1 : undefined;
}

/** Top-2 candidates within this margin of top-k mass = a "close call" — the
 * decision could easily have gone the other way; prime counterfactual bait. */
export const CLOSE_CALL_MARGIN = 0.1;

/** Margin between the top two candidates that were actually sampleable — a
 * grammar-forbidden runner-up is not a counterfactual invitation. */
export function closeCallMargin(view: TopkView): number | undefined {
  const allowed = view.entries.filter((e) => !e.forbidden);
  return allowed.length >= 2 ? allowed[0].probability - allowed[1].probability : undefined;
}

export interface ChosenSignals {
  /** Sampling rank of the chosen token among captured candidates (1 = argmax). */
  sampledRank?: number;
  chosenProb?: number;
  /** p(top1) − p(top2) over the captured top-k mass. */
  topMargin?: number;
  closeCall: boolean;
}

export function chosenSignals(derived: DerivedRun, predictionIndex: number, tokenId: number): ChosenSignals {
  const view = topkForPrediction(derived, predictionIndex);
  if (!view || view.entries.length === 0) return { closeCall: false };
  const sampledRank = chosenRank(view, tokenId);
  const chosenProb = chosenProbability(view, tokenId);
  const topMargin = closeCallMargin(view);
  return {
    sampledRank,
    chosenProb,
    topMargin,
    closeCall: topMargin !== undefined && topMargin < CLOSE_CALL_MARGIN,
  };
}
