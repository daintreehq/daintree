/**
 * The local model Canopy reads screens with, `daintreehq/canopy-reader-17m`.
 * It ships inside the app (#16415), at the revision and hashes pinned in
 * `canopy-reader-manifest.json`: the build fetches those files and packaging
 * checks them, and each launch checks them once more before the reader may
 * load them. Nothing here touches the network.
 */
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readdir, rm, rmdir, stat } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import {
  CANOPY_MODEL,
  CANOPY_MODEL_AUTHOR,
  canopyModelName,
  isCanopyModelId,
  type CanopyModelInfo,
  type CanopyModelState,
} from "../../../shared/types/ipc/canopy.js";
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

const FILES: readonly CanopyModelFileSpec[] = manifest.files;
/** The weights file the reader loads: weight-only INT8, which reads the same on every CPU. */
export const CANOPY_READER_WEIGHTS: string = manifest.weights;

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

export class CanopyModels {
  private checking: Promise<void> | null = null;
  private status: CanopyModelState | undefined;
  private disposed = false;

  constructor(
    /** The folder the app ships the model in. */
    private readonly dir: string,
    /** Told once the check is done, either way. */
    private readonly onChange: () => void,
    /** The files the model is made of, and their pins. */
    private readonly files: readonly CanopyModelFileSpec[] = FILES
  ) {}

  /**
   * Checks the shipped files against their pins, once a launch: every later
   * call joins or reads that one check, so nothing hashes the model twice.
   */
  ensure(): Promise<void> {
    this.checking ??= this.check();
    return this.checking;
  }

  private async check(): Promise<void> {
    const bad: string[] = [];
    for (const spec of this.files) {
      const ok = await matches(path.join(this.dir, spec.name), spec).catch(() => false);
      if (!ok) bad.push(spec.name);
    }
    if (bad.length > 0) {
      console.error(`[Canopy] Model at ${this.dir} fails its check: ${bad.join(", ")}`);
      this.status = { id: CANOPY_MODEL, status: "failed", error: DAMAGED };
    } else {
      this.status = { id: CANOPY_MODEL, status: "ready" };
    }
    if (!this.disposed) this.onChange();
  }

  /** The folder to read the model from once it checks out; null while checking, or when it didn't. */
  async installedDir(): Promise<string | null> {
    await this.ensure();
    return this.status?.status === "ready" ? this.dir : null;
  }

  /** The model as Settings shows it. */
  async info(): Promise<CanopyModelInfo> {
    await this.ensure();
    return {
      id: CANOPY_MODEL,
      name: canopyModelName(CANOPY_MODEL),
      bytes: this.files.reduce((sum, file) => sum + file.size, 0),
      installed: this.status?.status === "ready",
    };
  }

  /** Where the model stands: nothing to say until the check is done. */
  state(): CanopyModelState | undefined {
    return this.status;
  }

  /** A check finishing after this tells no one. */
  dispose(): void {
    this.disposed = true;
  }
}

/**
 * Deletes what earlier versions of Daintree downloaded into `root`
 * (`<userData>/canopy/models`): every reader model folder, with its
 * half-finished `.download` and set-aside `.old` copies, then `root` itself
 * once nothing else is in it.
 */
export async function removeDownloadedModels(root: string): Promise<void> {
  const names = await readdir(root).catch(() => null);
  if (names === null) return;
  for (const name of names) {
    const base = name.replace(/\.(download|old)$/, "");
    if (!isCanopyModelId(`${CANOPY_MODEL_AUTHOR}/${base}`)) continue;
    // Windows holds a file open until the process reading it has exited.
    await rm(path.join(root, name), {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 300,
    });
  }
  await rmdir(root).catch(() => {});
}
