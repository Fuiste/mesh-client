import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { hexToBytesExactOrThrow } from '@/shared/hexBytes';

import { createBoardClient } from './cascadiaBoard';
import {
  boardContactCard,
  boardNodeId,
  boardSessionKey,
  DEFAULT_BOARD_HOST,
  legacyBoardKey,
  loadActiveBoardKey,
  loadBoardHosts,
  parseBoardHost,
  removeBoardHost,
  saveActiveBoardKey,
  saveBoardHost,
} from './cascadiaBoardHosts';
import { boardResponseKey, reserveBoardRadio } from './cascadiaBoardSource';
import {
  attachBoardSessions,
  boardAddressConflict,
  getBoardClient,
  hasBoardContact,
} from './cascadiaBoardTransport';
import { connectionDriver } from './drivers/ConnectionDriver';
import { packetRouter } from './drivers/PacketRouter';
import * as dm from './meshcore/meshcoreDmSend';
import { importMeshcoreQr } from './meshcore/meshcoreQrIngest';

const second = parseBoardHost(
  '0123456789abcdeffedcba9876543210f00f000088557777111199990000abab',
  'other board',
  'cc1',
);
const first = DEFAULT_BOARD_HOST;
function prepareContact(identityId: string, host = first) {
  return importMeshcoreQr(boardContactCard(host), {
    identityId,
    saveContact: () => Promise.resolve(true),
  });
}
function frame(rid: string, result: unknown[]) {
  return `cc1 ${rid} 1/1 ${Buffer.from(JSON.stringify(result)).toString('base64url')}`;
}
beforeEach(() => {
  const map = new Map<string, string>();
  const storage = {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => {
      map.set(k, v);
    },
    removeItem: (k: string) => {
      map.delete(k);
    },
  };
  vi.stubGlobal('localStorage', storage);
  vi.stubGlobal('window', { localStorage: storage });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('meshcore board homes', () => {
  it('migrates only this radio’s legacy cache, journal or known board contact; explicit removal survives', async () => {
    const identity = 'old';
    expect(loadBoardHosts(identity)).toEqual([]);
    localStorage.setItem(
      legacyBoardKey(identity) + ':writes',
      JSON.stringify({ aabbccddeeff: JSON.stringify(['new', 'b', 'subject', 'body']) }),
    );
    expect(loadBoardHosts(identity)).toEqual([first]);
    const sendDm = vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined);
    const client = createBoardClient({ host: first, identityId: identity, sendDm });
    const write = client.create('bulletin', 'subject', 'body');
    expect(sendDm.mock.calls[0][0]).toBe('!cc1 aabbccddeeff ["new","b","subject","body"]');
    client.accept(frame('aabbccddeeff', ['saved', 'b', '123', 'me', '2026-11-24', 0]));
    await write;
    expect(loadBoardHosts(identity)).toEqual([first]); // cache alone
    expect(loadBoardHosts('other-old')).toEqual([]);
    await prepareContact('other-old');
    expect(loadBoardHosts('other-old')).toEqual([first]); // full-key contact alone
    removeBoardHost(identity, first.publicKey);
    expect(loadBoardHosts(identity)).toEqual([]);
    expect(loadBoardHosts('new-radio')).toEqual([]);
    expect(
      createBoardClient({ identityId: identity, host: second, sendDm }).getSnapshot().entries,
    ).toEqual([]);
    expect(
      createBoardClient({ identityId: 'new-radio', host: first, sendDm }).getSnapshot().entries,
    ).toEqual([]);
  });
  it('normalizes contact links and isolates active selection and composer scopes', () => {
    const host = parseBoardHost(boardContactCard(second), '', 'dm');
    expect(host).toEqual({ ...second, adapterId: 'dm' });
    expect(parseBoardHost(second.publicKey.toUpperCase(), 'renamed', 'cc1').publicKey).toBe(
      second.publicKey,
    );
    expect(() => parseBoardHost(second.publicKey.slice(0, 12), 'short', 'cc1')).toThrow();
    saveBoardHost('directory', host);
    saveActiveBoardKey('directory', host.publicKey);
    expect(loadActiveBoardKey('directory')).toBe(host.publicKey);
    expect(loadActiveBoardKey('other-directory')).toBeNull();
    expect(
      new Set([
        boardSessionKey('a', first),
        boardSessionKey('a', second),
        boardSessionKey('a', host),
        boardSessionKey('b', second),
      ]).size,
    ).toBe(4);
    expect(() => getBoardClient('directory', host)).toThrow('direct messages');
  });
  it('ignores ambiguous prefixes from candidates, saved hosts and unlisted contacts; an unsaved check only accepts its active id', async () => {
    const identity = 'collision';
    const collision = { ...second, publicKey: second.publicKey.slice(0, -2) + 'ac' };
    const key = second.publicKey,
      prefix = key.slice(0, 12),
      node = boardNodeId(second);
    await prepareContact(identity, second);
    const rid = '000000000012',
      text = frame(rid, ['list', null, []]);
    expect(boardResponseKey(identity, text, prefix, node)).toBeUndefined();
    const release = reserveBoardRadio(identity, second, rid);
    expect(boardResponseKey(identity, text, prefix, node)).toBe(key);
    expect(
      boardResponseKey(identity, text.replace(rid, '000000000013'), prefix, node),
    ).toBeUndefined();
    expect(
      boardResponseKey(identity, text, prefix, node, 0, [
        hexToBytesExactOrThrow(collision.publicKey, 32),
      ]),
    ).toBeUndefined();
    saveBoardHost(identity, collision);
    expect(boardAddressConflict(identity, second)).toBe(true);
    expect(hasBoardContact(identity, second)).toBe(false);
    expect(boardResponseKey(identity, text, prefix, node)).toBeUndefined();
    release();
    expect(boardResponseKey('different-radio', text, prefix, node)).toBeUndefined();
  });
  it('declines DM handoff and native replies for different full keys with the same chat node number', async () => {
    const id = 'same-chat-id';
    const bytes = hexToBytesExactOrThrow(second.publicKey, 32);
    // Flipping the same bit in two XOR words preserves the projected 32-bit chat number.
    bytes[0] ^= 1;
    bytes[4] ^= 1;
    const colliding = { ...second, publicKey: Buffer.from(bytes).toString('hex') };
    expect(colliding.publicKey.slice(0, 12)).not.toBe(second.publicKey.slice(0, 12));
    expect(boardNodeId(colliding)).toBe(boardNodeId(second));
    await prepareContact(id, second);
    expect(boardAddressConflict(id, colliding)).toBe(true);
    expect(hasBoardContact(id, colliding)).toBe(false);
    saveBoardHost(id, colliding);
    expect(hasBoardContact(id, second)).toBe(false);
    saveBoardHost(id, second);
    expect(
      boardResponseKey(
        id,
        frame('000000000022', ['list', null, []]),
        second.publicKey.slice(0, 12),
        boardNodeId(second),
      ),
    ).toBeUndefined();
  });
  it('preserves replies while switching boards, shares the radio lease and keeps equal local thread ids separate', async () => {
    const identity = 'switch';
    await prepareContact(identity, first);
    await prepareContact(identity, second);
    saveBoardHost(identity, second);
    vi.spyOn(connectionDriver, 'getHandle').mockReturnValue({});
    const sent = vi.spyOn(dm, 'meshcoreSendTextMessageWithNotFoundRestore').mockResolvedValue({});
    const client = getBoardClient(identity, first),
      other = getBoardClient(identity, second);
    expect(sent).not.toHaveBeenCalled();
    const detach = attachBoardSessions(identity);
    const pending = client.refresh('discussion');
    await expect(other.refresh('discussion')).rejects.toThrow('another board');
    const rid = sent.mock.calls[0][2].split(' ')[1];
    const text = frame(rid, ['list', null, [['1', 'first subject', 0, '2026-11-24']]]);
    detach(); // Closing the original view must not discard its outstanding receipt.
    packetRouter.dispatch(
      { type: 'meshcore_board_response', payload: { publicKey: second.publicKey, text } },
      identity,
    );
    packetRouter.dispatch(
      { type: 'meshcore_board_response', payload: { publicKey: first.publicKey, text } },
      'wrong-radio',
    );
    expect(client.getSnapshot().entries).toHaveLength(0);
    packetRouter.dispatch(
      { type: 'meshcore_board_response', payload: { publicKey: first.publicKey, text } },
      identity,
    );
    await pending;
    const close = attachBoardSessions(identity);
    const list = other.refresh('discussion');
    const next = sent.mock.calls[1][2].split(' ')[1];
    packetRouter.dispatch(
      {
        type: 'meshcore_board_response',
        payload: {
          publicKey: second.publicKey,
          text: frame(next, ['list', null, [['1', 'second subject', 0, '2026-11-24']]]),
        },
      },
      identity,
    );
    await list;
    close();
    expect(client.getSnapshot().entries[0]).toMatchObject({ id: 'd:1', subject: 'first subject' });
    expect(other.getSnapshot().entries[0]).toMatchObject({ id: 'd:1', subject: 'second subject' });
    expect(sent).toHaveBeenCalledTimes(2);
  });
});
