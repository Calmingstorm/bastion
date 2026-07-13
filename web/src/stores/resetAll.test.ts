import { describe, it, expect, vi } from 'vitest';
import { useServerStore } from './serverStore';
import { useMessageStore } from './messageStore';
import { useDMStore } from './dmStore';
import { usePresenceStore } from './presenceStore';
import { usePermissionStore } from './permissionStore';
import { useTypingStore } from './typingStore';
import { useUnreadStore } from './unreadStore';
import { useCommandStore } from './commandStore';
import { useToastStore } from './toastStore';
import { useAuthStore } from './authStore';
import { resetAllStores } from './resetAll';
import { wsClient } from '../api/websocket';
import type { Server } from '../types';

// Seed every per-user store with some data, so a test can prove each one is
// cleared. If resetAllStores stops resetting any store, its assertion fails.
function seedAllStores() {
  useServerStore.setState({ servers: [{ id: 's1', name: 'Secret' } as Server] });
  useMessageStore.setState({ messages: { c1: [{ id: 'm1' } as never] } });
  useDMStore.setState({ dmChannels: [{ id: 'd1' } as never] });
  usePresenceStore.setState({ presences: { u1: 'online' } });
  usePermissionStore.setState({ permissions: { s1: 7 } });
  useTypingStore.setState({ typing: { c1: { u1: 1 } } as never });
  useUnreadStore.setState({ readStates: { c1: {} as never }, unreadChannels: new Set(['c1']) });
  useCommandStore.setState({ commands: [{ id: 'cmd1' } as never], serverId: 's1' });
  useToastStore.setState({ toasts: [{ id: 1, message: 'stale toast' }] });
}

describe('resetAllStores', () => {
  it('clears every per-user data store', () => {
    seedAllStores();
    resetAllStores();

    expect(useServerStore.getState().servers).toEqual([]);
    expect(useMessageStore.getState().messages).toEqual({});
    expect(useDMStore.getState().dmChannels).toEqual([]);
    expect(usePresenceStore.getState().presences).toEqual({});
    expect(usePermissionStore.getState().permissions).toEqual({});
    expect(useTypingStore.getState().typing).toEqual({});
    expect(useUnreadStore.getState().readStates).toEqual({});
    expect(useUnreadStore.getState().unreadChannels.size).toBe(0);
    expect(useCommandStore.getState().commands).toEqual([]);
    expect(useCommandStore.getState().serverId).toBeNull();
    expect(useToastStore.getState().toasts).toEqual([]); // stale toasts don't leak into the next session
  });
});

describe('resetAllStores WebSocket teardown', () => {
  it('synchronously disconnects the session WebSocket (so a late event cannot repopulate a cleared store)', () => {
    const spy = vi.spyOn(wsClient, 'disconnect');
    resetAllStores();
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it('removes WebSocket handlers, so an event delivered after logout is inert', () => {
    const handler = vi.fn();
    wsClient.on('MESSAGE_CREATE', handler);
    resetAllStores(); // -> wsClient.disconnect() -> removeAllHandlers()
    // A frame still in the browser's receive buffer would dispatch to registered
    // handlers; after logout there must be none left to write into the fresh store.
    (wsClient as unknown as { dispatch: (t: string, d: unknown) => void }).dispatch(
      'MESSAGE_CREATE',
      { message: { id: 'm', channelId: 'c' } }
    );
    expect(handler).not.toHaveBeenCalled();
  });
});

describe('authStore.logout', () => {
  it('clears auth state and every other per-user store', () => {
    useAuthStore.setState({ isAuthenticated: true, user: { id: 'u1' } as never });
    seedAllStores();

    useAuthStore.getState().logout();

    expect(useAuthStore.getState().isAuthenticated).toBe(false);
    expect(useAuthStore.getState().user).toBeNull();
    // A sample of the other stores — the exhaustive check is above.
    expect(useServerStore.getState().servers).toEqual([]);
    expect(useMessageStore.getState().messages).toEqual({});
    expect(useCommandStore.getState().commands).toEqual([]);
  });
});
