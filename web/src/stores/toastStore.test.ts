import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useToastStore } from './toastStore';

describe('toastStore', () => {
  beforeEach(() => {
    useToastStore.setState({ toasts: [] });
  });

  it('adds a toast', () => {
    useToastStore.getState().addToast('Failed to send message.');
    expect(useToastStore.getState().toasts.map((t) => t.message)).toEqual(['Failed to send message.']);
  });

  it('removes a toast by id', () => {
    useToastStore.getState().addToast('x');
    const id = useToastStore.getState().toasts[0].id;
    useToastStore.getState().removeToast(id);
    expect(useToastStore.getState().toasts).toEqual([]);
  });

  it('auto-dismisses after the TTL', () => {
    vi.useFakeTimers();
    try {
      useToastStore.getState().addToast('x');
      expect(useToastStore.getState().toasts).toHaveLength(1);
      vi.advanceTimersByTime(5001);
      expect(useToastStore.getState().toasts).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
