import type { Platform } from './types';

export const webPlatform: Platform = {
  name: 'web',

  storage: {
    getItem: (key: string) => localStorage.getItem(key),
    setItem: (key: string, value: string) => localStorage.setItem(key, value),
    removeItem: (key: string) => localStorage.removeItem(key),
  },

  requestNotificationPermission: async () => {
    if (!('Notification' in window)) return false;
    if (Notification.permission === 'granted') return true;
    if (Notification.permission === 'denied') return false;
    const result = await Notification.requestPermission();
    return result === 'granted';
  },

  showNotification: (title: string, body: string, icon?: string) => {
    if (
      typeof window === 'undefined' ||
      !('Notification' in window) ||
      Notification.permission !== 'granted' ||
      !document.hidden
    ) {
      return;
    }
    new Notification(title, { body, icon: icon || '/favicon.ico' });
  },

  getOrigin: () => window.location.origin,

  openExternal: (url: string) => {
    window.open(url, '_blank', 'noopener,noreferrer');
  },

  setTitle: (title: string) => {
    document.title = title;
  },

  getVersion: async () => '0.1.0',
};
