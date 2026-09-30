# OTA Client Setup

Guide to configure `react-native-base` to **receive** updates from the server described in
[`OTA_SERVER.md`](OTA_SERVER.md). Read that file first — you need a running server and a
`PUBLISH_TOKEN` before continuing.

**Convention:** `<OTA_SERVER_URL>` = the base URL the app uses to reach the server
(`http://<device-ip>:3001` when testing over LAN, or your production domain).

This document stops at the `checkForUpdate()`/`downloadAndApplyUpdate()` utility layer.
Wiring that into your UI (Settings screen, debug panel, etc.) is an app-level decision.

## Table of Contents

1. [Install `expo-updates`](#1-install-expo-updates)
2. [Configure `app.json`](#2-configure-appjson)
3. [Publish script](#3-publish-script)
4. [Check / apply update utility](#4-check--apply-update-utility)
5. [Build, test, day-to-day workflow](#5-build-test-day-to-day-workflow)
6. [Troubleshooting](#6-troubleshooting)

---

## 1. Install `expo-updates`

```bash
npx expo install expo-updates
```

---

## 2. Configure `app.json`

```json
{
  "runtimeVersion": { "policy": "appVersion" },
  "updates": {
    "url": "<OTA_SERVER_URL>/api/manifest",
    "fallbackToCacheTimeout": 5000,
    "codeSigningCertificate": "./keys/certificate.pem",
    "codeSigningMetadata": {
      "keyid": "main",
      "alg": "rsa-v1_5-sha256"
    }
  }
}
```

`runtimeVersion.policy: "appVersion"` — the app only accepts OTA bundles whose
`runtimeVersion` exactly matches the `version` field in `app.json`. Changing `updates.url`
after a build has **no effect** on installed apps — you must rebuild.

`codeSigningCertificate` — path to the public certificate embedded into the APK at build
time. Must match the certificate on the server. See [`OTA_CODE_SIGNING.md`](OTA_CODE_SIGNING.md)
for details.

`fallbackToCacheTimeout` controls how many app opens before the update is visible:

| Value | Splash behaviour | Opens needed |
|---|---|---|
| Not set (default `0`) | No wait; enters immediately on cached bundle; new bundle downloads in background | **2 opens** — 1st downloads, 2nd applies |
| `5000` (ms) | Waits up to 5 s to finish download before hiding Splash; falls back to cache if timeout exceeded | **1 open** |

This is a **native** config (`expo prebuild` writes `EXPO_UPDATES_LAUNCH_WAIT_MS` into
`AndroidManifest.xml` / `EXUpdatesLaunchWaitMs` into `Expo.plist`). Changing this value
**requires a native rebuild** — installed apps are not affected.

**Only when testing over plain HTTP / LAN** (skip if the server has real HTTPS):
Android release builds block cleartext HTTP by default, even to `localhost`. Enable via
`expo-build-properties` (already present in the project):

```json
{
  "plugins": [
    ["expo-build-properties", { "android": { "usesCleartextTraffic": true } }]
  ]
}
```

**Do not** place `usesCleartextTraffic` inside the root `android` block — Expo silently
ignores it there, causing `Failed to download remote update` in logcat even though `curl`
from the device works fine.

---

## 3. Publish script

`scripts/publish.js`:

```js
#!/usr/bin/env node
/**
 * node scripts/publish.js [channel]
 * Requires OTA_PUBLISH_URL and OTA_PUBLISH_TOKEN in .env — see .env.example.
 */
const AdmZip = require("adm-zip")
const { execSync } = require("child_process")
const dotenv = require("dotenv")
const fs = require("fs")
const path = require("path")

dotenv.config({ path: path.join(__dirname, "..", ".env") })

const PROJECT_ROOT = path.resolve(__dirname, "..")
const EXPORT_TMP_DIR = path.join(__dirname, ".export-tmp")

function readRuntimeVersion(appJsonPath = path.join(PROJECT_ROOT, "app.json")) {
  const appJson = JSON.parse(fs.readFileSync(appJsonPath, "utf-8"))
  if (!appJson.version) throw new Error(`Could not read "version" from ${appJsonPath}`)
  return appJson.version
}

function createZipBuffer(sourceDir) {
  const zip = new AdmZip()
  zip.addLocalFolder(sourceDir)
  return zip.toBuffer()
}

async function uploadBundle({ serverUrl, token, runtimeVersion, channel, zipBuffer }) {
  const url = `${serverUrl.replace(/\/$/, "")}/publish?runtimeVersion=${encodeURIComponent(runtimeVersion)}&channel=${encodeURIComponent(channel)}`
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/zip", "x-publish-token": token || "" },
    body: zipBuffer,
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(`Publish failed (${res.status}): ${body.error || res.statusText}`)
  return body
}

function runExpoExport(outputDir) {
  fs.rmSync(outputDir, { recursive: true, force: true })
  execSync(`npx expo export --platform android --output-dir ${outputDir}`, {
    cwd: PROJECT_ROOT,
    stdio: "inherit",
  })
}

async function main() {
  const channel = process.argv[2] || "production"
  const runtimeVersion = readRuntimeVersion()
  const serverUrl = process.env.OTA_PUBLISH_URL || process.env.OTA_SERVER_URL || "http://localhost:3001"
  const token = process.env.OTA_PUBLISH_TOKEN
  if (!token) throw new Error("OTA_PUBLISH_TOKEN is not set. See .env.example.")

  runExpoExport(EXPORT_TMP_DIR)
  const zipBuffer = createZipBuffer(EXPORT_TMP_DIR)
  fs.rmSync(EXPORT_TMP_DIR, { recursive: true, force: true })

  const result = await uploadBundle({ serverUrl, token, runtimeVersion, channel, zipBuffer })
  console.log(`Published update: ${JSON.stringify(result)}`)
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message)
    process.exitCode = 1
  })
}
```

`.env.example` (root of the `rn` project):

```dotenv
# URL app uses to fetch manifests (4G/5G/Wi-Fi — must be reachable from device)
OTA_SERVER_URL=<device-accessible URL, e.g. http://192.168.x.x:3001>

# URL the publish script uses to upload bundles (local machine → server)
OTA_PUBLISH_URL=http://localhost:3001

OTA_PUBLISH_TOKEN=<PUBLISH_TOKEN from ota-server .env>
```

Install dependencies and register the npm script:

```bash
pnpm add -D adm-zip dotenv
```

```json
{ "scripts": { "ota:publish": "node scripts/publish.js" } }
```

---

## 4. Check / apply update utility

`app/utils/AppUpdates.ts`:

```ts
import * as Updates from "expo-updates"

export type CheckForUpdateResult =
  | { status: "disabled" }
  | { status: "up-to-date" }
  | { status: "available" }
  | { status: "error"; error: unknown }

// "disabled" when: (1) app.json is missing updates.url/runtimeVersion, or
// (2) running in dev client (expo run:android) — only release builds check for real.
export async function checkForUpdate(): Promise<CheckForUpdateResult> {
  if (!Updates.isEnabled) return { status: "disabled" }

  try {
    const result = await Updates.checkForUpdateAsync()
    return result.isAvailable ? { status: "available" } : { status: "up-to-date" }
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ERR_NOT_AVAILABLE_IN_DEV_CLIENT") {
      return { status: "disabled" }
    }
    return { status: "error", error }
  }
}

// Download and apply immediately instead of waiting for the next app launch (expo-updates default).
export async function downloadAndApplyUpdate(): Promise<void> {
  await Updates.fetchUpdateAsync()
  await Updates.reloadAsync()
}
```

---

## 5. Build, test, day-to-day workflow

After completing steps 1–3 (native changes) — build once:

```bash
pnpm install
npx expo prebuild --platform android --no-install
# build release APK (from android/ directory)
cd android && ./gradlew assembleRelease
```

Install on device, connect to the server (see `OTA_SERVER.md` step 2), then call
`checkForUpdate()` somewhere (e.g. a temporary `console.log` on startup) — the result must
be `"up-to-date"` or `"available"`, not `"disabled"` or `"error"`.

**From here on, no native rebuild is needed** for pure JS/asset changes:

```bash
pnpm run ota:publish production
```

Open the app on your device **2 times** (~10 seconds apart): the 1st launch downloads in
the background, the 2nd launch runs the new bundle — or **1 time** if you set
`fallbackToCacheTimeout` (step 2).

---

## 6. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Status always `"disabled"` | `Updates.isEnabled === false` | Check `app.json` has `updates.url` and `runtimeVersion`; or running dev client — only release builds check |
| `ota:publish` reports missing `OTA_PUBLISH_TOKEN` | `.env` not created | Copy `.env.example` to `.env` and fill in the values |
| Publish returns `401`/`501` | Wrong token / server not configured | See [`OTA_SERVER.md` §8](OTA_SERVER.md#8-troubleshooting) |
| App does not receive update after successful publish | `updates.url` in the installed build does not point to the server, or `runtimeVersion` mismatch | Changing `app.json` after a build has no effect — rebuild required |
| Android: connection error in `adb logcat` when using `adb reverse` | Missing or misplaced `usesCleartextTraffic` | Confirm it lives inside `expo-build-properties`, not the root `android` block — then rebuild |
| Android: `CertificateException` / `CodeSigningError` in logcat | Certificate missing required X.509 extensions or cert mismatch between server and app | See [`OTA_CODE_SIGNING.md` §6](OTA_CODE_SIGNING.md#6-troubleshooting) |

Server-side errors (channel fallback, rollback, etc.) — see [`OTA_SERVER.md`](OTA_SERVER.md).
