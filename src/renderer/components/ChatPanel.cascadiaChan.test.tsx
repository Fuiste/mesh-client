import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { pubkeyToNodeId } from '@/renderer/lib/meshcoreUtils';
import { removeNode, upsertNodeRecord } from '@/renderer/stores/nodeStore';
import { hexToBytesLenient } from '@/shared/hexBytes';

import ChatPanel, { type ChatPanelProps } from './ChatPanel';
import { ToastProvider } from './Toast';

const publicKey = hexToBytesLenient(
  'e96c285c22edb90b25b6e7b34f1357b4b5cc9ac8d0c79b8606688ca14a162cdf',
);
const peerId = pubkeyToNodeId(publicKey);
const identity = 'meshcore-board-test';

function panel(overrides: Partial<ChatPanelProps> = {}) {
  return (
    <ToastProvider>
      <ChatPanel
        protocol="meshcore"
        identityId={identity}
        initialDmTarget={peerId}
        messages={[]}
        channels={[]}
        nodes={
          new Map([
            [
              peerId,
              {
                node_id: peerId,
                long_name: 'cascadiachan',
                short_name: '',
                hw_model: '',
                snr: 0,
                battery: 0,
                last_heard: 0,
                latitude: null,
                longitude: null,
              },
            ],
          ])
        }
        myNodeNum={1}
        onSend={vi.fn()}
        onReact={vi.fn()}
        onResend={vi.fn()}
        onNodeClick={vi.fn()}
        isConnected
        isActive
        {...overrides}
      />
    </ToastProvider>
  );
}

const boardDisclosure = () => screen.queryByText('cascadiachan', { selector: 'summary' });

describe('CascadiaChan DM shortcuts', () => {
  beforeEach(() => {
    localStorage.clear();
    upsertNodeRecord(identity, { nodeId: peerId, publicKey });
  });
  afterEach(() => {
    act(() => {
      removeNode(identity, peerId);
    });
  });

  it('sends each shortcut as a plaintext DM on click and preserves the draft', async () => {
    let completeMenu!: () => void;
    const onSend = vi
      .fn()
      .mockResolvedValue(undefined)
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            completeMenu = resolve;
          }),
      );
    render(panel({ onSend }));
    const summary = await screen.findByText('cascadiachan', { selector: 'summary' });
    const details = summary.closest('details')!;
    expect(details.open).toBe(false);
    fireEvent.click(summary);
    const draft = screen.getByRole('textbox', { name: /dm to cascadiachan/i });
    fireEvent.change(draft, { target: { value: 'unfinished draft' } });
    expect(onSend).not.toHaveBeenCalled();

    const menu = within(details).getByRole('button', { name: 'menu' });
    fireEvent.click(menu);
    fireEvent.click(menu);
    expect(menu).toBeDisabled();
    expect(onSend).toHaveBeenCalledTimes(1);
    await act(async () => {
      completeMenu();
      await Promise.resolve();
    });
    for (const label of ['discussions', 'bulletins']) {
      const button = within(details).getByRole('button', { name: label });
      fireEvent.click(button);
      await waitFor(() => {
        expect(button).toBeEnabled();
      });
    }
    expect(onSend.mock.calls).toEqual(
      ['?', '!d', '!cb general'].map((command) => [command, expect.any(Number), peerId, undefined]),
    );
    expect(draft).toHaveValue('unfinished draft');
  });

  it('checks the full key even if the name, prefix and derived node id still match', async () => {
    const onSend = vi.fn();
    const { rerender } = render(panel({ onSend }));
    const summary = await screen.findByText('cascadiachan', { selector: 'summary' });
    fireEvent.click(summary);
    const menu = within(summary.closest('details')!).getByRole('button', { name: 'menu' });
    const collision = publicKey.slice();
    collision[16] ^= 1;
    collision[20] ^= 1;
    expect(pubkeyToNodeId(collision)).toBe(peerId);
    act(() => {
      upsertNodeRecord(identity, { nodeId: peerId, publicKey: collision });
    });
    fireEvent.click(menu);
    expect(onSend).not.toHaveBeenCalled();
    rerender(panel({ onSend }));
    expect(boardDisclosure()).toBeNull();
    act(() => {
      upsertNodeRecord(identity, { nodeId: peerId, publicKey });
    });
    await act(async () => {
      rerender(panel({ onSend, protocol: 'meshtastic' }));
      await Promise.resolve();
    });
    expect(boardDisclosure()).toBeNull();
  });

  it('does not queue commands while disconnected', async () => {
    const onSend = vi.fn();
    render(panel({ onSend, isConnected: false }));
    const summary = await screen.findByText('cascadiachan', { selector: 'summary' });
    fireEvent.click(summary);
    const button = within(summary.closest('details')!).getByRole('button', { name: 'menu' });
    expect(button).toBeDisabled();
    fireEvent.click(button);
    expect(onSend).not.toHaveBeenCalled();
  });
});
