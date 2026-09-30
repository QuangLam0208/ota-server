const { test } = require("node:test")
const assert = require("node:assert/strict")

const { convertSHA256HashToUUID } = require("../helpers")

test("convertSHA256HashToUUID formats a 64-char hex hash as a UUID", () => {
  const hash = "a".repeat(64)
  const uuid = convertSHA256HashToUUID(hash)
  assert.equal(uuid, "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa")
})

const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")

const { getLatestUpdateBundlePathAsync } = require("../helpers")

test("getLatestUpdateBundlePathAsync returns the most recently timestamped folder", async () => {
  const updatesRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ota-updates-"))
  const channelDir = path.join(updatesRoot, "2.2.2", "production")
  fs.mkdirSync(path.join(channelDir, "1000"), { recursive: true })
  fs.mkdirSync(path.join(channelDir, "2000"), { recursive: true })
  fs.mkdirSync(path.join(channelDir, "1500"), { recursive: true })

  const result = await getLatestUpdateBundlePathAsync("2.2.2", "production", updatesRoot)

  assert.equal(result, path.join(channelDir, "2000"))
})

test("getLatestUpdateBundlePathAsync rejects when nothing has been published", async () => {
  const updatesRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ota-updates-"))

  await assert.rejects(
    () => getLatestUpdateBundlePathAsync("9.9.9", "production", updatesRoot),
    /No updates published/,
  )
})

test("getLatestUpdateBundlePathAsync rejects a runtimeVersion containing path traversal segments", async () => {
  const updatesRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ota-updates-"))

  await assert.rejects(
    () => getLatestUpdateBundlePathAsync("../../etc", "production", updatesRoot),
    /Invalid runtimeVersion or channel/,
  )
})

test("getLatestUpdateBundlePathAsync rejects a channel containing path traversal segments", async () => {
  const updatesRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ota-updates-"))

  await assert.rejects(
    () => getLatestUpdateBundlePathAsync("2.2.2", "../../etc", updatesRoot),
    /Invalid runtimeVersion or channel/,
  )
})

const { getMetadataAsync } = require("../helpers")

test("getMetadataAsync reads metadata.json and derives a stable id from its content", async () => {
  const updateBundlePath = fs.mkdtempSync(path.join(os.tmpdir(), "ota-bundle-"))
  const metadata = {
    version: 0,
    bundler: "metro",
    fileMetadata: { android: { bundle: "bundle.js", assets: [] } },
  }
  fs.writeFileSync(path.join(updateBundlePath, "metadata.json"), JSON.stringify(metadata))

  const result = await getMetadataAsync({ updateBundlePath, runtimeVersion: "2.2.2" })

  assert.deepEqual(result.metadataJson, metadata)
  assert.equal(result.id.length, 64)
  assert.match(result.id, /^[0-9a-f]+$/)
  assert.ok(!Number.isNaN(Date.parse(result.createdAt)))
})

const { getAssetMetadataAsync } = require("../helpers")

test("getAssetMetadataAsync hashes the launch asset and builds its URL", async () => {
  const updateBundlePath = fs.mkdtempSync(path.join(os.tmpdir(), "ota-bundle-"))
  fs.writeFileSync(path.join(updateBundlePath, "bundle.js"), "console.log('hi')")

  const result = await getAssetMetadataAsync({
    updateBundlePath,
    filePath: "bundle.js",
    ext: null,
    isLaunchAsset: true,
    runtimeVersion: "2.2.2",
    platform: "android",
    channel: "production",
    hostname: "http://localhost:3001",
  })

  assert.equal(result.fileExtension, ".bundle")
  assert.equal(result.contentType, "application/javascript")
  assert.equal(result.key.length, 32)
  assert.equal(result.hash.includes("+"), false)
  assert.equal(result.hash.includes("/"), false)
  assert.match(
    result.url,
    /^http:\/\/localhost:3001\/api\/assets\?asset=.+&runtimeVersion=2\.2\.2&platform=android&channel=production$/,
  )
})

test("getAssetMetadataAsync uses the asset's own extension for a non-launch asset", async () => {
  const updateBundlePath = fs.mkdtempSync(path.join(os.tmpdir(), "ota-bundle-"))
  fs.writeFileSync(path.join(updateBundlePath, "icon.png"), "not-really-a-png")

  const result = await getAssetMetadataAsync({
    updateBundlePath,
    filePath: "icon.png",
    ext: "png",
    isLaunchAsset: false,
    runtimeVersion: "2.2.2",
    platform: "android",
    channel: "production",
    hostname: "http://localhost:3001",
  })

  assert.equal(result.fileExtension, ".png")
  assert.equal(result.contentType, "image/png")
})

const { listPublishedUpdates, deleteUpdate } = require("../helpers")

function writeUpdateFixture(updatesRoot, runtimeVersion, channel, timestamp) {
  const dir = path.join(updatesRoot, runtimeVersion, channel, timestamp)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    path.join(dir, "metadata.json"),
    JSON.stringify({ version: 0, bundler: "metro", fileMetadata: {} }),
  )
  return dir
}

test("listPublishedUpdates returns an empty array when nothing has been published", async () => {
  const updatesRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ota-updates-"))
  assert.deepEqual(await listPublishedUpdates(updatesRoot), [])
})

test("listPublishedUpdates returns an empty array when the updates root doesn't exist yet", async () => {
  const updatesRoot = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ota-updates-")), "missing")
  assert.deepEqual(await listPublishedUpdates(updatesRoot), [])
})

test("listPublishedUpdates lists every published update, newest timestamp first", async () => {
  const updatesRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ota-updates-"))
  writeUpdateFixture(updatesRoot, "2.2.2", "production", "1000")
  writeUpdateFixture(updatesRoot, "2.2.2", "production", "2000")
  writeUpdateFixture(updatesRoot, "2.2.2", "preview", "1500")

  const updates = await listPublishedUpdates(updatesRoot)

  assert.equal(updates.length, 3)
  assert.deepEqual(
    updates.map((u) => u.timestamp),
    ["2000", "1500", "1000"],
  )
  assert.match(updates[0].id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
  assert.ok(!Number.isNaN(Date.parse(updates[0].createdAt)))
})

test("deleteUpdate removes the published update's directory", () => {
  const updatesRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ota-updates-"))
  const dir = writeUpdateFixture(updatesRoot, "2.2.2", "production", "1000")
  assert.ok(fs.existsSync(dir))

  deleteUpdate(updatesRoot, "2.2.2", "production", "1000")

  assert.equal(fs.existsSync(dir), false)
})

test("deleteUpdate rejects a runtimeVersion/channel/timestamp that would escape updatesRoot", () => {
  const updatesRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ota-updates-"))
  writeUpdateFixture(updatesRoot, "2.2.2", "production", "1000")

  assert.throws(() => deleteUpdate(updatesRoot, "..", "production", "1000"), /Invalid/)
  assert.throws(() => deleteUpdate(updatesRoot, "2.2.2", "production", "../../etc"), /Invalid/)
})

test("deleteUpdate throws when the update doesn't exist", () => {
  const updatesRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ota-updates-"))
  assert.throws(() => deleteUpdate(updatesRoot, "9.9.9", "production", "1000"), /No update found/)
})

const { publishExportedBundle, isSafePathSegment } = require("../helpers")

test("publishExportedBundle copies exported files under runtimeVersion/channel/timestamp", () => {
  const exportedDir = fs.mkdtempSync(path.join(os.tmpdir(), "ota-export-"))
  fs.writeFileSync(path.join(exportedDir, "metadata.json"), "{}")
  const updatesRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ota-updates-"))

  const targetDir = publishExportedBundle({
    exportedDir,
    runtimeVersion: "2.2.2",
    channel: "production",
    updatesRoot,
    timestamp: "1700000000",
  })

  assert.equal(targetDir, path.join(updatesRoot, "2.2.2", "production", "1700000000"))
  assert.ok(fs.existsSync(path.join(targetDir, "metadata.json")))
})

test("publishExportedBundle rejects a runtimeVersion/channel/timestamp that would escape updatesRoot", () => {
  const exportedDir = fs.mkdtempSync(path.join(os.tmpdir(), "ota-export-"))
  fs.writeFileSync(path.join(exportedDir, "metadata.json"), "{}")
  const updatesRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ota-updates-"))

  assert.throws(
    () =>
      publishExportedBundle({
        exportedDir,
        runtimeVersion: "../../etc",
        channel: "production",
        updatesRoot,
        timestamp: "1700000000",
      }),
    /Invalid/,
  )
})

test("isSafePathSegment accepts real version/channel strings and rejects traversal attempts", () => {
  assert.equal(isSafePathSegment("2.2.2"), true)
  assert.equal(isSafePathSegment("production"), true)
  assert.equal(isSafePathSegment("preview-2"), true)
  assert.equal(isSafePathSegment(".."), false)
  assert.equal(isSafePathSegment("."), false)
  assert.equal(isSafePathSegment("../../etc"), false)
  assert.equal(isSafePathSegment("a/b"), false)
})

const { republishUpdate } = require("../helpers")
const { createHash } = require("node:crypto")

function makeUpdatesRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ota-updates-"))
}

function sha256(text) {
  return createHash("sha256").update(text).digest("hex")
}

test("republishUpdate clones the source update under a new, larger timestamp", async () => {
  const updatesRoot = makeUpdatesRoot()
  const sourceDir = path.join(updatesRoot, "2.2.2", "production", "1000")
  fs.mkdirSync(sourceDir, { recursive: true })
  fs.writeFileSync(path.join(sourceDir, "metadata.json"), '{"fileMetadata":{}}')
  fs.writeFileSync(path.join(sourceDir, "bundle.hbc"), "console.log('v1')")

  const result = republishUpdate(updatesRoot, "2.2.2", "production", "1000")

  assert.equal(result.runtimeVersion, "2.2.2")
  assert.equal(result.channel, "production")
  assert.equal(result.sourceTimestamp, "1000")
  assert.ok(Number(result.newTimestamp) > 1000)

  assert.equal(
    fs.readFileSync(path.join(result.targetDir, "bundle.hbc"), "utf-8"),
    "console.log('v1')",
  )
})

test("republishUpdate stamps the cloned metadata.json so its manifest id differs from the source", () => {
  const updatesRoot = makeUpdatesRoot()
  const sourceDir = path.join(updatesRoot, "2.2.2", "production", "1000")
  fs.mkdirSync(sourceDir, { recursive: true })
  const sourceMetadata = '{"fileMetadata":{}}'
  fs.writeFileSync(path.join(sourceDir, "metadata.json"), sourceMetadata)

  const result = republishUpdate(updatesRoot, "2.2.2", "production", "1000")

  const clonedMetadata = fs.readFileSync(path.join(result.targetDir, "metadata.json"), "utf-8")
  const clonedJson = JSON.parse(clonedMetadata)

  assert.equal(clonedJson._republishedFrom, "1000")
  assert.equal(clonedJson._republishedAt, result.newTimestamp)
  assert.notEqual(
    sha256(clonedMetadata),
    sha256(sourceMetadata),
    "manifest id (derived from metadata.json's hash) must differ from the source's",
  )
})

test("republishUpdate rejects a runtimeVersion containing path traversal segments", () => {
  const updatesRoot = makeUpdatesRoot()

  assert.throws(
    () => republishUpdate(updatesRoot, "../../etc", "production", "1000"),
    /Invalid runtimeVersion, channel, or timestamp/,
  )
})

test("republishUpdate rejects a channel containing path traversal segments", () => {
  const updatesRoot = makeUpdatesRoot()

  assert.throws(
    () => republishUpdate(updatesRoot, "2.2.2", "../../etc", "1000"),
    /Invalid runtimeVersion, channel, or timestamp/,
  )
})

test("republishUpdate rejects a sourceTimestamp containing path traversal segments", () => {
  const updatesRoot = makeUpdatesRoot()

  assert.throws(
    () => republishUpdate(updatesRoot, "2.2.2", "production", "../../etc"),
    /Invalid runtimeVersion, channel, or timestamp/,
  )
})

test("republishUpdate throws a descriptive error when the source update does not exist", () => {
  const updatesRoot = makeUpdatesRoot()

  assert.throws(
    () => republishUpdate(updatesRoot, "2.2.2", "production", "9999"),
    /No update found at 2\.2\.2\/production\/9999/,
  )
})

