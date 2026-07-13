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
  });

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
});
