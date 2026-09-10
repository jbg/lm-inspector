import { beforeEach, describe, expect, it } from "vitest";
import { applyEnvelope, getJournal, resetJournals } from "./journal";
import type { RunEventEnvelope } from "../../lib/types";
import type { ControlledRecord, GenerationEvent, OutputCheckpoint } from "./reconcile";

let seq = 0;

function record(runId: string, epoch: number, event: GenerationEvent): ControlledRecord {
  return {
    schema_version: 1,
    sequence: ++seq,
    epoch,
    generation: { schema_version: 1, run_id: runId, event },
  };
}

function envelope(
  rec: ControlledRecord,
  phase?: "replay",
): RunEventEnvelope {
  return {
    modelEpoch: 1,
    stream: "controlled",
    runId: rec.generation.run_id,
    envelopeSeq: seq,
    phase,
    payload: JSON.stringify(rec),
  };
}

function send(runId: string, epoch: number, event: GenerationEvent, phase?: "replay") {
  applyEnvelope(envelope(record(runId, epoch, event), phase));
}

function token(id: number, prediction: number, extra: Partial<Extract<GenerationEvent, { kind: "token" }>> = {}): GenerationEvent {
  return {
    kind: "token",
    token_id: id,
    prediction_index: prediction,
    input_range: [0, 1],
    committed: true,
    rank: 1,
    step_seconds: 0.01,
    ...extra,
  };
}

function textDelta(prediction: number, text: string): GenerationEvent {
  return { kind: "semantic", prediction_index: prediction, event: { TextDelta: text } };
}

beforeEach(() => {
  resetJournals();
  seq = 0;
});

describe("plain run", () => {
  it("folds started/token/semantic/completed", () => {
    send("r1", 0, { kind: "started", prompt_token_ids: [1, 2, 3], generation: {}, seed: 42 });
    send("r1", 0, token(100, 1));
    send("r1", 0, textDelta(1, "Hello"));
    send("r1", 0, token(101, 2, { rank: 3 }));
    send("r1", 0, textDelta(2, " world"));
    send("r1", 0, { kind: "completed", reason: "eos", generated_tokens: 2, elapsed_seconds: 0.5 });

    const d = getJournal("r1")!.derived;
    expect(d.promptTokenIds).toEqual([1, 2, 3]);
    expect(d.tokens.map((t) => t.tokenId)).toEqual([100, 101]);
    expect(d.tokens[0].text).toBe("Hello");
    expect(d.tokens[1].text).toBe(" world");
    expect(d.tokens[1].rank).toBe(3);
    expect(d.text).toBe("Hello world");
    expect(d.status).toBe("completed");
    expect(d.finishReason).toBe("eos");
  });

  it("ignores duplicate sequences", () => {
    send("r1", 0, { kind: "started", prompt_token_ids: [], generation: {}, seed: 1 });
    const rec = record("r1", 0, token(5, 1));
    applyEnvelope(envelope(rec));
    applyEnvelope(envelope(rec)); // same sequence again
    expect(getJournal("r1")!.derived.tokens).toHaveLength(1);
  });

  it("attaches captures by prediction index", () => {
    send("r1", 0, { kind: "started", prompt_token_ids: [], generation: {}, seed: 1 });
    send(
      "r1",
      0,
      token(7, 1, {
        captures: {
          phase: "decode",
          prediction_index: 1,
          records: [
            {
              selection_id: "topk",
              path: "model.logits",
              outcome: "captured",
              payload: { kind: "candidates", value: { candidates: [{ token_id: 7, score: 10 }] } },
            },
          ],
          interventions: [],
        },
      }),
    );
    const d = getJournal("r1")!.derived;
    expect(d.capturesByPrediction.get(1)?.records[0].path).toBe("model.logits");
  });
});

describe("restore truncation", () => {
  it("truncates to next_sequence, keeps abandoned, bumps epoch", () => {
    send("r1", 0, { kind: "started", prompt_token_ids: [], generation: {}, seed: 1 });
    send("r1", 0, token(10, 1));
    send("r1", 0, textDelta(1, "a"));
    const cutSeq = seq + 1; // next record's sequence is the snapshot boundary
    send("r1", 0, token(11, 2));
    send("r1", 0, textDelta(2, "b"));
    send("r1", 0, token(12, 3));

    const output: OutputCheckpoint = {
      run_id: "r1",
      epoch: 1,
      next_sequence: cutSeq,
      next_prediction: 2,
    };
    send("r1", 1, { kind: "restored", snapshot_id: "s1", output });

    const d = getJournal("r1")!.derived;
    expect(d.tokens.map((t) => t.tokenId)).toEqual([10]);
    expect(d.text).toBe("a");
    expect(d.epoch).toBe(1);
    expect(d.status).toBe("paused");
    expect(d.abandoned).toHaveLength(1);
    expect(d.abandoned[0].tokens.map((t) => t.tokenId)).toEqual([11, 12]);

    // Continuation in the new epoch applies normally.
    send("r1", 1, token(20, 2));
    send("r1", 1, textDelta(2, "C"));
    const d2 = getJournal("r1")!.derived;
    expect(d2.tokens.map((t) => t.tokenId)).toEqual([10, 20]);
    expect(d2.text).toBe("aC");
  });
});

describe("branch seeding", () => {
  it("seeds a child entirely from branch_started", () => {
    send("b1", 0, {
      kind: "branch_started",
      lineage: {
        parent: {
          snapshot_id: "s1",
          output: { run_id: "r1", epoch: 0, next_sequence: 4, next_prediction: 12 },
        },
      },
      prompt_token_ids: [1, 2],
      inherited_token_ids: [100, 101],
      inherited_semantics: [{ TextDelta: "Hello " }],
    });
    send("b1", 0, token(200, 12, { forced: true }));
    send("b1", 0, textDelta(12, "pull"));

    const d = getJournal("b1")!.derived;
    expect(d.inherited?.tokenIds).toEqual([100, 101]);
    expect(d.inherited?.text).toBe("Hello ");
    expect(d.inherited?.divergencePrediction).toBe(12);
    expect(d.tokens).toHaveLength(1);
    expect(d.tokens[0].forced).toBe(true);
    expect(d.text).toBe("pull");
  });

  it("marks replay-phase tokens", () => {
    send("b1", 0, {
      kind: "branch_started",
      lineage: {
        parent: { snapshot_id: "s1", output: { run_id: "r1", epoch: 0, next_sequence: 2, next_prediction: 5 } },
      },
      prompt_token_ids: [],
      inherited_token_ids: [],
      inherited_semantics: [],
    });
    send("b1", 0, token(50, 5), "replay");
    send("b1", 0, token(51, 6));
    const d = getJournal("b1")!.derived;
    expect(d.tokens[0].replay).toBe(true);
    expect(d.tokens[1].replay).toBe(false);
  });
});

describe("speculative steps", () => {
  it("appends committed tokens and records blocks", () => {
    const step = {
      sequence: 1,
      run_id: 1,
      epoch: 0,
      status: "running",
      drafted: { tokens: [7, 8, 9] },
      verification: {
        resolved: true,
        dispositions: ["accepted", "accepted", "rejected"],
        committed_token_ids: [7, 8, 42],
      },
      step_seconds: 0.02,
    };
    applyEnvelope({
      modelEpoch: 1,
      stream: "speculative",
      runId: "spec:0:1",
      envelopeSeq: 1,
      payload: JSON.stringify(step),
    });
    const d = getJournal("spec:0:1")!.derived;
    expect(d.speculative).toBe(true);
    expect(d.tokens.map((t) => t.tokenId)).toEqual([7, 8, 42]);
    expect(d.tokens.map((t) => t.predictionIndex)).toEqual([0, 1, 2]);
    expect(d.specBlocks).toHaveLength(1);
    expect(d.specBlocks[0].committedTokenIds).toEqual([7, 8, 42]);
  });

  it("holds drafted-only steps as pendingDraft", () => {
    applyEnvelope({
      modelEpoch: 1,
      stream: "speculative",
      runId: "spec:0:1",
      envelopeSeq: 1,
      payload: JSON.stringify({ sequence: 1, run_id: 1, epoch: 0, drafted: { tokens: [3, 4] } }),
    });
    const d = getJournal("spec:0:1")!.derived;
    expect(d.pendingDraft).toEqual({ tokens: [3, 4] });
    expect(d.tokens).toHaveLength(0);
  });
});
