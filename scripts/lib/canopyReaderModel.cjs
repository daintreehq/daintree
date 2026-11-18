/**
 * Canopy's reader model ships inside the app (#16415). The pinned revision and
 * every file's size and hash live in the tracked manifest; the files themselves
 * are fetched from Hugging Face once per checkout at build time, into a
 * gitignored folder per revision that electron-builder copies into the app's
 * resources.
 *
 * CommonJS so both the build scripts (ESM) and afterPack.cjs can load it.
 */
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..", "..");
const MANIFEST_PATH = path.join(ROOT, "electron/services/canopy/canopy-reader-manifest.json");
/** Where the build keeps the model for unpackaged runs, one folder per revision. */
const MODELS_ROOT = path.join(ROOT, "electron/resources/canopy-reader");
/** What the model folder is called inside the app's resources. */
const RESOURCES_NAME = "canopy-reader";
const REVISION = /^[0-9a-f]{40}$/;

const HF = "https://huggingface.co";
const USER_AGENT = "Daintree-Build/1.0";
const FILE_TIMEOUT_MS = 120_000;

function readManifest(file = MANIFEST_PATH) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

/**
 * A revision's folder: what an unpackaged run reads and packaging copies from.
 * Each holds only its own revision's pinned bytes, so a fetch for another pin
 * (a dev watch's, still out across a branch switch) never rewrites a file an
 * app built from this one has already checked (#17818).
 */
function modelDir(manifest = readManifest(), root = MODELS_ROOT) {
  if (!REVISION.test(manifest.revision)) {
    throw new Error(`The manifest's revision isn't a commit: ${manifest.revision}`);
  }
  return path.join(root, manifest.revision);
}

/** The checkout's own revision's folder. */
const MODEL_DIR = modelDir();

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
 * Hugging Face, so a cached build counts no download. Unless handed a `dir`,
 * it is the revision's folder under `root`, and a file the checkout kept flat
 * in `root` before each revision had its own folder is taken from there when
 * it matches its pin, so a warm checkout or cache never fetches it again.
 */
async function prepareModel({
  manifest = readManifest(),
  root = MODELS_ROOT,
  dir,
  fetchImpl = globalThis.fetch,
  log = console.log,
} = {}) {
  const target = dir ?? modelDir(manifest, root);
  let missing = invalidFiles(target, manifest);
  if (missing.length === 0) return { fetched: [] };
  fs.mkdirSync(target, { recursive: true });
  if (dir === undefined) missing = missing.filter((spec) => !adoptFlat(root, target, spec));
  if (missing.length === 0) return { fetched: [] };
  await checkPublished(manifest, fetchImpl);
  for (const spec of missing) {
    await fetchFile(target, manifest, spec, fetchImpl, log);
  }
  return { fetched: missing.map((spec) => spec.name) };
}

/** Puts `root`'s flat copy of `spec` in `dir` when it matches its pin; whether it did. */
function adoptFlat(root, dir, spec) {
  let content;
  try {
    content = fs.readFileSync(path.join(root, spec.name));
  } catch {
    return false;
  }
  if (!contentMatches(content, spec)) return false;
  place(dir, spec, content);
  return true;
}

/**
 * The app orders reader revisions by when Hugging Face published them, and
 * never reads with one older than it ships (#16416): the manifest's
 * `published` has to be the pinned revision's own date. Asked of the Hub API,
 * which counts no download.
 */
async function checkPublished(manifest, fetchImpl) {
  const url = `${HF}/api/models/${manifest.id}/revision/${manifest.revision}`;
  const response = await fetchImpl(url, {
    headers: { "User-Agent": USER_AGENT },
    signal: AbortSignal.timeout(FILE_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`Looking up ${manifest.revision.slice(0, 12)} failed: HTTP ${response.status}`);
  }
  const detail = await response.json();
  const published = Date.parse(manifest.published);
  if (
    detail.sha !== manifest.revision ||
    !Number.isFinite(published) ||
    Date.parse(detail.lastModified) !== published
  ) {
    throw new Error(
      `published in ${path.relative(ROOT, MANIFEST_PATH)} is ${manifest.published}, but Hugging Face published ${manifest.revision.slice(0, 12)} at ${detail.lastModified}`
    );
  }
}

/** One pinned file into place: checked before it is written, then staged and renamed over it. */
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
  place(dir, spec, content);
}

/**
 * Bytes already checked against `spec`, staged beside their place and renamed
 * over it. Each writer stages under a name of its own: a dev watch prepares the
 * model while the app runs, and `npm run fetch:canopy-model` may run beside it.
 */
function place(dir, spec, content) {
  const target = path.join(dir, spec.name);
  const part = `${target}.${process.pid}-${crypto.randomBytes(6).toString("hex")}.part`;
  try {
    fs.writeFileSync(part, content, { flag: "wx" });
    fs.renameSync(part, target);
  } finally {
    fs.rmSync(part, { force: true });
  }
}

module.exports = {
  MANIFEST_PATH,
  MODELS_ROOT,
  MODEL_DIR,
  RESOURCES_NAME,
  readManifest,
  modelDir,
  gitBlobId,
  contentMatches,
  invalidFiles,
  prepareModel,
};
