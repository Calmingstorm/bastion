import type { DMChannel } from '../types';
import { useDMStore } from './dmStore';
import { useServerStore } from './serverStore';
import { captureSessionGeneration, isSessionGenerationCurrent } from '../api/session';

// Create a direct message and switch to it, with the WHOLE workflow owned by the
// session generation captured at entry.
//
// Creation is delegated to the guarded dmStore.createDM, which returns undefined if
// the session changed while the create was in flight. That alone is not enough: the
// boundary can also land between createDM settling (its internal check passed) and
// this continuation running, so we re-check our own captured generation before the
// side effects (leaving the server view, selecting the DM). Server-context call sites
// (member list, message author, profile card) must use this rather than the raw
// apiCreateDM, which has no session ownership and would select a DM created for the
// account that just logged out.
export async function openDirectMessage(
  recipientIds: string[],
  stillValid: () => boolean = () => true
): Promise<DMChannel | undefined> {
  const generation = captureSessionGeneration();
  const dm = await useDMStore.getState().createDM(recipientIds);
  // stillValid lets a reusable caller (e.g. a profile card retargeted to another
  // user mid-flight) withdraw: a DM created for the previous target must not be
  // selected -- nor its card closed -- under the new one.
  if (!dm || !isSessionGenerationCurrent(generation) || !stillValid()) return undefined;
  // Entering DM scope claims the channel lineage (a held selectServer must not
  // shadow the newly opened DM).
  useServerStore.getState().clearServerSelection();
  useDMStore.getState().selectDM(dm.id);
  return dm;
}
