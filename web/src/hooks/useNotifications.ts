import { useEffect, useCallback } from 'react';

export function useNotifications() {
  useEffect(() => {
    if ('Notification' in window && Notification.permission === 'default') {
      Notification.requestPermission();
    }
  }, []);

  const notify = useCallback((title: string, body?: string) => {
    if (
      'Notification' in window &&
      Notification.permission === 'granted' &&
      document.hidden
    ) {
      new Notification(title, {
        body,
        icon: '/favicon.ico',
      });
    }
  }, []);

  return { notify };
}
