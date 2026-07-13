import { useServerStore } from './serverStore';
import { useMessageStore } from './messageStore';
import { useDMStore } from './dmStore';
import { usePresenceStore } from './presenceStore';
import { usePermissionStore } from './permissionStore';
import { useTypingStore } from './typingStore';
import { useUnreadStore } from './unreadStore';
import { useCommandStore } from './commandStore';
import { useToastStore } from './toastStore';

// resetAllStores clears every per-user data store. It is called on logout and on
// a terminal auth failure, so that logging in as a different user on the same
// session never surfaces the previous user's cached servers, messages, DMs,
// permissions, presence, typing, unread counts, commands, or transient toasts.
export function resetAllStores(): void {
  useServerStore.getState().reset();
  useMessageStore.getState().reset();
  useDMStore.getState().reset();
  usePresenceStore.getState().reset();
  usePermissionStore.getState().reset();
  useTypingStore.getState().reset();
  useUnreadStore.getState().reset();
  useCommandStore.getState().clear();
  useToastStore.getState().clear();
}
