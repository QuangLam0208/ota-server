const crypto = require("crypto")
const fsSync = require("fs")
const fs = require("fs/promises")
const mime = require("mime")
const path = require("path")

// Tạo mã băm cryptographic từ dữ liệu nhị phân hoặc chuỗi
function createHash(data, algorithm, encoding) {
  return crypto.createHash(algorithm).update(data).digest(encoding)
}

// Chuẩn hóa chuỗi Base64 thông thường thành Base64URL
function getBase64URLEncoding(base64String) {
  return base64String.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

// Cắt chuỗi SHA-256 dạng hex (32 ký tự đầu) thành định dạng chuẩn UUID 8-4-4-4-12
function convertSHA256HashToUUID(value) {
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20, 32)}`
}

const SAFE_PATH_SEGMENT = /^[A-Za-z0-9._-]+$/

// Hàm bảo mật cốt lõi: Xác thực chuỗi chỉ chứa ký tự chữ cái, số, dấu gạch ngang hoặc chấm
// Ngăn chặn triệt để tấn công Path Traversal (như truyền ../../etc/passwd vào query parameter)
function isSafePathSegment(value) {
  return (
    typeof value === "string" &&
    SAFE_PATH_SEGMENT.test(value) &&
    value !== "." &&
    value !== ".."
  )
}

// Tìm thư mục chứa bản cập nhật mới nhất cho một runtimeVersion và channel cụ thể
async function getLatestUpdateBundlePathAsync(runtimeVersion, channel, updatesRoot) {
  if (!isSafePathSegment(runtimeVersion) || !isSafePathSegment(channel)) {
    throw new Error("Invalid runtimeVersion or channel.")
  }

  const channelDir = path.join(updatesRoot, runtimeVersion, channel)

  const resolvedUpdatesRoot = path.resolve(updatesRoot)
  const resolvedChannelDir = path.resolve(channelDir)
  if (!resolvedChannelDir.startsWith(resolvedUpdatesRoot + path.sep)) {
    throw new Error("Invalid runtimeVersion or channel.")
  }

  if (!fsSync.existsSync(channelDir)) {
    throw new Error(
      `No updates published for runtimeVersion "${runtimeVersion}" channel "${channel}"`,
    )
  }

  const entries = await fs.readdir(channelDir)
  const timestampDirs = (
    await Promise.all(
      entries.map(async (entry) => {
        const stat = await fs.stat(path.join(channelDir, entry))
        return stat.isDirectory() ? entry : null
      }),
    )
  ).filter((entry) => entry !== null).sort((a, b) => parseInt(b, 10) - parseInt(a, 10))

  if (timestampDirs.length === 0) {
    throw new Error(
      `No updates published for runtimeVersion "${runtimeVersion}" channel "${channel}"`,
    )
  }

  return path.join(channelDir, timestampDirs[0])
}

// Đọc file metadata.json do Metro tạo ra trong thư mục update, tính ID và ngày tạo createdAt
async function getMetadataAsync({ updateBundlePath, runtimeVersion }) {
  const metadataPath = path.join(updateBundlePath, "metadata.json")
  try {
    const metadataBuffer = await fs.readFile(metadataPath)
    const metadataJson = JSON.parse(metadataBuffer.toString("utf-8"))

    // Normalize Windows backslashes to forward slashes for Linux compatibility
    for (const platform of Object.keys(metadataJson.fileMetadata || {})) {
      const pm = metadataJson.fileMetadata[platform]
      if (pm && pm.bundle) {
        pm.bundle = pm.bundle.replace(/\\/g, "/")
      }
      if (pm && Array.isArray(pm.assets)) {
        for (const asset of pm.assets) {
          if (asset.path) {
            asset.path = asset.path.replace(/\\/g, "/")
          }
        }
      }
    }

    const metadataStat = await fs.stat(metadataPath)
    const timestampDir = path.basename(updateBundlePath)
    const timestampNum = parseInt(timestampDir, 10)
    let createdAt
    if (!Number.isNaN(timestampNum) && timestampNum > 0) {
      createdAt = new Date(timestampNum).toISOString()
    } else if (metadataStat.birthtime && metadataStat.birthtime.getTime() > 0) {
      createdAt = new Date(metadataStat.birthtime).toISOString()
    } else if (metadataStat.mtime && metadataStat.mtime.getTime() > 0) {
      createdAt = new Date(metadataStat.mtime).toISOString()
    } else {
      createdAt = new Date().toISOString()
    }

    return {
      metadataJson,
      createdAt,
      id: createHash(metadataBuffer, "sha256", "hex"),
    }
  } catch (error) {
    throw new Error(`No update found with runtime version: ${runtimeVersion}. Error: ${error}`)
  }
}

// Băm và định dạng metadata cho từng asset (ảnh, font) và bundle JS (.hbc)
async function getAssetMetadataAsync({
  updateBundlePath,
  filePath,
  ext,
  isLaunchAsset,
  runtimeVersion,
  platform,
  channel,
  hostname,
}) {
  const normalizedFilePath = filePath.replace(/\\/g, "/")
  const assetFilePath = path.join(updateBundlePath, normalizedFilePath)
  const asset = await fs.readFile(assetFilePath)
  const assetHash = getBase64URLEncoding(createHash(asset, "sha256", "base64"))
  const key = createHash(asset, "md5", "hex")
  const keyExtensionSuffix = isLaunchAsset ? "bundle" : ext
  const contentType = isLaunchAsset ? "application/javascript" : mime.getType(ext)

  return {
    hash: assetHash,
    key,
    fileExtension: `.${keyExtensionSuffix}`,
    contentType,
    url: `${hostname}/api/assets?asset=${encodeURIComponent(
      assetFilePath,
    )}&runtimeVersion=${runtimeVersion}&platform=${platform}&channel=${channel}`,
  }
}

async function listPublishedUpdates(updatesRoot) {
  if (!fsSync.existsSync(updatesRoot)) {
    return []
  }

  const updates = []
  const runtimeVersions = await fs.readdir(updatesRoot)

  for (const runtimeVersion of runtimeVersions) {
    const runtimeVersionDir = path.join(updatesRoot, runtimeVersion)
    if (!(await fs.stat(runtimeVersionDir)).isDirectory()) continue

    const channels = await fs.readdir(runtimeVersionDir)
    for (const channel of channels) {
      const channelDir = path.join(runtimeVersionDir, channel)
      if (!(await fs.stat(channelDir)).isDirectory()) continue

      const timestamps = await fs.readdir(channelDir)
      for (const timestamp of timestamps) {
        const updateBundlePath = path.join(channelDir, timestamp)
        if (!(await fs.stat(updateBundlePath)).isDirectory()) continue

        try {
          const { id, createdAt } = await getMetadataAsync({ updateBundlePath, runtimeVersion })
          updates.push({
            runtimeVersion,
            channel,
            timestamp,
            id: convertSHA256HashToUUID(id),
            createdAt,
          })
        } catch {
          // Not a valid published update (e.g. missing/corrupt metadata.json) — skip it.
        }
      }
    }
  }

  return updates.sort((a, b) => b.timestamp.localeCompare(a.timestamp))
}

function publishExportedBundle({ exportedDir, runtimeVersion, channel, updatesRoot, timestamp }) {
  if (
    !isSafePathSegment(runtimeVersion) ||
    !isSafePathSegment(channel) ||
    !isSafePathSegment(timestamp)
  ) {
    throw new Error("Invalid runtimeVersion, channel, or timestamp.")
  }

  const targetDir = path.join(updatesRoot, runtimeVersion, channel, timestamp)
  fsSync.mkdirSync(targetDir, { recursive: true })
  fsSync.cpSync(exportedDir, targetDir, { recursive: true })
  return targetDir
}

function deleteUpdate(updatesRoot, runtimeVersion, channel, timestamp) {
  if (
    !isSafePathSegment(runtimeVersion) ||
    !isSafePathSegment(channel) ||
    !isSafePathSegment(timestamp)
  ) {
    throw new Error("Invalid runtimeVersion, channel, or timestamp.")
  }

  const targetDir = path.join(updatesRoot, runtimeVersion, channel, timestamp)

  const resolvedUpdatesRoot = path.resolve(updatesRoot)
  const resolvedTargetDir = path.resolve(targetDir)
  if (!resolvedTargetDir.startsWith(resolvedUpdatesRoot + path.sep)) {
    throw new Error("Invalid runtimeVersion, channel, or timestamp.")
  }

  if (!fsSync.existsSync(targetDir)) {
    throw new Error(`No update found at ${runtimeVersion}/${channel}/${timestamp}`)
  }

  fsSync.rmSync(targetDir, { recursive: true })
}

module.exports = {
  convertSHA256HashToUUID,
  isSafePathSegment,
  getLatestUpdateBundlePathAsync,
  getMetadataAsync,
  getAssetMetadataAsync,
  listPublishedUpdates,
  publishExportedBundle,
  deleteUpdate,
}
