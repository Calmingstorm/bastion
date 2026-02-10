import { create } from 'zustand';
import apiClient from '../api/client';

interface Features {
  gifSearch: boolean;
  gifProvider: string; // "tenor", "giphy", or ""
}

interface FeatureState {
  features: Features;
  loaded: boolean;
  fetchFeatures: () => Promise<void>;
}

export const useFeatureStore = create<FeatureState>((set) => ({
  features: { gifSearch: false, gifProvider: '' },
  loaded: false,
  fetchFeatures: async () => {
    try {
      const response = await apiClient.get<Features>('/api/features');
      set({ features: response.data, loaded: true });
    } catch {
      // Default to all disabled if unreachable
      set({ loaded: true });
    }
  },
}));
