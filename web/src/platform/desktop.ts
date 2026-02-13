import type { Platform, PlatformStorage } from './types';

// Lazy-loaded Tauri modules — only imported when running in Tauri
let tauriStore: Awaited<ReturnType<typeof import('@tauri-apps/plugin-store')['load']>> | null = null;
let flushTimer: ReturnType<typeof setTimeout> | null = null;

// In-memory mirror of the Tauri store for synchronous access
const memoryStore = new Map<string, string>();

async function initStore(): Promise<void> {
  const { load } = await import('@tauri-apps/plugin-store');
  tauriStore = await load('settings.json', { autoSave: false });

  // Load all existing entries into memory
  const entries = await tauriStore.entries<string>();
  for (const [key, value] of entries) {
    if (typeof value === 'string') {
      memoryStore.set(key, value);
    }
  }
}

function scheduleFlush(): void {
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = setTimeout(async () => {
    if (tauriStore) {
      await tauriStore.save();
    }
  }, 500);
}

const desktopStorage: PlatformStorage = {
  getItem: (key: string) => memoryStore.get(key) ?? null,

  setItem: (key: string, value: string) => {
    memoryStore.set(key, value);
    tauriStore?.set(key, value);
    scheduleFlush();
  },

  removeItem: (key: string) => {
    memoryStore.delete(key);
    tauriStore?.delete(key);
    scheduleFlush();
  },
};

export async function initDesktopPlatform(): Promise<Platform> {
  await initStore();

  return {
    name: 'desktop',
    storage: desktopStorage,

    requestNotificationPermission: async () => {
      const { isPermissionGranted, requestPermission } = await import(
        '@tauri-apps/plugin-notification'
      );
      let granted = await isPermissionGranted();
      if (!granted) {
        const result = await requestPermission();
        granted = result === 'granted';
      }
      return granted;
    },

    showNotification: async (title: string, body: string) => {
      const { sendNotification, isPermissionGranted } = await import(
        '@tauri-apps/plugin-notification'
      );
      const granted = await isPermissionGranted();
      if (granted) {
        sendNotification({ title, body });
      }
    },

    getOrigin: () => {
      // Desktop uses configured server URL
      return desktopStorage.getItem('serverUrl') || 'https://bastions.org';
    },

    openExternal: async (url: string) => {
      const { open } = await import('@tauri-apps/plugin-shell');
      await open(url);
    },

    setTitle: async (title: string) => {
      const { getCurrentWindow } = await import('@tauri-apps/api/window');
      await getCurrentWindow().setTitle(title);
    },

    getVersion: async () => {
      const { getVersion } = await import('@tauri-apps/api/app');
      return getVersion();
    },
  };
}
