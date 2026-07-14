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

// Machinery that holds unsettled work from the prior session (e.g. the HTTP
// client's queue of requests waiting on a token refresh) registers here to be
// settled at the boundary itself. Generation checks alone cannot end work that
// is parked on a promise which may never settle -- a hung refresh would strand
// its queued waiters forever if nothing drained them at invalidation time.
type SessionInvalidationListener = () => void;
const invalidationListeners = new Set<SessionInvalidationListener>();

/** Register a callback to run synchronously whenever the session is invalidated. */
export function onSessionInvalidated(listener: SessionInvalidationListener): () => void {
  invalidationListeners.add(listener);
  return () => invalidationListeners.delete(listener);
}

/**
 * End the current identity: advance the generation. MUST be called before aborting
 * requests / disconnecting the socket / resetting stores, so continuations that
 * settle during that teardown already see a stale generation. Listeners run after
 * the advance, so anything they settle already observes the new generation.
 */
export function invalidateSession(): void {
  generation += 1;
  invalidationListeners.forEach((listener) => listener());
}

/**
 * Thrown by an auth operation (login/register) whose result arrived after a newer
 * identity boundary superseded it. Callers must treat it as "not this session's
 * concern" -- neither a success (do not navigate) nor a login error to show.
 */
export class SessionSupersededError extends Error {
  constructor() {
    super('Session superseded by a newer identity');
    this.name = 'SessionSupersededError';
  }
}
