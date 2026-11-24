# mesh client cascadia

this windows x64 build is based on upstream `v6.11.0`. connect your meshcore radio, open the cascadiachan direct message, and expand **cascadiachan** above the composer. **menu**, **discussions**, and **bulletins** send `?`, `!d`, and `!cb general` through your connected radio. your draft stays in the composer. the shortcuts appear for the board's public key even if you rename the contact.

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
