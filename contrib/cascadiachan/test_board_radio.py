import base64
from concurrent.futures import ThreadPoolExecutor
import json
from pathlib import Path
import sqlite3
import sys
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import Mock, patch

from cascadia_board_radio import _send_response, answer


class BoardDeliveryTests(unittest.TestCase):
    class NoAck(IOError):
        pass

    def deliver(self, frames, outcomes):
        peer, interface = "ab" * 32, object()
        send = Mock(side_effect=outcomes)
        with patch.dict(sys.modules, {"relay_ack": SimpleNamespace(RecipientNoAck=self.NoAck),
                                      "utils": SimpleNamespace(send_one_chunk=send)}):
            _send_response(frames, peer, interface)
        for call in send.call_args_list:
            self.assertEqual(call.args[1:], (peer, interface))
        return [call.args[0] for call in send.call_args_list]

    def test_lost_acks_retry_exact_frame_then_probe_and_resume(self):
        with self.assertLogs(level="WARNING"):
            calls = self.deliver(["first","second","third","fourth"],
                                 [None,self.NoAck(),self.NoAck(),None,self.NoAck(),None])
        self.assertEqual(calls, ["first","second","second","third","fourth","fourth"])

    def test_unreachable_peer_and_non_ack_transport_errors_stop_promptly(self):
        with self.assertLogs(level="WARNING"):
            self.assertEqual(self.deliver(["a","b","c","d"], [self.NoAck()] * 3), ["a","a","b"])
        with self.assertLogs(level="ERROR"):
            self.assertEqual(self.deliver(["a","b"], [IOError("serial closed")]), ["a"])

    def test_response_wide_retry_budget(self):
        with self.assertLogs(level="WARNING"):
            calls = self.deliver(list("abcde"), [self.NoAck(),None] * 3 + [self.NoAck(),None])
        self.assertEqual(calls, list("aabbccde"))


class BoardRadioTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.path = Path(temp.name) / "board.db"
        config = Path(temp.name) / "config.ini"
        config.write_text("[boards]\nbulletin_boards = general\n", encoding="utf-8")
        self.args = dict(sender="ab" * 32, author="fern", origin="cd" * 32,
                         db_path=self.path, config_path=config)
        self.db = sqlite3.connect(self.path)
        self.addCleanup(self.db.close)
        self.db.executescript("""
            CREATE TABLE channels(id INTEGER PRIMARY KEY, name, url, local_only DEFAULT 0, sync_peers DEFAULT '');
            CREATE TABLE channel_comments(id INTEGER PRIMARY KEY, channel_id, sender_short_name, date, content,
                unique_id, expected_content_length, content_complete, source_node_id, source_timestamp, received_at, author_node_id);
            CREATE TABLE bulletins(id INTEGER PRIMARY KEY, board, sender_short_name, date, subject, content,
                unique_id, expected_content_length, content_complete, source_node_id, source_timestamp, received_at,
                author_node_id, local_only DEFAULT 0, sync_peers DEFAULT '');
            CREATE TABLE deleted_sync_tombstones(tombstone_key);
            CREATE TABLE board_sync(board, audience, peers);
        """)
        self.seq = 0

    def wire(self, request, rid=None, **extra):
        self.seq += 1
        rid = rid or f"{self.seq:012x}"
        message = f"!cc1 {rid} " + json.dumps(request, ensure_ascii=False, separators=(",", ":"))
        parts = answer(message, **{**self.args, **extra})
        self.assertTrue(all(len(p.encode()) <= 150 for p in parts))
        for i, part in enumerate(parts, 1):
            self.assertEqual(part.split()[:3], ["cc1", rid, f"{i}/{len(parts)}"])
        encoded = "".join(p.split()[3] for p in parts)
        return json.loads(base64.urlsafe_b64decode(encoded + "=" * (-len(encoded) % 4)))

    def test_duplicate_write_is_atomic_with_receipt_and_canonical_rows(self):
        rid = "123456789abc"
        request = ["new", "d", "ridge", "café and 🐈"]
        with ThreadPoolExecutor(2) as workers:
            results = list(workers.map(lambda _: self.wire(request, rid), range(2)))
        self.assertEqual(results[0], results[1])
        op, section, key, author, stamp, count = results[0]
        self.assertEqual((op, section, author, count), ("saved", "d", "fern", 0))
        self.assertEqual(self.db.execute("SELECT content FROM channel_comments WHERE channel_id=?", (int(key),)).fetchone()[0], "café and 🐈")
        self.assertEqual(self.wire(["reply", key, "one"])[-1], 1)
        self.assertEqual(self.wire(["read", "d", key, 0])[2][0], ["fern", stamp, "café and 🐈"])
        self.assertEqual(self.wire(["new", "d", "edited", "different"], rid)[0], "error")
        self.assertEqual(self.db.execute("SELECT count(*) FROM channels").fetchone()[0], 1)
        self.assertEqual(self.wire(["new", "d", "ridge", "another op"])[0], "saved")
        bulletin = self.wire(["new", "b", "tonight", "net at ten"])
        self.assertEqual(self.wire(["list", "b", 0])[2][0][:3], [bulletin[2], "tonight", 0])
        self.assertEqual(self.wire(["read", "b", bulletin[2], 0])[2][0][2], "net at ten")
        self.assertEqual(self.db.execute("SELECT content FROM bulletins WHERE unique_id=?", (bulletin[2],)).fetchone()[0], "net at ten")

    def test_private_rows_and_secrets_are_excluded_on_read_or_reply(self):
        self.db.executescript("""
            INSERT INTO channels(name,url,local_only) VALUES('secret','sensitive passphrase',1);
            INSERT INTO channels(name,url,sync_peers) VALUES('peer only','other passphrase','abc');
            INSERT INTO channels(name,url) VALUES('public','public channel psk');
            INSERT INTO board_sync VALUES('general','local','');
        """)
        rows = self.wire(["list", "d", 0])[2]
        self.assertEqual([r[1] for r in rows], ["public"])
        self.assertNotIn("psk", str(rows))
        self.assertEqual(self.wire(["read", "d", "3", 0]), ["read", None, []])
        for key in ("1", "2"):
            self.assertEqual(self.wire(["read", "d", key, 0])[0], "error")
            self.assertEqual(self.wire(["reply", key, "private write"])[0], "error")
        self.assertEqual(self.wire(["new", "b", "hello", "body"])[0], "error")

    def test_cursor_membership_survives_inserts_and_rechecks_withdrawals(self):
        keys = [self.wire(["new", "d", str(i), "start"])[2] for i in range(7)]
        first = self.wire(["list", "d", 0])
        self.assertEqual([r[0] for r in first[2]], list(reversed(keys[3:])))
        self.wire(["new", "d", "new during paging", "body"])
        self.db.execute("UPDATE channels SET local_only=1 WHERE id=?", (keys[0],))
        self.db.commit()
        more = self.wire(["list", "d", first[1]])
        self.assertEqual([r[0] for r in more[2]], list(reversed(keys[1:3])))
        self.assertIsNone(more[1])
        self.assertEqual(self.wire(["list", "d", first[1]], sender="other")[0], "error")

    def test_bad_request_and_rolled_back_post(self):
        import cascadia_board_radio as radio
        self.assertEqual(self.wire(["reply", "1", "☔"*90])[0], "error")
        for req in ([], [123], ["bad"], ["new","d","", "body"], ["read","d",{},0],
                    ["list","x",0], ["list","d",True]):
            self.assertEqual(self.wire(req)[0], "error")
        def fail(*a, **kw):
            raise sqlite3.OperationalError("failed event write")
        with patch.object(radio.logging, "exception"):
            self.assertEqual(self.wire(["new","d","x","body"],log_op=fail)[0],"error")
        self.assertEqual(self.db.execute("SELECT count(*) FROM channels").fetchone()[0], 0)


if __name__ == "__main__":
    unittest.main()
