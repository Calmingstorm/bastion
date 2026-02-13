// Type declaration stubs for @tauri-apps packages.
// These allow TypeScript to resolve dynamic imports in platform/desktop.ts
// without requiring the actual packages to be installed in web/node_modules/.
// The real packages are only available in desktop/node_modules/.

declare module '@tauri-apps/plugin-store' {
  export function load(path: string, options?: { autoSave?: boolean }): Promise<{
    entries<T>(): Promise<[string, T][]>;
    get<T>(key: string): Promise<T | null>;
    set(key: string, value: unknown): Promise<void>;
    delete(key: string): Promise<void>;
    save(): Promise<void>;
  }>;
}

declare module '@tauri-apps/plugin-notification' {
  export function isPermissionGranted(): Promise<boolean>;
  export function requestPermission(): Promise<string>;
  export function sendNotification(options: { title: string; body: string }): void;
}

declare module '@tauri-apps/plugin-shell' {
  export function open(url: string): Promise<void>;
}

declare module '@tauri-apps/api/window' {
  export function getCurrentWindow(): {
    setTitle(title: string): Promise<void>;
  };
}

declare module '@tauri-apps/api/app' {
  export function getVersion(): Promise<string>;
}
