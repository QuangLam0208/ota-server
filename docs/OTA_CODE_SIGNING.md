# OTA Code Signing

RSA-SHA256 signing of the manifests and directives returned by `ota-server` — fully compliant
with [Expo Updates Protocol v1 (Code Signing)](https://docs.expo.dev/technical-specs/expo-updates-1/#code-signing).
Read [`OTA_SERVER.md`](OTA_SERVER.md) first if you are not yet familiar with this server.

## Table of Contents

1. [Purpose](#1-purpose)
2. [Where the keys live](#2-where-the-keys-live)
3. [Server setup](#3-server-setup)
4. [App setup](#4-app-setup)
5. [How it works](#5-how-it-works)
6. [Troubleshooting](#6-troubleshooting)
7. [Key rotation](#7-key-rotation)

---

## 1. Purpose

By default `/api/manifest`/`/api/assets` are **unauthenticated** — anyone who can intercept
the connection (MITM, public Wi-Fi, rogue DNS) can substitute the JS code the app downloads
and runs. Code signing solves exactly one problem: the app **verifies the signature** before
executing any code — if the signature is wrong the update is rejected and the current bundle
is kept.

```
Server has PRIVATE KEY  → signs manifest before sending
App has PUBLIC KEY (embedded at build time)  → verifies signature before running code
```

---

## 2. Where the keys live

| File | Location | Role | Commit to git? |
|---|---|---|---|
| `private-key.pem` | `ota-server/keys/private-key.pem` | **Secret** — server uses it to **sign** | ❌ `.gitignore` |
| `certificate.pem` | `ota-server/keys/certificate.pem` **and** `rn/keys/certificate.pem` | **Public** — app uses it to **verify**, must exist in both locations | ✅ Yes |

The private key **never leaves the server**. The certificate (public) must be copied to the
app project because `app.json` references it at build time and it is bundled directly into the
APK/IPA.

---

## 3. Server setup

### 3.1 Generate a key pair

Use `openssl` with the Git-bundled config file (required on Windows) and the two X.509
extensions that `expo-updates` enforces:

```bash
# Generate private key
openssl genrsa -out keys/private-key.pem 2048

# Generate self-signed certificate with required extensions
openssl req -new -x509 \
  -key keys/private-key.pem \
  -out keys/certificate.pem \
  -days 3650 \
  -subj "/CN=BaseApp OTA Code Signing" \
  -config "C:\Program Files\Git\usr\ssl\openssl.cnf" \
  -addext "keyUsage = digitalSignature" \
  -addext "extendedKeyUsage = codeSigning"
```

> **Why the extra flags?** `expo-updates` Android (`CertificateChain.kt`) checks both
> `keyUsage[0]` (Digital Signature) **and** `extendedKeyUsage` OID `1.3.6.1.5.5.7.3.3`
> (Code Signing). A plain `openssl req -x509` without `-addext` produces a cert that lacks
> these extensions, causing a silent `CertificateException` on the device — the app falls
> back to the embedded bundle with no visible error. The `-config` flag is required on
> Windows where `openssl` cannot find its config file automatically.

### 3.2 Copy cert to the app and configure the server

```bash
cp ota-server/keys/certificate.pem rn/keys/certificate.pem
```

The server reads the private key path from `.env`:

```dotenv
PRIVATE_KEY_PATH=./keys/private-key.pem
KEY_ID=main
```

The `keys/` directory is mounted into the Docker container as a read-only volume
(`./keys:/app/keys:ro` in `docker-compose.yml`) — no manual copy into the container needed.
Restart the container after changing the key:

```bash
docker compose up -d --build
```

### 3.3 Server-side signing code

`server.js` calls `signManifest(payloadString, privateKeyPemPath, keyId)` which uses
`crypto.createSign("RSA-SHA256")` and returns an `expo-signature` header in
[Structured Field Values](https://www.rfc-editor.org/rfc/rfc8941) format:

```
sig="<base64>", keyid="main", alg="rsa-v1_5-sha256"
```

The signature is applied to **both response types** of `/api/manifest`: the `manifest` part
(update available) and the `directive` part (`noUpdateAvailable`). Signing only one of them
would let an attacker spoof the "nothing new" directive to block legitimate updates.

**Important:** the string that is signed and the string actually sent over the wire must be
**the same variable** — calling `JSON.stringify()` twice on the same object risks byte-level
differences that cause client-side verify failures even when the content looks identical.

---

## 4. App setup

`app.json`:

```json
{
  "updates": {
    "url": "<OTA_SERVER_URL>/api/manifest",
    "codeSigningCertificate": "./keys/certificate.pem",
    "codeSigningMetadata": {
      "keyid": "main",
      "alg": "rsa-v1_5-sha256"
    }
  }
}
```

This is a **native** change — run `expo prebuild` and rebuild the app; it cannot be applied
via OTA. During the build Expo reads `codeSigningCertificate`, bundles the cert into the
APK/IPA, and writes two `meta-data` entries into `AndroidManifest.xml` so `expo-updates`
knows which certificate and algorithm to use.

No changes to `app/utils/AppUpdates.ts` are needed — verification is entirely at the native
layer; JS calls `Updates.checkForUpdateAsync()` the same as before.

After changing `certificate.pem` you must run prebuild again and rebuild the app:

```bash
npx expo prebuild --platform android --no-install
cd android && ./gradlew assembleRelease
```

---

## 5. How it works

1. App calls `/api/manifest` as usual.
2. Server signs the JSON string of the response with `private-key.pem` and attaches the
   `expo-signature` header to the matching multipart part (`manifest` or `directive`).
3. The `expo-updates` native module verifies the signature against the embedded certificate,
   comparing **the exact raw bytes** of the received body (not a re-serialized parse).
4. Valid → proceed to download assets. Invalid / missing → `CodeSigningSignatureValidationException`,
   no download, current bundle is kept.

`keyid` in the header (`"main"`) tells the app **which certificate** among the ones it holds
to use for verification — only truly needed when multiple keys coexist (see [§7](#7-key-rotation)).

---

## 6. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `CodeSigningError`, stack trace stops at `CertificateChain.kt` (fails at cert parse) | Cert missing `keyUsage`/`extKeyUsage` extensions (generated with plain `openssl` without `-addext`) | Regenerate with the command in §3.1, run `expo prebuild`, rebuild app |
| `CodeSigningError`, stack trace stops at `FileDownloader.checkCodeSigningAndCreateManifest` (cert OK, signature verify fails) | Signed string and sent string are not byte-identical (two separate `JSON.stringify` calls) | Ensure `sendMultipart()` receives the **already-serialized string** that was signed, not a re-serialized one |
| `Key with keyid=... from signature not found in client configuration` | `keyid` in `app.json` does not match `keyid` server puts in the signature header | Align both sides to the same value (`"main"` by default) |
| App does not receive updates, no signing error in logcat | `private-key.pem` missing on server → server skips signing (unsigned mode) | `docker exec ota-server ls /app/keys/` and verify both files exist |
| `CertificateException: First certificate in chain is not a code signing certificate` | Certificate lacks the required extensions | Regenerate using §3.1, prebuild and rebuild |

---

## 7. Key rotation

When you need to rotate the key pair (suspected leak or scheduled rotation):

1. Generate a new pair with a different `keyid` (e.g. `"v2"`) — both the server signing config
   and `app.json` on the client side must be updated simultaneously.
2. Build and distribute the app with the new certificate **before** switching the server to sign
   with the new key — prevents older app versions (that don't have the new cert) from receiving
   a signature they cannot verify.
3. If you suspect the private key has been compromised: publish a new native build immediately
   (bump `runtimeVersion`) with a completely new certificate, and decommission the old key —
   individual OTA updates already signed cannot be revoked.
