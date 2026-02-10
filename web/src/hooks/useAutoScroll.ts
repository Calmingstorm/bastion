import { useRef, useEffect, useCallback } from 'react';

interface UseAutoScrollOptions {
  /** Pixel threshold from bottom to consider "at bottom" */
  threshold?: number;
}

interface UseAutoScrollReturn {
  containerRef: React.RefObject<HTMLDivElement | null>;
  scrollToBottom: () => void;
  isAtBottom: () => boolean;
}

export function useAutoScroll(
  deps: unknown[],
  options: UseAutoScrollOptions = {}
): UseAutoScrollReturn {
  const { threshold = 100 } = options;
  const containerRef = useRef<HTMLDivElement | null>(null);
  const wasAtBottomRef = useRef(true);

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

  return { containerRef, scrollToBottom, isAtBottom };
}
