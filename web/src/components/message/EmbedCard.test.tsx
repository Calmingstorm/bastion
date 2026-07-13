import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { EmbedCard } from './EmbedCard';
import type { Embed } from '../../types';

describe('EmbedCard', () => {
  it('does not turn a javascript: title URL into a link', () => {
    render(<EmbedCard embed={{ title: 'Click me', url: 'javascript:alert(1)' } as Embed} />);
    // The title still shows, but not as a clickable anchor carrying the URL.
    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.getByText('Click me')).toBeInTheDocument();
  });

  it('renders a valid https title URL as a link', () => {
    render(<EmbedCard embed={{ title: 'Go', url: 'https://example.com/page' } as Embed} />);
    const link = screen.getByRole('link', { name: 'Go' });
    expect(link).toHaveAttribute('href', 'https://example.com/page');
  });

  it('does not render an image with a non-http(s) src', () => {
    const { container } = render(
      <EmbedCard embed={{ image: { url: 'javascript:alert(1)' } } as Embed} />
    );
    expect(container.querySelector('img')).toBeNull();
  });

  it('does not render a thumbnail with a non-http(s) src', () => {
    const { container } = render(
      <EmbedCard embed={{ thumbnail: { url: 'javascript:alert(1)' } } as Embed} />
    );
    expect(container.querySelector('img')).toBeNull();
  });

  it('renders a thumbnail with a valid https src', () => {
    const { container } = render(
      <EmbedCard embed={{ thumbnail: { url: 'https://example.com/t.png' } } as Embed} />
    );
    const img = container.querySelector('img');
    expect(img).not.toBeNull();
    expect(img).toHaveAttribute('src', 'https://example.com/t.png');
  });
});
