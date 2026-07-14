import { describe, it, expect } from 'vitest';
import {
  captureSessionGeneration,
  isSessionGenerationCurrent,
  invalidateSession,
} from './session';

describe('session generation', () => {
  it('a captured generation stays current until the session is invalidated', () => {
    const g = captureSessionGeneration();
    expect(isSessionGenerationCurrent(g)).toBe(true);
    invalidateSession();
    expect(isSessionGenerationCurrent(g)).toBe(false);
  });

  it('invalidateSession advances the generation synchronously and monotonically', () => {
    const before = captureSessionGeneration();
    invalidateSession();
    const after = captureSessionGeneration();
    // Advanced immediately on return (so any abort/reset that runs next already
    // sees the new generation), and never reused.
    expect(after).not.toBe(before);
    expect(isSessionGenerationCurrent(before)).toBe(false);
    expect(isSessionGenerationCurrent(after)).toBe(true);
  });

  it('a fresh capture after invalidation is current again', () => {
    invalidateSession();
    const g = captureSessionGeneration();
    expect(isSessionGenerationCurrent(g)).toBe(true);
  });
});
