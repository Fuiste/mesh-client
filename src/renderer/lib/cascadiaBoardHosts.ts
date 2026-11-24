import { bytesToHex, hexToBytesExactOrThrow } from '@/shared/hexBytes';
import {
  buildMeshcoreContactAddUri,
  classifyMeshClientDeepLink,
} from '@/shared/meshClientDeepLink';

import { type NodeRecord, useNodeStore } from '../stores/nodeStore';
import { CASCADIACHAN_PUBLIC_KEY } from './cascadiaBoardIdentity';
import { pubkeyToNodeId } from './meshcoreUtils';

export interface BoardHost {
  name: string;
  publicKey: string;
  adapterId: 'cc1' | 'dm';
}

export const DEFAULT_BOARD_HOST: Readonly<BoardHost> = {
  name: 'CascadiaChan',
  publicKey: CASCADIACHAN_PUBLIC_KEY,
  adapterId: 'cc1',
};

export function boardNodeId(host: BoardHost) {
  return pubkeyToNodeId(hexToBytesExactOrThrow(host.publicKey, 32));
}

export function boardContactCard(host: BoardHost) {
  return buildMeshcoreContactAddUri({ name: host.name, publicKeyHex: host.publicKey, type: 1 });
}

export function parseBoardHost(
  input: string,
  name: string,
  adapterId: BoardHost['adapterId'],
): BoardHost {
  const value = input.trim();
  const contact = classifyMeshClientDeepLink(value);
  const key = (contact.kind === 'meshcoreContactAdd' ? contact.publicKeyHex : value).toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(key))
    throw new Error('enter a full meshcore public key or contact link');
  if (contact.kind === 'meshcoreContactAdd' && contact.type !== 1)
    throw new Error('select a meshcore chat contact');
  const label =
    name.trim() || (contact.kind === 'meshcoreContactAdd' ? contact.name : key.slice(0, 12));
  if (label.length > 128) throw new Error('board name is too long');
  const host = { name: label, publicKey: key, adapterId };
  if (!boardNodeId(host)) throw new Error('invalid meshcore contact key');
  return host;
}

export function boardSessionKey(identityId: string, host: BoardHost) {
  return JSON.stringify(['meshcore', identityId, host.publicKey, host.adapterId]);
}

const directoryKey = (identityId: string) =>
  'mesh-client:board-hosts:v1:' + encodeURIComponent(identityId);

export function identityContactKeys(identityId: string) {
  const records = useNodeStore.getState().nodes[identityId] as
    Record<number, NodeRecord> | undefined;
  return Object.values(records ?? {}).flatMap((n) => {
    const keys: string[] = [];
    if (n.publicKey?.length === 32) keys.push(bytesToHex(n.publicKey));
    if (n.publicKeyHex?.length === 64) keys.push(n.publicKeyHex.toLowerCase());
    return keys;
  });
}

export const legacyBoardKey = (identityId: string) =>
  `mesh-client:cascadia-board:v1:${identityId}:${CASCADIACHAN_PUBLIC_KEY}`;

export function loadBoardHosts(identityId: string): BoardHost[] {
  try {
    const storage = (globalThis as { localStorage?: Storage }).localStorage;
    const raw = storage?.getItem(directoryKey(identityId));
    if (raw == null) {
      const legacy = legacyBoardKey(identityId);
      const migrated =
        storage?.getItem(legacy) != null ||
        storage?.getItem(legacy + ':writes') != null ||
        identityContactKeys(identityId).includes(CASCADIACHAN_PUBLIC_KEY);
      return migrated ? [{ ...DEFAULT_BOARD_HOST }] : [];
    }
    const records: unknown = JSON.parse(raw);
    if (!Array.isArray(records)) return [];
    const hosts = new Map<string, BoardHost>();
    for (const value of records as unknown[]) {
      if (typeof value !== 'object' || value === null) continue;
      const row = value as Record<string, unknown>;
      if (
        typeof row.name === 'string' &&
        typeof row.publicKey === 'string' &&
        (row.adapterId === 'cc1' || row.adapterId === 'dm')
      ) {
        try {
          const host = parseBoardHost(row.publicKey, row.name, row.adapterId);
          hosts.set(host.publicKey, host);
        } catch {
          // catch-no-log-ok Ignore only the malformed local record.
        }
      }
    }
    return [...hosts.values()];
  } catch {
    // catch-no-log-ok Malformed local preferences do not initiate enrollment or radio traffic.
    return [];
  }
}

export function saveBoardHost(identityId: string, host: BoardHost) {
  const normalized = parseBoardHost(host.publicKey, host.name, host.adapterId);
  const hosts = new Map(loadBoardHosts(identityId).map((h) => [h.publicKey, h]));
  hosts.set(normalized.publicKey, normalized);
  localStorage.setItem(directoryKey(identityId), JSON.stringify([...hosts.values()]));
  return normalized;
}

export function removeBoardHost(identityId: string, publicKey: string) {
  const hosts = loadBoardHosts(identityId).filter((h) => h.publicKey !== publicKey);
  localStorage.setItem(directoryKey(identityId), JSON.stringify(hosts));
  if (loadActiveBoardKey(identityId) === publicKey)
    localStorage.removeItem(directoryKey(identityId) + ':active');
}

export function loadActiveBoardKey(identityId: string) {
  return (
    (globalThis as { localStorage?: Storage }).localStorage?.getItem(
      directoryKey(identityId) + ':active',
    ) ?? null
  );
}

export function saveActiveBoardKey(identityId: string, publicKey: string) {
  localStorage.setItem(directoryKey(identityId) + ':active', publicKey);
}
