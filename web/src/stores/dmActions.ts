import type { DMChannel } from '../types';
import { useDMStore } from './dmStore';
import { useServerStore } from './serverStore';

// Create a direct message and switch to it, obeying the session generation.
//
// Creation is delegated to the guarded dmStore.createDM, which returns undefined if
// the session changed while the create was in flight -- a DM created for the previous
// account must not surface in the new session. Only when a DM belonging to the CURRENT
// session comes back do we leave the server view and select it. Server-context call
// sites (member list, message author, profile card) must use this rather than the raw
// apiCreateDM, which has no session ownership and would select a DM created for the
// account that just logged out.
export async function openDirectMessage(
  recipientIds: string[]
): Promise<DMChannel | undefined> {
  const dm = await useDMStore.getState().createDM(recipientIds);
  if (!dm) return undefined;
  useServerStore.setState({ selectedServerId: null, selectedChannelId: null });
  useDMStore.getState().selectDM(dm.id);
  return dm;
}
