import { create } from 'zustand';
import { apiGetMemberPermissions } from '../api/client';
import { captureSessionGeneration, isSessionGenerationCurrent } from '../api/session';
import { hasFlag } from '../utils/permissions';

interface PermissionState {
  /** serverId → computed permission bitfield for the current user */
  permissions: Record<string, number>;
  fetchPermissions: (serverId: string) => Promise<void>;
  hasPermission: (serverId: string | null, perm: number) => boolean;
  reset: () => void;
}

// Bumped by reset(): a fetch held across reset() must not repopulate the cleared
// store when it settles, auth generation aside (the same contract the lineage
// stores honor). Keyed single-value writes need no reconciling journal -- a
// stale response only ever writes its own server's key -- so an epoch is the
// whole requirement.
let permissionEpoch = 0;

// Per-server request recency: two same-server fetches can race, and permissions
// are security-relevant -- an OLDER response resolving last must not overwrite
// the newer one (it may carry stale elevated permissions).
const requestSeqs = new Map<string, number>();

export const usePermissionStore = create<PermissionState>((set, get) => ({
  permissions: {},

  fetchPermissions: async (serverId: string) => {
    const generation = captureSessionGeneration();
    const epoch = permissionEpoch;
    const seq = (requestSeqs.get(serverId) ?? 0) + 1;
    requestSeqs.set(serverId, seq);
    try {
      const { permissions: perms } = await apiGetMemberPermissions(serverId);
      if (!isSessionGenerationCurrent(generation)) return;
      if (epoch !== permissionEpoch) return; // reset() intervened
      if (requestSeqs.get(serverId) !== seq) return; // a newer same-server request owns this key
      set((state) => ({
        permissions: { ...state.permissions, [serverId]: perms },
      }));
    } catch {
      // On error, leave existing value (or absent) — UI will fall back to no perms
    }
  },

  hasPermission: (serverId: string | null, perm: number) => {
    if (!serverId) return false;
    const perms = get().permissions[serverId];
    if (perms === undefined) return false;
    return hasFlag(perms, perm);
  },

  reset: () => {
    permissionEpoch += 1;
    requestSeqs.clear();
    set({ permissions: {} });
  },
}));
