import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { WebSocketClient } from './websocket';

// A controllable WebSocket double: the client calls `new WebSocket(url)` and reads
// WebSocket.OPEN/CONNECTING, and drives the socket via onopen/onmessage/onclose.
// The test grabs each created instance to fire a callback by hand, simulating a
// frame buffered on a socket that has since been superseded.
class FakeWS {
  static OPEN = 1;
  static CONNECTING = 0;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances: FakeWS[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  readyState = FakeWS.OPEN;
  url: string;
  constructor(url: string) {
    this.url = url;
    FakeWS.instances.push(this);
  }
  send(): void {}
  close(): void {
    this.readyState = FakeWS.CLOSED;
  }
}

function frame(type: string, data: unknown): { data: string } {
  return { data: JSON.stringify({ type, data }) };
}

describe('WebSocketClient connection generation', () => {
  let original: typeof globalThis.WebSocket;

  beforeEach(() => {
    FakeWS.instances = [];
    original = globalThis.WebSocket;
    globalThis.WebSocket = FakeWS as unknown as typeof WebSocket;
  });

  afterEach(() => {
    globalThis.WebSocket = original;
    vi.useRealTimers();
  });

  // Reach the private timers to prove a superseded callback did not touch live
  // connection state (start/stop the heartbeat, schedule a reconnect).
  function timers(client: WebSocketClient) {
    return client as unknown as { heartbeatTimer: unknown; reconnectTimer: unknown };
  }

  it('a frame buffered on a superseded socket is not dispatched to the next session handlers', () => {
    const client = new WebSocketClient();
    const oldHandler = vi.fn();
    const newHandler = vi.fn();

    // Old session connects and registers a handler.
    client.on('MESSAGE_CREATE', oldHandler);
    client.connect('token-old');
    const ws1 = FakeWS.instances[0];

    // Logout: disconnect removes handlers and supersedes ws1's generation.
    client.disconnect();

    // New session registers fresh handlers and connects (same singleton).
    client.on('MESSAGE_CREATE', newHandler);
    client.connect('token-new');
    const ws2 = FakeWS.instances[FakeWS.instances.length - 1];
    expect(ws2).not.toBe(ws1);

    // A frame still buffered on the OLD socket now fires. It must reach NEITHER the
    // old handler (removed) nor the new session's handler.
    ws1.onmessage?.(frame('MESSAGE_CREATE', { id: 'stale', channelId: 'c' }));
    expect(oldHandler).not.toHaveBeenCalled();
    expect(newHandler).not.toHaveBeenCalled();

    // A frame on the CURRENT socket is delivered normally.
    ws2.onmessage?.(frame('MESSAGE_CREATE', { id: 'fresh', channelId: 'c' }));
    expect(newHandler).toHaveBeenCalledTimes(1);
  });

  it('a superseded socket opening does not dispatch CONNECTED into the new session', () => {
    const client = new WebSocketClient();

    client.on('CONNECTED', vi.fn());
    client.connect('token-old');
    const ws1 = FakeWS.instances[0];
    client.disconnect(); // supersede ws1 (also clears the old handlers)

    // New session registers its own CONNECTED handler and connects.
    const newConnected = vi.fn();
    client.on('CONNECTED', newConnected);
    client.connect('token-new');

    // ws1's onopen fires late (its connect attempt resolved after it was superseded).
    // The generation guard must stop it from dispatching CONNECTED -- which would
    // otherwise fire the new session's reconnect resync from a dead socket.
    ws1.onopen?.();
    expect(newConnected).not.toHaveBeenCalled();
  });

  it('the first connection of a new session is initial, not a reconnect', () => {
    const client = new WebSocketClient();
    client.connect('token-old');
    const ws1 = FakeWS.instances[0];
    ws1.onopen?.(); // first-ever open: sets wasConnectedBefore

    client.disconnect(); // logout ends the session

    // New session connects and registers its CONNECTED handler.
    const connected = vi.fn();
    client.on('CONNECTED', connected);
    client.connect('token-new');
    const ws2 = FakeWS.instances[FakeWS.instances.length - 1];
    ws2.onopen?.();

    // A fresh authentication session must not be classified as a reconnect (which
    // would fire a spurious resyncAfterReconnect). Only a network-drop reconnect --
    // which never calls disconnect() -- keeps isReconnect true.
    expect(connected).toHaveBeenCalledWith({ isReconnect: false });
  });

  it('a superseded onopen firing after disconnect (before the next connect) does nothing', () => {
    vi.useFakeTimers();
    const client = new WebSocketClient();
    client.connect('token-old');
    const ws1 = FakeWS.instances[0];
    client.disconnect(); // supersedes ws1's generation and stops the heartbeat

    // ws1's connect attempt opens late, after disconnect but before any new connect.
    // It must not restart the heartbeat (which disconnect just stopped).
    ws1.onopen?.();
    expect(timers(client).heartbeatTimer).toBeNull();
  });

  it('a superseded onclose firing after the new socket opens does not stop its heartbeat or reconnect', () => {
    vi.useFakeTimers();
    const client = new WebSocketClient();
    client.connect('token-old');
    const ws1 = FakeWS.instances[0];
    client.disconnect(); // ws1.close() is called but ws1.onclose is not nulled
    client.connect('token-new');
    const ws2 = FakeWS.instances[FakeWS.instances.length - 1];
    ws2.onopen?.(); // the live socket starts its heartbeat
    expect(timers(client).heartbeatTimer).not.toBeNull();

    // ws1's close event fires late, after ws2 is live. Its generation is stale, so
    // it must not stop ws2's heartbeat nor schedule a reconnect.
    ws1.onclose?.();
    expect(timers(client).heartbeatTimer).not.toBeNull(); // ws2's heartbeat survives
    expect(timers(client).reconnectTimer).toBeNull(); // no spurious reconnect
  });

  it('randomizes reconnect backoff within the equal-jitter window (distinct delays per seed)', () => {
    vi.useFakeTimers();
    const randomSpy = vi.spyOn(Math, 'random');
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    try {
      // Capture the reconnect delay scheduled for a given Math.random() value. At
      // attempt 0 the ceiling is min(1000, 30000) = 1000; equal jitter =>
      // ceiling/2 + random * ceiling/2, i.e. 500 at random 0 and 1000 at random 1.
      const delayFor = (r: number): number => {
        randomSpy.mockReturnValue(r);
        const client = new WebSocketClient();
        client.connect('t');
        setTimeoutSpy.mockClear();
        FakeWS.instances[FakeWS.instances.length - 1].onclose?.(); // -> scheduleReconnect
        const call = setTimeoutSpy.mock.calls.find((c) => typeof c[1] === 'number');
        return call![1] as number;
      };
      const d0 = delayFor(0);
      const d1 = delayFor(1);
      expect(d0).toBe(500);
      expect(d1).toBe(1000);
      // The random term must actually move the delay -- a constant ceiling/2 would
      // synchronize the whole fleet and fail this.
      expect(d0).not.toBe(d1);
    } finally {
      randomSpy.mockRestore();
      setTimeoutSpy.mockRestore();
      vi.useRealTimers();
    }
  });
});
