const path = require("path")
require("dotenv").config({ path: path.join(__dirname, ".env") })

const express = require("express")
const FormData = require("form-data")
const AdmZip = require("adm-zip")
const fs = require("fs")
const os = require("os")
const mime = require("mime")

const {
  convertSHA256HashToUUID,
  isSafePathSegment,
  getLatestUpdateBundlePathAsync,
  getAssetMetadataAsync,
  getMetadataAsync,
  listPublishedUpdates,
  publishExportedBundle,
  deleteUpdate,
} = require("./helpers")

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
}

function formatDateTime(isoString) {
  const date = new Date(isoString)
  if (Number.isNaN(date.getTime())) return isoString
  return date.toLocaleString("vi-VN", {
    timeZone: "Asia/Ho_Chi_Minh",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  })
}

function renderDashboardHtml(updates) {
  const rows = updates
    .map(
      (u) => `
    <tr>
      <td>${escapeHtml(u.runtimeVersion)}</td>
      <td>${escapeHtml(u.channel)}</td>
      <td>${escapeHtml(u.timestamp)}</td>
      <td><code>${escapeHtml(u.id)}</code></td>
      <td>${escapeHtml(formatDateTime(u.createdAt))}</td>
      <td>
        <form method="POST" action="/updates/${encodeURIComponent(u.runtimeVersion)}/${encodeURIComponent(u.channel)}/${encodeURIComponent(u.timestamp)}/delete" onsubmit="return confirm('Xóa bản update này?')">
          <button type="submit">Xóa</button>
        </form>
      </td>
    </tr>`,
    )
    .join("")

  return `<!doctype html>
<html lang="vi">
<head>
  <meta charset="utf-8">
  <title>OTA Server</title>
  <style>
    body { font-family: -apple-system, sans-serif; margin: 2rem; background: #1a1a1a; color: #eee; }
    h1 { font-size: 1.3rem; }
    table { border-collapse: collapse; width: 100%; margin-top: 1rem; }
    th, td { border: 1px solid #444; padding: 8px 12px; text-align: left; font-size: 14px; }
    th { background: #2a2a2a; }
    code { font-size: 12px; }
    button { background: #c0392b; color: white; border: none; padding: 4px 10px; border-radius: 4px; cursor: pointer; }
    button:hover { background: #e74c3c; }
  </style>
</head>
<body>
  <h1>OTA Server — Các bản đã publish</h1>
  ${
    updates.length === 0
      ? "<p>Chưa có bản nào được publish.</p>"
      : `<table>
    <thead><tr><th>Runtime Version</th><th>Channel</th><th>Timestamp</th><th>Manifest ID</th><th>Created At</th><th></th></tr></thead>
    <tbody>${rows}</tbody>
  </table>`
  }
</body>
</html>`
}

function sendMultipart(res, partName, payload) {
  const form = new FormData()
  form.append(partName, JSON.stringify(payload), {
    contentType: "application/json",
    header: { "content-type": "application/json; charset=utf-8" },
  })

  res.status(200)
  res.setHeader("expo-protocol-version", "1")
  res.setHeader("expo-sfv-version", "0")
  res.setHeader("cache-control", "private, max-age=0")
  res.setHeader("content-type", `multipart/mixed; boundary=${form.getBoundary()}`)
  res.end(form.getBuffer())
}

function createApp({
  updatesRoot = path.join(__dirname, "updates"),
  publishToken = process.env.PUBLISH_TOKEN,
} = {}) {
  const app = express()
  app.set("trust proxy", true)
  app.use(express.urlencoded({ extended: false }))

  app.use((req, res, next) => {
    console.log(`\n[${new Date().toISOString()}] >>> ${req.method} ${req.originalUrl}`)
    console.log("Headers:", JSON.stringify(req.headers, null, 2))
    next()
  })

  app.post(
    "/publish",
    express.raw({ type: "application/zip", limit: "100mb" }),
    (req, res) => {
      if (!publishToken) {
        res
          .status(501)
          .json({ error: "Publishing is disabled: server has no PUBLISH_TOKEN configured." })
        return
      }

      if (req.headers["x-publish-token"] !== publishToken) {
        res.status(401).json({ error: "Invalid or missing publish token." })
        return
      }

      const runtimeVersion = req.query.runtimeVersion
      const channel = req.query.channel || "production"
      if (!isSafePathSegment(runtimeVersion) || !isSafePathSegment(channel)) {
        res.status(400).json({ error: "Invalid runtimeVersion or channel." })
        return
      }

      if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
        res.status(400).json({ error: "Expected a non-empty application/zip request body." })
        return
      }

      const extractDir = fs.mkdtempSync(path.join(os.tmpdir(), "ota-publish-"))
      try {
        const zip = new AdmZip(req.body)
        zip.extractAllTo(extractDir, true)

        if (!fs.existsSync(path.join(extractDir, "metadata.json"))) {
          res.status(400).json({ error: "Uploaded archive is missing metadata.json." })
          return
        }

        const timestamp = Date.now().toString()
        const targetDir = publishExportedBundle({
          exportedDir: extractDir,
          runtimeVersion,
          channel,
          updatesRoot,
          timestamp,
        })

        res.status(200).json({ runtimeVersion, channel, timestamp, targetDir })
      } catch (error) {
        res.status(400).json({ error: `Failed to extract/publish archive: ${error.message}` })
      } finally {
        fs.rmSync(extractDir, { recursive: true, force: true })
      }
    },
  )

  app.get("/", async (req, res) => {
    const updates = await listPublishedUpdates(updatesRoot)
    res.status(200)
    res.setHeader("content-type", "text/html; charset=utf-8")
    res.end(renderDashboardHtml(updates))
  })

  app.post("/updates/:runtimeVersion/:channel/:timestamp/delete", (req, res) => {
    const { runtimeVersion, channel, timestamp } = req.params
    try {
      deleteUpdate(updatesRoot, runtimeVersion, channel, timestamp)
    } catch (error) {
      res.status(400).send(`Error: ${error.message}`)
      return
    }
    res.redirect("/")
  })

  app.get("/api/manifest", async (req, res) => {
    const platform = req.headers["expo-platform"]
    if (platform !== "ios" && platform !== "android") {
      res.status(400).json({ error: 'Unsupported platform. Expected "ios" or "android".' })
      return
    }

    const runtimeVersion = req.headers["expo-runtime-version"]
    if (!runtimeVersion || typeof runtimeVersion !== "string") {
      res.status(400).json({ error: "No runtimeVersion provided." })
      return
    }

    let targetChannel = req.headers["expo-channel-name"] || req.query.channel || "production"

    let updateBundlePath
    try {
      updateBundlePath = await getLatestUpdateBundlePathAsync(runtimeVersion, targetChannel, updatesRoot)
    } catch (error) {
      if (targetChannel !== "production") {
        try {
          updateBundlePath = await getLatestUpdateBundlePathAsync(runtimeVersion, "production", updatesRoot)
          targetChannel = "production"
        } catch {
          console.log(`[Manifest Error] No update found for ${runtimeVersion} / ${targetChannel}:`, error.message)
          res.status(404).json({ error: error.message })
          return
        }
      } else {
        console.log(`[Manifest Error] No update found for ${runtimeVersion} / ${targetChannel}:`, error.message)
        res.status(404).json({ error: error.message })
        return
      }
    }

    try {
      const currentUpdateId = req.headers["expo-current-update-id"]
      const { metadataJson, createdAt, id } = await getMetadataAsync({
        updateBundlePath,
        runtimeVersion,
      })
      const manifestId = convertSHA256HashToUUID(id)

      console.log(`[Manifest Check] runtimeVersion=${runtimeVersion}, channel=${targetChannel}`)
      console.log(`[Manifest Check] currentUpdateId on device: "${currentUpdateId}"`)
      console.log(`[Manifest Check] latest manifestId on server: "${manifestId}" (createdAt: ${createdAt})`)

      if (currentUpdateId === manifestId) {
        console.log(`[Manifest Response] Matches currentUpdateId -> sending directive: noUpdateAvailable`)
        sendMultipart(res, "directive", { type: "noUpdateAvailable" })
        return
      }

      console.log(`[Manifest Response] New update available! Sending manifest ${manifestId}`)

      const hostname = `${req.protocol}://${req.get("host")}`
      const platformMetadata = metadataJson.fileMetadata[platform]

      if (!platformMetadata) {
        res
          .status(404)
          .json({ error: `No build for platform "${platform}" in this update.` })
        return
      }

      const manifest = {
        id: manifestId,
        createdAt,
        runtimeVersion,
        assets: await Promise.all(
          platformMetadata.assets.map((asset) =>
            getAssetMetadataAsync({
              updateBundlePath,
              filePath: asset.path,
              ext: asset.ext,
              isLaunchAsset: false,
              runtimeVersion,
              platform,
              channel: targetChannel,
              hostname,
            }),
          ),
        ),
        launchAsset: await getAssetMetadataAsync({
          updateBundlePath,
          filePath: platformMetadata.bundle,
          ext: null,
          isLaunchAsset: true,
          runtimeVersion,
          platform,
          channel: targetChannel,
          hostname,
        }),
        metadata: {},
        extra: {},
      }

      sendMultipart(res, "manifest", manifest)
    } catch (error) {
      console.error(error)
      res.status(404).json({ error: String(error) })
    }
  })

  app.get("/api/assets", async (req, res) => {
    const { asset: assetPathParam, runtimeVersion, platform, channel } = req.query

    if (!assetPathParam || typeof assetPathParam !== "string") {
      res.status(400).json({ error: "No asset name provided." })
      return
    }
    if (platform !== "ios" && platform !== "android") {
      res.status(400).json({ error: 'No platform provided. Expected "ios" or "android".' })
      return
    }
    if (!runtimeVersion || typeof runtimeVersion !== "string") {
      res.status(400).json({ error: "No runtimeVersion provided." })
      return
    }

    let targetChannel = channel || "production"
    let updateBundlePath
    try {
      updateBundlePath = await getLatestUpdateBundlePathAsync(
        runtimeVersion,
        targetChannel,
        updatesRoot,
      )
    } catch (error) {
      if (targetChannel !== "production") {
        try {
          updateBundlePath = await getLatestUpdateBundlePathAsync(
            runtimeVersion,
            "production",
            updatesRoot,
          )
          targetChannel = "production"
        } catch {
          res.status(404).json({ error: error.message })
          return
        }
      } else {
        res.status(404).json({ error: error.message })
        return
      }
    }

    let metadataJson
    try {
      const result = await getMetadataAsync({ updateBundlePath, runtimeVersion })
      metadataJson = result.metadataJson
    } catch (error) {
      res.status(404).json({ error: error.message })
      return
    }

    const resolvedUpdateBundlePath = path.resolve(updateBundlePath)
    const resolvedAssetPath = path.resolve(assetPathParam.replace(/\\/g, "/"))
    const relativePath = path.relative(resolvedUpdateBundlePath, resolvedAssetPath).replace(/\\/g, "/")
    const escapesBundleDir = relativePath.startsWith("..") || path.isAbsolute(relativePath)

    if (escapesBundleDir) {
      res.status(400).json({ error: "Invalid asset path." })
      return
    }

    const platformMetadata = metadataJson.fileMetadata[platform]

    if (!platformMetadata) {
      res
        .status(404)
        .json({ error: `No build for platform "${platform}" in this update.` })
      return
    }

    const assetMetadata = platformMetadata.assets.find(
      (asset) => asset.path === relativePath,
    )
    const isLaunchAsset = platformMetadata.bundle === relativePath

    if (!isLaunchAsset && !assetMetadata) {
      res.status(404).json({ error: "Asset not registered in this update's metadata." })
      return
    }

    if (!fs.existsSync(assetPathParam)) {
      res.status(404).json({ error: `Asset "${assetPathParam}" does not exist.` })
      return
    }

    try {
      const asset = await fs.promises.readFile(assetPathParam)
      res.status(200)
      res.setHeader(
        "content-type",
        isLaunchAsset ? "application/javascript" : mime.getType(assetMetadata.ext),
      )
      res.end(asset)
    } catch (error) {
      res.status(500).json({ error: String(error) })
    }
  })

  return app
}

if (require.main === module) {
  const PORT = process.env.PORT || 3001
  const app = createApp()
  app.listen(PORT, () => {
    console.log(`OTA server listening on http://localhost:${PORT}`)
  })
}

module.exports = { createApp }
