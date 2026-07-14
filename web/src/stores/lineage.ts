// A per-resource ownership lineage that RECONCILES fetches with mutations.
//
// Fetches claim the lineage at start (a newer fetch or a scope barrier supersedes
// an older fetch outright). Mutations and realtime commits do NOT discard an
// in-flight fetch: they journal their FUNCTIONAL application, and when the fetch
// commits, every mutation journaled after its start is re-applied onto the
// snapshot -- preserving both the mutation's effect and the snapshot's unaffected
// rows. Discarding the whole dataset to keep one changed row is not ownership;
// it is amnesia.
export type ReconcileResult<T> =
  | { kind: 'ok'; list: T[] }
  // A newer fetch or a barrier owns the resource now; commit nothing (the owner
  // manages the loading flag).
  | { kind: 'superseded' }
  // The journal was pruned past this fetch's start; the snapshot cannot be
  // reconciled. Keep current state, but the fetch still owns loading.
  | { kind: 'gap' };

export interface Lineage<T> {
  startFetch(): number;
  claim(apply: (list: T[]) => T[]): void;
  barrier(): void;
  reconcile(startToken: number, snapshot: T[]): ReconcileResult<T>;
}

const JOURNAL_CAP = 128;

export function createLineage<T>(): Lineage<T> {
  let counter = 0;
  let lastFetchStart = 0; // only fetches and barriers move this
  let prunedThrough = 0; // journal entries with seq <= this are gone
  const journal: { seq: number; apply: (list: T[]) => T[] }[] = [];

  return {
    startFetch() {
      counter += 1;
      lastFetchStart = counter;
      return counter;
    },
    claim(apply) {
      counter += 1;
      journal.push({ seq: counter, apply });
      if (journal.length > JOURNAL_CAP) {
        const removed = journal.splice(0, journal.length - JOURNAL_CAP);
        prunedThrough = removed[removed.length - 1].seq;
      }
    },
    barrier() {
      counter += 1;
      lastFetchStart = counter; // any in-flight fetch no longer matches
    },
    reconcile(startToken, snapshot) {
      if (startToken !== lastFetchStart) return { kind: 'superseded' };
      if (prunedThrough > startToken) return { kind: 'gap' };
      let list = snapshot;
      for (const e of journal) {
        if (e.seq > startToken) list = e.apply(list);
      }
      return { kind: 'ok', list };
    },
  };
}
