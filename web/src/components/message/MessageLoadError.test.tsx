import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MessageLoadError } from './MessageLoadError';

describe('MessageLoadError', () => {
  it('shows the error message and a Retry button', () => {
    render(<MessageLoadError error="Failed to load messages." onRetry={() => {}} />);
    expect(screen.getByText('Failed to load messages.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });

  it('calls onRetry when Retry is clicked', async () => {
    const onRetry = vi.fn();
    render(<MessageLoadError error="Failed to load messages." onRetry={onRetry} />);
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});
