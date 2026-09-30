# OTA Server

A self-hosted server (`ota-server`) that delivers JavaScript bundle updates to Expo apps via
`expo-updates`, replacing EAS Update. Content maps directly to `server.js`/`helpers.js` in
this repository.

**Convention:** `<OTA_SERVER_URL>` = the server's base URL (domain, ngrok URL, or
`http://localhost:3001` for local testing).

## Table of Contents

1. [What OTA can update](#1-what-ota-can-update)
2. [Install and run the server](#2-install-and-run-the-server)
3. [API reference](#3-api-reference)
4. [How the latest version is determined](#4-how-the-latest-version-is-determined)
5. [Rollback and revert](#5-rollback-and-revert)
6. [Storage layout](#6-storage-layout)
7. [Security](#7-security)
8. [Troubleshooting](#8-troubleshooting)

---

## 1. What OTA can update

| Can update | Cannot update — requires native rebuild |
|---|---|
| Text, i18n, styles, JS logic | `app.json` `android`/`ios`/`plugins` sections |
| API calls, JS bug fixes | Adding native libraries, icons, splash, permissions |
| Images/assets imported in code | Native config files (`google-services.json`, etc.), bumping `version` |

OTA only replaces the **compiled JS bundle (Hermes bytecode) + assets** stored in the app's
sandbox — it does not touch the APK/IPA itself.

```
Publisher  --POST /publish (zip)-->  ota-server  --> updates/<rt>/<channel>/<timestamp>/
App        --GET /api/manifest + /api/assets-->  ota-server
```

---

## 2. Install and run the server

```bash
cd ota-server
npm install
cp .env.example .env
```

`.env`:

```dotenv
PORT=3001
PUBLISH_TOKEN=<secret — generate with: node -e "console.log(require('crypto').randomBytes(24).toString('hex'))">
PRIVATE_KEY_PATH=./keys/private-key.pem   # path to RSA private key for code signing
KEY_ID=main                                # keyid embedded in expo-signature header
```

`PUBLISH_TOKEN` missing → `/publish` always returns `501`.
`PRIVATE_KEY_PATH` missing or file not found → server runs without code signing (manifests
are unsigned). See [`OTA_CODE_SIGNING.md`](OTA_CODE_SIGNING.md) to enable signing.

**Run:**

```bash
npm start                         # directly, http://localhost:3001
docker compose up -d --build      # Docker (recommended for persistence)
```

`docker-compose.yml` mounts `./updates:/app/updates` (update storage) and
`./keys:/app/keys:ro` (code signing keys, read-only).

**Device access options:**

| Method | When | Notes |
|---|---|---|
| `adb reverse tcp:3001 tcp:3001` | USB cable | Set `updates.url` to `http://localhost:3001/...` in `app.json`. Release Android builds require `usesCleartextTraffic` via `expo-build-properties` — without it you get `Failed to download remote update` in logcat |
| LAN IP (`http://192.168.x.x:3001`) | Same Wi-Fi network | Set `OTA_SERVER_URL` to the machine's LAN IP in `rn/.env` |
| ngrok | Wireless, cross-network testing | `docker compose --profile ngrok up -d`. Free tier URL changes on each restart unless you have a static ngrok domain |
| VPS / public domain | Production | HTTPS required; see §7 |

All requests are logged to the console (method, path, headers) — useful when debugging.

---

## 3. API reference

### `POST /publish`

| | |
|---|---|
| Auth | Header `x-publish-token` matching `PUBLISH_TOKEN` |
| Input | Query `runtimeVersion` (required), `channel` (default `production`). Body: raw `.zip` (must contain `metadata.json` at root — output of `expo export`), max 100 MB |
| `200` | `{ runtimeVersion, channel, timestamp, targetDir }` |
| `400` | Bad parameters, empty body, or zip missing `metadata.json` |
| `401` | Wrong / missing token |
| `501` | Server has no `PUBLISH_TOKEN` configured |

```bash
curl -X POST "<OTA_SERVER_URL>/publish?runtimeVersion=1.0.0&channel=production" \
  -H "Content-Type: application/zip" -H "x-publish-token: $PUBLISH_TOKEN" \
  --data-binary @export.zip
```

### `GET /api/manifest`

Called automatically by `expo-updates` on every app launch.

| | |
|---|---|
| Input | Headers: `expo-platform` (`ios`/`android`, required), `expo-runtime-version` (required), `expo-channel-name` (default `production`), `expo-current-update-id` |
| `200` | `multipart/mixed`: `manifest` part (update available) or `directive: noUpdateAvailable` |
| `400`/`404` | Missing header, or no bundle matches the requested `runtimeVersion`/`channel` |

When code signing is enabled, each part carries an `expo-signature` header
(`sig="..."`, `keyid="main"`, `alg="rsa-v1_5-sha256"`).

### `GET /api/assets`

Streams the actual JS bundle or asset file, using the URL the server embeds in the manifest.
Query: `asset`, `runtimeVersion`, `platform`, `channel`. Returns `400` if `asset` escapes
the update directory (path traversal protection), `404` if not found.

### `GET /` — dashboard

HTML listing all published versions with a **Delete** button and a **Re-publish** button per
entry. No authentication.

### `POST /updates/:runtimeVersion/:channel/:timestamp/republish`

Instant rollback — clones an existing version as a new entry without rebuilding. See §5.

### `POST /updates/:runtimeVersion/:channel/:timestamp/delete`

Removes a specific version. Alternative rollback approach; see §5.

---

## 4. How the latest version is determined

- **"Latest"** = the subfolder with the **highest numeric timestamp** inside
  `updates/<runtimeVersion>/<channel>/`.
- **Comparison by ID, not version number**: `id = SHA256(metadata.json)` → UUID format. The
  app sends `expo-current-update-id`; the server compares it with the latest ID — different
  means there is an update. **Two publishes of identical content produce the same ID** (same
  `metadata.json`), differing only in timestamp.
- **Channel fallback:** if no bundle exists for the requested channel (and it is not
  `production`), the server retries with `production` before returning `404`. This can hide
  an accidental wrong-channel publish.

---

## 5. Rollback and revert

There is no "pinned version" concept — only "latest by timestamp". Rollback = **promoting old
content to become the new latest**, without modifying or deleting existing entries. Two
approaches:

### Option 1 — Instant re-publish (recommended)

Clones an old version into a new timestamp entry on disk — **no rebuild, ~100 ms**:

1. Open `<OTA_SERVER_URL>/` — identify the stable version to restore.
2. Click **Re-publish** in the dashboard, or:
   ```bash
   curl -X POST "<OTA_SERVER_URL>/updates/<runtimeVersion>/<channel>/<sourceTimestamp>/republish"
   ```
3. Open the app 1–2 times — the server creates `updates/.../<new-timestamp>/` with the old
   bundle content.

**Mechanism:** bundle/asset files are copied as-is (preserving hashes, benefiting from
on-device cache), but **two fields are injected into a copy of `metadata.json`**
(`_republishedFrom`, `_republishedAt`) to change its hash and therefore its `manifestId`.
This is required: `expo-updates` stores updates by ID in its internal SQLite database — if
the clone kept the original ID, the app would recognise it as already seen, skip it, and the
buggy newer version would remain active. This is standard **cache-busting** (same principle
as hash-suffixed filenames in Webpack/Vite).

### Option 2 — Revert via publish (safest, slowest)

```bash
git revert <bad-commit>
pnpm run ota:publish <channel>
```

Nothing is deleted on the server; there is a Git commit documenting the reason. Trade-off:
requires a full `expo export` run.

---

## 6. Storage layout

```
updates/<runtimeVersion>/<channel>/<timestamp>/
  metadata.json   # generated by expo export — source of the manifest ID
  _expo/...       # JS bundle (Hermes bytecode)
  assets/...      # images, fonts
```

No database — every endpoint reads the directory structure directly. Deleting a
`<timestamp>/` folder removes the version completely with no trace.

---

## 7. Security

This server is intended for internal use and **does not include** authentication for the
dashboard or delete endpoints, nor rate limiting. `PUBLISH_TOKEN` is a shared secret — if
leaked, rotate it on both the server and all clients. Run inside a trusted network or add
VPN/IP allowlist before exposing publicly.

**Code signing (RSA signature on manifests/assets)** is supported — see
[`OTA_CODE_SIGNING.md`](OTA_CODE_SIGNING.md) to enable it and prevent JS code substitution
via MITM.

For production deployments, terminate HTTPS with Nginx or Caddy:

```nginx
server {
    server_name ota.mycompany.com;
    client_max_body_size 100M;

    location / {
        proxy_pass http://127.0.0.1:3001;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
    }

    listen 443 ssl http2;
    ssl_certificate /etc/letsencrypt/live/ota.mycompany.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/ota.mycompany.com/privkey.pem;
}
```

---

## 8. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `/publish` returns `501` | No `PUBLISH_TOKEN` in `.env` | Add it to `.env`, restart server |
| `/publish` returns `401` | Token mismatch | Check both sides for trailing spaces |
| `/publish` returns `400 "missing metadata.json"` | Zip contains the parent folder instead of its contents | Zip only the contents of the export directory |
| App opens many times with no change | `updates.url` in the installed app does not match this server, or `runtimeVersion`/`channel` mismatch | Changing `app.json` after a build has no effect — rebuild required; watch server logs during app launch to see `/api/manifest` requests |
| Android: `Failed to download remote update` in logcat | Missing `usesCleartextTraffic` | Enable via `expo-build-properties`, rebuild |
| Android: `CertificateException` in logcat | Certificate missing required X.509 extensions, or cert mismatch | See [`OTA_CODE_SIGNING.md` §6](OTA_CODE_SIGNING.md#6-troubleshooting) |
| `/api/assets` returns `400 "Invalid asset path"` | Manually modified asset URL | Use the `assets[].url` values exactly as the server returns them in the manifest |
| `docker compose up` fails with `NGROK_AUTHTOKEN missing` | ngrok service included without the `--profile ngrok` flag | Run `docker compose up -d --build` (no profile) to start only `ota-server`; add `--profile ngrok` only when you need the tunnel |
