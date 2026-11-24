# mesh client cascadia

this windows x64 build is based on upstream `v6.11.0`. connect your meshcore radio and choose **boards** on the rail. on a narrow screen, open **more → boards**. a fresh radio starts with an empty board list. to join a board, choose **add board**, paste the operator's meshcore contact link and verify the full public key with them. send a local advert so the host can learn your contact and reply. choose **check board**, then **add board** when the check succeeds. choose **save for chat** for a menu-only bbs.

select a board, choose **discussions** or **bulletins**, then **refresh index**. select a subject and fetch its posts over radio. the client caches what you read for offline use. discussions accept replies and bulletins are standalone notices. the composer counts the encoded request against the 150-byte radio budget. a saved receipt confirms storage on the selected host. if the reply times out, retry on that same board with the same text so it can return the original receipt.

boards use addressed dms on the active meshcore connection. each operator can run an independent bacon server with cc1 support. handhelds can still use its numbered dm menu. to install a fresh host and generate its contact link, follow the [operator guide](contrib/cascadiachan/).

## build on windows

use the pinned pnpm version from `package.json`. stage the matching radio sidecar from the upstream x64 release of the same version, or build it from source using the [development guide](docs/reticulum-development.md). to reuse the one from a standard per-user upstream install, run these commands in powershell from the checkout.

```powershell
$sidecar = Join-Path $env:LOCALAPPDATA 'Programs/mesh-client/resources/reticulum-sidecar/mesh-client-reticulum.exe'
$stage = New-Item -ItemType Directory -Force 'resources/reticulum-sidecar/staged/win32-x64'
Copy-Item -LiteralPath $sidecar -Destination $stage.FullName
pnpm install --frozen-lockfile
pnpm run build
pnpm exec electron-builder --config electron-builder.cascadia.json --win --x64 --dir --publish never
```

launch `release/win-unpacked/Mesh Client Cascadia.exe`. to continue using an existing stock profile, quit stock mesh client first and launch with `--user-data-dir="<absolute path to the mesh-client profile>"`. quit the active build before switching back so it releases the radio.
