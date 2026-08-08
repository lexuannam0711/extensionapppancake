# Multi-device release and control plane

## Implemented local foundations

- Modern Windows build uses Electron 34 + NSIS through `npm run build:modern`.
- Win7 build uses Electron 22 + pinned `package.win7-lock.json` and portable ZIP through `npm run build:win7`.
- Release manifest carries `version`, `channel`, `minSupportedVersion`, HTTPS artifact URL, SHA-256, Ed25519 signature, and release notes.
- `src/update/modern-updater.js` checks a signed manifest on startup, verifies exact installer SHA-256 bytes, asks before download, and launches the verified NSIS installer on quit. Release CI embeds the Ed25519 public key in the artifact.
- `scripts/win7-updater.js` runs outside the app, verifies manifest/artifact, rejects unsafe extracted paths, swaps app tree atomically, and leaves backup for rollback.
- Runtime JSON and uploads move to stable `%APPDATA%/PancakeDesktopAIShortcutBot/{data,uploads}` in Electron. `PANCAKE_DATA_DIR` and `PANCAKE_UPLOADS_DIR` remain for server-only development.
- `metadata.json` records `dataSchemaVersion`; migration copies only missing allowlisted files and creates backup when target data already exists.
- AI credentials are no longer returned by health/settings/config responses or saved in settings logs. Existing local credentials still require rotation before public release.
- `src/control-plane/server.js` provides manifest, device register/heartbeat, profile, admin, revoke, block, audit, JWT role checks, rate limiting, and one-time device token proof.
- Desktop reads CONTROL_PLANE_URL, SUPABASE_URL, and SUPABASE_ANON_KEY; refresh/device tokens use OS-encrypted storage, and heartbeat sends metadata only.
- Bootstrap each machine with its own %APPDATA%\\PancakeDesktopAIShortcutBot\\.env; this file is never packaged or synchronized.
- `control-plane/supabase/schema.sql` enables tables and RLS. `scripts/start-control-plane.js` uses Supabase REST with `SUPABASE_SERVICE_ROLE_KEY` only on VPS; no app artifact contains that key.
- `scripts/audit-artifact.js` rejects runtime data, uploads, secrets, local agent directories, and signing keys; CI audits generated payload directories after packaging.

## Release flow

1. Configure Supabase, VPS HTTPS, `SUPABASE_JWT_SECRET`, `SUPABASE_URL`, and `SUPABASE_SERVICE_ROLE_KEY` on VPS only.
2. Configure GitHub `release` environment secrets: `WIN_CERTIFICATE_BASE64`, `WIN_CERTIFICATE_PASSWORD`, and `RELEASE_SIGNING_PRIVATE_KEY`.
3. Push code. CI runs `npm run check`, `npm test`, `npm audit`, and artifact scan.
4. Admin creates tag `vX.Y.Z`. Release workflow builds modern NSIS and Win7 ZIP, signs, creates manifests, and opens a draft GitHub Release.
5. Admin inspects draft artifacts and publishes release. Workflow never publishes automatically.
6. Set app `UPDATE_MANIFEST_URL` to VPS `/v1/update-manifest`, `UPDATE_PUBLIC_KEY` to shipped release public key, and `UPDATE_ALLOWED_HOSTS` to artifact hosts.

## Explicit non-goals

- No `.env`, Pancake session, logs, uploads, customer data, or local JSON sync.
- No Supabase project, VPS, certificate, signing key, or GitHub release is created by local code changes.
- Local Electron API remains loopback-only and now requires a per-process capability token when launched by Electron. Direct server-only development remains unauthenticated unless `LOCAL_API_TOKEN` is set.

## Rollout gates

- Rotate any existing AI/Telegram credentials before a public release.
- Apply SQL in a new production Supabase project, then test RLS with operator/admin accounts.
- Pilot one Windows 10/11 machine and one Windows 7 machine offline/online before wider deployment.
- Test interrupted downloads, invalid signatures, locked files, blocked versions, rollback, and data preservation. Live Supabase/VPS device registration and operator login still require deployment-level integration testing.