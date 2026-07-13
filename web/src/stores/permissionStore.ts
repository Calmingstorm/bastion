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

export const usePermissionStore = create<PermissionState>((set, get) => ({
  permissions: {},

  fetchPermissions: async (serverId: string) => {
    const generation = captureSessionGeneration();
    try {
      const { permissions: perms } = await apiGetMemberPermissions(serverId);
      if (!isSessionGenerationCurrent(generation)) return;
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
    set({ permissions: {} });
  },
}));
