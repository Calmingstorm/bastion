import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ToastContainer } from './ToastContainer';
import { useToastStore } from '../stores/toastStore';

describe('ToastContainer', () => {
  beforeEach(() => {
    useToastStore.setState({ toasts: [] });
  });

  it('renders nothing when there are no toasts', () => {
    const { container } = render(<ToastContainer />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders a toast message and dismisses it on click', async () => {
    useToastStore.setState({ toasts: [{ id: 1, message: 'Failed to send message.' }] });
    render(<ToastContainer />);
    expect(screen.getByText('Failed to send message.')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(useToastStore.getState().toasts).toEqual([]);
  });
});
