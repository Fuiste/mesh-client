import type { Connection } from '@liamcottle/meshcore.js';

import { bytesToHex } from '@/shared/hexBytes';
import { buildMeshcoreContactAddUri } from '@/shared/meshClientDeepLink';

import { CASCADIACHAN_NODE_ID, CASCADIACHAN_PUBLIC_KEY } from './cascadiaBoardIdentity';
import { connectionDriver } from './drivers/ConnectionDriver';
import { isLoraSenderBlocked } from './loraBlocklist';
import { resolveMeshcoreDestinationPubKeyForIdentity } from './meshcore/meshcoreDestinationPubKey';
import { meshcoreSendTextMessageWithNotFoundRestore } from './meshcore/meshcoreDmSend';
import {
  addMeshcoreNodeContactToRadio,
  type MeshcoreRoomLoginPathSyncConn,
} from './meshcoreRoomLoginPathSync';
import { tryGetMeshcoreSession } from './sessions/meshcoreSession';

export const CASCADIACHAN_CONTACT_CARD = buildMeshcoreContactAddUri({
  publicKeyHex: CASCADIACHAN_PUBLIC_KEY,
  name: 'CascadiaChan',
  type: 1,
});

export function hasBoardContact(identityId: string): boolean {
  const key = resolveMeshcoreDestinationPubKeyForIdentity(identityId, CASCADIACHAN_NODE_ID);
  return !!key && bytesToHex(key) === CASCADIACHAN_PUBLIC_KEY;
}

export async function sendBoardDm(identityId: string, text: string): Promise<void> {
  async function send() {
    const handle = connectionDriver.getHandle(identityId);
    const key = resolveMeshcoreDestinationPubKeyForIdentity(identityId, CASCADIACHAN_NODE_ID);
    if (
      !handle ||
      !key ||
      bytesToHex(key) !== CASCADIACHAN_PUBLIC_KEY ||
      isLoraSenderBlocked('meshcore', CASCADIACHAN_NODE_ID)
    ) {
      throw new Error('board radio or contact unavailable');
    }
    await meshcoreSendTextMessageWithNotFoundRestore(handle as Connection, key, text, () =>
      addMeshcoreNodeContactToRadio(handle as MeshcoreRoomLoginPathSyncConn, key, {
        long_name: 'CascadiaChan',
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
