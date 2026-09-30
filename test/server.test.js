const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const { test } = require("node:test")
const assert = require("node:assert/strict")

const { createApp } = require("../server")

function setUpFixture() {
  const updatesRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ota-updates-"))
  const bundleDir = path.join(updatesRoot, "2.2.2", "production", "1000")
  fs.mkdirSync(bundleDir, { recursive: true })
  fs.writeFileSync(path.join(bundleDir, "bundle.js"), "console.log('v1')")
  fs.writeFileSync(
    path.join(bundleDir, "metadata.json"),
    JSON.stringify({
      version: 0,
      bundler: "metro",
      fileMetadata: { android: { bundle: "bundle.js", assets: [] } },
    }),
  )
  return { updatesRoot, bundleDir }
}

async function withServer(updatesRoot, run) {
  const app = createApp({ updatesRoot })
  const server = app.listen(0)
  const { port } = server.address()
  try {
    await run(`http://localhost:${port}`)
  } finally {
    server.close()
  }
}

function getBoundary(contentType) {
  const match = contentType.match(/boundary=(.+)$/)
  return match[1]
}

function extractPart(rawBody, boundary, partName) {
  const parts = rawBody.split(`--${boundary}`)
  const part = parts.find((p) => p.includes(`name="${partName}"`))
  if (!part) return null
  const jsonStart = part.indexOf("{")
  const jsonEnd = part.lastIndexOf("}")
  return JSON.parse(part.slice(jsonStart, jsonEnd + 1))
}

test("manifest endpoint rejects a request with no platform header", async () => {
  const { updatesRoot } = setUpFixture()
  await withServer(updatesRoot, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/manifest`, {
      headers: { "expo-runtime-version": "2.2.2" },
    })
    assert.equal(res.status, 400)
  })
})

test("manifest endpoint returns a manifest part for a known runtimeVersion/channel", async () => {
  const { updatesRoot } = setUpFixture()
  await withServer(updatesRoot, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/manifest`, {
      headers: {
        "expo-platform": "android",
        "expo-runtime-version": "2.2.2",
        "expo-channel-name": "production",
      },
    })
    assert.equal(res.status, 200)

    const boundary = getBoundary(res.headers.get("content-type"))
    const manifest = extractPart(await res.text(), boundary, "manifest")

    assert.equal(manifest.runtimeVersion, "2.2.2")
    assert.equal(manifest.launchAsset.contentType, "application/javascript")
    assert.match(manifest.id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
  })
})

test("manifest endpoint returns https asset URLs when behind a proxy with x-forwarded-proto: https", async () => {
  const { updatesRoot } = setUpFixture()
  await withServer(updatesRoot, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/manifest`, {
      headers: {
        "expo-platform": "android",
        "expo-runtime-version": "2.2.2",
        "expo-channel-name": "production",
        "x-forwarded-proto": "https",
      },
    })
    assert.equal(res.status, 200)

    const boundary = getBoundary(res.headers.get("content-type"))
    const manifest = extractPart(await res.text(), boundary, "manifest")

    assert.ok(
      manifest.launchAsset.url.startsWith("https://"),
      `expected launchAsset.url to start with https://, got ${manifest.launchAsset.url}`,
    )
  })
})

test("manifest endpoint returns 404 (not a crash) when the platform has no build in this update's metadata", async () => {
  const { updatesRoot } = setUpFixture()
  await withServer(updatesRoot, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/manifest`, {
      headers: {
        "expo-platform": "ios",
        "expo-runtime-version": "2.2.2",
        "expo-channel-name": "production",
      },
    })
    assert.equal(res.status, 404)
    const body = await res.json()
    assert.match(body.error, /ios/)
  })
})

test("manifest endpoint returns noUpdateAvailable when expo-current-update-id matches the latest manifest", async () => {
  const { updatesRoot } = setUpFixture()
  await withServer(updatesRoot, async (baseUrl) => {
    const first = await fetch(`${baseUrl}/api/manifest`, {
      headers: { "expo-platform": "android", "expo-runtime-version": "2.2.2" },
    })
    const firstBoundary = getBoundary(first.headers.get("content-type"))
    const manifest = extractPart(await first.text(), firstBoundary, "manifest")

    const second = await fetch(`${baseUrl}/api/manifest`, {
      headers: {
        "expo-platform": "android",
        "expo-runtime-version": "2.2.2",
        "expo-current-update-id": manifest.id,
      },
    })
    assert.equal(second.status, 200)
    const secondBoundary = getBoundary(second.headers.get("content-type"))
    const directive = extractPart(await second.text(), secondBoundary, "directive")

    assert.equal(directive.type, "noUpdateAvailable")
  })
})

test("assets endpoint serves the launch asset bytes", async () => {
  const { updatesRoot, bundleDir } = setUpFixture()
  await withServer(updatesRoot, async (baseUrl) => {
    const assetPath = path.join(bundleDir, "bundle.js")
    const res = await fetch(
      `${baseUrl}/api/assets?asset=${encodeURIComponent(
        assetPath,
      )}&runtimeVersion=2.2.2&platform=android&channel=production`,
    )
    assert.equal(res.status, 200)
    assert.equal(res.headers.get("content-type"), "application/javascript")
    const text = await res.text()
    assert.equal(text, "console.log('v1')")
  })
})

test("assets endpoint rejects an asset path outside the update bundle directory (path traversal)", async () => {
  const { updatesRoot } = setUpFixture()
  const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "ota-outside-"))
  const secretPath = path.join(outsideDir, "secret.txt")
  const secretContents = "TOP-SECRET-CONTENTS-SHOULD-NEVER-BE-SERVED"
  fs.writeFileSync(secretPath, secretContents)

  await withServer(updatesRoot, async (baseUrl) => {
    const res = await fetch(
      `${baseUrl}/api/assets?asset=${encodeURIComponent(
        secretPath,
      )}&runtimeVersion=2.2.2&platform=android&channel=production`,
    )
    assert.equal(res.status, 400)
    const body = await res.text()
    assert.ok(!body.includes(secretContents))
  })
})

test("assets endpoint returns 404 (not a crash) when the platform has no build in this update's metadata", async () => {
  const { updatesRoot, bundleDir } = setUpFixture()
  await withServer(updatesRoot, async (baseUrl) => {
    const assetPath = path.join(bundleDir, "bundle.js")
    const res = await fetch(
      `${baseUrl}/api/assets?asset=${encodeURIComponent(
        assetPath,
      )}&runtimeVersion=2.2.2&platform=ios&channel=production`,
    )
    assert.equal(res.status, 404)
    const body = await res.json()
    assert.match(body.error, /ios/)
  })
})

test("assets endpoint returns 404 for an asset not registered in the update's metadata", async () => {
  const { updatesRoot, bundleDir } = setUpFixture()
  const unregisteredPath = path.join(bundleDir, "unregistered.png")
  fs.writeFileSync(unregisteredPath, "not-a-real-image")

  await withServer(updatesRoot, async (baseUrl) => {
    const res = await fetch(
      `${baseUrl}/api/assets?asset=${encodeURIComponent(
        unregisteredPath,
      )}&runtimeVersion=2.2.2&platform=android&channel=production`,
    )
    assert.equal(res.status, 404)
  })
})

test("dashboard root page lists published updates", async () => {
  const { updatesRoot } = setUpFixture()
  await withServer(updatesRoot, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/`)
    assert.equal(res.status, 200)
    assert.match(res.headers.get("content-type"), /text\/html/)
    const html = await res.text()
    assert.match(html, /2\.2\.2/)
    assert.match(html, /production/)
    assert.match(html, /1000/)
    assert.match(html, /<form/)
  })
})

test("dashboard root page shows an empty state when nothing has been published", async () => {
  const updatesRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ota-updates-"))
  await withServer(updatesRoot, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/`)
    assert.equal(res.status, 200)
    const html = await res.text()
    assert.match(html, /Chưa có bản nào/)
  })
})

test("POST /updates/:runtimeVersion/:channel/:timestamp/delete removes the update and redirects", async () => {
  const { updatesRoot, bundleDir } = setUpFixture()
  await withServer(updatesRoot, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/updates/2.2.2/production/1000/delete`, {
      method: "POST",
      redirect: "manual",
    })
    assert.equal(res.status, 302)
    assert.equal(res.headers.get("location"), "/")
    assert.equal(fs.existsSync(bundleDir), false)
  })
})

test("POST delete rejects a path-traversal attempt in the URL segments", async () => {
  const { updatesRoot, bundleDir } = setUpFixture()
  await withServer(updatesRoot, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/updates/2.2.2/production/..%2f..%2f..%2fetc/delete`, {
      method: "POST",
      redirect: "manual",
    })
    assert.equal(res.status, 400)
    assert.ok(fs.existsSync(bundleDir))
  })
})

const AdmZip = require("adm-zip")

function fixtureZipBuffer() {
  const sourceDir = fs.mkdtempSync(path.join(os.tmpdir(), "ota-export-"))
  fs.writeFileSync(
    path.join(sourceDir, "metadata.json"),
    JSON.stringify({
      version: 0,
      bundler: "metro",
      fileMetadata: { android: { bundle: "bundle.js", assets: [] } },
    }),
  )
  fs.writeFileSync(path.join(sourceDir, "bundle.js"), "console.log('v1')")
  const zip = new AdmZip()
  zip.addLocalFolder(sourceDir)
  return zip.toBuffer()
}

async function withPublishServer({ updatesRoot, publishToken }, run) {
  const app = createApp({ updatesRoot, publishToken })
  const server = app.listen(0)
  const { port } = server.address()
  try {
    await run(`http://localhost:${port}`)
  } finally {
    server.close()
  }
}

test("POST /publish returns 501 when the server has no publish token configured", async () => {
  const updatesRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ota-updates-"))
  // Explicit "" (not undefined) so this doesn't fall back to process.env.PUBLISH_TOKEN
  // via the createApp default parameter if a real .env happens to be present locally.
  await withPublishServer({ updatesRoot, publishToken: "" }, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/publish?runtimeVersion=2.2.2&channel=production`, {
      method: "POST",
      headers: { "content-type": "application/zip", "x-publish-token": "anything" },
      body: fixtureZipBuffer(),
    })
    assert.equal(res.status, 501)
  })
})

test("POST /publish returns 401 when the token is missing or wrong", async () => {
  const updatesRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ota-updates-"))
  await withPublishServer({ updatesRoot, publishToken: "secret-token" }, async (baseUrl) => {
    const noToken = await fetch(`${baseUrl}/publish?runtimeVersion=2.2.2&channel=production`, {
      method: "POST",
      headers: { "content-type": "application/zip" },
      body: fixtureZipBuffer(),
    })
    assert.equal(noToken.status, 401)

    const wrongToken = await fetch(`${baseUrl}/publish?runtimeVersion=2.2.2&channel=production`, {
      method: "POST",
      headers: { "content-type": "application/zip", "x-publish-token": "wrong" },
      body: fixtureZipBuffer(),
    })
    assert.equal(wrongToken.status, 401)
  })
})

test("POST /publish rejects an invalid runtimeVersion/channel", async () => {
  const updatesRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ota-updates-"))
  await withPublishServer({ updatesRoot, publishToken: "secret-token" }, async (baseUrl) => {
    const res = await fetch(
      `${baseUrl}/publish?runtimeVersion=${encodeURIComponent("../../etc")}&channel=production`,
      {
        method: "POST",
        headers: { "content-type": "application/zip", "x-publish-token": "secret-token" },
        body: fixtureZipBuffer(),
      },
    )
    assert.equal(res.status, 400)
  })
})

test("POST /publish rejects an archive with no metadata.json", async () => {
  const updatesRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ota-updates-"))
  await withPublishServer({ updatesRoot, publishToken: "secret-token" }, async (baseUrl) => {
    const zip = new AdmZip()
    zip.addFile("readme.txt", Buffer.from("no metadata here"))

    const res = await fetch(`${baseUrl}/publish?runtimeVersion=2.2.2&channel=production`, {
      method: "POST",
      headers: { "content-type": "application/zip", "x-publish-token": "secret-token" },
      body: zip.toBuffer(),
    })
    assert.equal(res.status, 400)
  })
})

test("POST /publish extracts a valid zip and makes it the latest update for that runtimeVersion/channel", async () => {
  const updatesRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ota-updates-"))
  await withPublishServer({ updatesRoot, publishToken: "secret-token" }, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/publish?runtimeVersion=2.2.2&channel=production`, {
      method: "POST",
      headers: { "content-type": "application/zip", "x-publish-token": "secret-token" },
      body: fixtureZipBuffer(),
    })
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.runtimeVersion, "2.2.2")
    assert.equal(body.channel, "production")
    assert.ok(body.timestamp)

    const manifestRes = await fetch(`${baseUrl}/api/manifest`, {
      headers: { "expo-platform": "android", "expo-runtime-version": "2.2.2" },
    })
    assert.equal(manifestRes.status, 200)
  })
})

const crypto = require("node:crypto")
const { execSync } = require("node:child_process")

const defaultOpensslConf = [
  process.env.OPENSSL_CONF,
  "C:\\Program Files\\Git\\usr\\ssl\\openssl.cnf",
  "C:\\Program Files\\Git\\mingw64\\etc\\ssl\\openssl.cnf",
  "C:\\msys64\\usr\\ssl\\openssl.cnf",
].find((p) => p && fs.existsSync(p))

function makeTestKeypair() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ota-keys-"))
  const privateKeyPath = path.join(dir, "private-key.pem")
  const certificatePath = path.join(dir, "certificate.pem")
  const env = { ...process.env }
  if (defaultOpensslConf && !env.OPENSSL_CONF) {
    env.OPENSSL_CONF = defaultOpensslConf
  }
  execSync(`openssl genrsa -out "${privateKeyPath}" 2048`, { stdio: "pipe", env })
  execSync(
    `openssl req -new -x509 -key "${privateKeyPath}" -out "${certificatePath}" -days 1 -subj "/CN=test"`,
    { stdio: "pipe", env },
  )
  return { privateKeyPath, certificatePath }
}

function extractPartWithRaw(rawBody, boundary, partName) {
  const part = rawBody.split(`--${boundary}`).find((p) => p.includes(`name="${partName}"`))
  if (!part) return null
  const jsonStart = part.indexOf("{")
  const jsonEnd = part.lastIndexOf("}")
  const bodyString = part.slice(jsonStart, jsonEnd + 1)
  return {
    headersText: part.slice(0, jsonStart),
    bodyString,
    body: JSON.parse(bodyString),
  }
}

function parseSigHeader(headersText) {
  const match = headersText.match(/expo-signature: sig="([^"]+)"/)
  return match ? match[1] : null
}

const { convertSHA256HashToUUID } = require("../helpers")

test("POST .../republish clones the source update under a new timestamp and redirects to the dashboard", async () => {
  const updatesRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ota-updates-"))
  const bundleDir = path.join(updatesRoot, "2.2.2", "production", "1000")
  fs.mkdirSync(bundleDir, { recursive: true })
  const metadataText = JSON.stringify({ version: 0, bundler: "metro", fileMetadata: {} })
  fs.writeFileSync(path.join(bundleDir, "metadata.json"), metadataText)

  await withServer(updatesRoot, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/updates/2.2.2/production/1000/republish`, {
      method: "POST",
      redirect: "manual",
    })

    assert.equal(res.status, 302)
    assert.equal(res.headers.get("location"), "/")

    const channelDir = path.join(updatesRoot, "2.2.2", "production")
    const timestampDirs = fs.readdirSync(channelDir)
    assert.equal(timestampDirs.length, 2)

    const newTimestamp = timestampDirs.find((t) => t !== "1000")
    assert.ok(Number(newTimestamp) > 1000)
    assert.ok(
      fs.existsSync(path.join(channelDir, newTimestamp, "metadata.json")),
      "cloned update must contain the source's metadata.json",
    )
  })
})

test("POST .../republish returns 400 for a non-existent source timestamp", async () => {
  const updatesRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ota-updates-"))
  await withServer(updatesRoot, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/updates/2.2.2/production/9999/republish`, {
      method: "POST",
    })

    assert.equal(res.status, 400)
    assert.match(await res.text(), /Rollback failed/)
  })
})

test("POST .../republish rejects a path-traversal channel", async () => {
  const updatesRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ota-updates-"))
  const bundleDir = path.join(updatesRoot, "2.2.2", "production", "1000")
  fs.mkdirSync(bundleDir, { recursive: true })
  fs.writeFileSync(path.join(bundleDir, "metadata.json"), JSON.stringify({ version: 0, bundler: "metro", fileMetadata: {} }))

  await withServer(updatesRoot, async (baseUrl) => {
    const res = await fetch(
      `${baseUrl}/updates/2.2.2/${encodeURIComponent("../../etc")}/1000/republish`,
      { method: "POST" },
    )

    assert.equal(res.status, 400)
    assert.match(await res.text(), /Rollback failed/)
  })
})

test("GET /api/manifest signs the noUpdateAvailable directive when a private key is configured", async () => {
  const updatesRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ota-updates-"))
  const bundleDir = path.join(updatesRoot, "2.2.2", "production", "1000")
  fs.mkdirSync(bundleDir, { recursive: true })
  const metadataText = JSON.stringify({ version: 0, bundler: "metro", fileMetadata: {} })
  fs.writeFileSync(path.join(bundleDir, "metadata.json"), metadataText)
  const manifestId = convertSHA256HashToUUID(
    crypto.createHash("sha256").update(metadataText).digest("hex"),
  )
  const { privateKeyPath, certificatePath } = makeTestKeypair()

  const app = createApp({ updatesRoot, privateKeyPath })
  const server = app.listen(0)
  const { port } = server.address()
  try {
    const res = await fetch(`http://localhost:${port}/api/manifest`, {
      headers: {
        "expo-platform": "android",
        "expo-runtime-version": "2.2.2",
        "expo-channel-name": "production",
        "expo-current-update-id": manifestId,
      },
    })

    const rawBody = await res.text()
    const boundary = getBoundary(res.headers.get("content-type"))
    const { headersText, body, bodyString } = extractPartWithRaw(rawBody, boundary, "directive")

    assert.equal(body.type, "noUpdateAvailable")
    const signatureBase64 = parseSigHeader(headersText)
    assert.ok(signatureBase64, "expo-signature header must be present on the signed part")

    const certificate = fs.readFileSync(certificatePath, "utf-8")
    const verify = crypto.createVerify("RSA-SHA256")
    verify.update(bodyString)
    verify.end()
    assert.equal(
      verify.verify(certificate, signatureBase64, "base64"),
      true,
      "signature must verify against the exact bytes sent as the part body",
    )
  } finally {
    server.close()
  }
})

test("GET /api/manifest omits expo-signature when no private key is configured (unsigned mode)", async () => {
  const updatesRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ota-updates-"))
  const bundleDir = path.join(updatesRoot, "2.2.2", "production", "1000")
  fs.mkdirSync(bundleDir, { recursive: true })
  const metadataText = JSON.stringify({ version: 0, bundler: "metro", fileMetadata: {} })
  fs.writeFileSync(path.join(bundleDir, "metadata.json"), metadataText)
  const manifestId = convertSHA256HashToUUID(
    crypto.createHash("sha256").update(metadataText).digest("hex"),
  )

  const app = createApp({ updatesRoot, privateKeyPath: "/nonexistent/private-key.pem" })
  const server = app.listen(0)
  const { port } = server.address()
  try {
    const res = await fetch(`http://localhost:${port}/api/manifest`, {
      headers: {
        "expo-platform": "android",
        "expo-runtime-version": "2.2.2",
        "expo-channel-name": "production",
        "expo-current-update-id": manifestId,
      },
    })

    const rawBody = await res.text()
    const boundary = getBoundary(res.headers.get("content-type"))
    const { headersText } = extractPartWithRaw(rawBody, boundary, "directive")

    assert.equal(parseSigHeader(headersText), null)
  } finally {
    server.close()
  }
})

