import type { Platform } from './types';
import { webPlatform } from './web';

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
  }
}

export function getPlatform(): Platform {
  return currentPlatform;
}

export type { Platform, PlatformStorage } from './types';
