import type { Platform } from './types';
import { webPlatform } from './web';
import { setApiBaseURL } from '../api/client';
import { setWSServerUrl } from '../api/websocket';

let currentPlatform: Platform = webPlatform;

export function isTauri(): boolean {
  return '__TAURI__' in window;
}

export async function initPlatform(): Promise<void> {
  if (isTauri()) {
    // Dynamic import hidden from tsc so web builds don't need Tauri dependencies
    const desktopModule = './desktop';
    const mod = await import(/* @vite-ignore */ desktopModule) as {
      initDesktopPlatform: () => Promise<Platform>;
    };
    currentPlatform = await mod.initDesktopPlatform();

    // Configure API client and WebSocket with the stored server URL
    const serverUrl = currentPlatform.storage.getItem('serverUrl');
    if (serverUrl) {
      setApiBaseURL(serverUrl);
      setWSServerUrl(serverUrl);
    }
  }
}

export function getPlatform(): Platform {
  return currentPlatform;
}

export type { Platform, PlatformStorage } from './types';
