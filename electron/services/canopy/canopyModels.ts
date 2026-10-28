/**
 * The local model Canopy reads screens with, and getting it here. It is the
 * public `daintreehq/canopy-reader-17m` repo on Hugging Face: pinned at the
 * revision known at build time, and updated to a newer one when Hugging Face
 * publishes a revision this build can read.
 *
 * Nothing here ever sends a screen anywhere: the only requests are for the
 * repo's revision and the model files themselves.
 */
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
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

const HF = "https://huggingface.co";
const USER_AGENT = "Daintree-Canopy/1.0";
export { CANOPY_MODEL, canopyModelName, isCanopyModelId };
/**
 * Everything the reader needs besides its weights. `config.json` is what
 * Hugging Face counts a download by, so it is fetched with every download and
 * never to look for an update; `reader.json` holds the same and is not needed.
 */
const COMMON_FILES = ["config.json", "tokenizer.json", "tokenizer_config.json"];
/** Weight-only INT8: every multiply runs in float, so it reads the same on every CPU. */
const WEIGHTS = "model.int8.onnx";
const REVISION_TIMEOUT_MS = 10_000;
/** Progress is told at most this often. */
const PROGRESS_INTERVAL_MS = 250;

interface FileSpec {
  name: string;
  size: number;
  /** SHA-256 of an LFS file, the model weights. */
  sha256?: string;
  /** Git's blob SHA-1 of a small file kept in the repo itself. */
  blobId?: string;
}

interface Variant {
  revision: string;
  /** Every file fetched, the weights last. */
  files: FileSpec[];
}

/** The revision published at build time. */
const BUNDLED: Variant = {
  revision: "eb00edfd11d640d412e6b9fffcf812c795d308d4",
  files: [
    { name: "config.json", size: 1703, blobId: "ff12926090370f57579a3d9b641adf1311d8f381" },
    { name: "tokenizer.json", size: 3583228, blobId: "2f4d8583e507b7466d2490e2d6c045647a822698" },
    {
      name: "tokenizer_config.json",
      size: 368,
      blobId: "e3ce044f1db95b6884796f4fdf7d3f78fb6b9df4",
    },
    {
      name: WEIGHTS,
      size: 17410374,
      sha256: "da4e9eb4a873d1349fd38d2e86c5b120cc82d802844833ef3a901f48282c0fd1",
    },
  ],
};

/** Git's blob id: SHA-1 over `blob <size>\0` and the content. */
function gitBlobId(content: Buffer): string {
  return createHash("sha1").update(`blob ${content.length}\0`).update(content).digest("hex");
}

async function sha256File(file: string): Promise<string> {
  const hash = createHash("sha256");
  await pipeline(createReadStream(file), hash);
  return hash.digest("hex");
}

async function fetchJson(url: string, signal: AbortSignal): Promise<unknown> {
  const response = await fetch(url, { headers: { "User-Agent": USER_AGENT }, signal });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

/**
 * The repo's newest revision, from the Hub API, when this build can read it;
 * null when it can't. Its `reader.json` is what is checked: `config.json`
 * holds the same, but asking for it would count as a download.
 */
async function fetchLatest(signal: AbortSignal): Promise<Variant | null> {
  const detail = (await fetchJson(`${HF}/api/models/${CANOPY_MODEL}?blobs=true`, signal)) as {
    sha?: string;
    private?: boolean;
    siblings?: { rfilename?: string; size?: number; blobId?: string; lfs?: { sha256?: string } }[];
  };
  if (detail.private || typeof detail.sha !== "string" || !Array.isArray(detail.siblings)) {
    return null;
  }
  if (detail.sha === BUNDLED.revision) return BUNDLED;
  const spec = (name: string, lfs: boolean): FileSpec | null => {
    const sibling = detail.siblings!.find((s) => s.rfilename === name);
    if (!sibling || typeof sibling.size !== "number") return null;
    const sha256 = sibling.lfs?.sha256;
    if (lfs) return typeof sha256 === "string" ? { name, size: sibling.size, sha256 } : null;
    return typeof sibling.blobId === "string"
      ? { name, size: sibling.size, blobId: sibling.blobId }
      : null;
  };
  const files: FileSpec[] = [];
  for (const name of COMMON_FILES) {
    const file = spec(name, false);
    if (!file) return null;
    files.push(file);
  }
  const weights = spec(WEIGHTS, true);
  if (!weights) return null;
  files.push(weights);
  const meta = await fetchJson(`${HF}/${CANOPY_MODEL}/resolve/${detail.sha}/reader.json`, signal);
  return isReaderMeta(meta) ? { revision: detail.sha, files } : null;
}

/** Windows holds a file open until its reader process has exited: retried for a few seconds. */
function removeDir(dir: string): Promise<void> {
  return rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
}

function totalBytes(v: Variant): number {
  return v.files.reduce((sum, f) => sum + f.size, 0);
}

interface Installed {
  revision: string;
  bytes: number;
}

interface Download {
  received: number;
  total: number;
  abort: AbortController;
}

/** One `ensure`, registered before its first await so it can be cancelled from the start. */
interface Operation {
  abort: AbortController;
  done: Promise<void>;
}

export class CanopyModels {
  /**
   * The newest revision Hugging Face publishes, when this build reads it; null
   * before it has said, or when it can't be read here.
   */
  private latest: Variant | null = null;
  /** Hugging Face is asked for the newest revision once a launch, and again only after a failure. */
  private checked = false;
  private download: Download | null = null;
  private operation: Operation | null = null;
  private failure: string | null = null;
  private lastProgressAt = 0;
  private installed: Installed | null = null;
  /** An update is being moved into place: the folder is not there to read from meanwhile. */
  private replacing = false;
  private scanned: Promise<void> | null = null;
  /** A deletion under way: nothing is downloaded until it is done. */
  private removing: Promise<void> | null = null;

  constructor(
    private readonly root: string,
    private readonly onChange: () => void,
    /** Lets go of the installed files before an update replaces them. */
    private readonly beforeReplace: () => void = () => {},
    /** An update is in place: what the last revision read is no longer this model's. */
    private readonly afterReplace: () => void = () => {}
  ) {}

  private dirOf(id: string): string {
    return path.join(this.root, id.slice(id.indexOf("/") + 1));
  }

  /** The folder the ready model is in, or null when it isn't on this machine. */
  async installedDir(): Promise<string | null> {
    await this.scan();
    return this.installed && !this.replacing ? this.dirOf(CANOPY_MODEL) : null;
  }

  private scan(): Promise<void> {
    this.scanned ??= this.readInstall();
    return this.scanned;
  }

  private async readInstall(): Promise<void> {
    const dir = this.dirOf(CANOPY_MODEL);
    // An update stopped between moving the last revision aside and the new
    // one into place: the last one goes back.
    const backup = `${dir}.old`;
    const there = (folder: string) =>
      stat(path.join(folder, "install.json")).then(
        () => true,
        () => false
      );
    if (!(await there(dir)) && (await there(backup))) {
      await removeDir(dir).catch(() => {});
      await rename(backup, dir).catch(() => {});
    }
    try {
      const raw = JSON.parse(await readFile(path.join(dir, "install.json"), "utf8")) as {
        id?: unknown;
        revision?: unknown;
      };
      if (raw.id !== CANOPY_MODEL || typeof raw.revision !== "string") return;
      const names = await readdir(dir);
      let bytes = 0;
      for (const name of names) bytes += (await stat(path.join(dir, name))).size;
      this.installed = { revision: raw.revision, bytes };
    } catch {
      // Not installed, or a half-written install that is not one.
    }
  }

  /** The model as Settings shows it: what a download fetches, or what is here. */
  async info(): Promise<CanopyModelInfo> {
    await this.scan();
    return {
      id: CANOPY_MODEL,
      name: canopyModelName(CANOPY_MODEL),
      bytes: this.installed?.bytes ?? totalBytes(this.latest ?? BUNDLED),
      installed: this.installed !== null,
    };
  }

  /** Where the model stands. An update on its way leaves it ready: the installed one reads meanwhile. */
  state(): CanopyModelState {
    const id = CANOPY_MODEL;
    if (this.installed) return { id, status: "ready" };
    const download = this.download;
    if (download) {
      return { id, status: "downloading", received: download.received, total: download.total };
    }
    if (this.failure !== null) return { id, status: "failed", error: this.failure };
    return { id, status: "missing" };
  }

  /**
   * Gets the model here, or the newest revision of it this build reads, unless
   * it is or is on its way. Resolves once it is ready, failed or cancelled.
   */
  ensure(): Promise<void> {
    const current = this.operation;
    if (current && !current.abort.signal.aborted) return current.done;
    const abort = new AbortController();
    const operation: Operation = { abort, done: this.run(abort.signal, current?.done ?? null) };
    this.operation = operation;
    void operation.done.finally(() => {
      if (this.operation === operation) this.operation = null;
    });
    return operation.done;
  }

  /** Asks Hugging Face, once, for the newest revision; offline keeps the one known. */
  private async check(signal: AbortSignal): Promise<void> {
    if (this.checked) return;
    try {
      this.latest = await fetchLatest(
        AbortSignal.any([signal, AbortSignal.timeout(REVISION_TIMEOUT_MS)])
      );
      this.checked = true;
    } catch {
      // Offline: asked again on the next `ensure`.
    }
  }

  private async run(signal: AbortSignal, before: Promise<void> | null): Promise<void> {
    await before?.catch(() => {});
    await this.removing?.catch(() => {});
    await this.scan();
    if (signal.aborted) return;
    await this.check(signal);
    if (signal.aborted) return;
    const installed = this.installed;
    // An install is only ever replaced by the newest revision Hugging Face
    // named and this build reads: offline, or with a newest one it can't
    // read, whatever is here stands, never downgraded to the bundled one.
    if (installed && (this.latest === null || this.latest.revision === installed.revision)) {
      return;
    }
    const variant = installed ? this.latest! : (this.latest ?? BUNDLED);
    const download: Download = {
      received: 0,
      total: totalBytes(variant),
      abort: new AbortController(),
    };
    signal.addEventListener("abort", () => download.abort.abort(), { once: true });
    this.download = download;
    this.failure = null;
    this.onChange();
    try {
      await this.fetchInto(variant, download);
      this.installed = { revision: variant.revision, bytes: totalBytes(variant) };
      if (installed) this.afterReplace();
    } catch (error) {
      if (!download.abort.signal.aborted) {
        const message = formatErrorMessage(error, "The download failed.");
        // An update that failed leaves the installed model reading; it is tried on the next launch.
        if (this.installed) console.warn("[Canopy] Model update failed:", message);
        else this.failure = message;
      }
    } finally {
      if (this.download === download) this.download = null;
      this.onChange();
    }
  }

  /** Stops a download under way; what it fetched so far is kept for the next try. */
  cancel(): void {
    this.operation?.abort.abort();
  }

  /**
   * Deletes every model folder on this machine, half-finished downloads
   * included, but the one in use when `keepCurrent`: the models an earlier
   * Daintree could choose from go with it.
   */
  async remove(keepCurrent: boolean): Promise<void> {
    const before = this.removing;
    // The download under way now, not one started later: that one waits for
    // this removal, and waiting on it here would wait forever.
    const running = this.operation;
    const removal = (async () => {
      await before?.catch(() => {});
      await this.removeNow(keepCurrent, running);
    })();
    this.removing = removal;
    try {
      await removal;
    } finally {
      if (this.removing === removal) this.removing = null;
    }
  }

  private async removeNow(keepCurrent: boolean, running: Operation | null): Promise<void> {
    if (running && !keepCurrent) {
      running.abort.abort();
      await running.done.catch(() => {});
    }
    await this.scan();
    const kept = path.basename(this.dirOf(CANOPY_MODEL));
    if (!keepCurrent) this.installed = null;
    const names = await readdir(this.root).catch(() => [] as string[]);
    for (const name of names) {
      const base = name.replace(/\.(download|old)$/, "");
      if (!isCanopyModelId(`${CANOPY_MODEL_AUTHOR}/${base}`)) continue;
      if (keepCurrent && base === kept) continue;
      await removeDir(path.join(this.root, name));
    }
    this.onChange();
  }

  private progress(download: Download, bytes: number): void {
    download.received += bytes;
    const now = Date.now();
    if (now - this.lastProgressAt < PROGRESS_INTERVAL_MS) return;
    this.lastProgressAt = now;
    this.onChange();
  }

  /**
   * Every file into a staging folder beside the install, each checked against
   * the hash Hugging Face publishes, then the folder renamed into place: a
   * model is either all there and checked, or not there.
   */
  private async fetchInto(variant: Variant, download: Download): Promise<void> {
    const dir = this.dirOf(CANOPY_MODEL);
    const staging = `${dir}.download`;
    await mkdir(staging, { recursive: true });
    const signal = download.abort.signal;
    for (const file of variant.files) {
      const target = path.join(staging, file.name);
      const part = `${target}.${variant.revision.slice(0, 12)}.part`;
      // `config.json` is asked for on every download, never taken from an
      // earlier one: it is what Hugging Face counts a download by.
      if (file.name !== "config.json" && (await this.verified(target, file))) {
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
      const url = `${HF}/${CANOPY_MODEL}/resolve/${variant.revision}/${file.name}`;
      const response = await fetch(url, {
        headers: { "User-Agent": USER_AGENT, ...(have > 0 ? { Range: `bytes=${have}-` } : {}) },
        signal,
      });
      let append = false;
      if (response.status === 206 && have > 0) append = true;
      else if (response.status === 416 && have === file.size) append = true;
      else if (!response.ok) throw new Error(`Download failed (HTTP ${response.status})`);
      if (append) this.progress(download, have);
      if (response.status !== 416) {
        if (!response.body) throw new Error("Download failed (no data)");
        const count = new Transform({
          transform: (chunk: Buffer, _encoding, done) => {
            this.progress(download, chunk.length);
            done(null, chunk);
          },
        });
        await pipeline(
          Readable.fromWeb(response.body as import("node:stream/web").ReadableStream),
          count,
          createWriteStream(part, { flags: append ? "a" : "w" }),
          { signal }
        );
      }
      if (!(await this.verified(part, file))) {
        await rm(part, { force: true });
        throw new Error("The download didn't match what Hugging Face published. Try again.");
      }
      if (signal.aborted) throw new Error("cancelled");
      await rename(part, target);
    }
    // Stopped while the last file was checked: nothing is installed.
    if (signal.aborted) throw new Error("cancelled");
    await writeFile(
      path.join(staging, "install.json"),
      JSON.stringify({ id: CANOPY_MODEL, revision: variant.revision, weights: "int8" }),
      "utf8"
    );
    // An update: the reader lets go of the old files first, and nothing new
    // opens them until the new ones are in their place. The last revision is
    // moved aside, not deleted, until the new one is: a move that fails puts
    // it back, and a launch after one cut short finds it again.
    const backup = `${dir}.old`;
    this.replacing = true;
    try {
      if (this.installed) this.beforeReplace();
      await removeDir(backup);
      const hadOld = await rename(dir, backup).then(
        () => true,
        (error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return false;
          throw error;
        }
      );
      try {
        await rename(staging, dir);
      } catch (error) {
        if (hadOld) {
          await rename(backup, dir).catch(() => {
            this.installed = null;
          });
        }
        throw error;
      }
      await removeDir(backup).catch(() => {});
    } finally {
      this.replacing = false;
    }
  }

  private async verified(file: string, spec: FileSpec): Promise<boolean> {
    const size = await stat(file).then(
      (s) => s.size,
      () => -1
    );
    if (size !== spec.size) return false;
    if (spec.sha256) return (await sha256File(file)) === spec.sha256;
    if (spec.blobId) return gitBlobId(await readFile(file)) === spec.blobId;
    return false;
  }
}
