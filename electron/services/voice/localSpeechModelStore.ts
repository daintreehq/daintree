/**
 * The on-device speech model's files on this machine. Nothing ships with the
 * app: the model is fetched from Hugging Face when the user asks for it, at
 * the revision and hashes pinned in `localSpeechModelSpec.ts`, into a staging
 * folder that a stopped download resumes from. Every file is checked against
 * its SHA-256 before the folder is moved into place, and once more on the
 * first use of each launch; only then is the model ready. The only requests
 * are for those files: no audio ever leaves the machine.
 */
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { LocalSpeechModelStatus } from "../../../shared/types/voice.js";
import { formatErrorMessage } from "../../../shared/utils/errorMessage.js";
import { voiceErrorLogFields } from "../../../shared/utils/voiceLogFields.js";
import {
  LOCAL_SPEECH_MODEL,
  LOCAL_SPEECH_MODEL_BYTES,
  type LocalSpeechFileSpec,
} from "./localSpeechModelSpec.js";

const HF = "https://huggingface.co";
const USER_AGENT = "Daintree-Voice/1.0";
/** A response that sends nothing for this long is given up on; the next try resumes it. */
const STALL_TIMEOUT_MS = 60_000;
/** Settings hears a download's progress at most this often. */
const PROGRESS_INTERVAL_MS = 500;
const STAGING_SUFFIX = ".download";
/** Written last into an installed folder: without it, the folder is not an install. */
const INSTALL_RECORD = "install.json";

/**
 * ONNX Runtime has no build for these targets (`ONNX_UNSHIPPED_TARGETS` in
 * `scripts/afterPack.cjs`), so the model could never load there.
 */
const UNSUPPORTED_TARGETS = new Set(["darwin-x64"]);

export function localSpeechSupported(
  platform: string = process.platform,
  arch: string = process.arch
): boolean {
  return !UNSUPPORTED_TARGETS.has(`${platform}-${arch}`);
}

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface LocalSpeechModelStoreOptions {
  fetch?: FetchLike;
  supported?: boolean;
  files?: readonly LocalSpeechFileSpec[];
  revision?: string;
}

async function matches(
  file: string,
  spec: LocalSpeechFileSpec,
  signal?: AbortSignal
): Promise<boolean> {
  const size = await stat(file).then(
    (s) => s.size,
    () => -1
  );
  if (size !== spec.size) return false;
  const hash = createHash("sha256");
  await pipeline(createReadStream(file), hash, signal ? { signal } : {});
  return hash.digest("hex") === spec.sha256;
}

async function sizeOf(file: string): Promise<number> {
  return stat(file).then(
    (s) => s.size,
    () => 0
  );
}

/** Where a 206's body starts in the file, from its `Content-Range`; null when it doesn't say. */
function rangeFrom(response: Response): number | null {
  const match = /^bytes (\d+)-\d+\/(?:\d+|\*)$/.exec(response.headers.get("content-range") ?? "");
  return match ? Number(match[1]) : null;
}

/** A sentence for Settings: what went wrong, in the user's terms. */
function describeFailure(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  if (code === "ENOSPC") return "There isn't enough free disk space for the model.";
  if (code === "EACCES" || code === "EPERM") return "Daintree couldn't write the model to disk.";
  return formatErrorMessage(error, "The download failed");
}

class Cancelled extends Error {
  constructor() {
    super("cancelled");
  }
}

export class LocalSpeechModelStore {
  private current: LocalSpeechModelStatus;
  private checked: Promise<void> | null = null;
  private operation: { abort: AbortController; done: Promise<void> } | null = null;
  private lastProgressAt = 0;
  /** Moves on with every removal: a check or download begun before it reports nothing. */
  private epoch = 0;
  /** The removal under way: nothing may start reading or writing the files. */
  private removing: object | null = null;
  private readonly fetchImpl: FetchLike;
  private readonly files: readonly LocalSpeechFileSpec[];
  private readonly revision: string;
  private readonly totalBytes: number;

  constructor(
    /** The folder this model's revisions live in. */
    private readonly root: string,
    private readonly onChange: (status: LocalSpeechModelStatus) => void,
    options: LocalSpeechModelStoreOptions = {}
  ) {
    this.fetchImpl = options.fetch ?? ((url, init) => fetch(url, init));
    this.files = options.files ?? LOCAL_SPEECH_MODEL.files;
    this.revision = options.revision ?? LOCAL_SPEECH_MODEL.revision;
    this.totalBytes = options.files
      ? options.files.reduce((sum, file) => sum + file.size, 0)
      : LOCAL_SPEECH_MODEL_BYTES;
    const supported = options.supported ?? localSpeechSupported();
    this.current = {
      state: supported ? "checking" : "unsupported",
      totalBytes: this.totalBytes,
      receivedBytes: 0,
    };
    if (!supported) this.checked = Promise.resolve();
  }

  /** The folder an installed model is read from. */
  get installDir(): string {
    return path.join(this.root, this.revision);
  }

  private get stagingDir(): string {
    return path.join(this.root, `${this.revision}${STAGING_SUFFIX}`);
  }

  /** The status as last known; before the first `check()`, `checking`. */
  status(): LocalSpeechModelStatus {
    return { ...this.current };
  }

  private set(status: Omit<LocalSpeechModelStatus, "totalBytes">, epoch = this.epoch): void {
    if (epoch !== this.epoch) return;
    this.current = { totalBytes: this.totalBytes, ...status };
    this.onChange(this.status());
  }

  /**
   * Checks the installed model once a launch, every file against its hash.
   * Later calls share that check; a download, removal or failed load starts
   * over from what they leave.
   */
  check(): Promise<LocalSpeechModelStatus> {
    // Nothing is hashed while files are being deleted; the removal reports.
    if (this.removing) return Promise.resolve(this.status());
    this.checked ??= this.checkInstall(this.epoch);
    return this.checked.then(() => this.status());
  }

  private async checkInstall(epoch: number): Promise<void> {
    if (await this.installRecorded()) {
      this.set({ state: "checking", receivedBytes: this.totalBytes }, epoch);
      const bad = await this.mismatched(this.installDir);
      if (bad.length === 0) {
        this.set({ state: "ready", receivedBytes: this.totalBytes }, epoch);
        return;
      }
      console.warn(`[LocalSpeech] Installed model fails its check: ${bad.join(", ")}`);
      this.set(
        {
          state: "failed",
          receivedBytes: 0,
          error: "The downloaded model is damaged. Download it again to repair it.",
        },
        epoch
      );
      return;
    }
    // Files a failed deletion left in the install folder count too, so they
    // can still be deleted.
    const left = (await this.stagedBytes()) + (await this.leftoverBytes(this.installDir));
    this.set({ state: "absent", receivedBytes: Math.min(left, this.totalBytes) }, epoch);
  }

  private async leftoverBytes(dir: string): Promise<number> {
    let total = 0;
    for (const spec of this.files) total += await sizeOf(path.join(dir, spec.name));
    return total;
  }

  private async installRecorded(): Promise<boolean> {
    try {
      const record = JSON.parse(
        await readFile(path.join(this.installDir, INSTALL_RECORD), "utf8")
      ) as { id?: unknown; revision?: unknown };
      return record.id === LOCAL_SPEECH_MODEL.id && record.revision === this.revision;
    } catch {
      return false;
    }
  }

  private async mismatched(dir: string, signal?: AbortSignal): Promise<string[]> {
    const bad: string[] = [];
    for (const spec of this.files) {
      const ok = await matches(path.join(dir, spec.name), spec, signal).catch(() => false);
      // Stopped part way, a file read isn't a verdict on it.
      if (signal?.aborted) throw new Cancelled();
      if (!ok) bad.push(spec.name);
    }
    return bad;
  }

  /** Bytes a stopped download already holds, finished files and parts alike. */
  private async stagedBytes(): Promise<number> {
    let total = 0;
    for (const spec of this.files) {
      const file = path.join(this.stagingDir, spec.name);
      total += Math.min(spec.size, Math.max(await sizeOf(file), await sizeOf(`${file}.part`)));
    }
    return total;
  }

  /** The installed model's folder when it is ready to read; null otherwise. */
  async readyDir(): Promise<string | null> {
    if (this.removing) return null;
    const status = await this.check();
    return status.state === "ready" && !this.removing ? this.installDir : null;
  }

  /** A load from an installed folder failed: the next `check()` hashes it again. */
  invalidate(): void {
    if (this.operation) return;
    this.checked = null;
  }

  /**
   * Fetches and installs the model; a call while one runs joins it. Settles
   * once the model is ready, the download fails, or it is cancelled; the
   * outcome is in the status, never thrown.
   */
  download(): Promise<void> {
    if (this.current.state === "unsupported" || this.removing) return Promise.resolve();
    if (this.operation) return this.operation.done;
    const abort = new AbortController();
    const epoch = this.epoch;
    const done = this.check()
      .then(async (status) => {
        if (status.state === "ready" || abort.signal.aborted) return;
        await this.fetchAndInstall(abort.signal, epoch);
      })
      .catch(async (error: unknown) => {
        const receivedBytes = await this.stagedBytes();
        if (error instanceof Cancelled || abort.signal.aborted) {
          this.set({ state: "absent", receivedBytes }, epoch);
          return;
        }
        console.warn("[LocalSpeech] Model download failed", voiceErrorLogFields(error));
        this.set({ state: "failed", receivedBytes, error: describeFailure(error) }, epoch);
      })
      .finally(() => {
        if (this.operation?.abort === abort) this.operation = null;
      });
    this.operation = { abort, done };
    return done;
  }

  /** Stops a download; what it fetched stays for the next one to resume. */
  async cancel(): Promise<void> {
    const operation = this.operation;
    if (!operation) return;
    operation.abort.abort();
    await operation.done;
  }

  /**
   * Deletes the installed model and any partial download. From the moment it
   * is called, no dictation gets the folder and no download starts;
   * `beforeDelete` stops whatever already has the files open. A removal that
   * fails part way checks the folder again, so the status says what is left.
   */
  async remove(beforeDelete?: () => Promise<void>): Promise<void> {
    if (this.current.state === "unsupported") return;
    if (this.removing) throw new Error("The model is already being deleted");
    const removal = {};
    this.removing = removal;
    this.epoch++;
    try {
      const operation = this.operation;
      if (operation) {
        operation.abort.abort();
        await operation.done;
      }
      await beforeDelete?.();
      await rm(this.installDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
      await rm(this.stagingDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
      this.checked = Promise.resolve();
      this.set({ state: "absent", receivedBytes: 0 });
    } catch (error) {
      if (this.removing === removal) this.removing = null;
      this.checked = null;
      await this.check().catch(() => {});
      throw error;
    } finally {
      if (this.removing === removal) this.removing = null;
    }
  }

  private async fetchAndInstall(signal: AbortSignal, epoch: number): Promise<void> {
    const staging = this.stagingDir;
    await mkdir(staging, { recursive: true });
    let received = await this.stagedBytes();
    this.set({ state: "downloading", receivedBytes: received }, epoch);
    for (const spec of this.files) {
      if (signal.aborted) throw new Cancelled();
      const into = path.join(staging, spec.name);
      if ((await sizeOf(into)) === spec.size) continue;
      const before = Math.min(spec.size, await sizeOf(`${into}.part`));
      received +=
        (await this.fetchFile(spec, `${into}.part`, signal, received - before, epoch)) - before;
      await rename(`${into}.part`, into);
    }
    this.set({ state: "checking", receivedBytes: this.totalBytes }, epoch);
    const bad = await this.mismatched(staging, signal);
    if (bad.length > 0) {
      // Fetched again from scratch next time: a file that doesn't match is wrong all through.
      await Promise.all(bad.map((name) => rm(path.join(staging, name), { force: true })));
      throw new Error("The downloaded files don't match the model. Try the download again.");
    }
    if (signal.aborted) throw new Cancelled();
    await writeFile(
      path.join(staging, INSTALL_RECORD),
      JSON.stringify({ id: LOCAL_SPEECH_MODEL.id, revision: this.revision }),
      "utf8"
    );
    await rm(this.installDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
    await rename(staging, this.installDir);
    if (epoch !== this.epoch) return;
    this.checked = Promise.resolve();
    this.set({ state: "ready", receivedBytes: this.totalBytes }, epoch);
  }

  /** Fetches one file into `part`, resuming what is there. Returns the file's size on disk. */
  private async fetchFile(
    spec: LocalSpeechFileSpec,
    part: string,
    signal: AbortSignal,
    receivedOthers: number,
    epoch: number
  ): Promise<number> {
    let have = await sizeOf(part);
    if (have > spec.size) {
      await rm(part, { force: true });
      have = 0;
    }
    if (have === spec.size) return have;
    const stall = new AbortController();
    const timed = AbortSignal.any([signal, stall.signal]);
    let stallTimer: ReturnType<typeof setTimeout> | null = null;
    const armStall = () => {
      if (stallTimer) clearTimeout(stallTimer);
      stallTimer = setTimeout(() => stall.abort(), STALL_TIMEOUT_MS);
    };
    armStall();
    try {
      const response = await this.fetchImpl(
        `${HF}/${LOCAL_SPEECH_MODEL.id}/resolve/${this.revision}/${spec.name}`,
        {
          headers: { "User-Agent": USER_AGENT, ...(have > 0 ? { Range: `bytes=${have}-` } : {}) },
          signal: timed,
        }
      );
      let append = false;
      if (response.status === 206 && have > 0 && rangeFrom(response) === have) append = true;
      else if (response.status === 206 || response.status === 416) {
        // Not the rest of what is here: start the file again next time.
        await response.body?.cancel();
        await rm(part, { force: true });
        throw new Error(`The download failed (HTTP ${response.status}). Try again.`);
      } else if (!response.ok) {
        await response.body?.cancel();
        throw new Error(`The download failed (HTTP ${response.status}). Try again.`);
      }
      if (!response.body) throw new Error("The download failed: no data came back.");
      let size = append ? have : 0;
      const count = new Transform({
        transform: (chunk: Buffer, _encoding, done) => {
          size += chunk.length;
          armStall();
          if (size > spec.size) {
            done(new Error(`${spec.name} is larger than the pinned model file`));
            return;
          }
          this.progress(receivedOthers + size, epoch);
          done(null, chunk);
        },
      });
      await pipeline(
        Readable.fromWeb(response.body as import("node:stream/web").ReadableStream),
        count,
        createWriteStream(part, { flags: append ? "a" : "w" }),
        { signal: timed }
      );
      if (size !== spec.size) throw new Error(`${spec.name} ended early. Try again to resume.`);
      return size;
    } catch (error) {
      if (signal.aborted) throw new Cancelled();
      if (stall.signal.aborted) {
        throw new Error("The download stalled. Try again to resume.", { cause: error });
      }
      throw error;
    } finally {
      if (stallTimer) clearTimeout(stallTimer);
    }
  }

  private progress(receivedBytes: number, epoch: number): void {
    if (epoch !== this.epoch) return;
    const now = Date.now();
    if (now - this.lastProgressAt < PROGRESS_INTERVAL_MS) {
      this.current = { ...this.current, receivedBytes };
      return;
    }
    this.lastProgressAt = now;
    this.set({ state: "downloading", receivedBytes }, epoch);
  }
}
