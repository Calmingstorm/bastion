import { describe, it, expect, vi } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import type { MemberWithUser, Role, ServerBan, AuditLogEntry, ServerInvite, Channel } from '../../types';

vi.mock('../../api/client', async (orig) => {
  const actual = await orig<typeof import('../../api/client')>();
  return {
    ...actual,
    apiGetMembers: vi.fn(),
    apiGetRoles: vi.fn(),
    apiGetBans: vi.fn(),
    apiGetAuditLog: vi.fn(),
    apiGetInvites: vi.fn(),
    apiCreateInvite: vi.fn(),
    apiDeleteInvite: vi.fn(),
    apiGetChannels: vi.fn(),
  };
});

import { MembersTab, RolesTab, BansTab, AuditTab, ChannelsTab } from './ServerSettingsDialog';
import { InviteDialog } from './InviteDialog';
import * as client from '../../api/client';
import { invalidateSession } from '../../api/session';

// F38 round 14: every server-settings list fetch is session+recency owned. A held
// old-session response must neither render rows nor complete loading in the
// still-mounted UI. (Each pin asserts BOTH: no rows AND still-loading, so it is
// sensitive to the then+finally ownership pair.)
describe('server-settings tabs session ownership', () => {
  it('a stale members response renders nothing and never completes loading', async () => {
    let resolveMembers!: (m: MemberWithUser[]) => void;
    vi.mocked(client.apiGetMembers).mockImplementation(
      () => new Promise((res) => { resolveMembers = res as (m: MemberWithUser[]) => void; })
    );
    vi.mocked(client.apiGetRoles).mockResolvedValue([]);
    const { container } = render(<MembersTab serverId="s1" />);

    await act(async () => {
      invalidateSession();
      resolveMembers([{ serverId: 's1', userId: 'u9', username: 'oldmember', role: 'member', status: 'online' } as MemberWithUser]);
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(screen.queryByText(/oldmember/)).toBeNull();
    expect(container.querySelector('.animate-spin')).not.toBeNull();
  });

  it('a stale roles response renders nothing and never completes loading', async () => {
    let resolveRoles!: (r: Role[]) => void;
    vi.mocked(client.apiGetRoles).mockImplementation(
      () => new Promise((res) => { resolveRoles = res as (r: Role[]) => void; })
    );
    const { container } = render(<RolesTab serverId="s1" />);

    await act(async () => {
      invalidateSession();
      resolveRoles([{ id: 'r1', serverId: 's1', name: 'old-role', position: 1, permissions: 0 } as Role]);
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(screen.queryByText(/old-role/)).toBeNull();
    expect(container.querySelector('.animate-spin')).not.toBeNull();
  });

  it('a stale bans response renders nothing and never completes loading', async () => {
    let resolveBans!: (b: ServerBan[]) => void;
    vi.mocked(client.apiGetBans).mockImplementation(
      () => new Promise((res) => { resolveBans = res as (b: ServerBan[]) => void; })
    );
    const { container } = render(<BansTab serverId="s1" />);

    await act(async () => {
      invalidateSession();
      resolveBans([{ serverId: 's1', userId: 'u9', username: 'oldbanned', createdAt: '2026-01-01T00:00:00Z' } as ServerBan]);
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(screen.queryByText(/oldbanned/)).toBeNull();
    expect(container.querySelector('.animate-spin')).not.toBeNull();
  });

  it('a stale audit response renders nothing and never completes loading', async () => {
    let resolveAudit!: (e: AuditLogEntry[]) => void;
    vi.mocked(client.apiGetAuditLog).mockImplementation(
      () => new Promise((res) => { resolveAudit = res as (e: AuditLogEntry[]) => void; })
    );
    const { container } = render(<AuditTab serverId="s1" />);

    await act(async () => {
      invalidateSession();
      resolveAudit([
        {
          id: 'a1', serverId: 's1', actionType: 'MEMBER_KICK', createdAt: '2026-01-01T00:00:00Z',
          actor: { id: 'u1', username: 'oldactor' },
        } as AuditLogEntry,
      ]);
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(screen.queryByText(/oldactor/)).toBeNull();
    expect(container.querySelector('.animate-spin')).not.toBeNull();
  });

  it('a stale channels response renders nothing and never completes loading', async () => {
    let resolveChannels!: (c: Channel[]) => void;
    vi.mocked(client.apiGetChannels).mockImplementation(
      () => new Promise((res) => { resolveChannels = res as (c: Channel[]) => void; })
    );
    const { container } = render(<ChannelsTab serverId="s1" />);

    await act(async () => {
      invalidateSession();
      resolveChannels([{ id: 'c9', name: 'old-channel', type: 'text', position: 0 } as Channel]);
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(screen.queryByText(/old-channel/)).toBeNull();
    expect(container.querySelector('.animate-spin')).not.toBeNull();
  });

  it('a stale invites response does not populate the invite dialog', async () => {
    let resolveInvites!: (i: ServerInvite[]) => void;
    vi.mocked(client.apiGetInvites).mockImplementation(
      () => new Promise((res) => { resolveInvites = res as (i: ServerInvite[]) => void; })
    );
    render(<InviteDialog open onOpenChange={vi.fn()} serverId="s1" />);

    await act(async () => {
      invalidateSession();
      resolveInvites([{ id: 'i1', serverId: 's1', code: 'OLDCODE99', uses: 0, createdAt: '2026-01-01T00:00:00Z' } as ServerInvite]);
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(screen.queryByText(/OLDCODE99/)).toBeNull();
  });
});
