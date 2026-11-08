/**
 * Canopy's reader model ships inside the app (#16415). The pinned revision and
 * every file's size and hash live in the tracked manifest; the files themselves
 * are fetched from Hugging Face once per checkout at build time, into a
 * gitignored folder that electron-builder copies into the app's resources.
 *
 * CommonJS so both the build scripts (ESM) and afterPack.cjs can load it.
 */
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..", "..");
const MANIFEST_PATH = path.join(ROOT, "electron/services/canopy/canopy-reader-manifest.json");
/** Where the build puts the model for an unpackaged run, and where packaging copies it from. */
const MODEL_DIR = path.join(ROOT, "electron/resources/canopy-reader");
/** What the model folder is called inside the app's resources. */
const RESOURCES_NAME = "canopy-reader";

const HF = "https://huggingface.co";
const USER_AGENT = "Daintree-Build/1.0";
const FILE_TIMEOUT_MS = 120_000;

function readManifest(file = MANIFEST_PATH) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

/** Git's blob id: SHA-1 over `blob <size>\0` and the content. */
function gitBlobId(content) {
  return crypto.createHash("sha1").update(`blob ${content.length}\0`).update(content).digest("hex");
}

/** Whether `content` is the file the manifest pins: its size, then its SHA-256 or blob id. */
function contentMatches(content, spec) {
  if (content.length !== spec.size) return false;
  if (spec.sha256) return crypto.createHash("sha256").update(content).digest("hex") === spec.sha256;
  if (spec.blobId) return gitBlobId(content) === spec.blobId;
  return false;
}

function fileMatches(file, spec) {
  let size;
  try {
    size = fs.statSync(file).size;
  } catch {
    return false;
  }
  if (size !== spec.size) return false;
  return contentMatches(fs.readFileSync(file), spec);
}

/** The manifest's files that are missing from `dir` or don't match their pins. */
function invalidFiles(dir, manifest = readManifest()) {
  return manifest.files.filter((spec) => !fileMatches(path.join(dir, spec.name), spec));
}

/**
 * Fetches every file `dir` lacks or holds wrong from the pinned revision, each
 * checked before it replaces anything. A folder already right asks nothing of
 * Hugging Face, so a cached build counts no download.
 */
async function prepareModel({
  dir = MODEL_DIR,
  manifest = readManifest(),
  fetchImpl = globalThis.fetch,
  log = console.log,
} = {}) {
  const missing = invalidFiles(dir, manifest);
  if (missing.length === 0) return { fetched: [] };
  fs.mkdirSync(dir, { recursive: true });
  for (const spec of missing) {
    await fetchFile(dir, manifest, spec, fetchImpl, log);
  }
  return { fetched: missing.map((spec) => spec.name) };
}

/** One pinned file into place: checked before it is written, staged beside it, then renamed over it. */
async function fetchFile(dir, manifest, spec, fetchImpl, log) {
  const url = `${HF}/${manifest.id}/resolve/${manifest.revision}/${spec.name}`;
  log(
    `[canopy-reader] Fetching ${spec.name} (${spec.size} bytes) at ${manifest.revision.slice(0, 12)}`
  );
  const response = await fetchImpl(url, {
    headers: { "User-Agent": USER_AGENT },
    signal: AbortSignal.timeout(FILE_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`Fetching ${spec.name} failed: HTTP ${response.status}`);
  const content = Buffer.from(await response.arrayBuffer());
  if (!contentMatches(content, spec)) {
    throw new Error(
      `${spec.name} doesn't match the hash pinned in ${path.relative(ROOT, MANIFEST_PATH)}`
    );
  }
  const target = path.join(dir, spec.name);
  const part = `${target}.part`;
  try {
    fs.writeFileSync(part, content);
    fs.renameSync(part, target);
  } finally {
    fs.rmSync(part, { force: true });
  }
}

module.exports = {
  MANIFEST_PATH,
  MODEL_DIR,
  RESOURCES_NAME,
  readManifest,
  gitBlobId,
  contentMatches,
  invalidFiles,
  prepareModel,
};
