import { describe, it, expect } from 'vitest';
import type { Webhook } from '../types';
import { toWebhookSummary, type WebhookSummary } from './webhook';

// Compile-time guard: a token-bearing Webhook must NOT be assignable to the
// persistent-row type. If WebhookSummary is loosened back to a bare Omit (which
// structurally still admits a token), the assignment below stops erroring, the
// expect-error directive becomes unused, and `npm run test:typecheck` fails.
// This is the boundary a runtime test cannot express.
const _tokenBearing: Webhook = {
  id: 'w', serverId: 's', channelId: 'c', creatorId: 'u', name: 'n',
  token: 'whk_secret', tokenHint: 'ecret',
  userId: 'wu', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
};
// @ts-expect-error a plaintext token is forbidden in persistent client state
const _forbidden: WebhookSummary = _tokenBearing;
void _forbidden;

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
