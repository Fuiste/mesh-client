import { bytesToHex, hexToBytesExact } from '@/shared/hexBytes';

import { type NodeRecord, useNodeStore } from '../stores/nodeStore';
import {
  type BoardHost,
  boardNodeId,
  identityContactKeys,
  loadBoardHosts,
} from './cascadiaBoardHosts';
import { pubkeyToNodeId } from './meshcoreUtils';

// A radio can service one interactive board transfer at a time. The request's destination
// remains authoritative when the user changes tabs, even for an unsaved board being checked.
const active = new Map<string, { host: BoardHost; rid: string }>();
export function reserveBoardRadio(identityId: string, host: BoardHost, rid: string) {
  if (active.has(identityId)) throw new Error('this radio is waiting for another board');
  const owner = { host, rid };
  active.set(identityId, owner);
  return () => {
    if (active.get(identityId) === owner) active.delete(identityId);
  };
}

function ambiguous(host: BoardHost, keys: Iterable<string>) {
  const prefix = host.publicKey.slice(0, 12);
  const nodeId = boardNodeId(host);
  for (const key of keys) {
    if (key === host.publicKey) continue;
    if (key.startsWith(prefix)) return true;
    const bytes = hexToBytesExact(key, 32);
    if (bytes && pubkeyToNodeId(bytes) === nodeId) return true;
  }
  return false;
}

export function hasBoardContact(identityId: string, host: BoardHost) {
  const nodes = useNodeStore.getState().nodes[identityId] as
    Record<number, NodeRecord | undefined> | undefined;
  const row = nodes?.[boardNodeId(host)];
  if (!row) return false;
  const bytes = row.publicKey?.length === 32 ? bytesToHex(row.publicKey) : undefined;
  const hex = row.publicKeyHex?.toLowerCase();
  return (
    (bytes === host.publicKey || hex === host.publicKey) &&
    (!bytes || bytes === host.publicKey) &&
    (!hex || hex === host.publicKey) &&
    !boardAddressConflict(identityId, host)
  );
}

export function boardAddressConflict(identityId: string, host: BoardHost) {
  return ambiguous(host, [
    ...identityContactKeys(identityId),
    ...loadBoardHosts(identityId).map((h) => h.publicKey),
  ]);
}

/** The companion gives six sender bytes. Conflicting known full keys must fall through to normal DM handling. */
export function boardResponseKey(
  identityId: string | undefined | null,
  text: string,
  prefix: string,
  senderId: number,
  txtType?: number,
  wireKeys?: Iterable<Uint8Array | string>,
) {
  if (!identityId || (txtType != null && txtType !== 0)) return undefined;
  const frame = /^cc1 ([0-9a-f]{12}) \d{1,2}\/\d{1,2} [A-Za-z0-9_-]{1,150}$/.exec(text);
  if (!frame) return undefined;
  const hosts = loadBoardHosts(identityId);
  const owner = active.get(identityId);
  const pending = owner?.rid === frame[1] ? owner.host : undefined;
  const host =
    pending ?? hosts.find((h) => h.adapterId === 'cc1' && h.publicKey.startsWith(prefix));
  if (host?.publicKey.slice(0, 12) !== prefix || boardNodeId(host) !== senderId) return undefined;
  const keys = identityContactKeys(identityId);
  if (wireKeys)
    for (const key of wireKeys) {
      if (typeof key === 'string') {
        if (key.length === 64) keys.push(key.toLowerCase());
      } else if (key.length === 32) keys.push(bytesToHex(key));
    }
  if (
    !keys.includes(host.publicKey) ||
    ambiguous(host, [
      ...keys,
      ...hosts.map((h) => h.publicKey),
      ...(owner ? [owner.host.publicKey] : []),
    ])
  )
    return undefined;
  return host.publicKey;
}
