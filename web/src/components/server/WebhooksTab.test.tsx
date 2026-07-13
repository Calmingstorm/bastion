import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Webhook } from '../../types';

// Use a configured server origin distinct from the jsdom window origin, so a
// regression to window.location.origin is caught.
vi.mock('../../platform', async (orig) => {
  const actual = await orig<typeof import('../../platform')>();
  return { ...actual, getPlatform: () => ({ getOrigin: () => 'https://cfg.example' }) };
});

vi.mock('../../api/client', async (orig) => {
  const actual = await orig<typeof import('../../api/client')>();
  return {
    ...actual,
    apiGetChannels: vi.fn(async () => [{ id: 'c1', name: 'general', position: 0 }]),
    apiGetWebhooks: vi.fn(async () => []),
    apiCreateWebhook: vi.fn(),
    apiRegenerateWebhookToken: vi.fn(),
    apiDeleteWebhook: vi.fn(async () => {}),
  };
});

import { WebhooksTab } from './ServerSettingsDialog';
import * as client from '../../api/client';

function webhook(over: Partial<Webhook> = {}): Webhook {
  return {
    id: 'w1', serverId: 's1', channelId: 'c1', creatorId: 'u1', name: 'hook',
    userId: 'wu1', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
    ...over,
  };
}

describe('WebhooksTab', () => {
  beforeEach(() => {
    vi.mocked(client.apiGetWebhooks).mockResolvedValue([]);
    vi.mocked(client.apiRegenerateWebhookToken).mockReset();
  });

  it('reveals a URL built from the configured server origin, not the webview origin', async () => {
    vi.mocked(client.apiCreateWebhook).mockResolvedValue(
      webhook({ id: 'w1', token: 'whk_secret123', tokenHint: 'ecret123' })
    );
    render(<WebhooksTab serverId="s1" />);
    await waitFor(() => screen.getByText(/Create Webhook/));

    await userEvent.type(screen.getByPlaceholderText('Webhook name'), 'hook');
    await userEvent.click(screen.getByRole('button', { name: 'Create' }));

    const input = await screen.findByDisplayValue(
      'https://cfg.example/api/v1/webhooks/w1/whk_secret123'
    );
    expect(input).toBeInTheDocument();
  });

  it('lists persisted webhooks by hint only, with no per-row Copy URL', async () => {
    vi.mocked(client.apiGetWebhooks).mockResolvedValue([
      webhook({ id: 'w1', tokenHint: 'abcd1234' }),
    ]);
    render(<WebhooksTab serverId="s1" />);

    await screen.findByText(/abcd1234/);
    // Persisted rows never offer Copy URL (only the one-time reveal does), so a
    // regression that rebuilds a URL from a now-absent row token cannot appear.
    expect(screen.queryByRole('button', { name: 'Copy URL' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Regenerate' })).toBeInTheDocument();
  });

  it('requires confirmation, then updates the hint and reveals the new URL', async () => {
    vi.mocked(client.apiGetWebhooks).mockResolvedValue([webhook({ id: 'w1', tokenHint: 'abcd1234' })]);
    vi.mocked(client.apiRegenerateWebhookToken).mockResolvedValue(
      webhook({ id: 'w1', token: 'whk_rotated', tokenHint: 'rotated1' })
    );
    render(<WebhooksTab serverId="s1" />);
    await screen.findByText(/abcd1234/);

    await userEvent.click(screen.getByRole('button', { name: 'Regenerate' }));
    // First click only asks for confirmation — no API call yet.
    expect(client.apiRegenerateWebhookToken).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole('button', { name: 'Confirm rotate' }));
    expect(client.apiRegenerateWebhookToken).toHaveBeenCalledTimes(1);

    // The post-response update runs: the row hint changes and the new URL is
    // revealed from the configured origin. (A no-op update would leave the old
    // hint and no reveal, failing these.)
    expect(await screen.findByText(/rotated1/)).toBeInTheDocument();
    expect(screen.queryByText(/abcd1234/)).toBeNull();
    expect(
      await screen.findByDisplayValue('https://cfg.example/api/v1/webhooks/w1/whk_rotated')
    ).toBeInTheDocument();
  });

  it('re-enables regeneration after a successful rotation', async () => {
    vi.mocked(client.apiGetWebhooks).mockResolvedValue([webhook({ id: 'w1', tokenHint: 'abcd1234' })]);
    vi.mocked(client.apiRegenerateWebhookToken).mockResolvedValue(
      webhook({ id: 'w1', token: 'whk_r1', tokenHint: 'rot11111' })
    );
    render(<WebhooksTab serverId="s1" />);
    await screen.findByText(/abcd1234/);

    await userEvent.click(screen.getByRole('button', { name: 'Regenerate' }));
    await userEvent.click(screen.getByRole('button', { name: 'Confirm rotate' }));
    await screen.findByText(/rot11111/);

    // The finally block clears regeneratingId AND regenConfirm, so the control
    // returns to an enabled "Regenerate" and a second rotation can be started.
    // Dropping either clear leaves it stuck disabled on "Rotating…"/"Confirm".
    const regen = await screen.findByRole('button', { name: 'Regenerate' });
    expect(regen).toBeEnabled();
    await userEvent.click(regen);
    expect(screen.getByRole('button', { name: 'Confirm rotate' })).toBeInTheDocument();
  });

  it('clears in-flight state after a failed rotation and allows retry', async () => {
    vi.mocked(client.apiGetWebhooks).mockResolvedValue([webhook({ id: 'w1', tokenHint: 'abcd1234' })]);
    vi.mocked(client.apiRegenerateWebhookToken)
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce(webhook({ id: 'w1', token: 'whk_r2', tokenHint: 'retry222' }));
    render(<WebhooksTab serverId="s1" />);
    await screen.findByText(/abcd1234/);

    await userEvent.click(screen.getByRole('button', { name: 'Regenerate' }));
    await userEvent.click(screen.getByRole('button', { name: 'Confirm rotate' }));

    // The rejection is swallowed, but finally must still restore an enabled
    // "Regenerate" — otherwise a failed rotation wedges the control forever.
    const regen = await screen.findByRole('button', { name: 'Regenerate' });
    expect(regen).toBeEnabled();

    // Retry proceeds and succeeds.
    await userEvent.click(regen);
    await userEvent.click(screen.getByRole('button', { name: 'Confirm rotate' }));
    await screen.findByText(/retry222/);
  });

  it('resets the one-time copy state on a subsequent rotation', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    // Fake timers (auto-advancing so findBy* still settles) let us drop the
    // 2s copy-reset timeout at the end instead of leaking it into later tests.
    vi.useFakeTimers({ shouldAdvanceTime: true });

    vi.mocked(client.apiGetWebhooks).mockResolvedValue([webhook({ id: 'w1', tokenHint: 'abcd1234' })]);
    vi.mocked(client.apiRegenerateWebhookToken)
      .mockResolvedValueOnce(webhook({ id: 'w1', token: 'whk_first', tokenHint: 'first111' }))
      .mockResolvedValueOnce(webhook({ id: 'w1', token: 'whk_secnd', tokenHint: 'secnd222' }));
    render(<WebhooksTab serverId="s1" />);
    await screen.findByText(/abcd1234/);

    // First rotation reveals a token; copy it so copied=true.
    await userEvent.click(screen.getByRole('button', { name: 'Regenerate' }));
    await userEvent.click(screen.getByRole('button', { name: 'Confirm rotate' }));
    await screen.findByText(/first111/);
    await userEvent.click(screen.getByRole('button', { name: 'Copy URL' }));
    expect(writeText).toHaveBeenCalledWith('https://cfg.example/api/v1/webhooks/w1/whk_first');
    expect(screen.getByRole('button', { name: 'Copied!' })).toBeInTheDocument();

    // A second rotation must present the fresh token as un-copied. Without the
    // setCopied(false) on rotation, the stale "Copied!" carries over.
    await userEvent.click(screen.getByRole('button', { name: 'Regenerate' }));
    await userEvent.click(screen.getByRole('button', { name: 'Confirm rotate' }));
    await screen.findByText(/secnd222/);
    expect(screen.getByRole('button', { name: 'Copy URL' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Copied!' })).toBeNull();

    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('guards against a double-click firing two rotations', async () => {
    vi.mocked(client.apiGetWebhooks).mockResolvedValue([webhook({ id: 'w1', tokenHint: 'abcd1234' })]);
    // A rotation that stays pending, so the in-flight guard is observable.
    let resolve: (v: Webhook) => void = () => {};
    vi.mocked(client.apiRegenerateWebhookToken).mockReturnValue(
      new Promise<Webhook>((r) => { resolve = r; })
    );
    render(<WebhooksTab serverId="s1" />);
    await screen.findByText(/abcd1234/);

    await userEvent.click(screen.getByRole('button', { name: 'Regenerate' }));
    await userEvent.click(screen.getByRole('button', { name: 'Confirm rotate' }));

    // While the request is in flight the button is disabled and a further click
    // cannot start a second rotation.
    const rotating = screen.getByRole('button', { name: /Rotating/ });
    expect(rotating).toBeDisabled();
    await userEvent.click(rotating);
    expect(client.apiRegenerateWebhookToken).toHaveBeenCalledTimes(1);

    // Resolve and flush, so the pending state update happens inside act.
    resolve(webhook({ id: 'w1', token: 'whk_new', tokenHint: 'k_new123' }));
    await screen.findByText(/k_new123/);
  });
});
