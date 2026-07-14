import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import * as client from '../../api/client';
import { SearchDialog } from './SearchDialog';
import { useServerStore } from '../../stores/serverStore';
import { invalidateSession } from '../../api/session';
import type { SearchResult } from '../../types';

// F38 round 15: message search is session+query owned -- an old-account response
// must not render after invalidation, and a slower OLDER query must not overwrite
// newer results.
describe('SearchDialog session/query ownership', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function result(id: string, content: string): SearchResult {
    return {
      id, channelId: 'c1', channelName: 'general', content,
      authorId: 'u1', username: 'someone', createdAt: '2026-01-01T00:00:00Z',
    } as SearchResult;
  }

  it('a stale-session search response is not rendered', async () => {
    const user = userEvent.setup();
    let resolveSearch!: (r: SearchResult[]) => void;
    vi.spyOn(client, 'apiSearch').mockImplementation(
      () => new Promise((res) => { resolveSearch = res as (r: SearchResult[]) => void; })
    );
    render(<SearchDialog open onClose={vi.fn()} />);
    await user.type(screen.getByPlaceholderText('Search messages...'), 'old');
    await act(async () => {
      await new Promise((r) => setTimeout(r, 450)); // past the debounce; in flight
    });

    await act(async () => {
      invalidateSession();
      resolveSearch([result('m1', 'old-account-result')]);
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(screen.queryByText(/old-account-result/)).toBeNull();
  });

  it('a server switch supersedes an in-flight search and clears its scope', async () => {
    const user = userEvent.setup();
    useServerStore.setState({ selectedServerId: 'server-a' });
    let resolveSearch!: (r: SearchResult[]) => void;
    vi.spyOn(client, 'apiSearch').mockImplementation(
      () => new Promise((res) => { resolveSearch = res as (r: SearchResult[]) => void; })
    );
    render(<SearchDialog open onClose={vi.fn()} />);
    await user.type(screen.getByPlaceholderText('Search messages...'), 'query');
    await act(async () => {
      await new Promise((r) => setTimeout(r, 450)); // fired under server A (held)
    });

    await act(async () => {
      useServerStore.setState({ selectedServerId: 'server-b' }); // scope changes
      resolveSearch([result('m8', 'server-a-scoped-result')]);
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(screen.queryByText(/server-a-scoped-result/)).toBeNull();
    useServerStore.setState({ selectedServerId: null });
  });

  it('clearing the input supersedes an in-flight search', async () => {
    const user = userEvent.setup();
    let resolveSearch!: (r: SearchResult[]) => void;
    vi.spyOn(client, 'apiSearch').mockImplementation(
      () => new Promise((res) => { resolveSearch = res as (r: SearchResult[]) => void; })
    );
    render(<SearchDialog open onClose={vi.fn()} />);
    const input = screen.getByPlaceholderText('Search messages...');
    await user.type(input, 'query');
    await act(async () => {
      await new Promise((r) => setTimeout(r, 450)); // fired (held)
    });

    await user.clear(input); // the user empties the input while the search is in flight
    await act(async () => {
      resolveSearch([result('m9', 'stale-under-empty-input')]);
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(screen.queryByText(/stale-under-empty-input/)).toBeNull();
  });

  it('a slower older search cannot overwrite newer results', async () => {
    const user = userEvent.setup();
    let resolveFirst!: (r: SearchResult[]) => void;
    let resolveSecond!: (r: SearchResult[]) => void;
    vi.spyOn(client, 'apiSearch')
      .mockImplementationOnce(
        () => new Promise((res) => { resolveFirst = res as (r: SearchResult[]) => void; })
      )
      .mockImplementationOnce(
        () => new Promise((res) => { resolveSecond = res as (r: SearchResult[]) => void; })
      );
    render(<SearchDialog open onClose={vi.fn()} />);
    const input = screen.getByPlaceholderText('Search messages...');

    await user.type(input, 'he');
    await act(async () => {
      await new Promise((r) => setTimeout(r, 450)); // query 1 fired (held)
    });
    await user.type(input, 'llo');
    await act(async () => {
      await new Promise((r) => setTimeout(r, 450)); // query 2 fired (held)
    });

    await act(async () => {
      resolveSecond([result('m2', 'newer-hello-result')]); // newer first
      await new Promise((r) => setTimeout(r, 0));
    });
    await act(async () => {
      resolveFirst([result('m3', 'older-he-result')]); // older last
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(screen.getByText(/newer-hello-result/)).toBeInTheDocument();
    expect(screen.queryByText(/older-he-result/)).toBeNull();
  });
});
