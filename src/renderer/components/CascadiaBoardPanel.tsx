import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { createBoardClient } from '../lib/cascadiaBoard';
import { CASCADIACHAN_NODE_ID } from '../lib/cascadiaBoardIdentity';
import {
  CASCADIACHAN_CONTACT_CARD,
  hasBoardContact,
  sendBoardDm,
} from '../lib/cascadiaBoardTransport';
import { attachTypedPacketListener } from '../lib/drivers/attachTypedPacketListener';
import { isLoraSenderBlocked } from '../lib/loraBlocklist';
import { useNodeStore } from '../stores/nodeStore';
import { CascadiaBoardView } from './CascadiaBoardView';

interface Props {
  identityId: string | null;
  connected: boolean;
  radioLabel: string;
  importContact?: (text: string) => Promise<{ ok: boolean }>;
}

export default function CascadiaBoardPanel({
  identityId,
  connected,
  radioLabel,
  importContact,
}: Props) {
  const { t } = useTranslation();
  const [enrolling, setEnrolling] = useState(false);
  const [importFailed, setImportFailed] = useState(false);
  const hasContact = useNodeStore(() => !!identityId && hasBoardContact(identityId));
  const client = useMemo(
    () =>
      createBoardClient({
        identityId: identityId ?? 'unpaired',
        sendDm: (text) =>
          identityId
            ? sendBoardDm(identityId, text)
            : Promise.reject(new Error('radio unavailable')),
      }),
    [identityId],
  );
  useEffect(() => {
    if (!identityId) return;
    const unsubscribe = attachTypedPacketListener(
      identityId,
      'meshcore_board_response',
      ({ text }) => {
        if (hasBoardContact(identityId) && !isLoraSenderBlocked('meshcore', CASCADIACHAN_NODE_ID))
          client.accept(text);
      },
    );
    return () => {
      unsubscribe();
      client.cancelPending();
    };
  }, [client, identityId]);
  // A companion can queue replies while BLE reconnects. Keep the request alive until
  // its radio deadline, or until this identity is replaced and the listener detaches.

  async function enroll() {
    if (!importContact || enrolling) return;
    setEnrolling(true);
    setImportFailed(false);
    try {
      const result = await importContact(CASCADIACHAN_CONTACT_CARD);
      setImportFailed(!result.ok);
    } catch {
      // catch-no-log-ok The contact enrollment control displays the failure and offers another attempt.
      setImportFailed(true);
    } finally {
      setEnrolling(false);
    }
  }

  return (
    <>
      {identityId && !hasContact && importContact && (
        <div className="border-ink-700 mb-2 flex flex-wrap items-center gap-2 rounded border p-2">
          <button
            type="button"
            className="bg-secondary-dark rounded px-3 py-2"
            disabled={enrolling}
            onClick={() => void enroll()}
          >
            {t('cascadiaBoardRadio.add')}
          </button>
          <span role="status">
            {t(importFailed ? 'cascadiaBoardRadio.failed' : 'cascadiaBoardRadio.advert')}
          </span>
        </div>
      )}
      <CascadiaBoardView
        client={client}
        online={connected && hasContact}
        radioLabel={radioLabel}
        offlineReason={
          !connected
            ? t('cascadiaBoardRadio.connect')
            : !hasContact
              ? t('cascadiaBoardRadio.missing')
              : undefined
        }
      />
    </>
  );
}
