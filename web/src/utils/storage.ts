import { getPlatform } from '../platform';

export const storage = {
  getItem: (key: string): string | null => getPlatform().storage.getItem(key),
  setItem: (key: string, value: string): void => getPlatform().storage.setItem(key, value),
  removeItem: (key: string): void => getPlatform().storage.removeItem(key),
};
