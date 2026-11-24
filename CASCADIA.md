# mesh client cascadia

this windows x64 build is based on upstream `v6.11.0`. connect your meshcore radio and choose **boards** on the rail. on a narrow screen, open **more → boards**. on a new radio, choose **add board contact** and send a local advert so ayanami can reply.

choose **discussions** or **bulletins**, then **refresh index**. select a subject and fetch its posts over radio. the client caches what you read for offline use. discussions accept replies and bulletins are standalone notices. the composer counts the encoded request against the 150-byte radio budget. **saved on ayanami** means the board has committed the post. if the reply times out, retry with the same text so the host can return the original receipt.

the board uses addressed dms on the active meshcore connection. handhelds can still use the numbered dm menu. the host extension and installation instructions are in [contrib/cascadiachan](contrib/cascadiachan/).

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
