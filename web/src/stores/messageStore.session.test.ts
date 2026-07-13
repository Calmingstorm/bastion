import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { AxiosAdapter } from 'axios';
import apiClient, { setTokens, clearTokens, abortInFlightRequests } from '../api/client';
import { useMessageStore } from './messageStore';

// Integration test through the REAL client wiring (no '../api/client' mock): the
// store's fetchMessages links its per-request controller to the session, so logout
// (abortInFlightRequests) must cancel the exact in-flight message request, and the
// request's settlement must unlink so nothing lingers on the session signal.
describe('messageStore <-> client session cancellation (real wiring)', () => {
  let originalAdapter: AxiosAdapter | undefined;

  beforeEach(() => {
    originalAdapter = apiClient.defaults.adapter as AxiosAdapter | undefined;
    useMessageStore.getState().reset();
    clearTokens();
  });

  afterEach(() => {
    apiClient.defaults.adapter = originalAdapter;
    useMessageStore.getState().reset();
  });

  it('logout aborts the in-flight message request and it does not commit', async () => {
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

    const done = useMessageStore.getState().fetchMessages('c1'); // real fetch -> real apiGetMessages -> real client
    await reached;
    expect(captured).toBeDefined();
    expect(captured?.aborted).toBe(false); // in flight, not yet cancelled

    abortInFlightRequests(); // as logout does
    expect(captured?.aborted).toBe(true); // the exact message request was cancelled via the session link

    await done; // settles (aborted -> catch -> finally unlinks the session listener)
    expect(useMessageStore.getState().messages.c1 ?? []).toEqual([]); // nothing stale committed
  });
});
