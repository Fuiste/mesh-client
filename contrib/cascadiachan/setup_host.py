"""Check and install the cc1 host extension on a local Bacon BBS checkout."""

import argparse
import ast
import configparser
from contextlib import closing
from hashlib import sha256
from importlib import metadata
import json
import os
from pathlib import Path
import re
import sqlite3
import stat
import sys
import tempfile
from urllib.parse import urlencode

from cascadia_public_scope import BULLETINS, DISCUSSIONS, configure_public_reads


SOURCE = Path(__file__).resolve().parent
MODULES = ("cascadia_public_scope.py", "cascadia_board_radio.py")
MANIFEST = ".cc1-installed.json"
HOOK = b"""    if not is_sync_message and message.startswith("!cc1 "):
        from cascadia_board_radio import handle_radio_board
        handle_radio_board(message, sender_node_id, interface)
        return

"""
GUARD = b"""    if not is_sync_message and _refuse_banned_sender(sender_id, interface, sender_node_id):
        return

"""


def share_link(name, key):
    name = name.strip()
    if not name or not name.isprintable():
        raise ValueError("supply a printable board name")
    if len(name.encode("utf-16-le")) > 2 * 128:
        raise ValueError("board name exceeds 128 UTF-16 code units")
    if not re.fullmatch(r"[0-9a-fA-F]{64}", key):
        raise ValueError("supply the full 64-hex public key from the board companion")
    # Match Mesh Client's pubkeyToNodeId projection; it reserves zero.
    raw = bytes.fromhex(key)
    node_id = 0
    for offset in range(0, len(raw), 4):
        node_id ^= int.from_bytes(raw[offset:offset + 4], "little")
    if node_id == 0:
        raise ValueError("the public key maps to an invalid Mesh Client node id")
    return "meshcore://contact/add?" + urlencode({"name": name, "public_key": key.lower(), "type": "1"})


def check_runtime(checkout):
    if sys.version_info < (3, 10):
        raise ValueError("meshcore needs Python 3.10 or newer")
    try:
        from packaging.requirements import Requirement
    except ImportError as exc:
        raise ValueError("run with the Bacon virtualenv after installing its requirements") from exc
    for line in (checkout / "requirements.txt").read_text(encoding="utf-8").splitlines():
        line = line.split("#", 1)[0].strip()
        if not line:
            continue
        requirement = Requirement(line)
        if requirement.marker and not requirement.marker.evaluate():
            continue
        try:
            installed = metadata.version(requirement.name)
        except metadata.PackageNotFoundError:
            installed = None
        if not installed or not requirement.specifier.contains(installed):
            raise ValueError(f"install {requirement} in the Bacon virtualenv")
    # Check interfaces without importing a running BBS or opening a radio.
    symbols = {"db_operations.py": ("get_config_path", "get_database_path", "get_local_node_id"),
               "utils.py": ("resolve_display_name", "send_one_chunk"),
               "op_log.py": ("is_op_log_enabled", "append_local_event"),
               "relay_ack.py": ("RecipientNoAck",), "meshcore_interface.py": ("MeshCoreInterface",)}
    for name, required in symbols.items():
        tree = ast.parse((checkout / name).read_bytes())
        available = {node.name for node in tree.body if isinstance(node, (ast.FunctionDef, ast.ClassDef))}
        if set(required) - available:
            raise ValueError(f"incompatible Bacon API in {name}; use the documented revision")


def check_board(config_path, database):
    cfg = configparser.ConfigParser(interpolation=None)
    with config_path.open(encoding="utf-8-sig") as f:
        cfg.read_file(f)
    transports = {"meshcore_serial", "meshcore_tcp", "meshcore_ble"}
    active = [cfg.get("interface", "type", fallback="")]
    if cfg.getboolean("interface2", "enabled", fallback=True):
        active.append(cfg.get("interface2", "type", fallback=""))
    if not any(t.strip().lower() in transports for t in active):
        raise ValueError("configure a MeshCore companion in [interface] or [interface2]")
    with closing(sqlite3.connect(database.resolve().as_uri() + "?mode=ro", uri=True)) as db:
        db.execute("PRAGMA query_only=ON")
        configure_public_reads(db, config_path)
        db.execute("SELECT row_number() OVER(), json_array(value) FROM json_each('[1]')").fetchone()
        db.execute(f"WITH {DISCUSSIONS} SELECT * FROM discussions LIMIT 0", {"channel": None})
        db.execute(f"WITH {BULLETINS} SELECT * FROM bulletins_visible LIMIT 0", {"bulletin": None})
        for table in ("channel_comments", "bulletins"):
            db.execute(f"SELECT source_node_id, author_node_id FROM {table} LIMIT 0")
        return bool(db.execute("""SELECT public_board('general') AND NOT EXISTS(
                SELECT 1 FROM board_sync WHERE board='general' AND (audience!='all' OR peers!=''))""").fetchone()[0])


def hook_bytes(before):
    newline = b"\r\n" if b"\r\n" in before else b"\n"
    guard, hook = (block.replace(b"\n", newline) for block in (GUARD, HOOK))
    if before.count(guard) != 1:
        raise ValueError("cannot locate the unique Bacon banned-sender guard; no files changed")
    start = before.index(guard) + len(guard)
    tail = before[start:]
    installed = tail.startswith(hook)
    next_code = tail[len(hook):] if installed else tail
    if not next_code.startswith(b"    if not is_sync_message:" + newline):
        raise ValueError("unrecognized changes at the cc1 hook; inspect message_processing.py")
    if before.count(b"from cascadia_board_radio import handle_radio_board") != int(installed):
        raise ValueError("an existing cc1 hook differs; inspect message_processing.py")
    return before if installed else before[:start] + hook + tail


def read_target(path):
    if path.is_symlink() or (path.exists() and not path.is_file()):
        raise ValueError(f"expected a regular file at {path}")
    return path.read_bytes() if path.exists() else None


def source_digest(data):
    return sha256(data.replace(b"\r\n", b"\n")).hexdigest()


def inventory(checkout):
    manifest_path = checkout / MANIFEST
    manifest = read_target(manifest_path)
    previous = json.loads(manifest) if manifest is not None else {}
    if not isinstance(previous, dict) or previous.keys() - set(MODULES):
        raise ValueError(f"invalid installation manifest {manifest_path}")
    hashes = {}
    changes = []
    for name in MODULES:
        path = checkout / name
        old, new = read_target(path), (SOURCE / name).read_bytes()
        hashes[name] = source_digest(new)
        compile(new, name, "exec")
        if old is not None and source_digest(old) == hashes[name]:
            continue
        if old is not None and source_digest(old) != previous.get(name):
            raise ValueError(f"{name} contains unrecognized local changes; review before installing")
        changes.append((path, old, new))
    router = checkout / "message_processing.py"
    before = read_target(router)
    if before is None:
        raise ValueError("missing Bacon message_processing.py")
    after = hook_bytes(before)
    compile(after, str(router), "exec")
    if after != before:
        changes.append((router, before, after))
    encoded = (json.dumps(hashes, indent=2, sort_keys=True) + "\n").encode()
    if encoded != manifest:
        changes.append((manifest_path, manifest, encoded))
    return changes


def replace_file(path, before, after):
    if read_target(path) != before:
        raise ValueError(f"{path.name} changed during installation; rerun check")
    mode = stat.S_IMODE(path.stat().st_mode) if before is not None else 0o644
    temp = None
    try:
        with tempfile.NamedTemporaryFile(dir=path.parent, delete=False) as out:
            temp = Path(out.name)
            out.write(after)
        temp.chmod(mode)
        os.replace(temp, path)
    finally:
        if temp is not None:
            temp.unlink(missing_ok=True)


def run(action, checkout, config_path, database):
    check_runtime(checkout)
    general_public = check_board(config_path, database)
    if action == "check":
        changes = inventory(checkout)
    else:
        lock = checkout / ".cc1-install.lock"
        try:
            handle = lock.open("x")
        except FileExistsError as exc:
            raise ValueError(f"installation lock exists at {lock}") from exc
        try:
            # Modules first, hook next, manifest last. Each replacement is
            # atomic. Rerunning after an interruption recognizes completed files.
            changes = inventory(checkout)
            for path, before, after in changes:
                replace_file(path, before, after)
        finally:
            handle.close()
            lock.unlink()
    if changes:
        names = ", ".join(path.name for path, _, _ in changes)
        report = (f"ready to install: {names}" if action == "check" else
                  f"installed: {names}. start or restart your Bacon service when ready")
    else:
        report = "cc1 host files are current; config and database checks passed"
    if not general_public:
        report += "\ngeneral is private or unconfigured; new radio bulletins are disabled"
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="action", required=True)
    for name in ("check", "install"):
        sub = commands.add_parser(name)
        sub.add_argument("--checkout", type=Path, required=True)
        sub.add_argument("--config", type=Path, required=True)
        sub.add_argument("--database", type=Path, required=True)
    link = commands.add_parser("link")
    link.add_argument("--name", required=True)
    link.add_argument("--public-key", required=True)
    args = parser.parse_args()
    try:
        print(share_link(args.name, args.public_key) if args.action == "link"
              else run(args.action, args.checkout.resolve(), args.config, args.database))
    except (OSError, ValueError, sqlite3.Error, configparser.Error, SyntaxError) as exc:
        parser.exit(1, f"cc1 setup: {exc}\n")


if __name__ == "__main__":
    main()
