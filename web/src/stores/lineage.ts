// A per-resource ownership lineage that RECONCILES fetches with mutations.
//
// Fetches claim the lineage at start (a newer fetch or a scope barrier supersedes
// an older fetch outright). Mutations and realtime commits do NOT discard an
// in-flight fetch: they journal their FUNCTIONAL application, and when the fetch
// commits, every mutation journaled after its start is re-applied onto the
// snapshot -- preserving both the mutation's effect and the snapshot's unaffected
// rows. Discarding the whole dataset to keep one changed row is not ownership;
// it is amnesia.
//
// Deletions additionally TOMBSTONE their ids: the server can broadcast a delete
// before its database transaction commits, so a fetch that starts just after the
// event can return a snapshot that still contains the deleted row. The journal
// cannot help there (the removal's seq predates the fetch start), so reconcile
// drops tombstoned ids from the snapshot outright. A later claim that
// (re)asserts an id -- a create, update, or upsert -- clears its tombstone: the
// server has re-asserted existence, which also recovers from a broadcast whose
// deletion subsequently failed server-side.
export type ReconcileResult<T> =
  | { kind: 'ok'; list: T[] }
  // A newer fetch or a barrier owns the resource now; commit nothing (the owner
  // manages the loading flag).
  | { kind: 'superseded' }
  // The journal was pruned past this fetch's start; the snapshot cannot be
  // reconciled. The fetch still owns the resource -- it should RETRY for a
  // fresh snapshot rather than keep partial state.
  | { kind: 'gap' };

export interface ClaimMeta {
  // Ids this claim deletes: reconcile drops matching snapshot rows even when the
  // deletion predates the fetch start (broadcast-before-commit resurrection).
  removes?: string[];
  // Ids this claim creates/updates: the server re-asserted their existence, so
  // any tombstone for them is cleared.
  asserts?: string[];
}

export interface Lineage<T> {
  startFetch(): number;
  claim(apply: (list: T[]) => T[], meta?: ClaimMeta): void;
  barrier(): void;
  // True while `startToken` is still the newest fetch/barrier on this lineage.
  // Failure paths use this: only the owning fetch may settle loading or publish
  // an error -- a superseded failure belongs to a scope that no longer exists.
  owns(startToken: number): boolean;
  reconcile(startToken: number, snapshot: T[]): ReconcileResult<T>;
}

const JOURNAL_CAP = 128;
// Larger than JOURNAL_CAP on purpose: every removal is also a journal claim, so
// a fetch whose flight overlaps a tombstone prune has ALREADY hit the journal
// gap (and retried) first -- tombstone pruning never silently loses evidence an
// active fetch depends on.
const TOMBSTONE_CAP = 256;

export function createLineage<T>(getId: (item: T) => string): Lineage<T> {
  let counter = 0;
  let lastFetchStart = 0; // only fetches and barriers move this
  let prunedThrough = 0; // journal entries with seq <= this are gone
  const journal: { seq: number; apply: (list: T[]) => T[] }[] = [];
  const tombstones = new Map<string, number>(); // id -> claim seq (insertion-ordered)

  return {
    startFetch() {
      counter += 1;
      lastFetchStart = counter;
      return counter;
    },
    claim(apply, meta) {
      counter += 1;
      journal.push({ seq: counter, apply });
      if (journal.length > JOURNAL_CAP) {
        const removed = journal.splice(0, journal.length - JOURNAL_CAP);
        prunedThrough = removed[removed.length - 1].seq;
      }
      if (meta?.removes) {
        for (const id of meta.removes) {
          tombstones.delete(id); // refresh insertion order for the cap
          tombstones.set(id, counter);
        }
        while (tombstones.size > TOMBSTONE_CAP) {
          const oldest = tombstones.keys().next().value;
          if (oldest === undefined) break;
          tombstones.delete(oldest);
        }
      }
      if (meta?.asserts) {
        for (const id of meta.asserts) tombstones.delete(id);
      }
    },
    barrier() {
      counter += 1;
      lastFetchStart = counter; // any in-flight fetch no longer matches
    },
    owns(startToken) {
      return startToken === lastFetchStart;
    },
    reconcile(startToken, snapshot) {
      if (startToken !== lastFetchStart) return { kind: 'superseded' };
      if (prunedThrough > startToken) return { kind: 'gap' };
      // Tombstoned ids are dropped regardless of when the deletion was journaled:
      // ids are never reused, so a tombstoned id in a snapshot is a stale read,
      // not a recreation. (Recreation-by-server clears the tombstone via an
      // assert claim before any snapshot could legitimately contain it.)
      let list = snapshot.filter((item) => !tombstones.has(getId(item)));
      for (const e of journal) {
        if (e.seq > startToken) list = e.apply(list);
      }
      return { kind: 'ok', list };
    },
  };
}
