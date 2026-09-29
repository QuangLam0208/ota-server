# OTA Server

A minimal, self-hosted update server implementing the [Expo Updates protocol](https://docs.expo.dev/technical-specs/expo-updates-1/). It lets an Expo/React Native app running `expo-updates` fetch and apply JavaScript-only updates (bug fixes, UI changes, copy tweaks) **without going through EAS Update, an app store, or a full native rebuild.**

This is a proof-of-concept server built for internal use. It intentionally does **not** implement code signing, staged rollouts, or multi-tenant access control — see [Security](#security) before exposing it beyond a trusted network.

---

## Table of contents

- [What this does](#what-this-does)
- [Requirements](#requirements)
- [Installation](#installation)
- [Configuration](#configuration)
- [Running the server](#running-the-server)
- [Publishing an update](#publishing-an-update)
- [Web dashboard](#web-dashboard)
- [API reference](#api-reference)
- [Storage layout](#storage-layout)
- [Deploying remotely](#deploying-remotely)
- [Security](#security)
- [Troubleshooting](#troubleshooting)
- [Testing](#testing)

---

## What this does

A React Native app built with `expo-updates` can be configured (via `app.json`'s `updates.url`) to check a manifest server on launch for a newer JavaScript bundle. Normally that server is Expo's own hosted **EAS Update**. This project is a drop-in replacement you run yourself:

```
┌──────────────────────┐                          ┌──────────────────────┐
│   Your app's repo     │                          │      This server      │
│                       │   1. npm run ota:publish │                       │
│  (edit source code)   │ ────────────────────────►│   receives the zip,   │
│                       │   (export → zip → HTTP)  │   stores it, and       │
└──────────────────────┘                          │   serves it back       │
                                                    │   to the app on next  │
┌──────────────────────┐   2. checks on launch      │   launch               │
│    Installed app      │ ◄────────────────────────│                       │
│  (expo-updates client)│                          └──────────────────────┘
└──────────────────────┘
```

The server only ever serves the **latest** published bundle for a given `runtimeVersion` + `channel`. It never touches how the native app itself is built — a native rebuild (new native module, changed permission, new app icon, etc.) is still a normal `eas build` / store release, outside this server's scope.

## Requirements

- **Node.js 18 or later** (the server and its tooling use the built-in `fetch` API and `fs.cpSync`).
- No database, no external services. All state is plain files on disk under `updates/`.

## Installation

```bash
npm install
```

This installs the server's runtime dependencies (`express`, `adm-zip`, `dotenv`, `mime`, `form-data`) into `node_modules/`.

## Configuration

Copy the example environment file and fill in a secret token:

```bash
cp .env.example .env
```

```dotenv
# .env
PUBLISH_TOKEN=choose-a-long-random-secret-here
```

| Variable | Required | Purpose |
|---|---|---|
| `PUBLISH_TOKEN` | Yes, to enable publishing | Shared secret clients must send in the `x-publish-token` header to publish a new update via `POST /publish`. If unset, that endpoint is disabled and always responds `501`. |
| `PORT` | No (default `3001`) | Port the HTTP server listens on. |

**Generate a strong token** rather than typing one by hand:

```bash
node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"
```

Give this same value to whoever will be publishing updates — they'll need it configured on their side as well (see [Publishing an update](#publishing-an-update)).

`.env` is gitignored. Never commit it.

## Running the server

```bash
npm start
```

```
> ota-server@0.0.1 start
> node server.js

OTA server listening on http://localhost:3001
```

Keep this running for as long as you want apps to be able to check for and download updates. For production use, run it under a process manager (`pm2`, `systemd`, a container orchestrator, etc.) rather than a bare terminal — see [Deploying remotely](#deploying-remotely).

## Publishing an update

Publishing means: export the app's current JavaScript, package it, and upload it to this server, where it becomes the newest available update for its `runtimeVersion`/`channel`.

### Option A — using the included publish script

If you have the companion `scripts/publish.js` from the app's own repository (it ships alongside the React Native app's source, not this server), publishing is one command run from the **app's** project root:

```bash
# In the app's repo, not this one:
cp scripts/.env.example .env
```

```dotenv
# app repo's .env
OTA_SERVER_URL=https://your-ota-server.example.com   # or http://localhost:3001 for local testing
OTA_PUBLISH_TOKEN=choose-a-long-random-secret-here    # must match this server's PUBLISH_TOKEN
```

```bash
npm run ota:publish -- production
```

The `production` argument is the **channel** — use whatever channel name your build was configured with (`eas.json` build profiles typically map to `development` / `preview` / `production`). This command:

1. Runs `expo export --platform android` to produce a fresh JS bundle + assets.
2. Zips the export output.
3. `POST`s it to `<OTA_SERVER_URL>/publish` with the token in the `x-publish-token` header.

On success it prints the published `runtimeVersion`, `channel`, and `timestamp`.

### Option B — publishing without the script (custom CI, another language, etc.)

Any client that can make an HTTP request can publish, by following this contract:

1. Run `npx expo export --platform android --output-dir <dir>` (or `ios`, or both) in the app's project to produce an export directory containing `metadata.json`, the JS bundle, and asset files.
2. Zip the **contents** of that directory (not the directory itself — `metadata.json` must be at the zip's root).
3. `POST` the zip's bytes to:

   ```
   POST /publish?runtimeVersion=<runtimeVersion>&channel=<channel>
   Content-Type: application/zip
   x-publish-token: <PUBLISH_TOKEN>

   <raw zip bytes>
   ```

   Example with `curl`:

   ```bash
   curl -X POST \
     "https://your-ota-server.example.com/publish?runtimeVersion=2.2.2&channel=production" \
     -H "Content-Type: application/zip" \
     -H "x-publish-token: $PUBLISH_TOKEN" \
     --data-binary @export.zip
   ```

4. A `200` response confirms success:

   ```json
   { "runtimeVersion": "2.2.2", "channel": "production", "timestamp": "1790668658759", "targetDir": "..." }
   ```

See [API reference](#api-reference) for error responses.

### After publishing

The installed app picks up the new bundle automatically the next time it's opened, **without any manual action** — this relies on `expo-updates`' default `checkOnLaunch` behavior:

- **1st launch after publish:** the app checks in the background, downloads the new bundle silently, and keeps running the version it already had.
- **2nd launch:** the app now runs the newly downloaded bundle.

Leave 5–10 seconds between relaunches during testing so the download has time to finish before the app is closed again.

## Web dashboard

Open the server's root URL in a browser:

```
http://localhost:3001
```

It lists every published update — runtime version, channel, timestamp, manifest ID, and creation time — with a **Delete** button per row to remove an old update from disk. The dashboard has no authentication; treat access to it the same as access to the server itself (see [Security](#security)).

## API reference

| Method & path | Purpose | Auth |
|---|---|---|
| `GET /api/manifest` | Called by the `expo-updates` client. Reads `expo-platform`, `expo-runtime-version`, `expo-channel-name`, `expo-current-update-id` request headers; returns the latest manifest for that runtime/channel, or a `noUpdateAvailable` directive if the client is already current. | None (this is the public endpoint apps talk to) |
| `GET /api/assets` | Called by the `expo-updates` client to download the JS bundle and asset files referenced by a manifest. | None |
| `POST /publish` | Publishes a new update. See [Publishing an update](#publishing-an-update). | `x-publish-token` header, must match `PUBLISH_TOKEN` |
| `GET /` | Web dashboard — lists published updates. | None |
| `POST /updates/:runtimeVersion/:channel/:timestamp/delete` | Deletes one published update (used by the dashboard's Delete button). | None |

**`POST /publish` error responses:**

| Status | Meaning |
|---|---|
| `400` | Invalid `runtimeVersion`/`channel` (must match `[A-Za-z0-9._-]+`, no `.`/`..`), missing/empty body, or the uploaded archive has no `metadata.json` at its root. |
| `401` | Missing or incorrect `x-publish-token`. |
| `501` | The server has no `PUBLISH_TOKEN` configured — publishing is disabled entirely until you set one. |

## Storage layout

Everything published lives under `updates/` (gitignored — this is runtime data, not source):

```
updates/
  <runtimeVersion>/
    <channel>/
      <timestamp>/
        metadata.json     # produced by `expo export`
        _expo/...          # JS bundle
        assets/...          # images, fonts, etc.
```

The server always serves the most recently created `<timestamp>` folder for a given `<runtimeVersion>/<channel>`. Deleting a timestamp folder (via the dashboard or by hand) makes the previous one the new "latest."

## Deploying remotely

To run this somewhere other than your own machine (a VPS, a small cloud instance, etc.):

1. Copy this whole directory (or clone the repo) to the target machine.
2. `npm install`
3. Create `.env` with a `PUBLISH_TOKEN` on that machine.
4. Run it under a process manager so it survives reboots/crashes, e.g.:

   ```bash
   npm install -g pm2
   pm2 start server.js --name ota-server
   pm2 save
   ```

5. Put it behind a reverse proxy that terminates HTTPS (nginx, Caddy, or a platform load balancer) and forwards to `http://localhost:3001`. The server already sets `trust proxy` so it correctly reports `https://` asset URLs when it sees `X-Forwarded-Proto` from a proxy.
6. Point the app's `app.json` → `updates.url` and the publisher's `OTA_SERVER_URL` at this server's public HTTPS URL.

**A plain HTTP origin will not work for a release build of the app** — Android and iOS both block plaintext HTTP traffic for anything other than `localhost` by default. Always serve this over HTTPS once it's reachable from outside your own machine.

## Security

This server is intentionally a lightweight proof of concept. Before treating it as production infrastructure, be aware of what it does **not** do:

- **No code signing.** `expo-updates` supports verifying a cryptographic signature on every manifest/asset; this server doesn't produce one. Anyone who can reach `/api/manifest` and `/api/assets` — and anyone who can publish — has an unauthenticated path to changing what code your users' apps run. Keep the server on a trusted network or behind additional access control if this matters for your deployment.
- **The dashboard has no login.** Anyone who can reach `GET /` can see and delete published updates.
- **`PUBLISH_TOKEN` is a single shared secret**, not per-user credentials — anyone with the token can publish. Rotate it (and redistribute it) if it may have leaked.
- **No rate limiting.**

None of this is unusual for an internal tool on a trusted network, but don't expose this server's ports directly to the public internet without adding the protections above first.

## Troubleshooting

**"Publishing is disabled" (`501`)** — the server has no `PUBLISH_TOKEN` in its `.env`. Set one and restart the server.

**"Invalid or missing publish token" (`401`)** — the token sent by the publisher doesn't match this server's `PUBLISH_TOKEN`. Check both `.env` files for typos/whitespace.

**App never shows the update** — confirm:
1. `app.json`'s `updates.url` on the *installed* build actually points at this server (changing `app.json` after a build has no effect on already-installed apps — you must rebuild).
2. The app was opened **twice** after publishing, with a few seconds in between.
3. The published `runtimeVersion` matches the app's own runtime version exactly (`expo config` / `app.json`'s `version`, if using the `appVersion` runtime policy).
4. The build isn't a dev-client build — `expo-updates` intentionally disables update checks (`ERR_NOT_AVAILABLE_IN_DEV_CLIENT`) on those.

**Gradle build runs out of memory (`OutOfMemoryError: Metaspace`)** — this is unrelated to this server; it's a local Android build issue. Increase the Kotlin compiler's memory ceiling before building:

```bash
export JAVA_TOOL_OPTIONS="-XX:MaxMetaspaceSize=3072m"
```

## Testing

```bash
npm test
```

Runs the full suite with Node's built-in test runner (`node --test`) — no separate test framework required.
