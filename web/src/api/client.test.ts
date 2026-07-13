import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { AxiosAdapter } from 'axios';
import axios from 'axios';
import apiClient, {
  setTokens,
  clearTokens,
  getAccessToken,
  getRefreshToken,
  setAuthFailureHandler,
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
});
