import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { AxiosAdapter } from 'axios';
import axios from 'axios';
import apiClient, {
  setTokens,
  clearTokens,
  getAccessToken,
  getRefreshToken,
  setAuthFailureHandler,
  abortInFlightRequests,
} from './client';
import { useAuthStore } from '../stores/authStore';

// An adapter that always rejects with a 401, so the response interceptor's
// token-refresh path runs for every request.
function unauthorizedAdapter(): AxiosAdapter {
  return vi.fn(async (config) => {
    const err = new Error('Unauthorized') as Error & Record<string, unknown>;
    err.config = config;
    err.response = { status: 401, data: {} };
    err.isAxiosError = true;
    throw err;
  });
}

describe('apiClient auth interceptor', () => {
  let originalAdapter: AxiosAdapter | undefined;
  let onFailure: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    originalAdapter = apiClient.defaults.adapter as AxiosAdapter | undefined;
    apiClient.defaults.adapter = unauthorizedAdapter();
    onFailure = vi.fn();
    setAuthFailureHandler(onFailure);
    clearTokens();
  });

  afterEach(() => {
    apiClient.defaults.adapter = originalAdapter;
    vi.restoreAllMocks();
  });

  // F26: the missing-refresh-token branch must reset the refreshing flag and
  // drain the queue, so a second 401 still reaches the failure path instead of
  // hanging behind a stuck flag.
  it('fails and resets state on a 401 with no refresh token', async () => {
    await expect(apiClient.get('/anything')).rejects.toBeTruthy();
    expect(onFailure).toHaveBeenCalledTimes(1);

    await expect(apiClient.get('/again')).rejects.toBeTruthy();
    expect(onFailure).toHaveBeenCalledTimes(2);
  });

  // F27: a transient refresh failure (network/5xx) must not clear tokens or log
  // the user out — the session survives so the next request can retry.
  it('keeps the session on a transient refresh failure', async () => {
    setTokens('access-1', 'refresh-1');
    const post = vi.spyOn(axios, 'post').mockRejectedValue({ response: { status: 500 } });

    await expect(apiClient.get('/anything')).rejects.toBeTruthy();

    expect(post).toHaveBeenCalled();
    expect(getRefreshToken()).toBe('refresh-1');
    expect(onFailure).not.toHaveBeenCalled();
  });

  // F27: a definitive rejection of the refresh token itself ends the session.
  it('ends the session when the refresh token is rejected', async () => {
    setTokens('access-1', 'refresh-1');
    vi.spyOn(axios, 'post').mockRejectedValue({ response: { status: 401 } });

    await expect(apiClient.get('/anything')).rejects.toBeTruthy();

    expect(getRefreshToken()).toBeNull();
    expect(onFailure).toHaveBeenCalledTimes(1);
  });

  // A refresh runs on the bare axios.post, outside the request-abort boundary.
  // If it resolves after logout, the session-epoch guard must discard it so the
  // dead session is not resurrected.
  it('does not resurrect the session when a refresh resolves after logout', async () => {
    setTokens('access-1', 'refresh-1');
    let resolveRefresh: (value: unknown) => void = () => {};
    const heldRefresh = new Promise((r) => {
      resolveRefresh = r;
    });
    const post = vi.spyOn(axios, 'post').mockReturnValue(heldRefresh as never);

    const req = apiClient.get('/anything');
    await vi.waitFor(() => expect(post).toHaveBeenCalled());

    // Log out while the refresh is held.
    useAuthStore.getState().logout();

    // The refresh now succeeds, but it belongs to the ended session.
    resolveRefresh({ data: { accessToken: 'new-access' } });

    await expect(req).rejects.toBeTruthy();
    expect(getRefreshToken()).toBeNull();
    expect(getAccessToken()).toBeNull();
  });

  // A request that supplies its own signal (e.g. a per-fetch abort) must still be
  // cancelled by logout: the interceptor combines the caller's signal with the
  // session signal, so a message GET in flight at logout cannot resolve and write
  // the previous user's data back.
  it('cancels a caller-signalled request when the session is aborted', async () => {
    setTokens('access-1', 'refresh-1');
    let captured: AbortSignal | undefined;
    const reached = new Promise<void>((res) => {
      apiClient.defaults.adapter = ((config) => {
        const sig = config.signal as AbortSignal | undefined;
        captured = sig;
        res();
        return new Promise((_r, reject) => {
          sig?.addEventListener('abort', () => reject(new Error('aborted')));
        });
      }) as AxiosAdapter;
    });
    const own = new AbortController(); // the caller's own signal, never aborted here
    const req = apiClient.get('/channels/c1/messages', { signal: own.signal });
    req.catch(() => {}); // it rejects on abort; swallow so no unhandled rejection

    await reached;
    expect(captured?.aborted).toBe(false); // not aborted yet
    abortInFlightRequests(); // as logout does
    // The adapter saw a COMBINED signal, so the session abort cancels the request
    // even though the caller supplied its own (un-aborted) signal.
    expect(captured?.aborted).toBe(true);
  });
});
