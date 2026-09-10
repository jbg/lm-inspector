// Event-stream wiring: one Channel per app session; envelopes are batched per
// animation frame into the journal, and acked in windows so the backend's
// DeliveryGate meters generation to what the UI actually consumes.

import { openEventStream, live } from "./liveIpc";
import { i64ToNumber } from "./lossless";
import type { RunEventEnvelope } from "./types";
import { applyEnvelope } from "../state/journal/journal";
import { useSession } from "../state/session";

const ACK_EVERY_RECORDS = 64;
const ACK_EVERY_MS = 100;

let started = false;
let pendingEnvelopes: RunEventEnvelope[] = [];
let flushScheduled = false;
let lastAckedSeq = -1;
let highestSeq = -1;
let highestEpoch = 0;
let lastAckTime = 0;

export async function ensureEventStream(): Promise<void> {
  if (started) return;
  started = true;
  await openEventStream(onEnvelope);
}

function onEnvelope(env: RunEventEnvelope): void {
  pendingEnvelopes.push(env);
  if (!flushScheduled) {
    flushScheduled = true;
    requestAnimationFrame(flush);
  }
}

function flush(): void {
  flushScheduled = false;
  const batch = pendingEnvelopes;
  pendingEnvelopes = [];
  for (const env of batch) {
    if (env.stream === "system") {
      handleSystem(env);
    } else {
      applyEnvelope(env);
    }
    const seq = i64ToNumber(env.envelopeSeq);
    const epoch = i64ToNumber(env.modelEpoch);
    if (epoch > highestEpoch) {
      highestEpoch = epoch;
      highestSeq = -1;
      lastAckedSeq = -1;
    }
    if (seq > highestSeq) highestSeq = seq;
  }
  maybeAck();
}

function maybeAck(): void {
  const now = performance.now();
  if (
    highestSeq > lastAckedSeq &&
    (highestSeq - lastAckedSeq >= ACK_EVERY_RECORDS || now - lastAckTime >= ACK_EVERY_MS)
  ) {
    lastAckedSeq = highestSeq;
    lastAckTime = now;
    void live.ackEvents(highestEpoch, highestSeq).catch(() => {
      // Stale epoch during a model switch — the new gate has its own counter.
    });
  } else if (highestSeq > lastAckedSeq) {
    // Ensure a trailing ack lands even when the stream goes quiet.
    setTimeout(() => {
      if (highestSeq > lastAckedSeq) {
        lastAckedSeq = highestSeq;
        lastAckTime = performance.now();
        void live.ackEvents(highestEpoch, highestSeq).catch(() => {});
      }
    }, ACK_EVERY_MS);
  }
}

function handleSystem(env: RunEventEnvelope): void {
  try {
    const payload = JSON.parse(env.payload) as { kind?: string; stage?: string; message?: string };
    const session = useSession.getState();
    switch (payload.kind) {
      case "load_stage":
        session.setLoadStage(payload.stage ?? "");
        break;
      case "speculative_finished":
        session.setSpecFinished();
        break;
      case "speculative_failed":
      case "model_reset_failed":
        session.pushNotice(`${payload.kind}: ${payload.message ?? ""}`);
        break;
    }
  } catch {
    // Malformed system payloads are non-fatal.
  }
}
