import { hexToBytesExactOrThrow } from '@/shared/hexBytes';

import { pubkeyToNodeId } from './meshcoreUtils';

export const CASCADIACHAN_PUBLIC_KEY =
  'e96c285c22edb90b25b6e7b34f1357b4b5cc9ac8d0c79b8606688ca14a162cdf';
export const CASCADIACHAN_NODE_ID = pubkeyToNodeId(
  hexToBytesExactOrThrow(CASCADIACHAN_PUBLIC_KEY, 32),
);

/** Companion plaintext DMs identify the authenticated contact by its six-byte prefix. */
export function isCascadiaBoardResponse(
  text: string,
  prefixHex: string,
  senderId: number,
  txtType?: number,
): boolean {
  return (
    (txtType == null || txtType === 0) &&
    senderId === CASCADIACHAN_NODE_ID &&
    prefixHex === CASCADIACHAN_PUBLIC_KEY.slice(0, 12) &&
    /^cc1 [0-9a-f]{12} \d+\/\d+ [A-Za-z0-9_-]+$/.test(text)
  );
}
