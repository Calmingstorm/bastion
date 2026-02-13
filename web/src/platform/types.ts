export interface PlatformStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface Platform {
  name: 'web' | 'desktop';
  storage: PlatformStorage;
  requestNotificationPermission(): Promise<boolean>;
  showNotification(title: string, body: string, icon?: string): void;
  getOrigin(): string;
  openExternal(url: string): void;
  setTitle(title: string): void;
  getVersion(): Promise<string>;
}
