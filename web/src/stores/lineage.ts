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
// drops tombstoned ids from the snapshot outright.
//
// Tombstones are NOT permanent, but retirement must be EVIDENCE, not traffic --
// whichever fetch wanders past first does not get to issue a death certificate.
// A tombstone retires only on:
//   1. An explicit existence assertion -- a create/reopen claim, or assert()
//      called for an event that proves the id is alive (a message arriving in a
//      closed DM: the server reopens before broadcasting).
//   2. OMISSION by a same-scope fetch that started after the tombstone was laid:
//      the snapshot no longer contains the id, so the server has confirmed the
//      deletion and there is nothing left to suppress. A snapshot that still
//      CONTAINS the id is a stale read -- it is filtered and the tombstone
//      stays, so a second still-stale fetch cannot resurrect the row either.
// Scoping matters for (2): a channel tombstone belongs to its server, and a
// fetch for a DIFFERENT server's channels omits the id vacuously -- that fetch
// can testify about nothing.
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
  // The scope the removed ids belong to (e.g. the channel's serverId). Only a
  // fetch with the SAME scope can retire these tombstones by omission. Omit for
  // globally-scoped resources (the server list, the DM list).
  scope?: string;
  // Ids this claim creates/updates: the server re-asserted their existence, so
  // any tombstone for them is cleared.
  asserts?: string[];
}

export interface Lineage<T> {
  // `scope` identifies WHAT this fetch enumerates (e.g. which server's channels)
  // -- omission-retirement only trusts same-scope snapshots.
  startFetch(scope?: string): number;
  claim(apply: (list: T[]) => T[], meta?: ClaimMeta): void;
  barrier(): void;
  // True while `startToken` is still the newest fetch/barrier on this lineage.
  // Failure paths use this: only the owning fetch may settle loading or publish
  // an error -- a superseded failure belongs to a scope that no longer exists.
  owns(startToken: number): boolean;
  reconcile(startToken: number, snapshot: T[]): ReconcileResult<T>;
  // Explicit existence assertion WITHOUT a journal write: an event proved the id
  // is alive (e.g. a message arrived in it), so any tombstone is cleared.
  assert(ids: string[]): void;
  // Store-level reset: supersede any held fetch AND drop accumulated evidence.
  // Tombstones especially must not outlive the state they were laid against --
  // an account's closed shared DM would otherwise stay hidden from the next
  // account signing in on this client.
  reset(): void;
}

const JOURNAL_CAP = 128;
// Pruning evicts the OLDEST tombstone, and only once 256 newer removals exist --
// so an evicted deletion is 256 removals old, far beyond the ms-scale
// broadcast-before-commit window tombstones exist to cover. Genuinely recent
// removals are always resident.
const TOMBSTONE_CAP = 256;

export function createLineage<T>(getId: (item: T) => string): Lineage<T> {
  let counter = 0;
  let lastFetchStart = 0; // only fetches and barriers move this
  let lastFetchScope: string | undefined; // scope of the latest fetch
  let prunedThrough = 0; // journal entries with seq <= this are gone
  const journal: { seq: number; apply: (list: T[]) => T[] }[] = [];
  // id -> laid-at seq + owning scope (insertion-ordered for the cap)
  const tombstones = new Map<string, { seq: number; scope?: string }>();

  return {
    startFetch(scope) {
      counter += 1;
      lastFetchStart = counter;
      lastFetchScope = scope;
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
          tombstones.set(id, { seq: counter, scope: meta.scope });
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
      const snapshotIds = new Set(snapshot.map(getId));
      let list = snapshot.filter((item) => !tombstones.has(getId(item)));
      for (const e of journal) {
        if (e.seq > startToken) list = e.apply(list);
      }
      // Retirement by OMISSION only: this fetch started after the tombstone was
      // laid AND enumerates the tombstone's own scope AND its snapshot no longer
      // contains the id -- the server has confirmed the deletion. A snapshot
      // that still contains the id was read before the delete committed; it is
      // filtered above and the tombstone stays armed for the next stale read.
      for (const [id, t] of tombstones) {
        if (t.seq < startToken && t.scope === lastFetchScope && !snapshotIds.has(id)) {
          tombstones.delete(id);
        }
      }
      return { kind: 'ok', list };
    },
    assert(ids) {
      for (const id of ids) tombstones.delete(id);
    },
    reset() {
      // The counter stays monotonic so tokens held by in-flight fetches can never
      // collide with post-reset tokens.
      counter += 1;
      lastFetchStart = counter;
      lastFetchScope = undefined;
      journal.length = 0;
      prunedThrough = 0;
      tombstones.clear();
    },
  };
}
