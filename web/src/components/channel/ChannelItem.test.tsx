import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { RefObject } from 'react';
import type { Channel } from '../../types';

// Capture the props ConfirmDialog is rendered with, so we can prove ChannelItem
// supplies returnFocusRef pointing at the persistent channel button. Removing that
// prop from ChannelItem must fail this test.
let confirmProps: { returnFocusRef?: RefObject<HTMLElement | null> } | null = null;
vi.mock('../ui/ConfirmDialog', () => ({
  ConfirmDialog: (props: { returnFocusRef?: RefObject<HTMLElement | null> }) => {
    confirmProps = props;
    return null;
  },
}));

import { ChannelItem } from './ChannelItem';

const channel = { id: 'c1', name: 'general', type: 'text', position: 0 } as Channel;

describe('ChannelItem focus-return wiring', () => {
  it('gives the delete dialog a returnFocusRef pointing at the channel button', () => {
    confirmProps = null;
    render(<ChannelItem channel={channel} isSelected={false} onClick={() => {}} canManage />);
    const button = screen.getByRole('button', { name: /general/ });
    expect(confirmProps).not.toBeNull();
    // The context menu that opens the delete dialog unmounts on close, so the dialog
    // needs this stable trigger to restore focus to.
    expect(confirmProps!.returnFocusRef).toBeDefined();
    expect(confirmProps!.returnFocusRef!.current).toBe(button);
  });
});
