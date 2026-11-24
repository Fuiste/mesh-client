import {
  type BoardHost,
  boardSessionKey,
  DEFAULT_BOARD_HOST,
  legacyBoardKey,
} from './cascadiaBoardHosts';
import { CASCADIACHAN_PUBLIC_KEY } from './cascadiaBoardIdentity';
import {
  boardId,
  type BoardKind,
  BoardRadio,
  newRequestId,
  validateBoardPost,
  wireKind,
  writeCommand,
} from './cascadiaBoardWire';

export { CASCADIACHAN_PUBLIC_KEY };
export {
  BOARD_FRAME_BYTES,
  type BoardKind,
  boardPostBytes,
  validateBoardPost,
} from './cascadiaBoardWire';

export interface BoardEntry {
  id: string;
  kind: BoardKind;
  subject: string;
  author: string;
  updatedAt: number;
  replyCount: number;
}
export interface BoardPost {
  author: string;
  body: string;
  createdAt: number;
  saved?: boolean;
}
export interface BoardSnapshot {
  entries: readonly BoardEntry[];
  posts: Readonly<Partial<Record<string, readonly BoardPost[]>>>;
  fetchedAt: number | null;
  indexFetchedAt: Partial<Record<BoardKind, number>>;
  moreEntries: Partial<Record<BoardKind, boolean>>;
  morePosts: Readonly<Partial<Record<string, boolean>>>;
}
interface Cache {
  snapshot: BoardSnapshot;
  indexCursor: Partial<Record<BoardKind, number>>;
  postCursor: Partial<Record<string, number>>;
}
interface Options {
  identityId: string;
  host?: BoardHost;
  acquire?: (rid: string) => () => void;
  sendDm: (text: string) => Promise<void>;
  storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
}

const now = () => Math.floor(Date.now() / 1000);
const emptyCache = (): Cache => ({
  snapshot: {
    entries: [],
    posts: {},
    fetchedAt: null,
    indexFetchedAt: {},
    moreEntries: {},
    morePosts: {},
  },
  indexCursor: {},
  postCursor: {},
});
const record = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const timestamp = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const count = (v: unknown): v is number =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const validKey = (v: unknown): v is string =>
  typeof v === 'string' && v.length > 0 && v.length <= 100;
const isId = (v: unknown): v is string =>
  typeof v === 'string' && /^[db]:/.test(v) && validKey(v.slice(2));
function parseDate(value: unknown) {
  if (typeof value !== 'string') throw new Error('invalid date from board');
  const ms = Date.parse(value.replace(' ', 'T'));
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : 0;
}
function validCache(value: unknown): value is Cache {
  if (!record(value) || !record(value.snapshot)) return false;
  const s = value.snapshot;
  return (
    Array.isArray(s.entries) &&
    s.entries.every(
      (e) =>
        record(e) &&
        isId(e.id) &&
        (e.kind === 'discussion' || e.kind === 'bulletin') &&
        e.id.startsWith(wireKind(e.kind) + ':') &&
        typeof e.author === 'string' &&
        typeof e.subject === 'string' &&
        count(e.replyCount) &&
        timestamp(e.updatedAt),
    ) &&
    record(s.posts) &&
    Object.entries(s.posts).every(
      ([id, posts]) =>
        isId(id) &&
        Array.isArray(posts) &&
        posts.every(
          (p) =>
            record(p) &&
            typeof p.author === 'string' &&
            typeof p.body === 'string' &&
            timestamp(p.createdAt),
        ),
    ) &&
    (s.fetchedAt === null || timestamp(s.fetchedAt)) &&
    record(s.indexFetchedAt) &&
    Object.values(s.indexFetchedAt).every(timestamp) &&
    record(s.moreEntries) &&
    Object.values(s.moreEntries).every((v) => typeof v === 'boolean') &&
    record(s.morePosts) &&
    Object.values(s.morePosts).every((v) => typeof v === 'boolean') &&
    record(value.indexCursor) &&
    Object.values(value.indexCursor).every(count) &&
    record(value.postCursor) &&
    Object.values(value.postCursor).every(count)
  );
}
function page(response: unknown[], type: 'list' | 'read') {
  const [op, cursor, rows] = response;
  if (op !== type || !(cursor === null || (count(cursor) && cursor > 0)) || !Array.isArray(rows)) {
    throw new Error('unexpected page from board');
  }
  return { cursor, rows: rows as unknown[] };
}

/** A client is scoped to the board and one local radio identity, including outstanding write IDs. */
export function createCc1BoardClient({
  identityId,
  host = DEFAULT_BOARD_HOST,
  acquire,
  sendDm,
  storage = window.localStorage,
}: Options) {
  if (host.adapterId !== 'cc1') throw new Error('this board uses direct messages');
  // Keep the exact original cache and unresolved-write journal for the built-in host.
  const key =
    host.publicKey === CASCADIACHAN_PUBLIC_KEY
      ? legacyBoardKey(identityId)
      : 'mesh-client:board-cache:v2:' + boardSessionKey(identityId, host);
  const writesKey = key + ':writes';
  const radio = new BoardRadio(sendDm, acquire);
  let cache = emptyCache();
  try {
    const stored = storage.getItem(key);
    if (stored) {
      const value: unknown = JSON.parse(stored);
      if (validCache(value)) cache = value;
    }
  } catch {
    console.debug('[CascadiaBoard] could not read the local cache; starting with an empty index');
  }

  const listeners = new Set<() => void>();
  function publish(snapshot: BoardSnapshot) {
    cache = { ...cache, snapshot };
    try {
      storage.setItem(key, JSON.stringify(cache));
    } catch {
      console.debug('[CascadiaBoard] local cache write failed; using the in-memory copy');
    }
    for (const notify of listeners) notify();
  }
  function entry(id: string) {
    const found = cache.snapshot.entries.find((e) => e.id === id);
    if (!found) throw new Error('refresh the board index to find this post');
    return found;
  }
  function storeCursor(map: Partial<Record<string, number>>, id: string, next: number | null) {
    if (next === null) Reflect.deleteProperty(map, id);
    else map[id] = next;
  }

  async function refresh(kind: BoardKind, more = false) {
    const offset = more ? cache.indexCursor[kind] : 0;
    if (offset === undefined) return;
    const result = page(await radio.request(['list', wireKind(kind), offset]), 'list');
    const s = cache.snapshot;
    const fetched = result.rows.map((r) => {
      if (!Array.isArray(r) || !validKey(r[0]) || typeof r[1] !== 'string' || !count(r[2]))
        throw new Error('invalid board index');
      const id = boardId(kind, r[0]);
      return {
        id,
        kind,
        subject: r[1],
        replyCount: r[2],
        updatedAt: parseDate(r[3]),
        author: s.posts[id]?.[0]?.author ?? '',
      };
    });
    const retained = more ? s.entries : s.entries.filter((e) => e.kind !== kind);
    const entries = new Map(retained.map((e) => [e.id, e]));
    const posts = { ...s.posts };
    const morePosts = { ...s.morePosts };
    for (const e of fetched) entries.set(e.id, e);
    const previous = new Map(s.entries.map((e) => [e.id, e]));
    for (const id of Object.keys(posts)) {
      const old = previous.get(id);
      const row = entries.get(id);
      if (
        old &&
        old.replyCount === row?.replyCount &&
        old.updatedAt === row.updatedAt &&
        old.subject === row.subject
      )
        continue;
      Reflect.deleteProperty(posts, id);
      Reflect.deleteProperty(morePosts, id);
      Reflect.deleteProperty(cache.postCursor, id);
      if (row) entries.set(id, { ...row, author: '' });
    }
    storeCursor(cache.indexCursor, kind, result.cursor);
    const time = now();
    publish({
      ...s,
      entries: [...entries.values()],
      posts,
      morePosts,
      fetchedAt: time,
      indexFetchedAt: { ...s.indexFetchedAt, [kind]: time },
      moreEntries: { ...s.moreEntries, [kind]: result.cursor !== null },
    });
  }

  async function read(id: string, more = false) {
    const e = entry(id);
    const offset = more ? cache.postCursor[id] : 0;
    if (offset === undefined) return;
    const result = page(
      await radio.request(['read', wireKind(e.kind), id.slice(2), offset]),
      'read',
    );
    const s = cache.snapshot;
    const fetched = result.rows.map((r) => {
      if (!Array.isArray(r) || typeof r[0] !== 'string' || typeof r[2] !== 'string')
        throw new Error('invalid post from board');
      return { author: r[0], createdAt: parseDate(r[1]), body: r[2] };
    });
    const posts = [...(more ? (s.posts[id] ?? []) : []), ...fetched];
    storeCursor(cache.postCursor, id, result.cursor);
    publish({
      ...s,
      posts: { ...s.posts, [id]: posts },
      morePosts: { ...s.morePosts, [id]: result.cursor !== null },
      entries: s.entries.map((row) =>
        row.id === id
          ? {
              ...row,
              author: posts[0]?.author ?? '',
              replyCount: result.cursor === null ? Math.max(0, posts.length - 1) : row.replyCount,
            }
          : row,
      ),
    });
  }

  // Persist a write's request ID before transmission. Explicit retries after a lost receipt,
  // reconnect or restart send the same ID and exact payload for board-side deduplication.
  function readJournal(): Record<string, string> {
    const raw = storage.getItem(writesKey);
    if (!raw) return {};
    const j: unknown = JSON.parse(raw);
    if (
      !record(j) ||
      !Object.entries(j).every(
        ([rid, cmd]) => /^[a-f0-9]{12}$/.test(rid) && typeof cmd === 'string',
      )
    )
      throw new Error('invalid board write journal');
    return j as Record<string, string>;
  }
  function reserve(command: readonly string[]): string {
    try {
      const j = readJournal();
      const serialized = JSON.stringify(command);
      const found = Object.keys(j).find((rid) => j[rid] === serialized);
      if (found) return found;
      const rid = newRequestId();
      j[rid] = serialized;
      storage.setItem(writesKey, JSON.stringify(j));
      return rid;
    } catch {
      throw new Error('could not save the retry id on this pc; post has not been sent');
    }
  }
  function complete(rid: string) {
    try {
      const journal = readJournal();
      Reflect.deleteProperty(journal, rid);
      if (Object.keys(journal).length) storage.setItem(writesKey, JSON.stringify(journal));
      else storage.removeItem(writesKey);
    } catch {
      console.debug('[CascadiaBoard] could not remove a confirmed, replay-safe request id');
    }
  }

  async function write(
    kind: BoardKind,
    subject: string | null,
    body: string,
    targetId?: string,
  ): Promise<string> {
    radio.ensureAvailable();
    const invalid = validateBoardPost(kind, subject, body, targetId);
    if (invalid) throw new Error(invalid);
    const command = writeCommand(kind, subject, body, targetId);
    const rid = reserve(command);
    const [op, section, key, author, date, total] = await radio.request(command, rid);
    if (
      op !== 'saved' ||
      section !== wireKind(kind) ||
      !validKey(key) ||
      typeof author !== 'string' ||
      !count(total)
    )
      throw new Error('invalid board receipt; retry the same post');
    const id = boardId(kind, key);
    if (targetId && targetId !== id) throw new Error('receipt refers to a different discussion');
    const p: BoardPost = { author, body: body.trim(), createdAt: parseDate(date), saved: true };
    const s = cache.snapshot;
    const last = s.posts[id];
    const existing = s.entries.find((e) => e.id === id);
    const posts = { ...s.posts };
    const morePosts = { ...s.morePosts };
    if (subject !== null) {
      posts[id] = [p];
      morePosts[id] = false;
    } else if (last && !s.morePosts[id] && last.length === total) {
      posts[id] = [...last, p];
      morePosts[id] = false;
    } else {
      // Concurrent posts may exist between the cached tail and our receipt.
      // Re-read from the host rather than inventing a contiguous thread.
      Reflect.deleteProperty(posts, id);
      Reflect.deleteProperty(morePosts, id);
    }
    Reflect.deleteProperty(cache.postCursor, id);
    const updated: BoardEntry = {
      id,
      kind,
      subject: subject?.trim() ?? existing?.subject ?? '',
      author: subject !== null ? author : (existing?.author ?? ''),
      updatedAt: p.createdAt,
      replyCount: total,
    };
    publish({
      ...s,
      entries: [updated, ...s.entries.filter((e) => e.id !== id)],
      posts,
      morePosts,
    });
    complete(rid);
    return id;
  }

  return {
    subscribe(notify: () => void) {
      listeners.add(notify);
      return () => {
        listeners.delete(notify);
      };
    },
    getSnapshot: () => cache.snapshot,
    refresh,
    read,
    create: (kind: BoardKind, subject: string, body: string) => write(kind, subject, body),
    reply: (id: string, body: string) => write(entry(id).kind, null, body, id),
    accept: (text: string) => radio.accept(text),
    cancelPending: () => {
      radio.cancelPending();
    },
    dispose: () => {
      radio.dispose();
      listeners.clear();
    },
  };
}
export { createCc1BoardClient as createBoardClient };
export type BoardClient = ReturnType<typeof createCc1BoardClient>;
