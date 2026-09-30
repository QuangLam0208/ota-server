const { test } = require("node:test")
const assert = require("node:assert/strict")
const crypto = require("node:crypto")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")

const { signManifest } = require("../helpers")

function makeTestKeypair() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ota-keys-"))
  const privateKeyPath = path.join(dir, "private-key.pem")
  const certificatePath = path.join(dir, "certificate.pem")

  execOpenssl(`genrsa -out "${privateKeyPath}" 2048`)
  execOpenssl(
    `req -new -x509 -key "${privateKeyPath}" -out "${certificatePath}" -days 1 -subj "/CN=test"`,
  )

  return { privateKeyPath, certificatePath }
}

const defaultOpensslConf = [
  process.env.OPENSSL_CONF,
  "C:\\Program Files\\Git\\usr\\ssl\\openssl.cnf",
  "C:\\Program Files\\Git\\mingw64\\etc\\ssl\\openssl.cnf",
  "C:\\msys64\\usr\\ssl\\openssl.cnf",
].find((p) => p && fs.existsSync(p))

function execOpenssl(args) {
  const env = { ...process.env }
  if (defaultOpensslConf && !env.OPENSSL_CONF) {
    env.OPENSSL_CONF = defaultOpensslConf
  }
  require("node:child_process").execSync(`openssl ${args}`, { stdio: "pipe", env })
}

function parseSigHeader(header) {
  const match = header.match(/sig="([^"]+)"/)
  return match[1]
}

test("signManifest produces a header in the Expo SFV format", () => {
  const { privateKeyPath } = makeTestKeypair()

  const header = signManifest('{"id":"abc"}', privateKeyPath)

  assert.match(header, /^sig="[A-Za-z0-9+/=]+", keyid="main", alg="rsa-v1_5-sha256"$/)
})

test("signManifest throws a descriptive error when the private key file is missing", () => {
  assert.throws(
    () => signManifest("{}", "/nonexistent/private-key.pem"),
    /Private key not found at: \/nonexistent\/private-key\.pem/,
  )
})

test("a signature verifies successfully against the matching certificate for unmodified payload", () => {
  const { privateKeyPath, certificatePath } = makeTestKeypair()
  const payload = '{"id":"abc","runtimeVersion":"1.0.0"}'

  const header = signManifest(payload, privateKeyPath)
  const signatureBase64 = parseSigHeader(header)

  const certificate = fs.readFileSync(certificatePath, "utf-8")
  const verify = crypto.createVerify("RSA-SHA256")
  verify.update(payload)
  verify.end()

  assert.equal(verify.verify(certificate, signatureBase64, "base64"), true)
})

test("verification fails if the payload is tampered with after signing (MITM simulation)", () => {
  const { privateKeyPath, certificatePath } = makeTestKeypair()
  const originalPayload = '{"id":"abc","runtimeVersion":"1.0.0"}'

  const header = signManifest(originalPayload, privateKeyPath)
  const signatureBase64 = parseSigHeader(header)

  // Attacker/MITM swaps one character in transit — client receives a
  // different payload than what was actually signed.
  const tamperedPayload = '{"id":"xyz","runtimeVersion":"1.0.0"}'

  const certificate = fs.readFileSync(certificatePath, "utf-8")
  const verify = crypto.createVerify("RSA-SHA256")
  verify.update(tamperedPayload)
  verify.end()

  assert.equal(verify.verify(certificate, signatureBase64, "base64"), false)
})

test("verification fails against a certificate from a different (rogue) keypair", () => {
  const { privateKeyPath } = makeTestKeypair()
  const rogueKeypair = makeTestKeypair()
  const payload = '{"id":"abc"}'

  const header = signManifest(payload, privateKeyPath)
  const signatureBase64 = parseSigHeader(header)

  const rogueCertificate = fs.readFileSync(rogueKeypair.certificatePath, "utf-8")
  const verify = crypto.createVerify("RSA-SHA256")
  verify.update(payload)
  verify.end()

  assert.equal(verify.verify(rogueCertificate, signatureBase64, "base64"), false)
})
