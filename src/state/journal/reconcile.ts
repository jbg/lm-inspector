// Pure event-journal reconciliation. Records arrive as parsed envelope
// payloads keyed (run_id, sequence, epoch); this module folds them into a
// DerivedRun the tape and panels render from. Rules follow eredu's
// lm-inspector-execution-control doc:
//   - sequences are strictly monotone across a run's whole journal
//   - Restored{output} truncates the visible view to sequence <
//     output.next_sequence and bumps the epoch; truncated tokens are retained
//     separately as "abandoned", never concatenated with the new path
//   - BranchStarted seeds a child run entirely from the record itself
//   - absent values stay undefined (unknown ≠ zero)

import { type I64, i64Compare, i64ToNumber } from "../../lib/lossless";

// ----- record shapes (structural, snake_case from serde) -----

export interface ControlledRecord {
  schema_version: number;
  sequence: I64;
  epoch: I64;
  timing?: Timing;
  generation: {
    schema_version: number;
    run_id: string;
    artifact_identity?: string;
    session_id?: string;
    capture_plan_id?: string;
    intervention_plan_id?: string;
    event: GenerationEvent;
  };
}

export interface Timing {
  [key: string]: unknown;
}

export type SemanticEvent =
  | { ReasoningDelta: string }
  | { TextDelta: string }
  | { ToolCallStart: { index: number; id: string; name: string } }
  | { ToolArgumentsDelta: { index: number; json_fragment: string } }
  | "ToolCallEnd"
  | { Finished: { reason: string } };

export interface CapturedStep {
  phase: string;
  prediction_index: I64;
  records: CaptureRecord[];
  interventions: InterventionRecord[];
  step_usage?: Record<string, I64>;
  cumulative_usage?: Record<string, I64>;
  capture_seconds?: number;
}

export interface CaptureRecord {
  selection_id: string;
  path: string;
  node_id?: string;
  position?: string;
  source_shape?: I64[];
  selected_shape?: I64[];
  outcome: unknown;
  payload?: CapturePayload;
  charged?: Record<string, I64>;
  [key: string]: unknown;
}

export type CapturePayload =
  | { kind: "tensor"; value: unknown }
  | { kind: "summary"; value: SummaryPayload }
  | { kind: "histogram"; value: HistogramPayload }
  | { kind: "candidates"; value: CandidatesPayload };

export interface SummaryPayload {
  elements?: I64;
  finite?: I64;
  non_finite?: I64;
  nan?: I64;
  positive_infinity?: I64;
  negative_infinity?: I64;
  min?: number | null;
  max?: number | null;
  mean?: number | null;
  rms?: number | null;
  [key: string]: unknown;
}

export interface HistogramPayload {
  edges: number[];
  counts: I64[];
  below?: I64;
  above?: I64;
  non_finite?: I64;
  [key: string]: unknown;
}

export interface CandidatesPayload {
  stage?: string;
  source?: string;
  /** allowed defaults true when absent; only meaningful when domain is known. */
  candidates: { token_id: number; score: number; allowed?: boolean }[];
  /** Exact pre-override sampling domain; absent = unknown, not permission. */
  domain?: { allowed_tokens: I64; vocabulary: I64; constrained: boolean };
  [key: string]: unknown;
}

export interface InterventionRecord {
  plan_id?: string;
  operation_id: string;
  target: string;
  node_id?: string;
  phase?: string;
  prediction_index?: I64;
  outcome: unknown;
  evidence?: CaptureRecord[];
  charged?: Record<string, I64>;
  [key: string]: unknown;
}

export type GenerationEvent =
  | {
      kind: "started";
      prompt_token_ids: number[];
      generation: Record<string, unknown>;
      seed: I64;
    }
  | {
      kind: "token";
      token_id: number;
      forced?: boolean;
      prediction_index: I64;
      input_range: [I64, I64];
      committed: boolean;
      rank: number;
      captures?: CapturedStep | null;
      step_seconds: number;
    }
  | { kind: "semantic"; prediction_index?: I64 | null; event: SemanticEvent }
  | { kind: "completed"; reason: string; generated_tokens: I64; elapsed_seconds: number }
  | { kind: "failed"; message: string; elapsed_seconds: number }
  | { kind: "lifecycle"; status: string; next_prediction: I64 }
  | { kind: "snapshot_created"; metadata: SnapshotMetadata }
  | { kind: "restored"; snapshot_id: string; output: OutputCheckpoint }
  | {
      kind: "sampling_changed";
      next_prediction: I64;
      request: Record<string, unknown>;
      before: Record<string, unknown>;
      after: Record<string, unknown>;
    }
  | {
      kind: "branch_started";
      lineage: BranchLineage;
      prompt_token_ids: number[];
      inherited_token_ids: number[];
      inherited_semantics: SemanticEvent[];
    }
  | {
      kind: "capture_failure";
      prediction_index: I64;
      input_range: [I64, I64];
      captures: CapturedStep;
      step_seconds: number;
    };

export interface OutputCheckpoint {
  run_id: string;
  epoch: I64;
  next_sequence: I64;
  next_prediction: I64;
}

export interface SnapshotMetadata {
  snapshot_id: string;
  status?: string;
  output: OutputCheckpoint;
  retained_bytes?: I64;
  pending_forced_token?: number | null;
  [key: string]: unknown;
}

export interface BranchLineage {
  run_id?: string;
  parent: SnapshotMetadata;
  sampling_override?: unknown;
  intervention_override?: unknown;
  [key: string]: unknown;
}

// ----- derived state -----

export interface TokenEntry {
  tokenId: number;
  predictionIndex: number;
  forced: boolean;
  rank: number;
  stepSeconds: number;
  seq: I64;
  epoch: I64;
  replay: boolean;
  speculative: boolean;
  /** Decoded text attributed to this prediction (from semantic deltas). */
  text: string;
  reasoning: boolean;
}

export interface ToolCallSpan {
  index: number;
  id: string;
  name: string;
  argsJson: string;
  done: boolean;
  predictionIndex?: number;
}

export interface SamplingMark {
  nextPrediction: number;
  request: Record<string, unknown>;
  before: Record<string, unknown>;
  after: Record<string, unknown>;
}

export interface SnapshotMark {
  snapshotId: string;
  nextPrediction: number;
  retainedBytes?: I64;
}

export interface AbandonedSegment {
  epoch: I64;
  tokens: TokenEntry[];
}

export interface SpecBlock {
  seq: I64;
  epoch: I64;
  status?: string;
  drafted?: unknown;
  verification?: SpecVerification | null;
  committedTokenIds: number[];
  forcedToken?: number | null;
  firstPrediction: number;
  stepSeconds?: number;
}

export interface SpecVerification {
  resolved?: boolean;
  proposals?: unknown;
  dispositions?: string[];
  committed_token_ids?: number[];
  optimistic?: unknown;
  optimistic_reused?: I64;
  optimistic_consumed?: I64;
  optimistic_discarded?: I64;
  [key: string]: unknown;
}

export interface DerivedRun {
  runId: string;
  epoch: I64;
  speculative: boolean;
  promptTokenIds: number[];
  seed?: I64;
  generationConfig?: Record<string, unknown>;
  tokens: TokenEntry[];
  toolCalls: ToolCallSpan[];
  capturesByPrediction: Map<number, CapturedStep>;
  interventionsByPrediction: Map<number, InterventionRecord[]>;
  captureFailures: { predictionIndex: number; captures: CapturedStep }[];
  samplingMarks: SamplingMark[];
  snapshots: SnapshotMark[];
  status: string;
  nextPrediction?: number;
  finishReason?: string;
  elapsedSeconds?: number;
  failureMessage?: string;
  inherited?: {
    lineage: BranchLineage;
    tokenIds: number[];
    text: string;
    divergencePrediction: number;
  };
  abandoned: AbandonedSegment[];
  specBlocks: SpecBlock[];
  pendingDraft?: unknown;
  /** What the most recent speculative step did — each eredu step() is one
   * scheduler phase, not one token. */
  specPhase?: "drafted" | "verifying" | "resolved" | "working";
  /** Lookahead: a next-block draft proposed while pendingDraft verifies. */
  pendingOptimistic?: unknown;
  lastSeq?: I64;
  /** Full generated text (committed view), reasoning excluded. */
  text: string;
  reasoningText: string;
}

export function emptyDerived(runId: string, speculative = false): DerivedRun {
  return {
    runId,
    epoch: 0,
    speculative,
    promptTokenIds: [],
    tokens: [],
    toolCalls: [],
    capturesByPrediction: new Map(),
    interventionsByPrediction: new Map(),
    captureFailures: [],
    samplingMarks: [],
    snapshots: [],
    status: "prepared",
    abandoned: [],
    specBlocks: [],
    text: "",
    reasoningText: "",
  };
}

export interface RawEntry {
  seq: I64;
  record: ControlledRecord;
  replay: boolean;
}

/** Apply one controlled record. Returns false when rejected (stale/duplicate). */
export function applyControlled(
  derived: DerivedRun,
  raw: RawEntry[],
  record: ControlledRecord,
  replay: boolean,
): boolean {
  if (derived.lastSeq !== undefined && i64Compare(record.sequence, derived.lastSeq) <= 0) {
    return false; // duplicate or out-of-order — Channel is ordered, so ignore
  }
  raw.push({ seq: record.sequence, record, replay });
  foldEvent(derived, record, replay);
  return true;
}

function foldEvent(derived: DerivedRun, record: ControlledRecord, replay: boolean): void {
  derived.lastSeq = record.sequence;
  derived.epoch = record.epoch;
  const ev = record.generation.event;
  switch (ev.kind) {
    case "started": {
      derived.promptTokenIds = ev.prompt_token_ids;
      derived.seed = ev.seed;
      derived.generationConfig = ev.generation;
      derived.status = "running";
      break;
    }
    case "token": {
      const predictionIndex = i64ToNumber(ev.prediction_index);
      derived.tokens.push({
        tokenId: ev.token_id,
        predictionIndex,
        forced: ev.forced ?? false,
        rank: ev.rank,
        stepSeconds: ev.step_seconds,
        seq: record.sequence,
        epoch: record.epoch,
        replay,
        speculative: false,
        text: "",
        reasoning: false,
      });
      if (ev.captures) {
        derived.capturesByPrediction.set(predictionIndex, ev.captures);
        if (ev.captures.interventions?.length) {
          derived.interventionsByPrediction.set(predictionIndex, ev.captures.interventions);
        }
      }
      break;
    }
    case "semantic": {
      applySemantic(derived, ev.event, ev.prediction_index ?? undefined);
      break;
    }
    case "completed": {
      derived.status = "completed";
      derived.finishReason = ev.reason;
      derived.elapsedSeconds = ev.elapsed_seconds;
      break;
    }
    case "failed": {
      derived.status = "failed";
      derived.failureMessage = ev.message;
      derived.elapsedSeconds = ev.elapsed_seconds;
      break;
    }
    case "lifecycle": {
      derived.status = ev.status;
      derived.nextPrediction = i64ToNumber(ev.next_prediction);
      break;
    }
    case "snapshot_created": {
      derived.snapshots.push({
        snapshotId: ev.metadata.snapshot_id,
        nextPrediction: i64ToNumber(ev.metadata.output.next_prediction),
        retainedBytes: ev.metadata.retained_bytes,
      });
      break;
    }
    case "sampling_changed": {
      derived.samplingMarks.push({
        nextPrediction: i64ToNumber(ev.next_prediction),
        request: ev.request,
        before: ev.before,
        after: ev.after,
      });
      break;
    }
    case "capture_failure": {
      derived.captureFailures.push({
        predictionIndex: i64ToNumber(ev.prediction_index),
        captures: ev.captures,
      });
      break;
    }
    case "branch_started": {
      derived.promptTokenIds = ev.prompt_token_ids;
      const inheritedText = renderSemanticText(ev.inherited_semantics);
      derived.inherited = {
        lineage: ev.lineage,
        tokenIds: ev.inherited_token_ids,
        text: inheritedText,
        divergencePrediction: i64ToNumber(ev.lineage.parent.output.next_prediction),
      };
      derived.status = "running";
      break;
    }
    case "restored": {
      // Handled by the caller (journal) via refold; folding it directly is a
      // programming error guarded in journal.applyEnvelope.
      break;
    }
  }
}

function applySemantic(derived: DerivedRun, ev: SemanticEvent, predictionIndex?: I64 | null): void {
  const pi = predictionIndex != null ? i64ToNumber(predictionIndex) : undefined;
  const attach = (text: string, reasoning: boolean) => {
    if (reasoning) derived.reasoningText += text;
    else derived.text += text;
    // Attribute the delta to the token at this prediction (latest matching).
    if (pi !== undefined) {
      for (let i = derived.tokens.length - 1; i >= 0; i--) {
        const t = derived.tokens[i];
        if (t.predictionIndex === pi) {
          t.text += text;
          if (reasoning) t.reasoning = true;
          break;
        }
        if (t.predictionIndex < pi) break;
      }
    }
  };
  if (typeof ev === "object" && "ReasoningDelta" in ev) attach(ev.ReasoningDelta, true);
  else if (typeof ev === "object" && "TextDelta" in ev) attach(ev.TextDelta, false);
  else if (typeof ev === "object" && "ToolCallStart" in ev) {
    derived.toolCalls.push({
      index: ev.ToolCallStart.index,
      id: ev.ToolCallStart.id,
      name: ev.ToolCallStart.name,
      argsJson: "",
      done: false,
      predictionIndex: pi,
    });
  } else if (typeof ev === "object" && "ToolArgumentsDelta" in ev) {
    const call = derived.toolCalls.find((c) => c.index === ev.ToolArgumentsDelta.index && !c.done);
    if (call) call.argsJson += ev.ToolArgumentsDelta.json_fragment;
  } else if (ev === "ToolCallEnd") {
    const call = [...derived.toolCalls].reverse().find((c) => !c.done);
    if (call) call.done = true;
  } else if (typeof ev === "object" && "Finished" in ev) {
    derived.finishReason = ev.Finished.reason;
  }
}

function renderSemanticText(events: SemanticEvent[]): string {
  let out = "";
  for (const ev of events) {
    if (typeof ev === "object" && "TextDelta" in ev) out += ev.TextDelta;
  }
  return out;
}

/** Rebuild a derived view after Restored{output}: retain raw records with
 * sequence < output.next_sequence, move truncated tokens to `abandoned`. */
export function refoldAfterRestore(
  runId: string,
  raw: RawEntry[],
  output: OutputCheckpoint,
  previous: DerivedRun,
): { derived: DerivedRun; raw: RawEntry[] } {
  const retained = raw.filter((e) => i64Compare(e.seq, output.next_sequence) < 0);
  const derived = emptyDerived(runId, previous.speculative);
  for (const entry of retained) foldEvent(derived, entry.record, entry.replay);
  // Tokens that existed before but are not in the retained view are abandoned.
  const retainedSeqs = new Set(derived.tokens.map((t) => String(t.seq)));
  const dropped = previous.tokens.filter((t) => !retainedSeqs.has(String(t.seq)));
  derived.abandoned = [...previous.abandoned];
  if (dropped.length > 0) derived.abandoned.push({ epoch: previous.epoch, tokens: dropped });
  derived.epoch = output.epoch;
  derived.status = "paused";
  derived.nextPrediction = i64ToNumber(output.next_prediction);
  derived.lastSeq = previous.lastSeq;
  return { derived, raw: retained };
}

// ----- speculative -----

export interface SpecStepRecord {
  schema_version?: number;
  sequence: I64;
  run_id: I64 | string;
  epoch: I64;
  status?: string;
  drafted?: unknown;
  verification?: SpecVerification | null;
  committed_token_ids?: number[];
  forced_token?: number | null;
  sampling?: unknown;
  captures?: unknown[];
  timing?: Timing;
  step_seconds?: number;
}

export function applySpecStep(derived: DerivedRun, step: SpecStepRecord): boolean {
  if (derived.lastSeq !== undefined && i64Compare(step.sequence, derived.lastSeq) <= 0) {
    return false;
  }
  derived.lastSeq = step.sequence;
  if (i64Compare(step.epoch, derived.epoch) !== 0) {
    // Epoch bump (restore or exchange in speculative mode): the committed
    // token stream is re-grounded by the worker's follow-up state events;
    // v1 keeps existing tokens and marks the boundary via a spec block.
    derived.epoch = step.epoch;
  }
  const committed = step.verification?.committed_token_ids ?? step.committed_token_ids ?? [];
  const firstPrediction =
    derived.tokens.length > 0
      ? derived.tokens[derived.tokens.length - 1].predictionIndex + 1
      : 0;
  for (let i = 0; i < committed.length; i++) {
    derived.tokens.push({
      tokenId: committed[i],
      predictionIndex: firstPrediction + i,
      forced: step.forced_token != null && committed[i] === step.forced_token,
      rank: 0,
      stepSeconds: i === 0 ? (step.step_seconds ?? 0) : 0,
      seq: step.sequence,
      epoch: step.epoch,
      replay: false,
      speculative: true,
      text: "",
      reasoning: false,
    });
  }
  // Phase narration: a step record with neither a draft delta nor a
  // verification is in-flight work (target verification submitted, prefill,
  // scheduling). The tentative draft stays visible until it is resolved —
  // clearing it on the in-flight step made drafts appear, vanish, then
  // resurface as committed tokens.
  if (step.verification || committed.length > 0) {
    derived.pendingDraft = undefined;
    derived.pendingOptimistic = undefined;
    derived.specPhase = "resolved";
  } else if (step.drafted != null) {
    if (derived.pendingDraft != null) {
      // A second draft while one is outstanding is the lookahead branch:
      // the next block drafted while the target verifies the current one.
      derived.pendingOptimistic = step.drafted;
      derived.specPhase = "verifying";
    } else {
      derived.pendingDraft = step.drafted;
      derived.specPhase = "drafted";
    }
  } else if (derived.pendingDraft != null) {
    derived.specPhase = "verifying";
  } else {
    derived.specPhase = "working";
  }
  if (step.verification || committed.length > 0) {
    derived.specBlocks.push({
      seq: step.sequence,
      epoch: step.epoch,
      status: step.status,
      drafted: step.drafted,
      verification: step.verification ?? null,
      committedTokenIds: committed,
      forcedToken: step.forced_token,
      firstPrediction,
      stepSeconds: step.step_seconds,
    });
  }
  if (step.status) derived.status = step.status;
  return true;
}

/** Attach target-committed semantic events (speculative_semantic stream). */
export function applySpecSemantic(derived: DerivedRun, ev: SemanticEvent): void {
  applySemantic(derived, ev, undefined);
}
