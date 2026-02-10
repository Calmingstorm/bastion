import { create } from 'zustand';
import apiClient from '../api/client';

interface Features {
  gifSearch: boolean;
}

interface FeatureState {
  features: Features;
  loaded: boolean;
  fetchFeatures: () => Promise<void>;
}

export const useFeatureStore = create<FeatureState>((set) => ({
  features: { gifSearch: false },
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
