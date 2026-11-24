import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';

import { hydrateAxeThemeColors } from '../lib/a11yTestHelpers';
import { type BoardClient, createCc1BoardClient } from '../lib/cascadiaBoard';
import {
  boardContactCard,
  type BoardHost,
  boardNodeId,
  loadBoardHosts,
  saveBoardHost,
} from '../lib/cascadiaBoardHosts';
import {
  boardAddressConflict,
  getBoardClient,
  hasBoardContact,
} from '../lib/cascadiaBoardTransport';
import { writeClipboardText } from '../lib/writeClipboardText';
import { upsertNodeRecord } from '../stores/nodeStore';
import CascadiaBoardPanel from './CascadiaBoardPanel';

vi.mock('../lib/cascadiaBoardTransport', () => ({
  getBoardClient: vi.fn(),
  hasBoardContact: vi.fn(),
  boardAddressConflict: vi.fn(),
  attachBoardSessions: () => () => {},
}));
vi.mock('../lib/writeClipboardText', () => ({ writeClipboardText: vi.fn() }));
const north: BoardHost = {
  name: 'North board',
  publicKey: '12345678' + 'a1'.repeat(28),
  adapterId: 'cc1',
};
const south: BoardHost = {
  name: 'South board',
  publicKey: '09abcdef' + 'b2'.repeat(28),
  adapterId: 'cc1',
};
const identity = 'meshcore:board-panel-a';
const fixture = () => ({
  identityId: identity,
  connected: true,
  radioLabel: 'radio',
  importContact: vi.fn().mockResolvedValue({ ok: true }),
  onOpenDm: vi.fn(),
  onOpenConnection: vi.fn(),
});
const button = (name: string) => screen.getByRole('button', { name });
beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
  const clients = new Map<string, BoardClient>();
  vi.mocked(getBoardClient).mockImplementation((identityId, host) => {
    const key = identityId + host.publicKey;
    const existing = clients.get(key);
    if (existing) return existing;
    const client = createCc1BoardClient({
      identityId,
      host,
      sendDm: () => Promise.reject(new Error('unexpected transmission')),
    });
    vi.spyOn(client, 'refresh').mockResolvedValue(undefined);
    clients.set(key, client);
    return client;
  });
  vi.mocked(hasBoardContact).mockReturnValue(true);
  vi.mocked(boardAddressConflict).mockReturnValue(false);
});
describe('multi-board workspace', () => {
  it('starts empty, offers the connection panel, and scopes saved boards per identity', async () => {
    const props = fixture();
    const { rerender } = render(<CascadiaBoardPanel {...props} identityId={null} />);
    expect(screen.getByRole('heading', { name: 'No saved boards' })).toBeVisible();
    await userEvent.click(button('Connect radio'));
    expect(props.onOpenConnection).toHaveBeenCalledOnce();
    saveBoardHost(identity, north);
    rerender(<CascadiaBoardPanel {...props} />);
    expect(screen.getByRole('combobox', { name: 'Board' })).toHaveValue(north.publicKey);
    const client = getBoardClient(identity, north);
    expect(client.refresh).not.toHaveBeenCalled();
    rerender(<CascadiaBoardPanel {...props} identityId="meshcore:other" />);
    expect(screen.getByRole('heading', { name: 'No saved boards' })).toBeVisible();
  });
  it('checks a shared link only on request, retries a missing reply, and saves the checked host', async () => {
    const props = fixture();
    const user = userEvent.setup();
    const { container } = render(<CascadiaBoardPanel {...props} />);
    await user.click(button('Add board'));
    const dialog = within(screen.getByRole('dialog'));
    await user.click(dialog.getByRole('button', { name: 'Contact link' }));
    fireEvent.change(dialog.getByRole('textbox', { name: 'Contact link' }), {
      target: { value: boardContactCard(south) },
    });
    const client = getBoardClient(identity, south);
    vi.mocked(client.refresh).mockRejectedValueOnce(
      new Error('no board confirmation; retry the same request'),
    );
    expect(client.refresh).not.toHaveBeenCalled();
    expect(loadBoardHosts(identity)).toEqual([]);
    hydrateAxeThemeColors(document.documentElement);
    expect(await axe(container)).toHaveNoViolations();
    await user.click(dialog.getByRole('button', { name: 'Check board' }));
    expect(dialog.getByRole('alert')).toHaveTextContent('No reply from South board yet');
    await user.click(dialog.getByRole('button', { name: 'Retry' }));
    expect(dialog.getByRole('status')).toHaveTextContent('Index received from South board');
    await user.click(dialog.getByRole('button', { name: 'Add board' }));
    expect(loadBoardHosts(identity)).toEqual([south]);
    expect(client.refresh).toHaveBeenCalledTimes(2);
  });
  it('opens an existing menu contact in dm, copies its shareable link, then removes only the saved board', async () => {
    const props = fixture();
    const user = userEvent.setup();
    upsertNodeRecord(identity, {
      nodeId: boardNodeId(south),
      longName: south.name,
      publicKeyHex: south.publicKey,
      onRadio: true,
    });
    render(<CascadiaBoardPanel {...props} />);
    await user.click(button('Add board'));
    const dialog = within(screen.getByRole('dialog'));
    await user.selectOptions(
      dialog.getByRole('combobox', { name: 'Choose a contact' }),
      south.publicKey,
    );
    await user.click(dialog.getByRole('button', { name: 'Save for chat' }));
    expect(props.onOpenDm).toHaveBeenCalledWith(boardNodeId(south));
    expect(getBoardClient(identity, south).refresh).not.toHaveBeenCalled();
    await user.click(button('Board actions'));
    await user.click(screen.getByRole('menuitem', { name: /Copy board link/ }));
    expect(writeClipboardText).toHaveBeenCalledWith(boardContactCard(south));
    expect(await screen.findByText('Copied')).toBeVisible();
    vi.mocked(writeClipboardText).mockRejectedValueOnce(new Error('clipboard denied'));
    await user.click(button('Board actions'));
    await user.click(screen.getByRole('menuitem', { name: /Copy board link/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't copy");
    await user.click(button('Board actions'));
    await user.click(screen.getByRole('menuitem', { name: /Remove from boards/ }));
    expect(loadBoardHosts(identity)).toEqual([]);
    expect(screen.getByRole('heading', { name: 'No saved boards' })).toBeVisible();
  });
  it('keeps drafts and pending confirmations with their original host when switching', async () => {
    const props = fixture();
    const user = userEvent.setup();
    saveBoardHost(identity, north);
    saveBoardHost(identity, south);
    const client = getBoardClient(identity, north);
    let finish!: (id: string) => void;
    vi.spyOn(client, 'create').mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    render(<CascadiaBoardPanel {...props} />);
    await user.click(button('New thread'));
    fireEvent.change(screen.getByRole('textbox', { name: 'Subject' }), {
      target: { value: 'Antenna swap' },
    });
    fireEvent.change(screen.getByRole('textbox', { name: 'Message' }), {
      target: { value: 'Ridge at noon' },
    });
    const pick = screen.getByRole('combobox', { name: 'Board' });
    await user.selectOptions(pick, south.publicKey);
    expect(screen.queryByRole('textbox')).toBeNull();
    await user.selectOptions(pick, north.publicKey);
    expect(screen.getByRole('textbox', { name: 'Message' })).toHaveValue('Ridge at noon');
    await user.click(button('Post thread'));
    await user.selectOptions(pick, south.publicKey);
    expect(screen.getByRole('status')).toHaveTextContent('Radio is waiting for North board');
    expect(button('Refresh index')).toBeDisabled();
    expect(getBoardClient(identity, south).refresh).not.toHaveBeenCalled();
    await act(async () => {
      finish('d:test');
      await Promise.resolve();
    });
    expect(button('Refresh index')).toBeEnabled();
    await user.selectOptions(pick, north.publicKey);
    expect(screen.getByRole('status')).toHaveTextContent('Saved on North board');
  });
});
