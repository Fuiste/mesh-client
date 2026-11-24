import './CascadiaBoardView.css';

import { ChevronLeft, Plus, Radio, RefreshCw, Reply, Trees } from 'lucide-react-motion';
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';

import {
  BOARD_FRAME_BYTES,
  type BoardClient,
  type BoardKind,
  type BoardPost,
  boardPostBytes,
  validateBoardPost,
} from '../lib/cascadiaBoard';
import { INPUT_CLASS, TEXTAREA_CLASS } from './ui/formClasses';
import { StatusDot } from './ui/StatusDot';

export interface CascadiaBoardViewProps {
  client: Pick<BoardClient, 'subscribe' | 'getSnapshot' | 'refresh' | 'read' | 'reply' | 'create'>;
  online: boolean;
  radioLabel: string;
  offlineReason?: string;
}

interface Draft {
  subject: string;
  body: string;
}
type Action = 'index' | 'read' | 'write';

function BoardTime({ seconds }: { seconds: number }) {
  const { i18n } = useTranslation();
  if (!seconds) return null;
  const date = new Date(seconds * 1000);
  const sameDay = date.toDateString() === new Date().toDateString();
  return (
    <time dateTime={date.toISOString()} title={date.toLocaleString(i18n.language)}>
      {sameDay
        ? date.toLocaleTimeString(i18n.language, { hour: '2-digit', minute: '2-digit' })
        : date.toLocaleDateString(i18n.language, {
            month: 'short',
            day: 'numeric',
            year: 'numeric',
          })}
    </time>
  );
}

function BoardMessage({ post, label }: { post: BoardPost; label: string }) {
  const { t } = useTranslation();
  return (
    <article className="board-message">
      <header className="board-meta">
        <span className="board-post-number">{label}</span>
        <strong>{post.author}</strong>
        <BoardTime seconds={post.createdAt} />
      </header>
      <p>{post.body}</p>
      {post.saved && <span className="board-saved">{t('cascadiaBoard.saved')}</span>}
    </article>
  );
}

function BoardComposer({
  kind,
  id,
  initial,
  pending,
  online,
  onDraft,
  onCancel,
  onSend,
}: {
  kind: BoardKind;
  id?: string;
  initial: Draft;
  pending: boolean;
  online: boolean;
  onDraft: (draft: Draft) => void;
  onCancel: () => void;
  onSend: (draft: Draft) => void;
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState(initial);
  const formRef = useRef<HTMLFormElement>(null);
  useEffect(() => {
    formRef.current?.querySelector<HTMLElement>('input,textarea')?.focus();
  }, []);
  const subject = id === undefined ? draft.subject.trim() : null;
  const body = draft.body.trim();
  const bytes = boardPostBytes(kind, subject, body, id);
  const validFields = Boolean(body && (id !== undefined || subject));
  const validation = validFields ? validateBoardPost(kind, subject, body, id) : null;
  const canPost = online && !pending && validFields && !validation;
  return (
    <form
      ref={formRef}
      className="board-composer"
      onBlur={() => {
        onDraft(draft);
      }}
      onSubmit={(event) => {
        event.preventDefault();
        if (canPost) onSend({ subject: subject ?? '', body });
      }}
    >
      {id === undefined && (
        <label>
          {t('cascadiaBoard.subject')}
          <input
            className={INPUT_CLASS}
            value={draft.subject}
            required
            onChange={(event) => {
              setDraft({ ...draft, subject: event.target.value });
            }}
            disabled={pending}
          />
        </label>
      )}
      <label>
        {id === undefined ? t('cascadiaBoard.message') : t('cascadiaBoard.yourReply')}
        <textarea
          className={TEXTAREA_CLASS}
          value={draft.body}
          required
          rows={3}
          onChange={(event) => {
            setDraft({ ...draft, body: event.target.value });
          }}
          disabled={pending}
        />
      </label>
      {validation && <p className="board-error">{validation}</p>}
      <div className="board-actions">
        <span className="board-budget">
          {t('cascadiaBoard.bytes', { used: bytes, limit: BOARD_FRAME_BYTES })}
        </span>
        <button
          type="button"
          className="board-command"
          disabled={pending}
          onClick={() => {
            onDraft(draft);
            onCancel();
          }}
        >
          {t('common.cancel')}
        </button>
        <button type="submit" className="board-primary" disabled={!canPost}>
          {id !== undefined
            ? t('cascadiaBoard.postReply')
            : kind === 'discussion'
              ? t('cascadiaBoard.postThread')
              : t('cascadiaBoard.postBulletin')}
        </button>
      </div>
    </form>
  );
}

export function CascadiaBoardView({
  client,
  online,
  radioLabel,
  offlineReason,
}: CascadiaBoardViewProps) {
  const { t } = useTranslation();
  const snapshot = useSyncExternalStore(client.subscribe, client.getSnapshot);
  const [kind, setKind] = useState<BoardKind>('discussion');
  const [selection, setSelection] = useState<string | null>(null);
  const [pane, setPane] = useState<'list' | 'read'>('list');
  const [compose, setCompose] = useState<'new' | 'reply' | null>(null);
  const [pending, setPending] = useState<Action | null>(null);
  const busy = useRef(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [drafts, setDrafts] = useState<ReadonlyMap<string, Draft>>(() => new Map());
  const entries = useMemo(
    () => snapshot.entries.filter((item) => item.kind === kind),
    [snapshot.entries, kind],
  );
  const selected =
    entries.find((item) => item.id === selection) ?? (compose === 'reply' ? undefined : entries[0]);
  const posts = selected ? snapshot.posts[selected.id] : undefined;
  const morePosts = selected && snapshot.morePosts[selected.id];
  const thread = kind === 'discussion';
  const title = thread ? t('cascadiaBoard.threads') : t('cascadiaBoard.notices');
  const newLabel = thread ? t('cascadiaBoard.newThread') : t('cascadiaBoard.newBulletin');
  const draftKey = compose === 'new' ? `new:${kind}` : `reply:${selected?.id ?? ''}`;
  const canSend = online && pending === null;

  function rememberDraft(draft: Draft) {
    setDrafts((previous) => new Map(previous).set(draftKey, draft));
  }
  function navigate(nextKind: BoardKind, id: string | null, nextPane: 'read' | 'list') {
    setKind(nextKind);
    setSelection(id);
    setPane(nextPane);
    setCompose(null);
    setNotice('');
    setError('');
  }
  async function run(action: Action, work: () => Promise<unknown>, done: string) {
    if (busy.current || !online) return;
    busy.current = true;
    setPending(action);
    setNotice('');
    setError('');
    try {
      await work();
      setNotice(done);
    } catch (cause) {
      // catch-no-log-ok The board displays the radio operation's error to its sender.
      setError(cause instanceof Error ? cause.message : t('cascadiaBoard.failed'));
    } finally {
      busy.current = false;
      setPending(null);
    }
  }
  function fetchIndex(more = false) {
    void run('index', () => client.refresh(kind, more), t('cascadiaBoard.indexUpdated'));
  }
  function fetchPosts(more = false) {
    if (selected)
      void run('read', () => client.read(selected.id, more), t('cascadiaBoard.postsCached'));
  }
  function publish(draft: Draft) {
    if (compose !== 'new' && !selected) return;
    void run(
      'write',
      async () => {
        if (compose === 'new') {
          const id = await client.create(kind, draft.subject, draft.body);
          setSelection(id);
        } else if (selected) {
          await client.reply(selected.id, draft.body);
        }
        setDrafts((previous) => {
          const next = new Map(previous);
          next.delete(draftKey);
          return next;
        });
        setCompose(null);
        setPane('read');
      },
      t('cascadiaBoard.saved'),
    );
  }
  const progress =
    pending === 'write'
      ? t('cascadiaBoard.confirming')
      : pending === 'read'
        ? t('cascadiaBoard.requestingPosts')
        : pending === 'index'
          ? t('cascadiaBoard.requestingIndex')
          : '';
  const stationStatus =
    error ||
    progress ||
    (!online && (offlineReason || t('cascadiaBoard.offline'))) ||
    notice ||
    (snapshot.indexFetchedAt[kind] ? t('cascadiaBoard.cachedIndex') : t('cascadiaBoard.noIndex'));
  return (
    <section
      className="cascadia-board"
      data-pane={pane}
      aria-label={t('chatPanel.cascadiaChan.name')}
    >
      <header className="board-banner">
        <div className="board-brand">
          <Trees aria-hidden="true" />
          <h1 aria-label={t('chatPanel.cascadiaChan.name')}>
            cascadia<em>chan</em>
          </h1>
        </div>
        <span className="board-station">
          ayanami <span>/ m7</span>
        </span>
      </header>
      <div className="board-toolbar">
        <nav aria-label={t('cascadiaBoard.sections')}>
          <button
            type="button"
            aria-pressed={thread}
            disabled={pending !== null}
            onClick={() => {
              navigate('discussion', null, 'list');
            }}
          >
            {t('chatPanel.cascadiaChan.discussions')}
          </button>
          <button
            type="button"
            aria-pressed={!thread}
            disabled={pending !== null}
            onClick={() => {
              navigate('bulletin', null, 'list');
            }}
          >
            {t('chatPanel.cascadiaChan.bulletins')}
          </button>
        </nav>
        <button
          type="button"
          className="board-command"
          disabled={!canSend}
          onClick={() => {
            fetchIndex();
          }}
        >
          <RefreshCw aria-hidden="true" />
          {t('cascadiaBoard.refreshIndex')}
        </button>
      </div>
      <div className="board-split">
        <section className="board-index" aria-label={title}>
          <div className="board-index-head">
            <h2>{title}</h2>
            <button
              type="button"
              className="board-command"
              disabled={pending !== null}
              onClick={() => {
                setCompose('new');
                setPane('read');
                setError('');
                setNotice('');
              }}
            >
              <Plus aria-hidden="true" />
              {newLabel}
            </button>
          </div>
          {entries.map((item) => (
            <button
              type="button"
              key={item.id}
              className="board-row"
              aria-pressed={compose !== 'new' && selected?.id === item.id}
              disabled={pending !== null}
              onClick={() => {
                navigate(kind, item.id, 'read');
              }}
            >
              <strong>{item.subject}</strong>
              <small>
                {thread && <span>{t('cascadiaBoard.replies', { count: item.replyCount })}</span>}
                {!thread && item.author && <span>{item.author}</span>}
                <BoardTime seconds={item.updatedAt} />
                {!snapshot.posts[item.id] && <span>{t('cascadiaBoard.onRadio')}</span>}
              </small>
            </button>
          ))}
          {!entries.length && (
            <p className="board-hint">
              {snapshot.indexFetchedAt[kind]
                ? t('cascadiaBoard.emptyIndex')
                : t('cascadiaBoard.firstRefresh')}
            </p>
          )}
          {snapshot.moreEntries[kind] && (
            <button
              type="button"
              className="board-command board-pager"
              disabled={!canSend}
              onClick={() => {
                fetchIndex(true);
              }}
            >
              {t('cascadiaBoard.moreEntries')}
            </button>
          )}
        </section>
        <section className="board-reader" aria-label={t('cascadiaBoard.reader')}>
          <button
            type="button"
            className="board-back board-command"
            disabled={pending !== null}
            onClick={() => {
              navigate(kind, selected?.id ?? null, 'list');
            }}
          >
            <ChevronLeft aria-hidden="true" />
            {title}
          </button>
          {(selected || compose === 'new') && (
            <div className="board-path">
              <span>{thread ? '/discussions/' : '/general/'}</span>
              {compose !== 'new' && (
                <span>{posts ? t('cascadiaBoard.cached') : t('cascadiaBoard.indexOnly')}</span>
              )}
            </div>
          )}
          {compose === 'new' ? (
            <h2>{newLabel}</h2>
          ) : selected ? (
            <>
              <h2>{selected.subject}</h2>
              {posts ? (
                <>
                  {posts[0] && (
                    <BoardMessage
                      post={posts[0]}
                      label={thread ? t('cascadiaBoard.op') : t('cascadiaBoard.bulletin')}
                    />
                  )}
                  {!posts.length && <p className="board-hint">{t('cascadiaBoard.emptyPosts')}</p>}
                  {thread && posts.length > 0 && (
                    <h3 className="board-count">
                      {t('cascadiaBoard.replies', { count: selected.replyCount })}
                    </h3>
                  )}
                  {posts.slice(1).map((post, index) => (
                    <BoardMessage
                      key={index}
                      post={post}
                      label={t('cascadiaBoard.replyNumber', { n: index + 1 })}
                    />
                  ))}
                  {!compose && (
                    <div className="board-actions">
                      <button
                        type="button"
                        className="board-command"
                        disabled={!canSend}
                        onClick={() => {
                          fetchPosts(Boolean(morePosts));
                        }}
                      >
                        {morePosts ? t('cascadiaBoard.morePosts') : t('cascadiaBoard.refreshPosts')}
                      </button>
                      {thread && (
                        <button
                          type="button"
                          className="board-primary"
                          disabled={pending !== null}
                          onClick={() => {
                            setSelection(selected.id);
                            setCompose('reply');
                            setError('');
                            setNotice('');
                          }}
                        >
                          <Reply aria-hidden="true" />
                          {t('cascadiaBoard.reply')}
                        </button>
                      )}
                    </div>
                  )}
                </>
              ) : (
                <>
                  <p className="board-hint">{t('cascadiaBoard.fetchHint')}</p>
                  <button
                    type="button"
                    className="board-primary"
                    disabled={!canSend}
                    onClick={() => {
                      fetchPosts();
                    }}
                  >
                    <Radio aria-hidden="true" />
                    {thread ? t('cascadiaBoard.fetchThread') : t('cascadiaBoard.fetchBulletin')}
                  </button>
                </>
              )}
            </>
          ) : (
            <p className="board-hint">{t('cascadiaBoard.selectThread')}</p>
          )}
          {(compose === 'new' || (compose === 'reply' && selected)) && (
            <BoardComposer
              key={draftKey}
              kind={kind}
              id={compose === 'new' ? undefined : selected?.id}
              initial={drafts.get(draftKey) ?? { subject: '', body: '' }}
              pending={pending !== null}
              online={online}
              onDraft={rememberDraft}
              onCancel={() => {
                setCompose(null);
              }}
              onSend={publish}
            />
          )}
        </section>
      </div>
      <footer className="board-status">
        <span>
          <StatusDot tone={online ? 'ok' : 'off'} />
          {radioLabel}
        </span>
        <span role="status" aria-live="polite" className={error ? 'board-error' : undefined}>
          {stationStatus}
        </span>
      </footer>
    </section>
  );
}
