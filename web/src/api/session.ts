// Authoritative session generation.
//
// The generation increments at every IDENTITY boundary -- logout, a failed
// stored-session validation, or a direct account replacement -- and it does so
// SYNCHRONOUSLY, before any request abort, WebSocket disconnect, or store reset
// runs. Aborting transport is best-effort (a request that already resolved cannot
// be cancelled); this generation is the actual boundary. Any async work started
// under an old identity captures the generation at entry and, after every await,
// checks it is still current before touching state -- so a request that settles
// after the boundary cannot write the previous account's data into the new one.
//
// Token refresh WITHIN the same session must not increment the generation: it
// keeps the same identity.
let generation = 0;

/** The current session generation, captured at an async action's entry. */
export function captureSessionGeneration(): number {
  return generation;
}

/** True while `generation` is still the live session (no identity boundary since). */
export function isSessionGenerationCurrent(generation_: number): boolean {
  return generation_ === generation;
}

/**
 * End the current identity: advance the generation. MUST be called before aborting
 * requests / disconnecting the socket / resetting stores, so continuations that
 * settle during that teardown already see a stale generation.
 */
export function invalidateSession(): void {
  generation += 1;
}
