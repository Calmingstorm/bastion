import { describe, it, expect, beforeEach, vi } from 'vitest';
import { resyncAfterReconnect } from './wsStore';
import { useServerStore } from './serverStore';
import { useDMStore } from './dmStore';
import { useMessageStore } from './messageStore';
import { useUnreadStore } from './unreadStore';

describe('resyncAfterReconnect', () => {
  beforeEach(() => {
    useServerStore.setState({ selectedChannelId: null });
    useDMStore.setState({ selectedDMId: null });
    vi.restoreAllMocks();
  });

  it('re-fetches the active channel in merge mode', () => {
    useServerStore.setState({ selectedChannelId: 'c1' });
    const fetchSpy = vi.spyOn(useMessageStore.getState(), 'fetchMessages').mockResolvedValue();
    vi.spyOn(useDMStore.getState(), 'fetchDMs').mockResolvedValue();
    vi.spyOn(useUnreadStore.getState(), 'fetchReadStates').mockResolvedValue();

    resyncAfterReconnect();

    // The reconnect wiring must pass merge=true, so the resync preserves history
    // and live changes instead of replacing them.
    expect(fetchSpy).toHaveBeenCalledWith('c1', undefined, true);
  });

  it('falls back to the selected DM when no server channel is active', () => {
    useDMStore.setState({ selectedDMId: 'd1' });
    const fetchSpy = vi.spyOn(useMessageStore.getState(), 'fetchMessages').mockResolvedValue();
    vi.spyOn(useDMStore.getState(), 'fetchDMs').mockResolvedValue();
    vi.spyOn(useUnreadStore.getState(), 'fetchReadStates').mockResolvedValue();

    resyncAfterReconnect();

    expect(fetchSpy).toHaveBeenCalledWith('d1', undefined, true);
  });
});
