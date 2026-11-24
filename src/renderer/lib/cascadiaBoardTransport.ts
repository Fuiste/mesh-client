import type { Connection } from '@liamcottle/meshcore.js';

import { bytesToHex } from '@/shared/hexBytes';

import { type BoardClient, createCc1BoardClient } from './cascadiaBoard';
import {
  boardContactCard,
  type BoardHost,
  boardNodeId,
  boardSessionKey,
  DEFAULT_BOARD_HOST,
} from './cascadiaBoardHosts';
import { hasBoardContact as knownContact, reserveBoardRadio } from './cascadiaBoardSource';
import { attachTypedPacketListener } from './drivers/attachTypedPacketListener';
import { connectionDriver } from './drivers/ConnectionDriver';
import { isLoraSenderBlocked } from './loraBlocklist';
import { resolveMeshcoreDestinationPubKeyForIdentity } from './meshcore/meshcoreDestinationPubKey';
import { meshcoreSendTextMessageWithNotFoundRestore } from './meshcore/meshcoreDmSend';
import {
  addMeshcoreNodeContactToRadio,
  type MeshcoreRoomLoginPathSyncConn,
} from './meshcoreRoomLoginPathSync';
import { tryGetMeshcoreSession } from './sessions/meshcoreSession';

export { boardAddressConflict } from './cascadiaBoardSource';

export const CASCADIACHAN_CONTACT_CARD = boardContactCard(DEFAULT_BOARD_HOST);

export function hasBoardContact(identityId: string, host = DEFAULT_BOARD_HOST): boolean {
  return knownContact(identityId, host);
}

export async function sendBoardDm(
  identityId: string,
  text: string,
  host = DEFAULT_BOARD_HOST,
): Promise<void> {
  async function send() {
    const handle = connectionDriver.getHandle(identityId);
    const id = boardNodeId(host);
    const key = resolveMeshcoreDestinationPubKeyForIdentity(identityId, id);
    if (
      !handle ||
      !key ||
      host.adapterId !== 'cc1' ||
      bytesToHex(key) !== host.publicKey ||
      !hasBoardContact(identityId, host) ||
      isLoraSenderBlocked('meshcore', id)
    ) {
      throw new Error('board radio or contact unavailable');
    }
    await meshcoreSendTextMessageWithNotFoundRestore(handle as Connection, key, text, () =>
      addMeshcoreNodeContactToRadio(handle as MeshcoreRoomLoginPathSyncConn, key, {
        long_name: host.name,
        hw_model: 'Chat',
        last_heard: 0,
        latitude: null,
        longitude: null,
      }),
    );
  }
  const runWithRadio = tryGetMeshcoreSession()?.runMeshcoreUserTxWithLiveTcp;
  return runWithRadio ? runWithRadio(send) : send();
}

const adapters = { cc1: createCc1BoardClient };
interface RadioBoards {
  clients: Map<string, BoardClient>;
  references: number;
  pending: boolean;
  detach?: () => void;
}
const radios = new Map<string, RadioBoards>();
function sessions(identityId: string): RadioBoards {
  let found = radios.get(identityId);
  if (!found) {
    found = { clients: new Map(), references: 0, pending: false };
    radios.set(identityId, found);
  }
  return found;
}
function detachUnused(r: RadioBoards) {
  if (r.references === 0 && !r.pending) {
    r.detach?.();
    r.detach = undefined;
  }
}

export function getBoardClient(identityId: string, host: BoardHost): BoardClient {
  if (host.adapterId === 'dm') throw new Error('this board uses direct messages');
  const r = sessions(identityId);
  const scope = boardSessionKey(identityId, host);
  const existing = r.clients.get(scope);
  if (existing) return existing;
  const client = adapters[host.adapterId]({
    identityId,
    host,
    sendDm: (text) => sendBoardDm(identityId, text, host),
    acquire: (rid) => {
      const release = reserveBoardRadio(identityId, host, rid);
      r.pending = true;
      return () => {
        release();
        r.pending = false;
        detachUnused(r);
      };
    },
  });
  r.clients.set(scope, client);
  return client;
}

export function attachBoardSessions(identityId: string) {
  const r = sessions(identityId);
  r.references++;
  r.detach ??= attachTypedPacketListener(
    identityId,
    'meshcore_board_response',
    ({ text, publicKey }) => {
      const host = { name: '', adapterId: 'cc1' as const, publicKey };
      if (!hasBoardContact(identityId, host) || isLoraSenderBlocked('meshcore', boardNodeId(host)))
        return;
      r.clients.get(boardSessionKey(identityId, host))?.accept(text);
    },
  );
  return () => {
    r.references--;
    detachUnused(r);
  };
}
