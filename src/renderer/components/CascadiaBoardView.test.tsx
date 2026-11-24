import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';

import { hydrateAxeThemeColors } from '@/renderer/lib/a11yTestHelpers';
import { type BoardClient, type BoardSnapshot } from '@/renderer/lib/cascadiaBoard';

import { CascadiaBoardView } from './CascadiaBoardView';

function setup(online = true) {
  const board: BoardSnapshot = {
    entries: [
      {
        id: 'd:1',
        kind: 'discussion',
        subject: 'antenna swap',
        replyCount: 0,
        author: '',
        updatedAt: 0,
      },
      {
        id: 'b:1',
        kind: 'bulletin',
        subject: 'listen tonight',
        replyCount: 0,
        author: 'alder',
        updatedAt: 0,
      },
    ],
    posts: { 'd:1': [{ author: 'fern', body: 'two whips to trade', createdAt: 0 }] },
    fetchedAt: 123,
    moreEntries: { discussion: true },
    indexFetchedAt: { discussion: 123 },
    morePosts: {},
  };
  const client = {
    subscribe: () => () => {},
    getSnapshot: () => board,
    refresh: vi.fn(async () => {}),
    read: vi.fn(async () => {}),
    reply: vi.fn<BoardClient['reply']>().mockResolvedValue('d:1'),
    create: vi.fn<BoardClient['create']>().mockResolvedValue('d:2'),
  };
  const { container } = render(
    <CascadiaBoardView
      client={client}
      boardName="Test board"
      online={online}
      radioLabel="test radio"
    />,
  );
  return { container, client, board };
}

const button = (name: string) =>
  screen.getByRole('button', { name: (label) => label.toLowerCase() === name.toLowerCase() });

describe('cascadiachan board view', () => {
  it('reads the cache offline, keeps a draft and disables radio actions', () => {
    const { client } = setup(false);
    expect(screen.getByText('two whips to trade')).toBeVisible();
    expect(button('refresh index')).toBeDisabled();
    fireEvent.click(button('reply'));
    fireEvent.change(screen.getByRole('textbox', { name: 'Your reply' }), {
      target: { value: 'found one' },
    });
    expect(button('post reply')).toBeDisabled();
    fireEvent.click(button('Cancel'));
    fireEvent.click(button('reply'));
    expect(screen.getByRole('textbox', { name: 'Your reply' })).toHaveValue('found one');
    expect(client.reply).not.toHaveBeenCalled();
  });

  it('waits for a board receipt, preserves a failed draft and prevents oversized writes', async () => {
    const { client } = setup();
    let reject!: (error: Error) => void;
    client.reply.mockImplementationOnce(
      () =>
        new Promise<string>((_, no) => {
          reject = no;
        }),
    );
    fireEvent.click(button('reply'));
    const draft = screen.getByRole('textbox', { name: 'Your reply' });
    fireEvent.change(draft, { target: { value: '🌲'.repeat(40) } });
    expect(button('post reply')).toBeDisabled();
    fireEvent.change(draft, { target: { value: 'i can bring one' } });
    fireEvent.click(button('post reply'));
    expect(client.reply).toHaveBeenCalledWith('d:1', 'i can bring one');
    expect(button('post reply')).toBeDisabled();
    expect(screen.getByRole('status')).toHaveTextContent('Waiting for board confirmation');
    await act(async () => {
      reject(new Error('radio timeout'));
      await Promise.resolve();
    });
    expect(draft).toHaveValue('i can bring one');
    expect(screen.getByRole('status')).toHaveTextContent('radio timeout');
    fireEvent.click(button('post reply'));
    expect(await screen.findByText('Saved on Test board')).toBeVisible();
  });

  it('loads more subjects on demand and treats bulletins as standalone notices', async () => {
    const { client } = setup();
    const user = userEvent.setup();
    expect(client.refresh).not.toHaveBeenCalled();
    await user.click(button('load more subjects'));
    expect(client.refresh).toHaveBeenCalledWith('discussion', true);
    fireEvent.click(button('bulletins'));
    expect(client.read).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Reply' })).toBeNull();
    await user.click(button('fetch bulletin by radio'));
    expect(client.read).toHaveBeenCalledWith('b:1', false);
    fireEvent.click(button('new bulletin'));
    fireEvent.change(screen.getByRole('textbox', { name: 'Subject' }), {
      target: { value: 'ridge net' },
    });
    fireEvent.change(screen.getByRole('textbox', { name: 'Message' }), {
      target: { value: 'listen at ten' },
    });
    await user.click(button('post bulletin'));
    expect(client.create).toHaveBeenCalledWith('bulletin', 'ridge net', 'listen at ten');
  });

  it('keeps the board landmarks and controls accessible', async () => {
    const { container } = setup();
    hydrateAxeThemeColors(document.documentElement);
    expect(await axe(container)).toHaveNoViolations();
  });

  it('never retargets an open reply when a refreshed index drops its subject', async () => {
    const { client, board } = setup();
    const user = userEvent.setup();
    await user.click(button('reply'));
    fireEvent.change(screen.getByRole('textbox', { name: 'Your reply' }), {
      target: { value: 'meant for antenna swap' },
    });
    client.refresh.mockImplementationOnce(() => {
      board.entries = [{ ...board.entries[0], id: 'd:2', subject: 'another discussion' }];
      return Promise.resolve();
    });
    await user.click(button('refresh index'));
    expect(screen.queryByRole('button', { name: 'Post reply' })).toBeNull();
    expect(client.reply).not.toHaveBeenCalled();
  });
});
