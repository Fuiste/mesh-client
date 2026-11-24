import { describe, expect, it, vi } from 'vitest';

import { hexToBytesExactOrThrow } from '@/shared/hexBytes';

import { CASCADIACHAN_NODE_ID, CASCADIACHAN_PUBLIC_KEY } from './cascadiaBoardIdentity';
import { CASCADIACHAN_CONTACT_CARD } from './cascadiaBoardTransport';
import { packetRouter } from './drivers/PacketRouter';
import { importMeshcoreQr } from './meshcore/meshcoreQrIngest';
import { decodeMeshcoreDirectMessageEvents } from './meshcoreDirectMessageDecode';
import { processMeshcoreWaitingMessageItem } from './meshcoreProcessWaitingMessageItem';

const prefix = CASCADIACHAN_PUBLIC_KEY.slice(0, 12);
const keys = new Map([[prefix, CASCADIACHAN_NODE_ID]]);
const dm = {
  text: 'cc1 00aabbccddee 1/1 WyJsaXN0IixudWxsLFtdXQ',
  senderTimestamp: 1000,
  pubKeyPrefix: hexToBytesExactOrThrow(prefix, 6),
  txtType: 0,
};

describe('board DM routing', () => {
  it('delivers live encrypted replies to the board and keeps ordinary DMs in chat', async () => {
    await importMeshcoreQr(CASCADIACHAN_CONTACT_CARD, {
      identityId: 'm5',
      saveContact: () => Promise.resolve(true),
    });
    const decode = (input: typeof dm, contacts = keys) =>
      decodeMeshcoreDirectMessageEvents(input, contacts, new Set(), 'm5', [
        hexToBytesExactOrThrow(CASCADIACHAN_PUBLIC_KEY, 32),
      ]);
    expect(decode(dm)).toEqual([
      {
        type: 'meshcore_board_response',
        payload: { text: dm.text, publicKey: CASCADIACHAN_PUBLIC_KEY },
      },
    ]);
    expect(decode({ ...dm, text: 'menu' })[0]?.type).toBe('text_message');
    expect(decode(dm, new Map([[prefix, 123]]))[0]?.type).toBe('text_message');
    expect(
      decode(
        { ...dm, pubKeyPrefix: new Uint8Array(6) },
        new Map([['000000000000', CASCADIACHAN_NODE_ID]]),
      )[0]?.type,
    ).toBe('text_message');
  });

  it('routes queued board frames to the receiving identity without filling the chat history', async () => {
    await importMeshcoreQr(CASCADIACHAN_CONTACT_CARD, {
      identityId: 'm5',
      saveContact: () => Promise.resolve(true),
    });
    const dispatch = vi.spyOn(packetRouter, 'dispatch').mockImplementation(() => {});
    try {
      const result = processMeshcoreWaitingMessageItem(
        { contactMessage: dm },
        {
          workingNodes: new Map(),
          pubKeyPrefixMap: keys,
          myNodeNum: 42,
          meshcoreIdentityId: 'm5',
          storePriorForBatch: () => [],
          logTransportLineAsDevice: () => {},
        },
      );
      expect(dispatch).toHaveBeenCalledWith(
        {
          type: 'meshcore_board_response',
          payload: { text: dm.text, publicKey: CASCADIACHAN_PUBLIC_KEY },
        },
        'm5',
      );
      expect(result.pendingMessages).toEqual([]);
    } finally {
      dispatch.mockRestore();
    }
  });
});
