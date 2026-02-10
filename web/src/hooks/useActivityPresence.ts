import { useEffect, useRef } from 'react';
import { wsClient } from '../api/websocket';
import { usePresenceStore } from '../stores/presenceStore';
import { useAuthStore } from '../stores/authStore';

const IDLE_TIMEOUT = 10 * 60 * 1000; // 10 minutes
const CHECK_INTERVAL = 30_000; // Check every 30 seconds

const ACTIVITY_EVENTS: (keyof WindowEventMap)[] = [
  'mousemove',
  'mousedown',
  'keydown',
  'scroll',
  'touchstart',
  'pointerdown',
  'wheel',
];

/**
 * Tracks user activity (mouse, keyboard, touch, scroll) and updates
 * presence status via WebSocket. Goes idle after 10 minutes of no activity,
 * returns to online on any interaction or tab focus.
 */
export function useActivityPresence() {
  const currentStatusRef = useRef<'online' | 'idle'>('online');
  const lastActivityRef = useRef(Date.now());

  useEffect(() => {
    const userId = useAuthStore.getState().user?.id;
    if (!userId) return;

    const setStatus = (status: 'online' | 'idle') => {
      if (currentStatusRef.current === status) return;
      currentStatusRef.current = status;
      usePresenceStore.getState().setPresence(userId, status);
      wsClient.send('PRESENCE_UPDATE', { status });
    };

    const onActivity = () => {
      lastActivityRef.current = Date.now();
      if (currentStatusRef.current === 'idle') {
        setStatus('online');
      }
    };

    const onVisibilityChange = () => {
      if (!document.hidden) {
        onActivity();
      }
    };

    // Periodic idle check
    const timer = setInterval(() => {
      if (Date.now() - lastActivityRef.current >= IDLE_TIMEOUT) {
        setStatus('idle');
      }
    }, CHECK_INTERVAL);

    for (const event of ACTIVITY_EVENTS) {
      window.addEventListener(event, onActivity, { passive: true });
    }
    document.addEventListener('visibilitychange', onVisibilityChange);

    return () => {
      clearInterval(timer);
      for (const event of ACTIVITY_EVENTS) {
        window.removeEventListener(event, onActivity);
      }
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, []);
}
