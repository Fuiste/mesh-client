import { Copy, Ellipsis, MessageCircle, Plus, Server, X } from 'lucide-react-motion';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import {
  boardContactCard,
  type BoardHost,
  boardNodeId,
  boardSessionKey,
  loadActiveBoardKey,
  loadBoardHosts,
  removeBoardHost,
  saveActiveBoardKey,
  saveBoardHost,
} from '../lib/cascadiaBoardHosts';
import {
  attachBoardSessions,
  boardAddressConflict,
  getBoardClient,
  hasBoardContact,
} from '../lib/cascadiaBoardTransport';
import { resolveMeshcoreDestinationPubKeyHexSync } from '../lib/meshcore/meshcoreDestinationPubKey';
import { writeClipboardText } from '../lib/writeClipboardText';
import { useIdentityStore } from '../stores/identityStore';
import { useNodeStore } from '../stores/nodeStore';
import { BoardHostDialog } from './BoardHostDialog';
import { CascadiaBoardView } from './CascadiaBoardView';
import { Button } from './ui/Button';
import { SELECT_BOX_CLASS } from './ui/formClasses';
import { MenuButton } from './ui/Menu';

interface Props {
  identityId: string | null;
  connected: boolean;
  radioLabel: string;
  importContact?: (text: string) => Promise<{ ok: boolean }>;
  onOpenDm: (nodeId: number) => void;
  onOpenConnection: () => void;
}

export default function CascadiaBoardPanel(props: Props) {
  return <IdentityBoards key={props.identityId ?? 'unpaired'} {...props} />;
}
function IdentityBoards({
  identityId,
  connected,
  radioLabel,
  importContact,
  onOpenDm,
  onOpenConnection,
}: Props) {
  const { t } = useTranslation();
  const identity = identityId ?? 'unpaired';
  const [savedHosts, setHosts] = useState(() => loadBoardHosts(identity));
  const nodes = useNodeStore((state) => (identityId ? state.nodes[identityId] : undefined));
  // The radio can restore the contact used for legacy migration after the panel first mounts.
  const hosts = !savedHosts.length && nodes ? loadBoardHosts(identity) : savedHosts;
  const [activeKey, setActiveKey] = useState(() => loadActiveBoardKey(identity));
  const active = hosts.find((host) => host.publicKey === activeKey) ?? hosts[0];
  const [visited, setVisited] = useState(() => new Set(active ? [active.publicKey] : []));
  const [dialog, setDialog] = useState(false);
  const [busyHost, setBusyHost] = useState<BoardHost | null>(null);
  const [importing, setImporting] = useState<string | null>(null);
  const [issue, setIssue] = useState<{ key: string; message: string; success?: boolean } | null>(
    null,
  );
  const self = useIdentityStore((state) =>
    identityId ? state.identities[identityId]?.selfNodeNum : undefined,
  );
  const contacts = useMemo(() => {
    const result: BoardHost[] = [];
    for (const node of Object.values(nodes ?? {})) {
      if (
        node.onRadio === false ||
        node.nodeId === self ||
        (!node.publicKey && !node.publicKeyHex) ||
        /repeater|room server/i.test(node.hwModel ?? '')
      )
        continue;
      const publicKey = resolveMeshcoreDestinationPubKeyHexSync(node.nodeId, {
        storePublicKey: node.publicKey,
        storePublicKeyHex: node.publicKeyHex,
      });
      if (publicKey)
        result.push({
          publicKey,
          name: node.longName || node.shortName || publicKey.slice(0, 12),
          adapterId: 'dm',
        });
    }
    return result.sort((a, b) => a.name.localeCompare(b.name));
  }, [nodes, self]);
  useEffect(() => {
    if (identityId) return attachBoardSessions(identityId);
  }, [identityId]);

  function select(host: BoardHost) {
    setIssue(null);
    setActiveKey(host.publicKey);
    saveActiveBoardKey(identity, host.publicKey);
    setVisited((previous) => {
      const next = new Set(previous).add(host.publicKey);
      if (active) next.add(active.publicKey);
      return next;
    });
  }
  async function ensureContact(host: BoardHost) {
    if (identityId && boardAddressConflict(identityId, host))
      throw new Error(t('boardHosts.conflict'));
    if (identityId && hasBoardContact(identityId, host)) return;
    if (!identityId || !importContact || !(await importContact(boardContactCard(host))).ok) {
      throw new Error(t('cascadiaBoardRadio.failed'));
    }
  }
  async function importActive(host: BoardHost) {
    setImporting(host.publicKey);
    setIssue(null);
    try {
      await ensureContact(host);
    } catch (cause) {
      // catch-no-log-ok The enrollment control shows the operator the import failure.
      setIssue({
        key: host.publicKey,
        message: cause instanceof Error ? cause.message : t('cascadiaBoardRadio.failed'),
      });
    } finally {
      setImporting(null);
    }
  }
  function save(host: BoardHost) {
    const problem = contactProblem(host);
    if (problem) throw new Error(problem);
    const existing = hosts.find((saved) => saved.publicKey === host.publicKey);
    const saved = saveBoardHost(
      identity,
      existing?.adapterId === 'cc1' && host.adapterId === 'dm' ? existing : host,
    );
    setHosts(loadBoardHosts(identity));
    select(saved);
    setDialog(false);
    if (host.adapterId === 'dm') openChat(host);
  }
  function contactProblem(host: BoardHost) {
    if (identityId && boardAddressConflict(identityId, host)) return t('boardHosts.conflict');
    return identityId && hasBoardContact(identityId, host) ? '' : t('cascadiaBoardRadio.missing');
  }
  async function copyLink(host: BoardHost) {
    try {
      await writeClipboardText(boardContactCard(host));
      setIssue({ key: host.publicKey, message: t('common.copied'), success: true });
    } catch {
      // catch-no-log-ok Clipboard failure is shown beside this host's controls.
      setIssue({ key: host.publicKey, message: t('common.copyFailed') });
    }
  }
  function openChat(host: BoardHost) {
    const problem = contactProblem(host);
    if (problem) {
      setIssue({ key: host.publicKey, message: problem });
      return;
    }
    onOpenDm(boardNodeId(host));
  }
  function name(host: BoardHost) {
    return hosts.some((other) => other.publicKey !== host.publicKey && other.name === host.name)
      ? host.name + ' · ' + host.publicKey.slice(0, 12)
      : host.name;
  }
  const contactReady = Boolean(active && identityId && hasBoardContact(identityId, active));
  return (
    <div className="boards-workspace">
      <div className="boards-hostbar">
        {active && (
          <label className="text-ink-200 text-sm font-medium">
            <Server aria-hidden="true" />
            {t('boardHosts.board')}
            <select
              className={SELECT_BOX_CLASS}
              value={active?.publicKey ?? ''}
              onChange={(event) => {
                const host = hosts.find((item) => item.publicKey === event.target.value);
                if (host) select(host);
              }}
            >
              {hosts.map((host) => (
                <option value={host.publicKey} key={host.publicKey}>
                  {name(host)}
                </option>
              ))}
            </select>
          </label>
        )}
        {active && (
          <Button
            icon={<Plus aria-hidden="true" />}
            size="sm"
            disabled={!identityId}
            onClick={() => {
              setDialog(true);
            }}
          >
            {t('boardHosts.add')}
          </Button>
        )}
        {active && (
          <MenuButton
            icon={<Ellipsis aria-hidden="true" />}
            size="sm"
            aria-label={t('boardHosts.actions')}
            menuLabel={t('boardHosts.actions')}
            entries={[
              {
                id: 'share',
                label: t('boardHosts.copyLink'),
                icon: <Copy aria-hidden="true" />,
                onSelect: () => {
                  void copyLink(active);
                },
              },
              {
                id: 'chat',
                label: t('boardHosts.openChat'),
                icon: <MessageCircle aria-hidden="true" />,
                disabled: !contactReady,
                onSelect: () => {
                  openChat(active);
                },
              },
              {
                id: 'remove',
                label: t('boardHosts.remove'),
                description: t('boardHosts.kept'),
                icon: <X aria-hidden="true" />,
                onSelect: () => {
                  removeBoardHost(identity, active.publicKey);
                  const remaining = loadBoardHosts(identity);
                  setHosts(remaining);
                  if (remaining[0]) select(remaining[0]);
                  else setActiveKey(null);
                },
              },
            ]}
          />
        )}
      </div>
      {!active && (
        <section className="bg-deep-black rounded-card border-ink-800 flex flex-col items-start gap-3 border p-4">
          <h2 className="text-ink-100 text-title font-semibold">{t('boardHosts.empty')}</h2>
          <p className="text-muted text-sm">
            {identityId ? t('boardHosts.first') : t('cascadiaBoardRadio.connect')}
          </p>
          {identityId ? (
            <Button
              variant="primary"
              icon={<Plus aria-hidden="true" />}
              onClick={() => {
                setDialog(true);
              }}
            >
              {t('boardHosts.add')}
            </Button>
          ) : (
            <Button variant="primary" onClick={onOpenConnection}>
              {t('boardHosts.connect')}
            </Button>
          )}
        </section>
      )}
      {active && identityId && !contactReady && importContact && (
        <div className="boards-contact-notice text-muted text-xs">
          <Button
            size="sm"
            disabled={importing !== null}
            onClick={() => {
              void importActive(active);
            }}
          >
            {t('cascadiaBoardRadio.add')}
          </Button>
          <span role="status">
            {boardAddressConflict(identityId, active)
              ? t('boardHosts.conflict')
              : t('cascadiaBoardRadio.advert')}
          </span>
        </div>
      )}
      {active && issue?.key === active.publicKey && (
        <p
          role={issue.success ? 'status' : 'alert'}
          className={issue.success ? 'text-muted text-sm' : 'text-sm text-red-400'}
        >
          {issue.message}
        </p>
      )}
      {active?.adapterId === 'dm' && (
        <section className="bg-deep-black border-ink-800 rounded-card flex flex-col items-start gap-3 border p-4">
          <h2 className="text-ink-100 text-title font-semibold">{name(active)}</h2>
          <p className="text-muted text-sm">{t('boardHosts.chatHint')}</p>
          <Button
            variant="primary"
            icon={<MessageCircle aria-hidden="true" />}
            disabled={!contactReady}
            onClick={() => {
              openChat(active);
            }}
          >
            {t('boardHosts.openChat')}
          </Button>
        </section>
      )}
      {hosts
        .filter(
          (host) =>
            host.adapterId === 'cc1' &&
            (host.publicKey === active?.publicKey || visited.has(host.publicKey)),
        )
        .map((host) => {
          const ready = Boolean(identityId && hasBoardContact(identityId, host));
          return (
            <div
              className="boards-session"
              key={boardSessionKey(identity, host)}
              hidden={active?.publicKey !== host.publicKey}
            >
              <CascadiaBoardView
                boardName={name(host)}
                onBusyChange={(busy) => {
                  setBusyHost(busy ? host : null);
                }}
                radioBusyBy={busyHost ? name(busyHost) : undefined}
                client={getBoardClient(identity, host)}
                radioLabel={radioLabel}
                online={connected && ready}
                offlineReason={
                  !connected
                    ? t('cascadiaBoardRadio.connect')
                    : !ready
                      ? t('cascadiaBoardRadio.missing')
                      : undefined
                }
              />
            </div>
          );
        })}
      {dialog && identityId && (
        <BoardHostDialog
          identityId={identityId}
          contacts={contacts}
          connected={connected}
          radioBusyBy={busyHost ? name(busyHost) : undefined}
          ensureContact={ensureContact}
          onSave={save}
          onClose={() => {
            setDialog(false);
          }}
          getCachedAt={(host) =>
            getBoardClient(identityId, host).getSnapshot().indexFetchedAt.discussion ?? null
          }
          checkBoard={async (host) => {
            const client = getBoardClient(identityId, host);
            setBusyHost(host);
            try {
              await client.refresh('discussion');
              return client.getSnapshot().entries.filter((entry) => entry.kind === 'discussion')
                .length;
            } finally {
              setBusyHost(null);
            }
          }}
        />
      )}
    </div>
  );
}
