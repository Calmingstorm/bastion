import { useEffect, useCallback } from 'react';
import { getPlatform } from '../platform';

export function useNotifications() {
  useEffect(() => {
    getPlatform().requestNotificationPermission();
  }, []);

  const notify = useCallback((title: string, body?: string) => {
    getPlatform().showNotification(title, body || '');
  }, []);

  return { notify };
}
