import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import * as client from '../../api/client';
import type { GifResult } from '../../api/client';
import { GifPicker } from './GifPicker';

// F38 round 17: the gif grid is owned by the query LINEAGE, claimed on every
// keystroke -- an already-fired older request must not publish beneath a newly
// typed query during the debounce gap.
describe('GifPicker query lineage', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function gif(id: string): GifResult {
    return { id, title: id, previewUrl: `/p/${id}.gif`, url: `/g/${id}.gif`, width: 100, height: 100 };
  }

  it('an older fired search cannot publish beneath a newly typed query', async () => {
    const user = userEvent.setup();
    vi.spyOn(client, 'apiTrendingGifs').mockResolvedValue([]);
    let resolveOld!: (g: GifResult[]) => void;
    vi.spyOn(client, 'apiSearchGifs').mockImplementation(
      () => new Promise((res) => { resolveOld = res as (g: GifResult[]) => void; })
    );

    const { container } = render(<GifPicker onSelect={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: 'GIF' })); // open; trending loads

    const input = screen.getByPlaceholderText(/Search/);
    await user.type(input, 'cats');
    await act(async () => {
      await new Promise((r) => setTimeout(r, 350)); // 'cats' fired (held)
    });

    await user.type(input, 'x'); // new keystroke claims the lineage (debounce pending)
    await act(async () => {
      resolveOld([gif('stale-cat')]); // the old request then resolves
      await new Promise((r) => setTimeout(r, 0));
    });

    // The stale grid must not publish beneath the newly typed query.
    expect(container.querySelector('img[src="/p/stale-cat.gif"]')).toBeNull();
  });
});
