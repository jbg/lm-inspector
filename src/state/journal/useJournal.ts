import { useSyncExternalStore } from "react";
import { getJournal, journalsVersion, subscribeJournals, type RunJournal } from "./journal";

/** Subscribe to one run's journal; re-renders when that journal changes.
 * Journals mutate in place, so the store snapshot is the version counter and
 * the journal object is read directly afterwards. */
export function useJournal(runId: string | undefined): RunJournal | undefined {
  useSyncExternalStore(subscribeJournals, () =>
    runId ? (getJournal(runId)?.version ?? -1) : -1,
  );
  return runId ? getJournal(runId) : undefined;
}

/** Re-render on any journal change (run lists, lineage strip). */
export function useJournalsVersion(): number {
  return useSyncExternalStore(subscribeJournals, journalsVersion);
}
