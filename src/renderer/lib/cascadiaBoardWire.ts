export const BOARD_FRAME_BYTES = 150;
const MAX_PARTS = 32;
const EMPTY_ID = '000000000000';
const RESPONSE_IDLE_MS = 75_000;

export type BoardKind = 'discussion' | 'bulletin';
export const wireKind = (kind: BoardKind) => (kind === 'discussion' ? 'd' : 'b');
export const boardId = (kind: BoardKind, key: string) => `${wireKind(kind)}:${key}`;

export function writeCommand(kind: BoardKind, subject: string | null, body: string, id?: string) {
  return subject === null
    ? ['reply', id?.slice(2) ?? '', body.trim()]
    : ['new', wireKind(kind), subject.trim(), body.trim()];
}

function frame(rid: string, command: readonly unknown[]) {
  return `!cc1 ${rid} ${JSON.stringify(command)}`;
}
const byteLength = (value: string) => new TextEncoder().encode(value).length;

export function boardPostBytes(kind: BoardKind, subject: string | null, body: string, id?: string) {
  return byteLength(frame(EMPTY_ID, writeCommand(kind, subject, body, id)));
}

export function validateBoardPost(
  kind: BoardKind,
  subject: string | null,
  body: string,
  id?: string,
): string | null {
  if (subject === null && (kind !== 'discussion' || !id?.startsWith('d:')))
    return 'select a discussion to reply';
  if (subject !== null && !subject.trim()) return 'enter a subject';
  if (subject !== null && /[|\r\n]/.test(subject.trim()))
    return 'use one subject line without a pipe character';
  if (!body.trim()) return 'enter a message';
  if (boardPostBytes(kind, subject, body, id) > BOARD_FRAME_BYTES)
    return 'shorten this post to fit one radio message';
  return null;
}

export function newRequestId() {
  return Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) =>
    b.toString(16).padStart(2, '0'),
  ).join('');
}

export function decodeBoardResponse(parts: string[]): unknown[] {
  const text = atob(parts.join('').replace(/-/g, '+').replace(/_/g, '/'));
  const bytes = Uint8Array.from(text, (c) => c.charCodeAt(0));
  const result: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  if (!Array.isArray(result)) throw new Error('invalid response from board');
  return result;
}

interface Exchange {
  rid: string;
  parts: Map<number, string>;
  total?: number;
  armIdle: () => void;
  finish: (err?: Error, response?: unknown[]) => void;
}

export class BoardRadio {
  private pending?: Exchange;
  private disposed = false;
  constructor(
    private readonly sendDm: (text: string) => Promise<void>,
    private readonly acquire?: (rid: string) => () => void,
  ) {}

  ensureAvailable() {
    if (this.disposed) throw new Error('board session closed');
    if (this.pending) throw new Error('waiting for the previous board request');
  }

  request(command: readonly unknown[], rid = newRequestId()): Promise<unknown[]> {
    this.ensureAvailable();
    const text = frame(rid, command);
    if (byteLength(text) > BOARD_FRAME_BYTES) throw new Error('request exceeds one radio message');
    const release = this.acquire?.(rid);
    return new Promise((resolve, reject) => {
      let idle: ReturnType<typeof setTimeout>;
      const timeout = () => {
        exchange.finish(new Error('no board confirmation; retry the same request'));
      };
      const exchange: Exchange = {
        rid,
        parts: new Map(),
        armIdle: () => {
          clearTimeout(idle);
          idle = setTimeout(timeout, RESPONSE_IDLE_MS);
        },
        finish: (err, response) => {
          if (this.pending !== exchange) return;
          clearTimeout(idle);
          this.pending = undefined;
          release?.();
          if (response) resolve(response);
          else reject(err ?? new Error('board request failed'));
        },
      };
      this.pending = exchange;
      exchange.armIdle();
      try {
        void this.sendDm(text).catch((err: unknown) => {
          exchange.finish(err instanceof Error ? err : new Error('radio send failed'));
        });
      } catch (err) {
        // catch-no-log-ok Reject the active exchange with the synchronous transport error.
        exchange.finish(err instanceof Error ? err : new Error('radio send failed'));
      }
    });
  }

  /** Sender and receiving radio identity must be verified by the caller. Never accepts chat as a receipt. */
  accept(text: string): boolean {
    const m = /^cc1 ([0-9a-f]{12}) (\d{1,2})\/(\d{1,2}) ([\w-]{1,150})$/.exec(text);
    const x = this.pending;
    if (!m || x?.rid !== m[1]) return false;
    const part = Number(m[2]),
      total = Number(m[3]);
    const seen = x.parts.get(part);
    if (
      part < 1 ||
      part > total ||
      total > MAX_PARTS ||
      (x.total !== undefined && total !== x.total) ||
      (seen !== undefined && seen !== m[4])
    ) {
      x.finish(new Error('invalid board response; retry the request'));
      return true;
    }
    if (seen !== undefined) return true;
    x.parts.set(part, m[4]);
    x.total = total;
    x.armIdle();
    if (x.parts.size === total) {
      try {
        const result = decodeBoardResponse(
          Array.from({ length: total }, (_, i) => x.parts.get(i + 1)!),
        );
        if (result[0] === 'error')
          x.finish(
            new Error(typeof result[1] === 'string' ? result[1] : 'board rejected the request'),
          );
        else x.finish(undefined, result);
      } catch {
        // catch-no-log-ok The request receives a decoding error without copying packet contents into logs.
        x.finish(new Error('could not decode board response'));
      }
    }
    return true;
  }

  cancelPending() {
    this.pending?.finish(new Error('radio disconnected; board confirmation unavailable'));
  }
  dispose() {
    this.disposed = true;
    this.cancelPending();
  }
}
