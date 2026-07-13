import { useServerStore } from './serverStore';
import { useMessageStore } from './messageStore';
import { useDMStore } from './dmStore';
import { usePresenceStore } from './presenceStore';
import { usePermissionStore } from './permissionStore';
import { useTypingStore } from './typingStore';
import { useUnreadStore } from './unreadStore';
import { useCommandStore } from './commandStore';
import { useToastStore } from './toastStore';
import { wsClient } from '../api/websocket';

// resetAllStores clears every per-user data store. It is called on logout and on
// a terminal auth failure, so that logging in as a different user on the same
// session never surfaces the previous user's cached servers, messages, DMs,
// permissions, presence, typing, unread counts, commands, or transient toasts.
export function resetAllStores(): void {
  // Synchronously tear down the session's WebSocket FIRST: disconnect() removes
  // every handler and closes the socket, so a buffered or in-flight event
  // (MESSAGE_CREATE, REACTION_ADD, ...) delivered after the stores are cleared
  // can no longer repopulate them. Relying on the AppPage effect cleanup to
  // disconnect is too late -- it runs after this synchronous logout, leaving a
  // window in which the old session's socket writes into the fresh one. Calling
  // wsClient directly (not the wsStore) keeps this module free of the
  // wsStore -> authStore -> resetAll import cycle; the wsStore's own
  // isConnected/heartbeat are reconciled by that same effect cleanup.
  wsClient.disconnect();
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
