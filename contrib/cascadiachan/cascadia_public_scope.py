"""Visibility filters shared by CascadiaChan radio reads and writes."""

import base64
import configparser
from pathlib import Path


def _channel_key(name, url):
    # BACON's channel deletion marker uses both fields. The URL can be a radio
    # passphrase and must never leave this lookup or become a public permalink.
    encoded = f"{name}\x1f{url}".encode("utf-8")
    return base64.urlsafe_b64encode(encoded).rstrip(b"=").decode("ascii")


# Channel entries have neither a creator nor a creation date. Their oldest
# visible comment is the opening post and the most recent one bumps the thread.
DISCUSSIONS = """
    channels_visible AS (
        SELECT c.id, c.name
        FROM channels c
        WHERE c.local_only = 0 AND c.sync_peers = ''
          AND (:channel IS NULL OR c.id = :channel)
          AND NOT EXISTS (
              SELECT 1 FROM deleted_sync_tombstones t
              WHERE t.tombstone_key = 'channels:' || channel_key(c.name, c.url))
    ),
    comments_visible AS (
        SELECT r.id, r.unique_id, r.channel_id, r.sender_short_name, r.content,
               coalesce(nullif(r.source_timestamp, ''), nullif(r.date, ''), r.received_at, '') AS stamp
        FROM channel_comments r JOIN channels_visible c ON c.id = r.channel_id
        WHERE r.content_complete = 1
          AND (r.expected_content_length IS NULL OR length(r.content) >= r.expected_content_length)
          AND NOT EXISTS (
              SELECT 1 FROM deleted_sync_tombstones t
              WHERE t.tombstone_key = 'channels:comment:' || r.unique_id)
    ),
    ranked AS (
        SELECT r.*,
               row_number() OVER w AS seq,
               count(*) OVER (PARTITION BY channel_id) AS n,
               last_value(stamp) OVER (
                   PARTITION BY channel_id ORDER BY julianday(stamp), id
                   ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING
               ) AS bumped
        FROM comments_visible r
        WINDOW w AS (PARTITION BY channel_id ORDER BY julianday(stamp), id)
    ),
    discussions AS (
        SELECT 'discussion' AS kind, cast(c.id AS text) AS key, c.name AS board, c.name AS title,
               coalesce(r.sender_short_name, '') AS author, coalesce(r.content, '') AS body,
               coalesce(r.stamp, '') AS created_at, coalesce(r.bumped, '') AS updated_at,
               coalesce(r.n - 1, 0) AS reply_count
        FROM channels_visible c LEFT JOIN ranked r ON r.channel_id = c.id AND r.seq = 1
    )
"""

BULLETINS = """
    bulletins_visible AS (
        SELECT 'bulletin' AS kind, b.unique_id AS key, b.board, b.subject AS title,
               b.sender_short_name AS author, b.content AS body,
               coalesce(nullif(b.source_timestamp, ''), nullif(b.date, ''), b.received_at, '') AS created_at,
               coalesce(nullif(b.source_timestamp, ''), nullif(b.date, ''), b.received_at, '') AS updated_at,
               0 AS reply_count
        FROM bulletins b
        WHERE public_board(b.board) AND b.local_only = 0 AND b.sync_peers = ''
          AND b.content_complete = 1
          AND (b.expected_content_length IS NULL OR length(b.content) >= b.expected_content_length)
          AND (:bulletin IS NULL OR b.unique_id = :bulletin)
          AND NOT EXISTS (
              SELECT 1 FROM board_sync a
              WHERE a.board = board_name(b.board) AND (a.audience != 'all' OR a.peers != ''))
          AND NOT EXISTS (
              SELECT 1 FROM deleted_sync_tombstones t WHERE t.tombstone_key = 'bulletins:' || b.unique_id)
    )
"""


def _board_name(value):
    return value.strip().casefold()


def configure_public_reads(db, config_path):
    """Register the same public-board scope for the LAN reader and radio UI."""
    config = configparser.ConfigParser(interpolation=None)
    with Path(config_path).open(encoding="utf-8-sig") as source:
        config.read_file(source)
    raw = config.get("boards", "bulletin_boards", fallback="")
    allowed = {_board_name(name) for name in raw.replace("\n", ",").split(",") if name.strip()}
    db.create_function("public_board", 1, lambda name: _board_name(name) in allowed)
    db.create_function("board_name", 1, _board_name, deterministic=True)
    db.create_function("channel_key", 2, _channel_key, deterministic=True)
