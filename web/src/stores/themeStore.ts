import { create } from 'zustand';

type Theme = 'dark' | 'light';

interface ThemeState {
  theme: Theme;
  toggleTheme: () => void;
}

function applyTheme(theme: Theme) {
  document.documentElement.setAttribute('data-theme', theme);
  localStorage.setItem('bastion-theme', theme);
}

const stored = (typeof localStorage !== 'undefined'
  ? localStorage.getItem('bastion-theme')
  : null) as Theme | null;
const initial: Theme = stored === 'light' ? 'light' : 'dark';

// Apply on load so there's no flash
if (typeof document !== 'undefined') {
  document.documentElement.setAttribute('data-theme', initial);
}

export const useThemeStore = create<ThemeState>((set) => ({
  theme: initial,

  toggleTheme: () => {
    set((state) => {
      const next = state.theme === 'dark' ? 'light' : 'dark';
      applyTheme(next);
      return { theme: next };
    });
  },
}));
