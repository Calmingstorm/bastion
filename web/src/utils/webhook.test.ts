import { describe, it, expect } from 'vitest';
import type { Webhook } from '../types';
import { toWebhookSummary } from './webhook';

describe('toWebhookSummary', () => {
  it('removes the plaintext token but keeps the hint', () => {
    const wh: Webhook = {
      id: 'w1', serverId: 's1', channelId: 'c1', creatorId: 'u1', name: 'hook',
      token: 'whk_secret', tokenHint: 'ecret',
      userId: 'wu1', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
    };
    const summary = toWebhookSummary(wh);
    // Removed from the persistent representation, not merely undefined.
    expect('token' in summary).toBe(false);
    expect(summary.tokenHint).toBe('ecret');
    expect(summary.id).toBe('w1');
  });
});
