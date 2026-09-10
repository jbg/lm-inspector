// Per-token decoded text cache. Single-id decodes ignore byte-merge context,
// so journal semantic text wins when present; this covers prompt tokens and
// candidates (which have no semantic pairing).

import { live } from "./liveIpc";

const cache = new Map<number, string>();
const pending = new Map<number, Promise<string>>();
const listeners = new Set<() => void>();
let version = 0;

export function pieceVersion(): number {
  return version;
}

export function subscribePieces(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function pieceFor(id: number): string | undefined {
  const hit = cache.get(id);
  if (hit !== undefined) return hit;
  if (!pending.has(id)) {
    const promise = live
      .decodeTokens([id], false)
      .then((text) => {
        cache.set(id, text);
        pending.delete(id);
        version++;
        for (const l of listeners) l();
        return text;
      })
      .catch(() => {
        pending.delete(id);
        return "";
      });
    pending.set(id, promise);
  }
  return undefined;
}

/** Prefetch a batch (prompt bands). */
export function prefetchPieces(ids: number[]): void {
  for (const id of new Set(ids)) void pieceFor(id);
}

export function resetPieces(): void {
  cache.clear();
  pending.clear();
  version++;
  for (const l of listeners) l();
}
