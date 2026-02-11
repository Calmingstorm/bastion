type Handler = (detail?: unknown) => void;

const listeners = new Map<string, Set<Handler>>();

export const eventBus = {
  emit(event: string, detail?: unknown): void {
    const handlers = listeners.get(event);
    if (handlers) {
      handlers.forEach((h) => h(detail));
    }
  },

  on(event: string, handler: Handler): void {
    if (!listeners.has(event)) {
      listeners.set(event, new Set());
    }
    listeners.get(event)!.add(handler);
  },

  off(event: string, handler: Handler): void {
    const handlers = listeners.get(event);
    if (handlers) {
      handlers.delete(handler);
    }
  },
};
