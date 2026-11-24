import { expect, it, vi } from 'vitest';

import { CASCADIACHAN_NODE_ID, CASCADIACHAN_PUBLIC_KEY } from './cascadiaBoardIdentity';
import { CASCADIACHAN_CONTACT_CARD, hasBoardContact } from './cascadiaBoardTransport';
import { importMeshcoreQr } from './meshcore/meshcoreQrIngest';

it('enrolls a fresh identity through the board button’s contact importer', async () => {
  const identityId = 'fresh-cascadia-board-identity';
  const saveContact = vi.fn().mockResolvedValue(true);
  expect(hasBoardContact(identityId)).toBe(false);
  const result = await importMeshcoreQr(CASCADIACHAN_CONTACT_CARD, { identityId, saveContact });
  expect(result).toMatchObject({ ok: true, kind: 'contact', nodeId: CASCADIACHAN_NODE_ID });
  expect(saveContact).toHaveBeenCalledWith(
    expect.objectContaining({
      name: 'CascadiaChan',
      publicKeyHex: CASCADIACHAN_PUBLIC_KEY,
      contactType: 1,
    }),
  );
  expect(hasBoardContact(identityId)).toBe(true);
});
