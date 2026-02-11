import { create } from 'zustand';

type Layout = 'modern' | 'classic';

interface LayoutState {
  layout: Layout;
  setLayout: (layout: Layout) => void;
}

const stored = (typeof localStorage !== 'undefined'
  ? localStorage.getItem('bastion-layout')
  : null) as Layout | null;
const initial: Layout = stored === 'classic' ? 'classic' : 'modern';

export const useLayoutStore = create<LayoutState>((set) => ({
  layout: initial,

  setLayout: (layout: Layout) => {
    localStorage.setItem('bastion-layout', layout);
    set({ layout });
  },
}));
