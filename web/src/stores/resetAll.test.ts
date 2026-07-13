import { describe, it, expect } from 'vitest';
import { useServerStore } from './serverStore';
import { useCommandStore } from './commandStore';
import { useAuthStore } from './authStore';
import { resetAllStores } from './resetAll';
import type { Server } from '../types';

function seedStores() {
  useServerStore.setState({ servers: [{ id: 's1', name: 'Secret' } as Server] });
  useCommandStore.setState({ commands: [{ id: 'c1' } as never], serverId: 's1' });
}

describe('resetAllStores', () => {
  it('clears the per-user data stores', () => {
    seedStores();
    resetAllStores();
    expect(useServerStore.getState().servers).toEqual([]);
    expect(useCommandStore.getState().commands).toEqual([]);
    expect(useCommandStore.getState().serverId).toBeNull();
  });
});

describe('authStore.logout', () => {
  it('clears auth state and every other per-user store', () => {
    useAuthStore.setState({ isAuthenticated: true, user: { id: 'u1' } as never });
    seedStores();

    useAuthStore.getState().logout();

    expect(useAuthStore.getState().isAuthenticated).toBe(false);
    expect(useAuthStore.getState().user).toBeNull();
    // The previous user's cached data must not survive into the next session.
    expect(useServerStore.getState().servers).toEqual([]);
    expect(useCommandStore.getState().commands).toEqual([]);
  });
});
