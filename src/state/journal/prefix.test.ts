import { describe, expect, it } from "vitest";
import { emptyDerived, type TokenEntry } from "./reconcile";
import { prefixForPrediction } from "./prefix";

function token(predictionIndex: number, tokenId: number): TokenEntry {
  return {
    tokenId,
    predictionIndex,
    forced: false,
    rank: 0,
    stepSeconds: 0,
    seq: predictionIndex,
    epoch: 0,
    replay: false,
    speculative: false,
    text: "",
    reasoning: false,
  };
}

describe("prefixForPrediction", () => {
  it("returns prompt + committed tokens before the analyzed prediction", () => {
    const d = emptyDerived("run");
    d.promptTokenIds = [10, 11, 12];
    d.tokens = [token(0, 100), token(1, 101), token(2, 102)];
    expect(prefixForPrediction(d, 0)).toEqual([10, 11, 12]);
    expect(prefixForPrediction(d, 2)).toEqual([10, 11, 12, 100, 101]);
  });

  it("refuses without recorded prompt ids", () => {
    const d = emptyDerived("run");
    d.tokens = [token(0, 100)];
    expect(prefixForPrediction(d, 1)).toBeUndefined();
  });

  it("refuses an incomplete committed view (gap before the prediction)", () => {
    const d = emptyDerived("run");
    d.promptTokenIds = [10];
    d.tokens = [token(0, 100), token(2, 102)]; // prediction 1 missing
    expect(prefixForPrediction(d, 3)).toBeUndefined();
  });

  it("splices inherited branch tokens before the divergence point", () => {
    const d = emptyDerived("branch");
    d.promptTokenIds = [10, 11];
    d.inherited = {
      lineage: { parent_run_id: "parent", snapshot_id: "s", divergence_prediction: 2 } as never,
      tokenIds: [100, 101],
      text: "",
      divergencePrediction: 2,
    };
    d.tokens = [token(2, 202), token(3, 203)];
    expect(prefixForPrediction(d, 3)).toEqual([10, 11, 100, 101, 202]);
    // Analyzing the divergence prediction itself uses only inherited tokens.
    expect(prefixForPrediction(d, 2)).toEqual([10, 11, 100, 101]);
  });
});
