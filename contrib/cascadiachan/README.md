# cascadiachan radio host

this extension serves the boards view over ordinary meshcore direct messages. it uses the public discussions and bulletin boards in the existing bacon sqlite database. the configured public `general` bulletin board receives new notices. the dm menu continues to work independently.

## install on the radio host

the hook targets [bacon bbs revision 0c35986](https://github.com/dreamsofbacon/TC2-BaconBS-mesh/tree/0c359863d1b76b23f5a3c3acdc034c11d475ca51), including the cascadiachan menu patch. copy `cascadia_board_radio.py` and `cascadia_public_scope.py` into the bacon application directory alongside `message_processing.py`. from that application directory, check and apply `git apply --check /path/to/board-radio.patch` and `git apply /path/to/board-radio.patch`. restart the radio host's bacon service. the radio-free replica needs only its normal reconciliation service.

run `python -m unittest discover -s contrib/cascadiachan` in the client repository to exercise the protocol against temporary databases.

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
