import { getPlatform } from '../platform';

export function showNotification(title: string, body: string, icon?: string): void {
  getPlatform().showNotification(title, body, icon);
}
