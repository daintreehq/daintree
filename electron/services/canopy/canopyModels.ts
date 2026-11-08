/**
 * The local model Canopy reads screens with, `daintreehq/canopy-reader-17m`.
 * It ships inside the app (#16415), at the revision and hashes pinned in
 * `canopy-reader-manifest.json`: the build fetches those files and packaging
 * checks them, and each launch checks them once more before the reader may
 * load them.
 *
 * A newer revision Hugging Face publishes reaches users between releases
 * (#16416): with Canopy on, the Hub is asked once a launch for its newest
 * revision, and one this build reads is fetched beside the copy in use,
 * checked against the hashes the Hub publishes, and read with from then on.
 * The shipped copy is the floor: nothing older than it is ever read. The only
 * requests are for the repo's revision metadata and its model files; no screen
 * ever leaves the machine.
 */
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  rmdir,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  CANOPY_MODEL,
  CANOPY_MODEL_AUTHOR,
  canopyModelName,
  isCanopyModelId,
  type CanopyModelInfo,
  type CanopyModelState,
} from "../../../shared/types/ipc/canopy.js";
import { formatErrorMessage } from "../../../shared/utils/errorMessage.js";
import { isReaderMeta } from "./canopyReader.js";
import manifest from "./canopy-reader-manifest.json" with { type: "json" };

export { CANOPY_MODEL, canopyModelName };

export interface CanopyModelFileSpec {
  name: string;
  size: number;
  /** SHA-256 of an LFS file, the model weights. */
  sha256?: string;
  /** Git's blob SHA-1 of a small file kept in the repo itself. */
  blobId?: string;
}

/** One revision of the model: its commit, when it was published, and its files' pins. */
export interface CanopyModelRevision {
  revision: string;
  /** When Hugging Face published it (epoch ms): the only order revisions have offline. */
  published: number;
  files: readonly CanopyModelFileSpec[];
}

/** The weights file the reader loads: weight-only INT8, which reads the same on every CPU. */
export const CANOPY_READER_WEIGHTS: string = manifest.weights;

/** The revision this build ships. */
const SHIPPED: CanopyModelRevision = {
  revision: manifest.revision,
  published: Date.parse(manifest.published),
  files: manifest.files,
};

/** Every file the reader opens. An update must carry each, with a hash the Hub publishes. */
const READER_FILES = ["config.json", "tokenizer.json", "tokenizer_config.json"] as const;

const HF = "https://huggingface.co";
const USER_AGENT = "Daintree-Canopy/1.0";
const CHECK_TIMEOUT_MS = 10_000;
/** One file's request, body included: one cut off is picked up where it stopped on the next try. */
const FILE_TIMEOUT_MS = 300_000;
/** Settings hears an update's progress at most this often. */
const PROGRESS_INTERVAL_MS = 500;
const REVISION = /^[0-9a-f]{40}$/;
const STAGING = ".download";
/** An update's record of itself. In a finished update's folder it is the last thing written. */
const INSTALL = "install.json";
/** The same record in a download's folder, written first, so a download stopped part way says what it was. */
const PENDING = "download.json";
/** A revision this build fetched and couldn't run: the same record, beside the folders, so it isn't fetched again. */
const REJECTED = ".rejected";
/** Far past the reader's ~21 MB: a Hub answer naming more is not this model. */
const MAX_MODEL_BYTES = 512 * 1024 * 1024;

const DAMAGED =
  "The model that comes with Daintree is missing or damaged. Reinstalling Daintree puts it back.";

/** Whether `file` is the one pinned: its size, then its hash, read as a stream. */
async function matches(file: string, spec: CanopyModelFileSpec): Promise<boolean> {
  const size = await stat(file).then(
    (s) => s.size,
    () => -1
  );
  if (size !== spec.size) return false;
  if (spec.sha256) {
    const hash = createHash("sha256");
    await pipeline(createReadStream(file), hash);
    return hash.digest("hex") === spec.sha256;
  }
  if (spec.blobId) {
    const hash = createHash("sha1").update(`blob ${size}\0`);
    await pipeline(createReadStream(file), hash);
    return hash.digest("hex") === spec.blobId;
  }
  return false;
}

/** The files of `files` in `dir` that are missing or don't match their pins. */
async function mismatched(dir: string, files: readonly CanopyModelFileSpec[]): Promise<string[]> {
  const bad: string[] = [];
  for (const spec of files) {
    const ok = await matches(path.join(dir, spec.name), spec).catch(() => false);
    if (!ok) bad.push(spec.name);
  }
  return bad;
}

/** Windows holds a file open until its reader process has exited: retried for a few seconds. */
function removeDir(dir: string): Promise<void> {
  return rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
}

function isFileSpec(value: unknown): value is CanopyModelFileSpec {
  if (typeof value !== "object" || value === null) return false;
  const spec = value as Partial<CanopyModelFileSpec>;
  return (
    typeof spec.name === "string" &&
    // A plain name: an update's files never reach outside its folder.
    path.basename(spec.name) === spec.name &&
    !spec.name.startsWith(".") &&
    typeof spec.size === "number" &&
    Number.isSafeInteger(spec.size) &&
    spec.size >= 0 &&
    spec.size <= MAX_MODEL_BYTES &&
    (typeof spec.sha256 === "string" || typeof spec.blobId === "string")
  );
}

/** Every file the reader opens is pinned. */
function complete(files: readonly CanopyModelFileSpec[]): boolean {
  return [...READER_FILES, CANOPY_READER_WEIGHTS].every((name) =>
    files.some((file) => file.name === name)
  );
}

/** Newer than `than`: a different revision, published after it. */
function newer(revision: CanopyModelRevision, than: CanopyModelRevision): boolean {
  return revision.revision !== than.revision && revision.published > than.published;
}

function totalBytes(revision: CanopyModelRevision): number {
  return revision.files.reduce((sum, file) => sum + file.size, 0);
}

async function fetchJson(url: string, signal: AbortSignal): Promise<unknown> {
  const response = await fetch(url, { headers: { "User-Agent": USER_AGENT }, signal });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

/**
 * The repo's newest revision, from the Hub API: its commit, when it was
 * published, and the hashes the Hub publishes for the reader's files. Null
 * when the Hub's answer doesn't say all of that.
 */
async function fetchNewest(signal: AbortSignal): Promise<CanopyModelRevision | null> {
  const detail = (await fetchJson(`${HF}/api/models/${CANOPY_MODEL}?blobs=true`, signal)) as {
    sha?: unknown;
    lastModified?: unknown;
    private?: unknown;
    siblings?: unknown;
  };
  if (detail.private === true || typeof detail.sha !== "string" || !REVISION.test(detail.sha)) {
    return null;
  }
  const published = typeof detail.lastModified === "string" ? Date.parse(detail.lastModified) : NaN;
  if (!Number.isFinite(published) || !Array.isArray(detail.siblings)) return null;
  const siblings = detail.siblings as {
    rfilename?: unknown;
    size?: unknown;
    blobId?: unknown;
    lfs?: { sha256?: unknown };
  }[];
  const files: CanopyModelFileSpec[] = [];
  for (const name of [...READER_FILES, CANOPY_READER_WEIGHTS]) {
    const sibling = siblings.find((s) => s?.rfilename === name);
    if (!sibling || typeof sibling.size !== "number") return null;
    // The weights are in LFS, pinned by their SHA-256; the rest by git's blob id.
    const lfs = name === CANOPY_READER_WEIGHTS;
    const sha256 = sibling.lfs?.sha256;
    if (lfs && typeof sha256 !== "string") return null;
    if (!lfs && typeof sibling.blobId !== "string") return null;
    const spec = lfs
      ? { name, size: sibling.size, sha256: sha256 as string }
      : { name, size: sibling.size, blobId: sibling.blobId as string };
    if (!isFileSpec(spec)) return null;
    files.push(spec);
  }
  if (files.reduce((sum, file) => sum + file.size, 0) > MAX_MODEL_BYTES) return null;
  return { revision: detail.sha, published, files };
}

/**
 * Whether this build reads `revision`, from its `reader.json`: the same as its
 * `config.json`, which is never asked for here, since asking for it is what
 * Hugging Face counts as a download.
 */
async function readable(revision: string, signal: AbortSignal): Promise<boolean> {
  return isReaderMeta(
    await fetchJson(`${HF}/${CANOPY_MODEL}/resolve/${revision}/reader.json`, signal)
  );
}

/** What `folder` records of `revision` in `file`, or null when that isn't a record of it. */
async function readRecord(
  folder: string,
  revision: string,
  file: string
): Promise<CanopyModelRevision | null> {
  try {
    const raw = JSON.parse(await readFile(path.join(folder, file), "utf8")) as {
      id?: unknown;
      revision?: unknown;
      published?: unknown;
      files?: unknown;
    };
    if (raw.id !== CANOPY_MODEL || raw.revision !== revision) return null;
    if (typeof raw.published !== "number" || !Number.isFinite(raw.published)) return null;
    if (!Array.isArray(raw.files) || !raw.files.every(isFileSpec)) return null;
    const files = raw.files as CanopyModelFileSpec[];
    const names = new Set(files.map((spec) => spec.name));
    if (names.size !== files.length || !complete(files)) return null;
    return { revision, published: raw.published, files };
  } catch {
    return null;
  }
}

/** One thing this code keeps in the updates folder for a revision. */
interface Entry {
  name: string;
  revision: string;
  kind: "update" | "download" | "rejected";
}

/** A name in the updates folder this code wrote; null for anything else, which is left alone. */
function entryOf(name: string): Entry | null {
  const kind = name.endsWith(STAGING)
    ? "download"
    : name.endsWith(REJECTED)
      ? "rejected"
      : "update";
  const suffix = kind === "download" ? STAGING : kind === "rejected" ? REJECTED : "";
  const revision = name.slice(0, name.length - suffix.length);
  return REVISION.test(revision) ? { name, revision, kind } : null;
}

/** What an entry records of its revision: the record in its folder, or the marker itself. */
function recordOf(root: string, entry: Entry): Promise<CanopyModelRevision | null> {
  if (entry.kind === "rejected") return readRecord(root, entry.revision, entry.name);
  const file = entry.kind === "download" ? PENDING : INSTALL;
  return readRecord(path.join(root, entry.name), entry.revision, file);
}

/** Whether `root` or the folder holding it is missing or reached through a link: not ours to empty either way. */
async function notOwnFolder(root: string): Promise<boolean> {
  for (const folder of [path.dirname(root), root]) {
    const link = await lstat(folder).then(
      (s) => s.isSymbolicLink(),
      () => null
    );
    if (link !== false) return true;
  }
  return false;
}

/** One update folder gone; one that can't go yet (Windows) goes on a later launch. */
async function removeUpdate(root: string, name: string): Promise<void> {
  await removeDir(path.join(root, name)).catch((error: unknown) =>
    console.warn(`[Canopy] Couldn't delete the model update ${name}:`, error)
  );
}

/** Every file of `revision` in `dir` matches its pin, and its config is one this build reads. */
async function usable(dir: string, revision: CanopyModelRevision): Promise<boolean> {
  if ((await mismatched(dir, revision.files)).length > 0) return false;
  try {
    return isReaderMeta(JSON.parse(await readFile(path.join(dir, "config.json"), "utf8")));
  } catch {
    return false;
  }
}

/** Where a 206's body starts in the file, from its `Content-Range`; null when it doesn't say. */
function rangeFrom(response: Response): number | null {
  const match = /^bytes (\d+)-\d+\/(?:\d+|\*)$/.exec(response.headers.get("content-range") ?? "");
  return match ? Number(match[1]) : null;
}

/** The copy Canopy reads with. */
interface InUse {
  revision: CanopyModelRevision;
  dir: string;
  source: "bundled" | "update";
}

interface Download {
  revision: string;
  received: number;
  total: number;
}

/** One look for an update, registered before its first await so it can be cancelled from the start. */
interface Operation {
  abort: AbortController;
  done: Promise<void>;
}

/** Raised when a fetched revision can't be read with here, whatever its hashes say. */
class Unrunnable extends Error {}

export interface CanopyModelsOptions {
  /**
   * Where updates fetched from Hugging Face live, one folder per revision;
   * null never looks for one. Not `<userData>/canopy/models`, which
   * `removeDownloadedModels` empties on every launch.
   */
  updates?: string | null;
  /** The revision the app ships in its folder, and its files' pins. */
  shipped?: CanopyModelRevision;
  /**
   * Runs a fetched revision before it is read with, from its folder: throws
   * when it can't load or read here. A revision that throws is never used.
   */
  trial?: (dir: string) => Promise<void>;
}

export class CanopyModels {
  private local: Promise<void> | null = null;
  /** The copy read with: undefined until checked, null when none checks out. */
  private inUse: InUse | null | undefined;
  /**
   * The newest revision the Hub named this launch when this build reads it,
   * else null; undefined until the Hub has answered.
   */
  private newest: CanopyModelRevision | null | undefined;
  private download: Download | null = null;
  private operation: Operation | null = null;
  private lastProgressAt = 0;
  private disposed = false;
  private readonly updates: string | null;
  private readonly shipped: CanopyModelRevision;
  private readonly trial: ((dir: string) => Promise<void>) | null;

  constructor(
    /** The folder the app ships the model in. */
    private readonly dir: string,
    /** Told once the check is done, as an update makes progress, and when one is in place. */
    private readonly onChange: () => void,
    options: CanopyModelsOptions = {}
  ) {
    this.updates = options.updates ?? null;
    this.shipped = options.shipped ?? SHIPPED;
    this.trial = options.trial ?? null;
  }

  /**
   * Checks the copy to read with, once a launch, then, when updates are on,
   * looks for a newer revision and fetches it while that copy reads. Resolves
   * once both are done; an update that fails is logged and tried again on the
   * next call, never reported.
   */
  ensure(): Promise<void> {
    const local = this.checkLocal();
    if (this.updates === null || this.disposed) return local;
    const current = this.operation;
    if (current && !current.abort.signal.aborted) return current.done;
    const abort = new AbortController();
    // One stopped a moment ago may still be writing: this one starts once it has let go.
    const operation: Operation = {
      abort,
      done: this.update(local, abort.signal, current?.done ?? null),
    };
    this.operation = operation;
    const settle = () => {
      if (this.operation === operation) this.operation = null;
    };
    operation.done.then(settle, settle);
    return operation.done;
  }

  /** Every later call joins or reads the launch's one check: nothing hashes a model twice. */
  private checkLocal(): Promise<void> {
    this.local ??= this.pickLocal();
    return this.local;
  }

  /** The newest update here that checks out, else the shipped copy when it does. */
  private async pickLocal(): Promise<void> {
    let picked = this.updates === null ? null : await this.pickUpdate(this.updates);
    if (picked === null) {
      const bad = await mismatched(this.dir, this.shipped.files);
      if (bad.length > 0) {
        console.error(`[Canopy] Model at ${this.dir} fails its check: ${bad.join(", ")}`);
      } else {
        picked = { revision: this.shipped, dir: this.dir, source: "bundled" };
      }
    }
    this.inUse = picked;
    this.tell();
  }

  /**
   * The newest update in `root` that is newer than the shipped copy, matches
   * its hashes, and that this build reads. Every other one goes: one the
   * shipped copy has caught up with after an app update, one a newer update
   * replaced, one that no longer matches. A download stopped part way stays
   * for the next try when it says what it was fetching.
   */
  private async pickUpdate(root: string): Promise<InUse | null> {
    await removeStaleUpdates(root, undefined, this.shipped);
    const names = await readdir(root).catch(() => [] as string[]);
    const found: CanopyModelRevision[] = [];
    for (const name of names) {
      const entry = entryOf(name);
      if (entry === null || entry.kind === "rejected") continue;
      const record = await recordOf(root, entry);
      if (entry.kind === "download") {
        // Nothing writes it before this check is done: no record means it never got started.
        if (record === null) await this.discard(name);
      } else if (record !== null && newer(record, this.shipped)) {
        // Older than the shipped copy is never read, whether or not the sweep could delete it.
        found.push(record);
      } else {
        await this.discard(name);
      }
    }
    found.sort((a, b) => b.published - a.published);
    let picked: InUse | null = null;
    for (const revision of found) {
      const dir = path.join(root, revision.revision);
      if (picked === null && (await usable(dir, revision))) {
        picked = { revision, dir, source: "update" };
        continue;
      }
      if (picked === null)
        console.warn(`[Canopy] Model update ${revision.revision} fails its check`);
      await this.discard(revision.revision);
    }
    return picked;
  }

  private async update(
    local: Promise<void>,
    signal: AbortSignal,
    before: Promise<void> | null
  ): Promise<void> {
    await before?.catch(() => {});
    await local;
    if (signal.aborted) return;
    if (this.newest === undefined) {
      try {
        const timed = AbortSignal.any([signal, AbortSignal.timeout(CHECK_TIMEOUT_MS)]);
        const newest = await fetchNewest(timed);
        this.newest =
          newest &&
          newer(newest, this.floor()) &&
          !(await this.wasRejected(newest.revision)) &&
          (await readable(newest.revision, timed))
            ? newest
            : null;
      } catch (error) {
        // Offline, or the Hub didn't answer: asked again on the next `ensure`.
        if (!signal.aborted) {
          console.warn("[Canopy] Couldn't look for a model update:", formatErrorMessage(error, ""));
        }
        return;
      }
      await this.discardStaging(this.newest?.revision ?? null);
    }
    const target = this.newest;
    if (target === null || signal.aborted || !newer(target, this.floor())) return;
    const download: Download = {
      revision: target.revision,
      received: 0,
      total: totalBytes(target),
    };
    this.download = download;
    this.tell();
    try {
      const dir = await this.fetchInto(target, download, signal);
      // Stopped or let go while it was moved into place: the next launch finds it there.
      if (signal.aborted || this.disposed) return;
      const previous = this.inUse;
      this.inUse = { revision: target, dir, source: "update" };
      this.download = null;
      this.tell();
      if (previous?.source === "update") await this.discard(previous.revision.revision);
    } catch (error) {
      if (error instanceof Unrunnable) {
        console.warn(
          `[Canopy] Model update ${target.revision} can't be read with here:`,
          error.message
        );
        await this.reject(target);
      } else if (!signal.aborted) {
        // The copy in use reads on; what was fetched is kept for the next try.
        console.warn("[Canopy] Model update failed:", formatErrorMessage(error, ""));
      }
    } finally {
      if (this.download === download) {
        this.download = null;
        this.tell();
      }
    }
  }

  /** The revision an update has to be newer than: the copy in use, never older than the shipped one. */
  private floor(): CanopyModelRevision {
    const inUse = this.inUse?.revision;
    return inUse && inUse.published > this.shipped.published ? inUse : this.shipped;
  }

  /**
   * Every file into `<revision>.download`, each checked against the hash the
   * Hub publishes, then the folder renamed to `<revision>`: an update is either
   * all there and checked, or not an update. A file fetched part way is picked
   * up where it stopped on the next try.
   */
  private async fetchInto(
    target: CanopyModelRevision,
    download: Download,
    signal: AbortSignal
  ): Promise<string> {
    const root = this.updates!;
    const dir = path.join(root, target.revision);
    const staging = `${dir}${STAGING}`;
    await mkdir(staging, { recursive: true });
    const record = JSON.stringify({
      id: CANOPY_MODEL,
      revision: target.revision,
      published: target.published,
      files: target.files,
    });
    await writeFile(path.join(staging, PENDING), record, "utf8");
    for (const file of target.files) {
      const into = path.join(staging, file.name);
      const part = `${into}.part`;
      // `config.json` is asked for on every download, never taken from an
      // earlier one: it is what Hugging Face counts a download by.
      if (file.name !== "config.json" && (await matches(into, file).catch(() => false))) {
        this.progress(download, file.size);
        continue;
      }
      let have = await stat(part).then(
        (s) => s.size,
        () => 0
      );
      if (have > file.size) {
        await rm(part, { force: true });
        have = 0;
      }
      const timed = AbortSignal.any([signal, AbortSignal.timeout(FILE_TIMEOUT_MS)]);
      const response = await fetch(
        `${HF}/${CANOPY_MODEL}/resolve/${target.revision}/${file.name}`,
        {
          headers: { "User-Agent": USER_AGENT, ...(have > 0 ? { Range: `bytes=${have}-` } : {}) },
          signal: timed,
        }
      );
      let append = false;
      if (response.status === 206 && have > 0 && rangeFrom(response) === have) append = true;
      else if (response.status === 416 && have === file.size) append = true;
      else if (response.status === 206 || response.status === 416) {
        // Not the rest of what is here: the next try starts the file again.
        await response.body?.cancel();
        await rm(part, { force: true });
        throw new Error(`Download failed (HTTP ${response.status})`);
      } else if (!response.ok) {
        await response.body?.cancel();
        throw new Error(`Download failed (HTTP ${response.status})`);
      }
      if (append) this.progress(download, have);
      if (response.status !== 416) {
        if (!response.body) throw new Error("Download failed (no data)");
        let size = append ? have : 0;
        const count = new Transform({
          transform: (chunk: Buffer, _encoding, done) => {
            size += chunk.length;
            // Never a byte past what the Hub published: the file is wrong already.
            if (size > file.size) {
              done(new Error(`${file.name} is larger than Hugging Face published`));
              return;
            }
            this.progress(download, chunk.length);
            done(null, chunk);
          },
        });
        await pipeline(
          Readable.fromWeb(response.body as import("node:stream/web").ReadableStream),
          count,
          createWriteStream(part, { flags: append ? "a" : "w" }),
          { signal: timed }
        );
      } else {
        await response.body?.cancel();
      }
      if (!(await matches(part, file).catch(() => false))) {
        await rm(part, { force: true });
        throw new Error(`${file.name} doesn't match what Hugging Face published`);
      }
      await rename(part, into);
    }
    // The reader.json the Hub served said this build reads it; the config.json
    // the reader opens has to say so too.
    const meta: unknown = JSON.parse(await readFile(path.join(staging, "config.json"), "utf8"));
    if (!isReaderMeta(meta)) throw new Unrunnable("its config.json is not one this build reads");
    if (signal.aborted) throw new Error("cancelled");
    // Run where it was fetched, before anything reads with it: one stopped
    // here is tried again, never put in place untried.
    if (this.trial) {
      try {
        await this.trial(staging);
      } catch (error) {
        if (signal.aborted) throw new Error("cancelled");
        throw new Unrunnable(formatErrorMessage(error, "it doesn't run"));
      }
    }
    if (signal.aborted) throw new Error("cancelled");
    // The record goes last: until it is there, the folder is not an update.
    await rename(path.join(staging, PENDING), path.join(staging, INSTALL));
    // A folder of that name with no record in it is a move cut short: never the copy in use.
    await removeDir(dir);
    await rename(staging, dir);
    return dir;
  }

  private progress(download: Download, bytes: number): void {
    download.received += bytes;
    const now = Date.now();
    if (now - this.lastProgressAt < PROGRESS_INTERVAL_MS) return;
    this.lastProgressAt = now;
    this.tell();
  }

  /** A revision this build fetched and couldn't run, so it isn't fetched again. */
  private async wasRejected(revision: string): Promise<boolean> {
    return stat(path.join(this.updates!, `${revision}${REJECTED}`)).then(
      () => true,
      () => false
    );
  }

  /**
   * Remembers `target` as one this build can't run, and lets its files go.
   * The record goes with it, so the sweep deletes it once the shipped copy
   * has caught up.
   */
  private async reject(target: CanopyModelRevision): Promise<void> {
    this.newest = null;
    const root = this.updates!;
    const record = JSON.stringify({
      id: CANOPY_MODEL,
      revision: target.revision,
      published: target.published,
      files: target.files,
    });
    await writeFile(path.join(root, `${target.revision}${REJECTED}`), record, "utf8").catch(
      (error: unknown) => console.warn("[Canopy] Couldn't note a model update that failed:", error)
    );
    await this.discard(`${target.revision}${STAGING}`);
  }

  /** Partly fetched revisions other than `keep`: the Hub has moved on from them. */
  private async discardStaging(keep: string | null): Promise<void> {
    const names = await readdir(this.updates!).catch(() => [] as string[]);
    for (const name of names) {
      if (!name.endsWith(STAGING)) continue;
      const base = name.slice(0, -STAGING.length);
      if (REVISION.test(base) && base !== keep) await this.discard(name);
    }
  }

  private async discard(name: string): Promise<void> {
    await removeUpdate(this.updates!, name);
  }

  private tell(): void {
    if (!this.disposed) this.onChange();
  }

  /** The folder to read the model from once it checks out; null while checking, or when nothing did. */
  async installedDir(): Promise<string | null> {
    await this.checkLocal();
    return this.inUse?.dir ?? null;
  }

  /** The folder read with now, without waiting: null until checked, or when nothing checks out. */
  currentDir(): string | null {
    return this.inUse?.dir ?? null;
  }

  /** The model as Settings shows it. */
  async info(): Promise<CanopyModelInfo> {
    await this.checkLocal();
    return {
      id: CANOPY_MODEL,
      name: canopyModelName(CANOPY_MODEL),
      bytes: totalBytes(this.inUse?.revision ?? this.shipped),
      installed: this.inUse != null,
    };
  }

  /** Where the model stands: nothing to say until the check is done. An update on its way leaves it ready. */
  state(): CanopyModelState | undefined {
    const inUse = this.inUse;
    if (inUse === undefined) return undefined;
    if (inUse === null) return { id: CANOPY_MODEL, status: "failed", error: DAMAGED };
    const download = this.download;
    return {
      id: CANOPY_MODEL,
      status: "ready",
      revision: inUse.revision.revision,
      source: inUse.source,
      ...(download
        ? {
            update: {
              revision: download.revision,
              received: Math.min(download.received, download.total),
              total: download.total,
            },
          }
        : {}),
    };
  }

  /** Stops an update under way; what it fetched so far is kept for the next try. */
  cancel(): void {
    this.operation?.abort.abort();
  }

  /** A check or update finishing after this tells no one. */
  dispose(): void {
    this.disposed = true;
    this.cancel();
  }
}

/**
 * Deletes what earlier versions of Daintree downloaded into `root`
 * (`<userData>/canopy/models`): every reader model folder, with its
 * half-finished `.download` and set-aside `.old` copies, then `root` itself
 * once nothing else is in it. Updates fetched since the model shipped with
 * Daintree (#16416) live elsewhere, in `<userData>/canopy/reader-updates`.
 *
 * A `root` reached through a link is left alone: it may be a folder another
 * profile or build shares. One folder that can't go yet (Windows holds files
 * open until the process reading them exits) doesn't stop the rest; it goes
 * on a later launch. Stops between folders once `signal` aborts.
 */
export async function removeDownloadedModels(root: string, signal?: AbortSignal): Promise<void> {
  if (await notOwnFolder(root)) return;
  const names = await readdir(root).catch(() => null);
  if (names === null) return;
  for (const name of names) {
    if (signal?.aborted) return;
    const base = name.replace(/\.(download|old)$/, "");
    if (!isCanopyModelId(`${CANOPY_MODEL_AUTHOR}/${base}`)) continue;
    await rm(path.join(root, name), {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 300,
    }).catch((error: unknown) =>
      console.warn(`[Canopy] Couldn't delete the downloaded model ${name}:`, error)
    );
  }
  await rmdir(root).catch(() => {});
}

/**
 * Deletes every update in `root` (`<userData>/canopy/reader-updates`) the
 * shipped copy has caught up with, as after an app update that ships a newer
 * revision: finished, part way, or noted as one this build couldn't run,
 * along with any finished one whose record can't be read. Only records are read, nothing is hashed or fetched, so it
 * runs whatever Canopy's mode. A download with no record yet is left alone:
 * it may be being written.
 *
 * A `root` reached through a link is left alone, as `removeDownloadedModels`
 * leaves one. Stops between folders once `signal` aborts.
 */
export async function removeStaleUpdates(
  root: string,
  signal?: AbortSignal,
  shipped: CanopyModelRevision = SHIPPED
): Promise<void> {
  if (await notOwnFolder(root)) return;
  const names = await readdir(root).catch(() => null);
  if (names === null) return;
  for (const name of names) {
    if (signal?.aborted) return;
    const entry = entryOf(name);
    if (entry === null) continue;
    const record = await recordOf(root, entry);
    const stale =
      record !== null
        ? !newer(record, shipped)
        : entry.kind !== "download" || entry.revision === shipped.revision;
    if (stale) await removeUpdate(root, name);
  }
}
