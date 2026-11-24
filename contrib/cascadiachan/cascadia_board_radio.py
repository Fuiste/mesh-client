"""CascadiaChan v1 direct-message protocol for the public board only."""

import base64
from collections import OrderedDict
from contextlib import closing
from datetime import datetime, timezone
from hashlib import blake2s, sha256
import json
import logging
from pathlib import Path
import re
import secrets
import sqlite3
from threading import Lock
from time import monotonic
import uuid

from cascadia_public_scope import BULLETINS, DISCUSSIONS, configure_public_reads


MAX_REQUEST = 150
MAX_PARTS = 32
CHUNK = 124
HEADER = re.compile(r"!cc1 ([0-9a-f]{12}) (.+)", re.DOTALL)
_CURSORS = OrderedDict()
_LOCK = Lock()
_CURSOR_SECRET = secrets.token_bytes(16)


class BoardError(ValueError):
    pass


def encode(value):
    raw = json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode()
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


def frames(rid, result):
    payload = encode(result)
    if len(payload) > CHUNK * MAX_PARTS:
        payload = encode(["error", "post exceeds radio reading limit; open on lan"])
    chunks = [payload[i:i + CHUNK] for i in range(0, len(payload), CHUNK)]
    return [f"cc1 {rid} {i}/{len(chunks)} {part}" for i, part in enumerate(chunks, 1)]


def _remember(key, value):
    with _LOCK:
        _CURSORS[key] = (monotonic() + 900, value)
        _CURSORS.move_to_end(key)
        while len(_CURSORS) > 128:
            _CURSORS.popitem(last=False)


def _recall(key):
    with _LOCK:
        found = _CURSORS.get(key)
        if found and found[0] >= monotonic():
            return found[1]
        _CURSORS.pop(key, None)
    return None


def _source(op, section):
    if section == "b":
        predicate = " WHERE key = :target" if op == "read" else ""
        return f"WITH {BULLETINS}, records AS (SELECT * FROM bulletins_visible{predicate}) "
    if op == "list":
        return f"WITH {DISCUSSIONS}, records AS (SELECT * FROM discussions) "
    return f"""WITH {DISCUSSIONS}, records AS (
        SELECT cast(id AS text) AS key, sender_short_name AS author,
               stamp AS created_at, content AS body FROM ranked
    ) """


def _keys(db, sql, op, section, args):
    order = ("julianday(updated_at) DESC, key" if op == "list"
             else "julianday(created_at), cast(key AS INTEGER)" if section == "d" else "key")
    rows = db.execute(sql + f"SELECT key FROM records ORDER BY {order} LIMIT 16385", args).fetchall()
    if len(rows) > 16384:
        raise BoardError("too many records for a radio index")
    return tuple(row[0] for row in rows)


def _key(value):
    if not isinstance(value, str) or not 0 < len(value.encode()) <= 100:
        raise BoardError("invalid record key")
    return value


def _section(value):
    if value not in ("d", "b"):
        raise BoardError("unknown board section")
    return value


def _text(value, label):
    if not isinstance(value, str) or not value.strip() or "\x00" in value:
        raise BoardError(f"missing or invalid {label}")
    return value.strip()


def _read(db, sender, rid, cmd, database):
    op, section = cmd[:2]
    _section(section)
    key = _key(cmd[2]) if op == "read" else ""
    cursor = cmd[-1]
    if type(cursor) is not int or not 0 <= cursor < 2**52:
        raise BoardError("invalid page cursor")
    args = {"bulletin": key if op == "read" and section == "b" else None,
            "channel": key if op == "read" and section == "d" else None, "target": key}
    if op == "read":
        visible = (f"WITH {BULLETINS} SELECT 1 FROM bulletins_visible" if section == "b"
                   else f"WITH {DISCUSSIONS} SELECT 1 FROM channels_visible")
        if not db.execute(visible, args).fetchone():
            raise BoardError("board record unavailable")
    sql = _source(op, section)
    scope = (database, sender, op, section, key)
    cache_key = (*scope, cursor or rid)
    snapshot = _recall(cache_key)
    if cursor and snapshot is None:
        raise BoardError("page expired; refresh from the beginning")
    if snapshot is None:
        snapshot = (_keys(db, sql, op, section, args), 0)
        _remember(cache_key, snapshot)
    keys, offset = snapshot
    columns = ("r.key, r.title, r.reply_count, r.updated_at" if op == "list"
               else "r.author, r.created_at, r.body")
    page_size = 4 if op == "list" else 3
    rows = []
    # Fetch in snapshot order. Membership is rechecked on every page so
    # deletes and audience restrictions still take effect mid-read.
    while offset < len(keys) and len(rows) < page_size:
        batch = keys[offset:offset + page_size - len(rows)]
        args["keys"] = json.dumps(batch)
        result = dict(db.execute(sql + f"""
            SELECT r.key, json_array({columns}) FROM records r
            JOIN json_each(:keys) k ON k.value = r.key
        """, args))
        for member in batch:
            if member in result:
                candidate = json.loads(result[member])
                if len(encode([op, 2**48, [*rows, candidate]])) > CHUNK * MAX_PARTS:
                    if not rows:
                        raise BoardError("post exceeds radio reading limit; open on lan")
                    break
                rows.append(candidate)
            offset += 1
        else:
            continue
        break
    nxt = None
    if offset < len(keys):
        # A retransmission has identical continuation bytes. Cursors are
        # scoped to the sending device, operation, section, and record.
        digest = blake2s(json.dumps([scope, rid, cursor, offset]).encode(),
                          key=_CURSOR_SECRET, digest_size=6).digest()
        nxt = int.from_bytes(digest, "big") or 1
        _remember((*scope, nxt), (keys, offset))
    return [op, nxt, rows]


def _write(db, sender, author, origin, rid, cmd, raw, log_op):
    op = cmd[0]
    is_new = op == "new"
    section = _section(cmd[1]) if is_new else "d"
    title = _text(cmd[2], "subject") if is_new else None
    body = _text(cmd[-1], "body")
    if title and (not title.isprintable() or "|" in title):
        raise BoardError("subject cannot contain line breaks or |")
    db.execute("""CREATE TABLE IF NOT EXISTS cascadia_radio_receipts(
        sender TEXT NOT NULL, rid TEXT NOT NULL, request_hash TEXT NOT NULL,
        result TEXT NOT NULL, PRIMARY KEY(sender,rid))""")
    digest = sha256(raw.encode()).hexdigest()
    prior = db.execute("SELECT request_hash,result FROM cascadia_radio_receipts WHERE sender=? AND rid=?",
                       (sender, rid)).fetchone()
    if prior:
        if prior[0] != digest:
            raise BoardError("request id already used for another post")
        return json.loads(prior[1])

    now = datetime.now(timezone.utc)
    stamp = now.isoformat(timespec="microseconds")
    date = now.astimezone().strftime("%Y-%m-%d %H:%M")
    uid = str(uuid.uuid4())
    if section == "b":
        if not db.execute("""SELECT public_board('general') AND NOT EXISTS(
                SELECT 1 FROM board_sync WHERE board='general' AND (audience!='all' OR peers!=''))""").fetchone()[0]:
            raise BoardError("general bulletin board unavailable")
        key = uid
        db.execute("""INSERT INTO bulletins(board,sender_short_name,date,subject,content,unique_id,
            expected_content_length,content_complete,source_node_id,source_timestamp,received_at,author_node_id)
            VALUES('general',?,?,?,?,?,?,1,?,?,?,?)""",
            (author, date, title, body, uid, len(body), origin, stamp, stamp, sender))
        scope = "bulletins"
        payload = {"board": "general", "subject": title, "local_only": 0}
        count = 0
    else:
        if is_new:
            # BACON replicates channels by (name,url). Both fields are shown
            # by handhelds; use an opaque public identifier, never a secret.
            channel = db.execute("INSERT INTO channels(name,url) VALUES(?,?)",
                                 (title, f"cascadia:{uid}")).lastrowid
        else:
            channel = _key(cmd[1])
            found = db.execute(f"WITH {DISCUSSIONS} SELECT id FROM channels_visible",
                               {"channel": channel}).fetchone()
            if not found:
                raise BoardError("discussion unavailable")
            channel = found[0]
        key = str(channel)
        db.execute("""INSERT INTO channel_comments(channel_id,sender_short_name,date,content,unique_id,
            expected_content_length,content_complete,source_node_id,source_timestamp,received_at,author_node_id)
            VALUES(?,?,?,?,?,?,1,?,?,?,?)""",
            (channel, author, date, body, uid, len(body), origin, stamp, stamp, sender))
        scope = "channel_comments"
        payload = {"channel_id": channel}
        count = db.execute(f"WITH {DISCUSSIONS} SELECT reply_count FROM discussions",
                           {"channel": channel}).fetchone()[0]
    payload.update(sender_short_name=author, date=date)
    if origin and log_op:
        log_op(db.cursor(), origin_node_id=origin, event_type="upsert", scope=scope,
               target_uid=uid, payload=payload, created_at=stamp)
    response = ["saved", section, key, author, stamp, count]
    db.execute("INSERT INTO cascadia_radio_receipts VALUES(?,?,?,?)",
               (sender, rid, digest, json.dumps(response)))
    return response


def answer(message, *, sender, author, origin, db_path, config_path, log_op=None):
    match = HEADER.fullmatch(message)
    if not match:
        return []
    rid, raw = match.groups()
    try:
        if len(message.encode()) > MAX_REQUEST:
            raise BoardError("request exceeds 150 radio bytes")
        if not sender:
            raise BoardError("radio identity unavailable")
        cmd = json.loads(raw)
        if not isinstance(cmd, list) or not cmd or type(cmd[0]) is not str:
            raise BoardError("invalid board request")
        op = cmd[0]
        if len(cmd) != {"list":3, "read":4, "new":4, "reply":3}.get(op):
            raise BoardError("invalid board operation")
        writing = op in ("new", "reply")
        uri = Path(db_path).resolve().as_uri() + ("?mode=rw" if writing else "?mode=ro")
        with closing(sqlite3.connect(uri, uri=True, timeout=3)) as db:
            configure_public_reads(db, config_path)
            with db:
                db.execute("BEGIN IMMEDIATE" if writing else "BEGIN")
                if writing:
                    result = _write(db, sender, author, origin, rid, cmd, raw, log_op)
                else:
                    result = _read(db, sender, rid, cmd, uri)
    except (BoardError, json.JSONDecodeError) as exc:
        result = ["error", str(exc) if isinstance(exc, BoardError) else "invalid board request"]
    except Exception:
        logging.exception("CascadiaChan board operation failed")
        result = ["error", "board temporarily unavailable; retry this request"]
    return frames(rid, result)


def _send_response(replies, peer, interface):
    from relay_ack import RecipientNoAck
    from utils import send_one_chunk

    retries_left = 3
    probing = False
    for index, reply in enumerate(replies, start=1):
        attempts = 2 if retries_left and not probing else 1
        for attempt in range(attempts):
            if attempt:
                retries_left -= 1
                logging.info("CascadiaChan retrying fragment %s/%s", index, len(replies))
            try:
                # Keep every attempt under BACON's pacing and send lock, and
                # retain the full peer key and exact numbered frame on retries.
                send_one_chunk(reply, peer, interface)
            except RecipientNoAck:
                continue
            except Exception:
                logging.exception("CascadiaChan radio reply interrupted")
                return
            probing = False
            break
        else:
            logging.warning("CascadiaChan fragment %s/%s unacknowledged", index, len(replies))
            if probing:
                return
            # ACK loss doesn't imply data loss. Try the next numbered frame
            # once, resuming normal delivery only if its ACK gets through.
            probing = True


def handle_radio_board(message, sender_node_id, interface):
    from db_operations import get_config_path, get_database_path, get_local_node_id
    from op_log import append_local_event, is_op_log_enabled
    from utils import resolve_display_name

    # With only the six-byte MeshCore prefix, a retry after an advert would
    # have a different idempotency key. Wait for a resolved contact for writes.
    if not isinstance(sender_node_id, str) or not re.fullmatch(r"[a-fA-F0-9]{12,64}", sender_node_id):
        return
    peer = sender_node_id.lower()
    replies = answer(message, sender=peer if len(peer) == 64 else None,
                     author=resolve_display_name(sender_node_id, interface) or "unknown",
                     origin=get_local_node_id(), db_path=get_database_path(), config_path=get_config_path(),
                     log_op=append_local_event if is_op_log_enabled() else None)
    _send_response(replies, peer, interface)
