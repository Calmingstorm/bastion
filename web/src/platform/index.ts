import type { Platform } from './types';
import { webPlatform } from './web';
import { setApiBaseURL } from '../api/client';
import { setWSServerUrl } from '../api/websocket';

declare const __TAURI_MOBILE__: boolean | undefined;

let currentPlatform: Platform = webPlatform;
let tauriInitialized = false;

export function isTauri(): boolean {
  return '__TAURI_INTERNALS__' in window;
}

export function isMobile(): boolean {
  return typeof __TAURI_MOBILE__ !== 'undefined' && __TAURI_MOBILE__;
}

// True only if we're in Tauri AND the desktop platform loaded successfully
export function isDesktopReady(): boolean {
  return isTauri() && !isMobile() && tauriInitialized;
}

// True only if we're in Tauri mobile AND the mobile platform loaded successfully
export function isMobileReady(): boolean {
  return isTauri() && isMobile() && tauriInitialized;
}

export async function initPlatform(): Promise<void> {
  if (isTauri()) {
    try {
      if (isMobile()) {
        const mod = await import('./mobile');
        currentPlatform = await mod.initMobilePlatform();
      } else {
        const mod = await import('./desktop');
        currentPlatform = await mod.initDesktopPlatform();
      }
      tauriInitialized = true;

      // Configure API client and WebSocket with the stored server URL
      const serverUrl = currentPlatform.storage.getItem('serverUrl');
      if (serverUrl) {
        setApiBaseURL(serverUrl);
        setWSServerUrl(serverUrl);
      }
    } catch (err) {
      console.error('Failed to initialize platform:', err);
      // Falls back to webPlatform — isDesktopReady()/isMobileReady() will return false
    }
  }
}

export function getPlatform(): Platform {
  return currentPlatform;
}

/**
 * Resolve a media URL (avatar, icon, upload) to an absolute URL.
 * On web, relative URLs resolve naturally against the page origin.
 * On desktop/mobile, we must prepend the configured server URL.
 */
export function resolveMediaUrl(url: string | undefined | null): string | undefined {
  if (!url) return undefined;
  // Already absolute
  if (url.startsWith('http://') || url.startsWith('https://') || url.startsWith('data:') || url.startsWith('blob:')) {
    return url;
  }
  // On desktop/mobile, prepend the server URL
  if (isTauri()) {
    const serverUrl = currentPlatform.storage.getItem('serverUrl');
    if (serverUrl) {
      return serverUrl.replace(/\/+$/, '') + (url.startsWith('/') ? url : '/' + url);
    }
  }
  return url;
}

export type { Platform, PlatformStorage } from './types';
