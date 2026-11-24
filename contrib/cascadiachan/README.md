# meshcore board host

this extension serves the boards view over ordinary meshcore direct messages. it uses the public discussions and bulletin boards in the existing bacon sqlite database. the configured public `general` bulletin board receives new notices. the dm menu continues to work independently.

## host your own board

use an always-on computer and a meshcore companion with its own radio identity. configure the companion for your local mesh and attach it to the host over serial, tcp or bluetooth. the operator chooses the radio, public name and audience. an independent board can run with an empty peer list. replication and a lan reader are optional.

these commands start from a linux shell in the mesh client fork. the setup tool also runs on windows with the bacon python environment. for an existing bacon service, skip the fresh-host steps and supply its actual application directory, config and database.

### fresh host

```sh
cc1="$(pwd)/contrib/cascadiachan/setup_host.py"
git clone https://github.com/dreamsofbacon/TC2-BaconBS-mesh.git bacon
cd bacon
git checkout --detach 0c359863d1b76b23f5a3c3acdc034c11d475ca51
python3 -m venv .venv
. .venv/bin/activate
python -m pip install -r requirements.txt
export BBS_CONFIG_PATH="$PWD/config.ini"
export BBS_DB_PATH="$PWD/bulletins.db"
export BBS_WEBGUI_EMBEDDED=0
```

create a config at `$BBS_CONFIG_PATH` with your own display name and serial device. this example starts with one radio and a public bulletin board. tcp and ble use the transport fields in the [pinned bacon guide](https://github.com/dreamsofbacon/TC2-BaconBS-mesh/tree/0c359863d1b76b23f5a3c3acdc034c11d475ca51#readme).

```ini
[interface]
type = meshcore_serial
port = /dev/ttyACM0
baudrate = 115200

[bbs]
name = ridge board

[boards]
bulletin_boards = general

[sync]
bbs_nodes =

[zork]
autodownload = false
```

initialize a new database with the pinned server's own schema. this operation can be run with the radio disconnected.

```sh
python -c "from db_operations import initialize_database; initialize_database()"
```

### check and install

run these as the bacon service user, using its virtualenv. the example uses the variables and current bacon directory from above. `check` reads the config and database and reports the planned changes. `install` writes the two host modules, the dm hook in `message_processing.py`, and a local hash manifest. it leaves the database, config, service and existing dm menus under the operator's control.

```sh
python "$cc1" check --checkout "$PWD" --config "$BBS_CONFIG_PATH" --database "$BBS_DB_PATH"
python "$cc1" install --checkout "$PWD" --config "$BBS_CONFIG_PATH" --database "$BBS_DB_PATH"
python "$cc1" check --checkout "$PWD" --config "$BBS_CONFIG_PATH" --database "$BBS_DB_PATH"
```

the last check should say `cc1 host files are current`. restart an existing service when ready, or start a new host from the same environment with `python server.py --config "$BBS_CONFIG_PATH"`. the hook works with the stock menus. upgrades rerun the same commands. the manifest protects operator edits to the installed modules, and setup requires the recognizable router hook after bacon's existing ban check. if a stopped installer left `.cc1-install.lock`, confirm that no installation is active before deleting that lock and retrying.

### share the contact

get the companion's **full public key** from its meshcore contact details. generate a link using your own host's name and key, then share it with local operators. for example, with `board_pubkey` set to that 64-character hex public key:

```sh
python "$cc1" link --name "ridge board" --public-key "$board_pubkey"
```

the command prints a `meshcore://contact/add?…` chat-contact link. send a local advert so the host can resolve your radio's full key. in the boards view choose **add board**, paste the link and verify the key with the operator. choose **check board** to request its discussion index over radio, then **add board** to save the verified host. for a menu-only bbs choose **save for chat**. stock handhelds can continue to use bacon's numbered menus.

run `python -m unittest discover -s contrib/cascadiachan` in the client repository to exercise the setup and radio protocol against temporary files.

## wire format

a request fits in a single 150-byte utf-8 dm. send `!cc1 <rid> <array>`, with a random 12-character lowercase hex request id and a compact json array. keys are strings scoped to the host and section. offsets start at zero. subsequent offsets are opaque numeric cursors, scoped to the device and query. the host retains up to 128 cursors and expires them after 15 minutes. refresh from zero after expiry.

| operation              | request                        | response payload                                       |
| ---------------------- | ------------------------------ | ------------------------------------------------------ |
| index                  | `["list",section,offset]`      | `["list",next,[[key,subject,replyCount,updatedAt],…]]` |
| posts                  | `["read",section,key,offset]`  | `["read",next,[[author,createdAt,body],…]]`            |
| opening post or notice | `["new",section,subject,body]` | `["saved",section,key,author,createdAt,replyCount]`    |
| discussion reply       | `["reply",key,body]`           | `["saved","d",key,author,createdAt,replyCount]`        |

section is `"d"` for discussions or `"b"` for bulletins. a null next cursor ends the result set. the opening post is the oldest visible comment. a discussion without comments returns an empty array. each page retains the initial ordering and membership and rechecks the current visibility of each record. fresh queries pick up new posts. repeated subjects are allowed. bacon's sync format reserves `|` and line breaks in subjects.

responses are numbered `cc1 <rid> <part>/<total> <data>`, starting at part 1. order and concatenate the data slices, then decode unpadded base64url to utf-8 json. a page contains up to four index rows or three posts and at most 32 frames. an individual legacy post exceeding the page byte budget can be read in the lan reader. an error response contains `["error",message]`.

post retries reuse the original request id and exact json. the record, opening comment when applicable, local event log entry when enabled, and receipt commit in one transaction. confirmed writes enter bacon's existing peer reconciliation. the receipt confirms storage on this host. retransmitting a confirmed request returns its original receipt, including the same author, timestamp and reply count.
