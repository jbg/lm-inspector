// Non-reactive journal storage. Journals mutate in place at streaming rates;
// React subscribes through per-run version counters (useJournal). The zustand
// stores never hold journal contents.

import { parseLossless } from "../../lib/lossless";
import type { RunEventEnvelope } from "../../lib/types";
import {
  applyControlled,
  applySpecSemantic,
  applySpecStep,
  emptyDerived,
  refoldAfterRestore,
  type ControlledRecord,
  type DerivedRun,
  type RawEntry,
  type SemanticEvent,
  type SpecStepRecord,
} from "./reconcile";

export interface RunJournal {
  runId: string;
  raw: RawEntry[];
  derived: DerivedRun;
  version: number;
}

const journals = new Map<string, RunJournal>();
const listeners = new Set<() => void>();
let globalVersion = 0;

export function subscribeJournals(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function journalsVersion(): number {
  return globalVersion;
}

function bump(journal: RunJournal): void {
  journal.version++;
  globalVersion++;
  for (const l of listeners) l();
}

export function getJournal(runId: string): RunJournal | undefined {
  return journals.get(runId);
}

export function allJournals(): RunJournal[] {
  return [...journals.values()];
}

export function resetJournals(): void {
  journals.clear();
  globalVersion++;
  for (const l of listeners) l();
}

function ensure(runId: string, speculative: boolean): RunJournal {
  let j = journals.get(runId);
  if (!j) {
    j = { runId, raw: [], derived: emptyDerived(runId, speculative), version: 0 };
    journals.set(runId, j);
  }
  return j;
}

/** Ingest one envelope (already decoded from the Channel). */
export function applyEnvelope(envelope: RunEventEnvelope): void {
  const payload = parseLossless(envelope.payload);
  if (envelope.stream === "controlled") {
    const record = payload as ControlledRecord;
    const runId = record.generation.run_id;
    const journal = ensure(runId, false);
    const ev = record.generation.event;
    if (ev.kind === "restored") {
      const { derived, raw } = refoldAfterRestore(runId, journal.raw, ev.output, journal.derived);
      // Record the restore itself in the retained raw stream so paging back
      // reproduces the same view.
      derived.lastSeq = record.sequence;
      journal.raw = raw;
      journal.raw.push({ seq: record.sequence, record, replay: false });
      journal.derived = derived;
      bump(journal);
      return;
    }
    if (applyControlled(journal.derived, journal.raw, record, envelope.phase === "replay")) {
      bump(journal);
    }
    return;
  }
  if (envelope.stream === "speculative") {
    const journal = ensure(envelope.runId, true);
    // Synthetic worker record: the speculative pipeline's own step records
    // never carry the prompt, so it arrives once up front.
    const maybePrompt = payload as { kind?: string; prompt_token_ids?: number[] };
    if (maybePrompt.kind === "spec_prompt") {
      if (maybePrompt.prompt_token_ids && journal.derived.promptTokenIds.length === 0) {
        journal.derived.promptTokenIds = maybePrompt.prompt_token_ids;
        bump(journal);
      }
      return;
    }
    if (applySpecStep(journal.derived, payload as SpecStepRecord)) bump(journal);
    return;
  }
  if (envelope.stream === "speculative_semantic") {
    const journal = ensure(envelope.runId, true);
    applySpecSemantic(journal.derived, payload as SemanticEvent);
    bump(journal);
  }
  // "system" envelopes are handled by the session store, not the journal.
}

/** Re-ingest a paged journal (webview reload / archive view). */
export function hydrateFromEnvelopes(envelopes: RunEventEnvelope[]): void {
  for (const env of envelopes) applyEnvelope(env);
}
