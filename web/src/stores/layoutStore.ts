import { create } from 'zustand';
import { storage } from '../utils/storage';

type Layout = 'modern' | 'classic';

interface LayoutState {
  layout: Layout;
  setLayout: (layout: Layout) => void;
}

const stored = storage.getItem('bastion-layout') as Layout | null;
const initial: Layout = stored === 'classic' ? 'classic' : 'modern';

export const useLayoutStore = create<LayoutState>((set) => ({
  layout: initial,

  setLayout: (layout: Layout) => {
    storage.setItem('bastion-layout', layout);
    set({ layout });
  },
}));
