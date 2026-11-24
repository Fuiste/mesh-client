import { hexToBytesExactOrThrow } from '@/shared/hexBytes';

import { pubkeyToNodeId } from './meshcoreUtils';

export const CASCADIACHAN_PUBLIC_KEY =
  'e96c285c22edb90b25b6e7b34f1357b4b5cc9ac8d0c79b8606688ca14a162cdf';
export const CASCADIACHAN_NODE_ID = pubkeyToNodeId(
  hexToBytesExactOrThrow(CASCADIACHAN_PUBLIC_KEY, 32),
);
