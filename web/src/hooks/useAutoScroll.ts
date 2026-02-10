import { useRef, useEffect, useCallback } from 'react';

interface UseAutoScrollOptions {
  /** Pixel threshold from bottom to consider "at bottom" */
  threshold?: number;
}

interface UseAutoScrollReturn {
  containerRef: React.RefObject<HTMLDivElement | null>;
  scrollToBottom: () => void;
  /** Scroll to bottom and keep watching for height changes (image loads, embeds) for a few seconds */
  scrollToBottomPersistent: () => void;
  isAtBottom: () => boolean;
}

export function useAutoScroll(
  deps: unknown[],
  options: UseAutoScrollOptions = {}
): UseAutoScrollReturn {
  const { threshold = 100 } = options;
  const containerRef = useRef<HTMLDivElement | null>(null);
  const wasAtBottomRef = useRef(true);
  const heightWatcherRef = useRef<number | null>(null);

  const isAtBottom = useCallback((): boolean => {
    const container = containerRef.current;
    if (!container) return true;
    const { scrollTop, scrollHeight, clientHeight } = container;
    return scrollHeight - scrollTop - clientHeight <= threshold;
  }, [threshold]);

  const scrollToBottom = useCallback(() => {
    const container = containerRef.current;
    if (container) {
      container.scrollTop = container.scrollHeight;
    }
  }, []);

  // Scroll to bottom and keep re-scrolling whenever content height changes
  // (catches async image/GIF/embed loads). Watches for 3 seconds.
  const scrollToBottomPersistent = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;

    // Cancel any existing watcher
    if (heightWatcherRef.current) {
      cancelAnimationFrame(heightWatcherRef.current);
    }

    container.scrollTop = container.scrollHeight;
    wasAtBottomRef.current = true;

    let lastHeight = container.scrollHeight;
    const startTime = performance.now();
    const watchDuration = 3000; // Watch for 3 seconds

    const check = () => {
      const c = containerRef.current;
      if (!c) return;

      // Stop watching if user scrolled away from bottom
      if (!wasAtBottomRef.current) {
        heightWatcherRef.current = null;
        return;
      }

      // Stop after duration expires
      if (performance.now() - startTime > watchDuration) {
        heightWatcherRef.current = null;
        return;
      }

      const newHeight = c.scrollHeight;
      if (newHeight !== lastHeight) {
        c.scrollTop = c.scrollHeight;
        lastHeight = newHeight;
      }

      heightWatcherRef.current = requestAnimationFrame(check);
    };

    heightWatcherRef.current = requestAnimationFrame(check);
  }, []);

  // Clean up height watcher on unmount
  useEffect(() => {
    return () => {
      if (heightWatcherRef.current) {
        cancelAnimationFrame(heightWatcherRef.current);
      }
    };
  }, []);

  // Track whether user is at bottom before content changes
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const handleScroll = () => {
      wasAtBottomRef.current = isAtBottom();
    };

    container.addEventListener('scroll', handleScroll, { passive: true });
    return () => {
      container.removeEventListener('scroll', handleScroll);
    };
  }, [isAtBottom]);

  // Auto-scroll when dependencies change (new messages, etc.)
  useEffect(() => {
    if (wasAtBottomRef.current) {
      scrollToBottom();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return { containerRef, scrollToBottom, scrollToBottomPersistent, isAtBottom };
}
