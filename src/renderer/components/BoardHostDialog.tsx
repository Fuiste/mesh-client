import { MessageCircle, Radio } from 'lucide-react-motion';
import { useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useModalFocusTrap } from '../hooks/useModalFocusTrap';
import { type BoardHost, parseBoardHost } from '../lib/cascadiaBoardHosts';
import { Button } from './ui/Button';
import { INPUT_CLASS, SELECT_CLASS } from './ui/formClasses';

interface Props {
  identityId: string;
  connected: boolean;
  radioBusyBy?: string;
  contacts: BoardHost[];
  initial?: BoardHost;
  ensureContact: (host: BoardHost) => Promise<void>;
  checkBoard: (host: BoardHost) => Promise<number>;
  getCachedAt?: (host: BoardHost) => number | null;
  onSave: (host: BoardHost) => void;
  onClose: () => void;
}

export function BoardHostDialog({
  connected,
  radioBusyBy,
  contacts,
  initial,
  ensureContact,
  checkBoard,
  getCachedAt,
  onSave,
  onClose,
}: Props) {
  const { t, i18n } = useTranslation();
  const titleId = useId();
  const modalRef = useRef<HTMLDivElement>(null);
  useModalFocusTrap(modalRef, onClose);
  const [source, setSource] = useState<'contact' | 'link'>(() =>
    initial || contacts.length ? 'contact' : 'link',
  );
  const [key, setKey] = useState(initial?.publicKey ?? '');
  const [link, setLink] = useState('');
  const [name, setName] = useState('');
  const [verified, setVerified] = useState<{ host: BoardHost; count: number } | null>(null);
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const lock = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const contact =
    initial?.publicKey === key ? initial : contacts.find((item) => item.publicKey === key);
  const pick = source === 'contact' ? (contact?.publicKey ?? '') : link.trim();
  let candidate: BoardHost | null = null;
  if (pick) {
    try {
      candidate = parseBoardHost(
        pick,
        source === 'contact' ? (contact?.name ?? '') : name.trim(),
        'cc1',
      );
    } catch {
      // catch-no-log-ok Incomplete pasted contact links are surfaced as field validation.
    }
  }
  const cachedAt = candidate && getCachedAt?.(candidate);
  function reset() {
    setVerified(null);
    setError('');
  }
  async function act(mode: 'check' | 'dm') {
    if (!candidate || lock.current) return;
    const host: BoardHost = { ...candidate, adapterId: mode === 'dm' ? 'dm' : 'cc1' };
    lock.current = true;
    setError('');
    setPending(true);
    try {
      await ensureContact(host);
      if (!mounted.current) return;
      if (mode === 'dm') onSave(host);
      else setVerified({ host, count: await checkBoard(host) });
    } catch (reason) {
      // catch-no-log-ok Show the operator the contact import or board request error in the dialog.
      setError(
        reason instanceof Error && reason.message.startsWith('no board confirmation')
          ? t('boardHosts.noReply', { board: host.name })
          : reason instanceof Error
            ? reason.message
            : t('cascadiaBoard.failed'),
      );
    } finally {
      lock.current = false;
      setPending(false);
    }
  }
  return (
    <div className="bg-app-bg/75 fixed inset-0 z-50 flex items-center justify-center p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        ref={modalRef}
        className="board-host-modal rounded-modal shadow-level-3 border-secondary-dark bg-deep-black flex max-h-[90vh] w-full max-w-md flex-col gap-3 overflow-auto border p-4"
      >
        <h2 id={titleId} className="text-ink-100 text-lg font-semibold">
          {t('boardHosts.add')}
        </h2>
        <div className="border-ink-700 rounded-control flex gap-0.5 self-start border p-0.5">
          <Button
            size="sm"
            variant={source === 'contact' ? 'secondary' : 'ghost'}
            aria-pressed={source === 'contact'}
            disabled={pending}
            onClick={() => {
              reset();
              setSource('contact');
            }}
          >
            {t('boardHosts.contact')}
          </Button>
          <Button
            size="sm"
            variant={source === 'link' ? 'secondary' : 'ghost'}
            aria-pressed={source === 'link'}
            disabled={pending}
            onClick={() => {
              reset();
              setSource('link');
            }}
          >
            {t('boardHosts.link')}
          </Button>
        </div>
        {source === 'contact' ? (
          <label className="text-muted text-label">
            {t('boardHosts.choose')}
            <select
              className={SELECT_CLASS}
              value={key}
              disabled={pending}
              onChange={(e) => {
                reset();
                setKey(e.target.value);
              }}
            >
              <option value="">{t('boardHosts.choose')}</option>
              {initial && !contacts.some((c) => c.publicKey === initial.publicKey) && (
                <option value={initial.publicKey}>
                  {initial.name} · {initial.publicKey.slice(0, 8)}
                </option>
              )}
              {contacts.map((c) => (
                <option key={c.publicKey} value={c.publicKey}>
                  {c.name} · {c.publicKey.slice(0, 8)}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <>
            <label className="text-muted text-label">
              {t('boardHosts.link')}
              <input
                className={INPUT_CLASS}
                value={link}
                disabled={pending}
                onChange={(e) => {
                  reset();
                  setLink(e.target.value);
                }}
              />
            </label>
            <label className="text-muted text-label">
              {t('boardHosts.name')}
              <input
                className={INPUT_CLASS}
                value={name}
                disabled={pending}
                maxLength={64}
                onChange={(e) => {
                  reset();
                  setName(e.target.value);
                }}
              />
            </label>
          </>
        )}
        {pick && !candidate && (
          <p role="alert" className="text-sm text-red-400">
            {t('boardHosts.invalid')}
          </p>
        )}
        {candidate && (
          <div className="text-muted text-label">
            <strong className="text-ink-200">{candidate.name}</strong>
            <p className="font-mono break-all">{candidate.publicKey}</p>
            {cachedAt ? (
              <span>
                {t('boardHosts.cachedAt', {
                  time: new Date(cachedAt * 1000).toLocaleString(i18n.language),
                })}
              </span>
            ) : null}
          </div>
        )}
        <p className="text-muted text-sm">
          {radioBusyBy && !pending
            ? t('boardHosts.waiting', { board: radioBusyBy })
            : connected
              ? t('boardHosts.checkHint')
              : t('cascadiaBoardRadio.connect')}
        </p>
        {pending && (
          <p role="status" className="text-brand-green text-sm">
            {t('common.loading')}
          </p>
        )}
        {error && (
          <p role="alert" className="text-sm text-orange-300">
            {error}
          </p>
        )}
        {verified && (
          <p role="status" className="text-sm text-green-300">
            {t('boardHosts.checked', { board: verified.host.name, n: verified.count })}
          </p>
        )}
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            {t('common.close')}
          </Button>
          {!verified && (
            <Button
              variant="secondary"
              icon={<MessageCircle aria-hidden="true" />}
              disabled={!candidate || pending}
              onClick={() => {
                void act('dm');
              }}
            >
              {t('boardHosts.asChat')}
            </Button>
          )}
          {verified ? (
            <Button
              variant="primary"
              onClick={() => {
                try {
                  onSave(verified.host);
                } catch (reason) {
                  // catch-no-log-ok The operator can correct a changed contact or retry a failed save.
                  setError(reason instanceof Error ? reason.message : t('cascadiaBoard.failed'));
                }
              }}
            >
              {t('boardHosts.add')}
            </Button>
          ) : (
            <Button
              variant="primary"
              icon={<Radio aria-hidden="true" />}
              disabled={!candidate || !connected || pending || Boolean(radioBusyBy)}
              onClick={() => {
                void act('check');
              }}
            >
              {error ? t('common.retry') : t('boardHosts.check')}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
