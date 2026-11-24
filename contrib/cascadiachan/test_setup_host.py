import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from urllib.parse import parse_qs, urlsplit

import setup_host as setup


class HostInstallTests(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name)
        self.router = self.root / "message_processing.py"
        self.router.write_bytes(b"# operator comment\r\ndef _process_message(sender_id, message, interface, is_sync_message, sender_node_id):\r\n"
                                + setup.GUARD.replace(b"\n", b"\r\n")
                                + b"    if not is_sync_message:\r\n        return 'menu'\r\n")

    def install(self, mode="install"):
        with patch.object(setup, "check_runtime"), patch.object(setup, "check_board", return_value=True):
            return setup.run(mode, self.root, None, None)

    def test_clean_install_adopts_preexisting_hook_and_leaves_operator_edits(self):
        initial = self.router.read_bytes()
        self.assertIn("ready to install", self.install("check"))
        self.assertEqual(self.router.read_bytes(), initial)
        self.router.write_bytes(setup.hook_bytes(initial))
        before = self.router.read_bytes()
        name = setup.MODULES[0]
        (self.root / name).write_bytes((setup.SOURCE / name).read_bytes().replace(b"\r\n", b"\n"))
        self.install()
        self.assertEqual(self.router.read_bytes(), before)
        self.assertIn("current", self.install())
        self.assertIn(b"# operator comment\r\n", self.router.read_bytes())

    def test_guarded_upgrade_and_refusal_before_partial_writes(self):
        self.install()
        path = self.root / setup.MODULES[0]
        original = path.read_bytes()
        path.write_bytes(original + b"# operator customization\n")
        other = self.root / setup.MODULES[1]
        other_before = other.read_bytes()
        with self.assertRaisesRegex(ValueError, "unrecognized local changes"):
            self.install()
        self.assertEqual(other.read_bytes(), other_before)
        self.assertEqual(path.read_bytes(), original + b"# operator customization\n")
        self.assertFalse((self.root / ".cc1-install.lock").exists())
        # A prior version recorded in our manifest can be upgraded safely.
        prior = b"# previously installed version\n"
        path.write_bytes(prior)
        manifest_path = self.root / setup.MANIFEST
        manifest = json.loads(manifest_path.read_bytes())
        manifest[path.name] = setup.source_digest(prior)
        manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
        self.install()
        self.assertEqual(path.read_bytes(), original)

    def test_conflicting_hook_aborts_without_installing_modules(self):
        self.router.write_bytes(self.router.read_bytes().replace(b"    if not is_sync_message:\r\n",
                                                                  b"    if not operator_guard():\r\n"))
        with self.assertRaisesRegex(ValueError, "unrecognized changes"):
            self.install()
        self.assertFalse((self.root / setup.MODULES[0]).exists())

    def test_link_uses_own_key_and_escapes_query_fields(self):
        public = "AB" * 31 + "01"
        parts = urlsplit(setup.share_link("moss & rain / #2", public))
        self.assertEqual((parts.scheme, parts.netloc, parts.path), ("meshcore", "contact", "/add"))
        self.assertEqual(parse_qs(parts.query), {"name": ["moss & rain / #2"],
                                                 "type": ["1"], "public_key": [public.lower()]})
        astral_name = "🌲" * 64
        self.assertEqual(parse_qs(urlsplit(setup.share_link(astral_name, public)).query)["name"], [astral_name])
        for name, key in [("", public), ("name\nname", public), ("board", "abcdef123456"),
                          ("a" * 129, public), (astral_name + "a", public), ("board", "AB" * 32)]:
            with self.assertRaises(ValueError):
                setup.share_link(name, key)


if __name__ == "__main__":
    unittest.main()
