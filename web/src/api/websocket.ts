import type { WSMessage, WSEventType } from '../types';
import { storage } from '../utils/storage';

type EventHandler = (data: unknown) => void;

// Configurable server URL for desktop — set before connecting
let serverUrlOverride: string | null = null;

export function setWSServerUrl(url: string): void {
  serverUrlOverride = url;
}

function buildWSUrl(token: string): string {
  if (serverUrlOverride) {
    const parsed = new URL(serverUrlOverride);
    const protocol = parsed.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${protocol}//${parsed.host}/api/v1/ws?token=${encodeURIComponent(token)}`;
  }
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const host = import.meta.env.VITE_API_URL
    ? new URL(import.meta.env.VITE_API_URL).host
    : window.location.host;
  return `${protocol}//${host}/api/v1/ws?token=${encodeURIComponent(token)}`;
}

export class WebSocketClient {
  private ws: WebSocket | null = null;
  private url: string = '';
  private token: string = '';
  private handlers: Map<WSEventType, Set<EventHandler>> = new Map();
  private reconnectAttempts: number = 0;
  private maxReconnectDelay: number = 30000;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private heartbeatInterval: number = 30000;
  private intentionalClose: boolean = false;
  private wasConnectedBefore: boolean = false;
  // Monotonic generation of the live socket. Every socket callback captures the
  // generation it was created under and refuses to act once a newer socket (from a
  // reconnect) or a disconnect (logout) has superseded it. This client is a shared
  // singleton, so without it a buffered callback from an old socket would run
  // this.dispatch() against whatever handlers the NEXT session has since registered
  // -- delivering a previous session's frame into the new one.
  private connectionGen: number = 0;

  connect(token: string): void {
    this.token = token;
    this.intentionalClose = false;
    this.url = buildWSUrl(token);
    this.doConnect();
  }

  private doConnect(): void {
    // This socket's generation. Captured by every callback below; a callback whose
    // generation is no longer the live one belongs to a superseded socket and must
    // not dispatch a frame or mutate connection state.
    const gen = ++this.connectionGen;

    if (this.ws) {
      this.ws.onclose = null;
      this.ws.onerror = null;
      this.ws.onmessage = null;
      this.ws.onopen = null;
      if (
        this.ws.readyState === WebSocket.OPEN ||
        this.ws.readyState === WebSocket.CONNECTING
      ) {
        this.ws.close();
      }
    }

    this.ws = new WebSocket(this.url);

    this.ws.onopen = () => {
      if (gen !== this.connectionGen) return; // superseded socket
      this.reconnectAttempts = 0;
      this.startHeartbeat();
      // Notify listeners that the connection is open (or reopened after reconnect)
      this.dispatch('CONNECTED' as WSEventType, { isReconnect: this.wasConnectedBefore });
      this.wasConnectedBefore = true;
    };

    this.ws.onmessage = (event: MessageEvent) => {
      if (gen !== this.connectionGen) return; // buffered frame from a superseded socket
      try {
        const msg: WSMessage = JSON.parse(event.data as string);
        this.dispatch(msg.type, msg.data);
      } catch {
        // Ignore malformed messages
      }
    };

    this.ws.onerror = () => {
      // Error handling is done in onclose
    };

    this.ws.onclose = () => {
      if (gen !== this.connectionGen) return; // a superseded socket closing
      this.stopHeartbeat();
      if (!this.intentionalClose) {
        this.scheduleReconnect();
      }
    };
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ type: 'PING' }));
      }
    }, this.heartbeatInterval);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
    }

    const ceiling = Math.min(
      1000 * Math.pow(2, this.reconnectAttempts),
      this.maxReconnectDelay
    );
    // Equal jitter: half the exponential backoff plus a random point in the other
    // half -> a delay in [ceiling/2, ceiling]. A single server restart drops the
    // whole fleet at once; without jitter every client would reconnect on the same
    // tick and stampede the server. This keeps a real minimum backoff while
    // spreading the herd.
    const delay = ceiling / 2 + Math.random() * (ceiling / 2);
    this.reconnectAttempts++;

    this.reconnectTimer = setTimeout(() => {
      // Read fresh token from storage in case it was refreshed during disconnect
      const freshToken = storage.getItem('accessToken');
      if (freshToken) this.token = freshToken;
      this.url = buildWSUrl(this.token);
      this.doConnect();
    }, delay);
  }

  disconnect(): void {
    // Invalidate the live socket's callbacks first: any buffered onmessage/onclose
    // from the socket we are about to close now belongs to a superseded generation
    // and will no-op, even though onmessage is not nulled and close() is async.
    this.connectionGen++;
    this.intentionalClose = true;
    // A disconnect ends the session (logout / a fresh connect's leading teardown).
    // Reset the reconnect lineage so the NEXT session's first open is classified as
    // an initial connection, not a reconnect -- otherwise it would fire a spurious
    // resyncAfterReconnect. A network-drop reconnect does NOT come through here (it
    // runs onclose -> scheduleReconnect -> doConnect), so it correctly stays a
    // reconnect.
    this.wasConnectedBefore = false;
    this.removeAllHandlers();

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    this.stopHeartbeat();

    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }

    this.reconnectAttempts = 0;
  }

  updateToken(token: string): void {
    this.token = token;
  }

  removeAllHandlers(): void {
    this.handlers.clear();
  }

  on(event: WSEventType, handler: EventHandler): void {
    if (!this.handlers.has(event)) {
      this.handlers.set(event, new Set());
    }
    this.handlers.get(event)!.add(handler);
  }

  off(event: WSEventType, handler: EventHandler): void {
    const handlers = this.handlers.get(event);
    if (handlers) {
      handlers.delete(handler);
    }
  }

  private dispatch(event: WSEventType, data: unknown): void {
    const handlers = this.handlers.get(event);
    if (handlers) {
      handlers.forEach((handler) => {
        try {
          handler(data);
        } catch (err) {
          console.error(`WebSocket handler error for ${event}:`, err);
        }
      });
    }
  }

  send(type: string, data?: unknown): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type, data }));
    }
  }

  get isConnected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }
}

export const wsClient = new WebSocketClient();
