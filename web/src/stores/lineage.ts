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
// Tombstones are NOT permanent -- they cover a race, they do not encode "gone
// forever" (leave/kick/ban are reversible; a closed shared DM can be reopened by
// the other side). Two things retire one: a claim that (re)asserts the id (a
// create event -- the server re-asserted existence), and FETCH RETIREMENT -- the
// first ok-committing fetch that STARTED after the tombstone was laid filters it
// one last time (covering the broadcast-before-commit read) and then retires it,
// so from the next fetch on the server's word rules.
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
      let list = snapshot.filter((item) => !tombstones.has(getId(item)));
      for (const e of journal) {
        if (e.seq > startToken) list = e.apply(list);
      }
      // FETCH RETIREMENT: this fetch started after these tombstones were laid, so
      // its snapshot is server truth minted after the delete broadcast. One
      // filtered commit covers the broadcast-before-commit read; after that the
      // server's word rules -- a legitimately reopened DM or rejoined server
      // reappears on the next fetch instead of being suppressed forever.
      // (Post-start tombstones stay: their fetch-that-moved-past hasn't happened.)
      for (const [id, seq] of tombstones) {
        if (seq < startToken) tombstones.delete(id);
      }
      return { kind: 'ok', list };
    },
    reset() {
      // The counter stays monotonic so tokens held by in-flight fetches can never
      // collide with post-reset tokens.
      counter += 1;
      lastFetchStart = counter;
      journal.length = 0;
      prunedThrough = 0;
      tombstones.clear();
    },
  };
}
