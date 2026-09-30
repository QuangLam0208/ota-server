# OTA Server

A self-hosted, lightweight Over-The-Air (OTA) update server fully compliant with the
[Expo Updates Protocol (v1)](https://docs.expo.dev/technical-specs/expo-updates-1/).

Delivers JavaScript bundle and asset updates to React Native / Expo apps using `expo-updates`
**without EAS Update, app store review, or native APK/AAB rebuilds**.

---

## Key Features

- **Expo Updates Protocol v1**: multipart/mixed manifest responses, `directive` payloads, asset streaming, RSA-SHA256 code signing.
- **Docker-first**: Alpine Linux container with `./updates` and `./keys` volume mounts for persistence and code signing keys.
- **Rollback in ~100 ms**: instant re-publish endpoint clones any existing version as the new latest without a rebuild.
- **Strict version isolation**: updates segregated by `runtimeVersion` and `channel`.
- **Zero database**: all metadata and assets live on disk.
- **Path traversal protection**: all user-supplied path parameters are validated.
- **51 automated tests**: `npm test`.

---

## Requirements

- **Node.js** ≥ 18
- **Docker & Docker Compose** (recommended)
- **React Native / Expo app** with `expo-updates` configured

---

## Quick Start

```bash
npm install
cp .env.example .env   # fill in PUBLISH_TOKEN (and optionally PRIVATE_KEY_PATH, KEY_ID)
docker compose up -d --build
```

Open [http://localhost:3001](http://localhost:3001) for the web dashboard.

```bash
npm test   # run automated test suite (51 tests)
```

---

## Documentation

| Document | Contents |
|---|---|
| [`docs/OTA_SERVER.md`](docs/OTA_SERVER.md) | Full API reference, environment variables, Docker setup, rollback, storage layout, troubleshooting |
| [`docs/OTA_CLIENT_SETUP.md`](docs/OTA_CLIENT_SETUP.md) | React Native `app.json` config, publish script, `checkForUpdate()` utility, day-to-day workflow |
| [`docs/OTA_CODE_SIGNING.md`](docs/OTA_CODE_SIGNING.md) | RSA key generation (openssl), server signing setup, app verification, key rotation |

---

## Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `PORT` | No | `3001` | HTTP server port |
| `PUBLISH_TOKEN` | Yes | — | Shared secret for `POST /publish`. Missing → returns `501` |
| `PRIVATE_KEY_PATH` | No | — | Path to RSA private key PEM for code signing. Missing → manifests are unsigned |
| `KEY_ID` | No | `main` | `keyid` embedded in the `expo-signature` header |

---

## API Summary

| Method & Path | Auth | Description |
|---|---|---|
| `GET /api/manifest` | Public | Queried by `expo-updates` on every app launch |
| `GET /api/assets` | Public | Streams JS bundle or asset files referenced by the manifest |
| `POST /publish` | `x-publish-token` header | Upload a new update bundle (`.zip` from `expo export`) |
| `GET /` | Public | Web dashboard |
| `POST /updates/:rv/:ch/:ts/republish` | Public | Instant rollback — clone a version as a new entry |
| `POST /updates/:rv/:ch/:ts/delete` | Public | Delete a specific version |

See [`docs/OTA_SERVER.md`](docs/OTA_SERVER.md) for full details.
