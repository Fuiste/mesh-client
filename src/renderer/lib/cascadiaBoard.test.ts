import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  BOARD_FRAME_BYTES,
  type BoardClient,
  boardPostBytes,
  createBoardClient,
  validateBoardPost,
} from './cascadiaBoard';

const date = '2026-11-24T10:00:00Z';
function memory() {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => {
      map.set(k, v);
    },
    removeItem: (k: string) => {
      map.delete(k);
    },
  };
}
function setup(storage = memory(), identityId = 'm5') {
  const sendDm = vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined);
  const client = createBoardClient({ identityId, storage, sendDm });
  const lastFrame = () => sendDm.mock.calls.at(-1)![0];
  function deliver(response: unknown[]) {
    const rid = lastFrame().split(' ')[1];
    for (const f of frames(rid, response)) expect(client.accept(f)).toBe(true);
  }
  return { client, storage, lastFrame, sendDm, deliver };
}
function frames(rid: string, payload: unknown[], width = 55) {
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const pieces = Array.from({ length: Math.ceil(encoded.length / width) }, (_, i) =>
    encoded.slice(i * width, (i + 1) * width),
  );
  return pieces.map((p, i) => `cc1 ${rid} ${i + 1}/${pieces.length} ${p}`);
}
function acceptOther(client: BoardClient, frame: string) {
  expect(client.accept(frame)).toBe(false);
}
afterEach(() => vi.useRealTimers());
describe('cascadia board radio client', () => {
  it('reads only requested pages, reassembles out-of-order UTF-8 fragments and isolates cached radio identities', async () => {
    const h = setup();
    const start = h.client.refresh('discussion');
    expect(h.lastFrame()).toMatch(/^!cc1 [a-f0-9]{12} \["list","d",0\]$/);
    const rid = h.lastFrame().split(' ')[1];
    const parts = frames(rid, ['list', 913, [['7', 'ridge 🌲', 2, date]]], 12);
    acceptOther(h.client, 'hello');
    acceptOther(h.client, parts[0].replace(rid, '000000000001'));
    h.client.accept(parts[2]);
    h.client.accept(parts[2]);
    for (const f of [...parts].reverse()) h.client.accept(f);
    await start;
    const next = h.client.refresh('discussion', true);
    expect(h.lastFrame()).toContain('["list","d",913]');
    h.deliver(['list', null, [['8', 'other', 0, date]]]);
    await next;
    const load = h.client.read('d:7');
    h.deliver(['read', 43, [['fern', date, 'op']]]);
    await load;
    expect(h.client.getSnapshot().morePosts['d:7']).toBe(true);
    const more = h.client.read('d:7', true);
    expect(h.lastFrame()).toContain('["read","d","7",43]');
    h.deliver([
      'read',
      null,
      [
        ['alder', date, 'reply 1'],
        ['fern', date, 'reply 2'],
      ],
    ]);
    await more;
    expect(h.client.getSnapshot().posts['d:7']?.map((p) => p.body)).toEqual([
      'op',
      'reply 1',
      'reply 2',
    ]);
    expect(setup(h.storage).client.getSnapshot()).toEqual(h.client.getSnapshot());
    expect(setup(h.storage, 'm7').client.getSnapshot().entries).toEqual([]);
    expect(h.sendDm).toHaveBeenCalledTimes(4);
    const changed = h.client.refresh('discussion');
    h.deliver(['list', null, [['7', 'ridge 🌲', 3, date]]]);
    await changed;
    expect(h.client.getSnapshot().posts['d:7']).toBeUndefined();
  });
  it('evicts bodies and continuations dropped from a fresh index before loading later pages', async () => {
    const h = setup();
    async function exchange(pending: Promise<unknown>, result: unknown[]) {
      h.deliver(result);
      await pending;
    }
    await exchange(h.client.refresh('bulletin'), ['list', null, [['n', 'notice', 0, date]]]);
    await exchange(h.client.read('b:n'), ['read', null, [['fern', date, 'keep this notice']]]);
    await exchange(h.client.refresh('discussion'), ['list', 11, [['1', 'front page', 0, date]]]);
    await exchange(h.client.refresh('discussion', true), [
      'list',
      null,
      [
        ['2', 'older', 2, date],
        ['3', 'removed', 0, date],
      ],
    ]);
    await exchange(h.client.read('d:2'), ['read', 22, [['fern', date, 'stale op']]]);
    await exchange(h.client.read('d:3'), ['read', null, [['fern', date, 'removed post']]]);
    await exchange(h.client.refresh('discussion'), ['list', 33, [['1', 'front page', 0, date]]]);
    expect(Object.keys(h.client.getSnapshot().posts)).toEqual(['b:n']);
    expect(h.client.getSnapshot().morePosts['d:2']).toBeUndefined();
    await exchange(h.client.refresh('discussion', true), ['list', null, [['2', 'older', 3, date]]]);
    const reopened = setup(h.storage);
    expect(reopened.client.getSnapshot().posts['d:2']).toBeUndefined();
    await reopened.client.read('d:2', true);
    expect(reopened.sendDm).not.toHaveBeenCalled();
    await expect(reopened.client.read('d:3')).rejects.toThrow('refresh');
  });
  it('waits for a board receipt and safely retries an unconfirmed write after restart', async () => {
    vi.useFakeTimers();
    const h = setup();
    const first = h.client.create('discussion', 'swap', 'spare whips');
    const timedOut = expect(first).rejects.toThrow('no board confirmation');
    expect(h.client.getSnapshot().entries).toHaveLength(0);
    await expect(h.client.refresh('bulletin')).rejects.toThrow('previous board request');
    await vi.advanceTimersByTimeAsync(75_000);
    await timedOut;
    const resumed = setup(h.storage);
    const retry = resumed.client.create('discussion', 'swap', 'spare whips');
    expect(resumed.lastFrame()).toBe(h.lastFrame());
    resumed.deliver(['saved', 'd', '14', 'rpc', date, 0]);
    expect(await retry).toBe('d:14');
    const reply = resumed.client.reply('d:14', 'bringing two');
    expect(resumed.client.getSnapshot().posts['d:14']).toHaveLength(1);
    resumed.deliver(['saved', 'd', '14', 'rpc', date, 1]);
    await reply;
    expect(resumed.client.getSnapshot().posts['d:14']?.[1]).toMatchObject({
      body: 'bringing two',
      saved: true,
    });
    const third = resumed.client.reply('d:14', 'one left');
    resumed.deliver(['saved', 'd', '14', 'rpc', date, 3]);
    await third;
    expect(resumed.client.getSnapshot().posts['d:14']).toBeUndefined();
    expect(resumed.client.getSnapshot().entries[0].replyCount).toBe(3);
  });
  it('enforces exact escaped UTF-8 wire length and never sends an unjournaled mutation', async () => {
    const h = setup();
    const overhead = boardPostBytes('bulletin', 'net', '');
    const fit = 'x'.repeat(BOARD_FRAME_BYTES - overhead);
    expect(validateBoardPost('bulletin', 'net', fit)).toBeNull();
    expect(validateBoardPost('bulletin', 'net', fit + '🌲')).toBeTruthy();
    expect(boardPostBytes('bulletin', 'net', '"🌲"')).toBe(overhead + 8);
    await expect(h.client.create('bulletin', 'net', fit + '!')).rejects.toThrow('shorten');
    vi.spyOn(h.storage, 'setItem').mockImplementation(() => {
      throw Error('quota');
    });
    await expect(h.client.create('bulletin', 'net', 'short')).rejects.toThrow('has not been sent');
    expect(h.sendDm).not.toHaveBeenCalled();
  });
  it('keeps partial, rejected and conflicting responses out of the cache', async () => {
    const h = setup();
    let pending = h.client.refresh('bulletin');
    h.deliver(['error', 'page expired']);
    await expect(pending).rejects.toThrow('page expired');
    pending = h.client.refresh('bulletin');
    const rid = h.lastFrame().split(' ')[1];
    h.client.accept(`cc1 ${rid} 1/2 ZQ`);
    h.client.accept(`cc1 ${rid} 1/2 Zx`);
    await expect(pending).rejects.toThrow('invalid board response');
    pending = h.client.refresh('discussion');
    h.client.cancelPending();
    await expect(pending).rejects.toThrow('disconnected');
    expect(h.client.getSnapshot().fetchedAt).toBeNull();
  });
});
