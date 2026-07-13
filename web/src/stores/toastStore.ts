import { create } from 'zustand';

export interface Toast {
  id: number;
  message: string;
}

interface ToastState {
  toasts: Toast[];
  /** Show a transient error toast. Auto-dismisses after a few seconds. */
  addToast: (message: string) => void;
  removeToast: (id: number) => void;
  clear: () => void;
}

const TOAST_TTL_MS = 5000;
let nextId = 0;

export const useToastStore = create<ToastState>((set) => ({
  toasts: [],
  addToast: (message: string) => {
    const id = (nextId += 1);
    set((s) => ({ toasts: [...s.toasts, { id, message }] }));
    setTimeout(() => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), TOAST_TTL_MS);
  },
  removeToast: (id: number) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
  clear: () => set({ toasts: [] }),
}));
