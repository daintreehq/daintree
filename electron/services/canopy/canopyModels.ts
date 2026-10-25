/**
 * The local models Canopy reads screens with: which are published, which are
 * on this machine, and getting one here. Models are the public
 * `daintreehq/canopy-reader-*` repos on Hugging Face; the list is read from
 * there, so a new one shows up without a Daintree release, and falls back to
 * the two known at build time when Hugging Face can't be reached.
 *
 * Nothing here ever sends a screen anywhere: the only requests are for the
 * catalogue and the model files themselves.
 */
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  CANOPY_MODEL_AUTHOR,
  CANOPY_MODEL_PREFIX,
  DEFAULT_CANOPY_MODEL,
  canopyModelName,
  isCanopyModelId,
  type CanopyModelBench,
  type CanopyModelState,
  type CanopyModelVariant,
} from "../../../shared/types/ipc/canopy.js";
import { formatErrorMessage } from "../../../shared/utils/errorMessage.js";
import { isReaderMeta } from "./canopyReader.js";

const HF = "https://huggingface.co";
const AUTHOR = CANOPY_MODEL_AUTHOR;
const PREFIX = CANOPY_MODEL_PREFIX;
const USER_AGENT = "Daintree-Canopy/1.0";
export { DEFAULT_CANOPY_MODEL, canopyModelName, isCanopyModelId };
/** What every model needs besides its weights: no reference code, nothing else. */
const COMMON_FILES = ["reader.json", "tokenizer.json", "tokenizer_config.json"];
/**
 * Light's INT8 weights read about half the screens wrongly on an Intel x86 CPU
 * (approvals and finished turns called "working") while its FP32 weights match
 * the reference, so x86 reads with FP32 where the FP32 file is small enough to
 * be worth it: Light's is 68 MB. Best is right in INT8 on x86, and its FP32 is
 * 274 MB. Measured on an Intel Core 5 210H; ARM was measured on Apple silicon.
 */
const FP32_MAX_BYTES = 100_000_000;

/** Which weights a model reads with here. */
export type CanopyWeights = "int8" | "fp32";
const CATALOGUE_TIMEOUT_MS = 10_000;
/** How long a fetched catalogue is used before Hugging Face is asked again. */
const CATALOGUE_TTL_MS = 10 * 60_000;
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
  id: string;
  revision: string;
  /** Everything but the weights, always fetched. */
  files: FileSpec[];
  /** The weights, by precision; `fp32` is absent when the repo has none. */
  weights: { int8: FileSpec; fp32?: FileSpec };
  bench: CanopyModelBench | null;
  supported: boolean;
}

/** The two published at build time, measured on real screens (bench.json `int8.real`). */
const BUNDLED: Variant[] = [
  {
    id: `${AUTHOR}/${PREFIX}17m`,
    revision: "23f15f0dc4f78413e748de3fbe429dca8b1ee4fd",
    files: [
      { name: "reader.json", size: 1660, blobId: "dc3c0c5e4d88d8d33e574f0c1a9efc56822e9654" },
      { name: "tokenizer.json", size: 3583228, blobId: "2f4d8583e507b7466d2490e2d6c045647a822698" },
      {
        name: "tokenizer_config.json",
        size: 368,
        blobId: "e3ce044f1db95b6884796f4fdf7d3f78fb6b9df4",
      },
    ],
    weights: {
      int8: {
        name: "model.int8.onnx",
        size: 17298433,
        sha256: "4dd453e0c1bd9b9ae276dc4b270111154f97f26f39abb2b447d62614147ae2c6",
      },
      fp32: {
        name: "model.fp32.onnx",
        size: 67726050,
        sha256: "79440750a6e8754ac9c634325d98ee540253cc2b280dfcddfd6cf98fc02b94d2",
      },
    },
    bench: {
      goldCategory: 58,
      gold: 60,
      agentCategory: 89,
      agents: 93,
      headline: 0.758,
      options: 0.739,
      cardF1: 0.651,
      msPerScreen: 25,
    },
    supported: true,
  },
  {
    id: `${AUTHOR}/${PREFIX}68m`,
    revision: "6fc6edbc0b30cca404bdbb5b1fa559f104636f50",
    files: [
      { name: "reader.json", size: 1660, blobId: "ef044049dc950c207b902598121004191d51d914" },
      { name: "tokenizer.json", size: 3583228, blobId: "2f4d8583e507b7466d2490e2d6c045647a822698" },
      {
        name: "tokenizer_config.json",
        size: 368,
        blobId: "e3ce044f1db95b6884796f4fdf7d3f78fb6b9df4",
      },
    ],
    weights: {
      int8: {
        name: "model.int8.onnx",
        size: 69749457,
        sha256: "f597ea748cc5f3e3e3522493637837d50ebcb9bc3a5977ef1af82b94aefe3702",
      },
      fp32: {
        name: "model.fp32.onnx",
        size: 274305518,
        sha256: "5fa325de68298578c5ca7f9d7af45ec603010b21fe98a4d1ef4e9d91414934e9",
      },
    },
    bench: {
      goldCategory: 57,
      gold: 60,
      agentCategory: 89,
      agents: 93,
      headline: 0.817,
      options: 0.87,
      cardF1: 0.714,
      msPerScreen: 130,
    },
    supported: true,
  },
];

/** The names the two first models go by; any other is named for its size. */
/** Git's blob id: SHA-1 over `blob <size>\0` and the content. */
function gitBlobId(content: Buffer): string {
  return createHash("sha1").update(`blob ${content.length}\0`).update(content).digest("hex");
}

async function sha256File(file: string): Promise<string> {
  const hash = createHash("sha256");
  await pipeline(createReadStream(file), hash);
  return hash.digest("hex");
}

function benchOf(raw: unknown): CanopyModelBench | null {
  const real = (raw as { int8?: { real?: Record<string, Record<string, number>> } } | null)?.int8
    ?.real;
  const ms = (raw as { int8?: { ms_median?: number } } | null)?.int8?.ms_median;
  const gold = real?.gold;
  const agents = real?.agents;
  const lines = real?.lines_vs_gold;
  const nums = [
    gold?.category_coarse,
    gold?.n,
    agents?.category_coarse,
    agents?.n,
    lines?.headline_acc,
    lines?.options_exact,
    lines?.card_f1,
    ms,
  ];
  if (!nums.every((n) => typeof n === "number" && Number.isFinite(n))) return null;
  return {
    goldCategory: gold!.category_coarse,
    gold: gold!.n,
    agentCategory: agents!.category_coarse,
    agents: agents!.n,
    headline: lines!.headline_acc,
    options: lines!.options_exact,
    cardF1: lines!.card_f1,
    msPerScreen: Math.round(ms!),
  };
}

async function fetchJson(url: string, signal: AbortSignal): Promise<unknown> {
  const response = await fetch(url, { headers: { "User-Agent": USER_AGENT }, signal });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

async function fetchVariant(id: string, signal: AbortSignal): Promise<Variant | null> {
  const detail = (await fetchJson(`${HF}/api/models/${id}?blobs=true`, signal)) as {
    sha?: string;
    private?: boolean;
    siblings?: { rfilename?: string; size?: number; blobId?: string; lfs?: { sha256?: string } }[];
  };
  if (detail.private || typeof detail.sha !== "string" || !Array.isArray(detail.siblings)) {
    return null;
  }
  const spec = (name: string, lfsOnly: boolean): FileSpec | null => {
    const sibling = detail.siblings!.find((s) => s.rfilename === name);
    if (!sibling || typeof sibling.size !== "number") return null;
    const sha256 = sibling.lfs?.sha256;
    if (lfsOnly && typeof sha256 !== "string") return null;
    if (sha256) return { name, size: sibling.size, sha256 };
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
  const int8 = spec("model.int8.onnx", true);
  if (!int8) return null;
  const fp32 = spec("model.fp32.onnx", true);
  const at = `${HF}/${id}/resolve/${detail.sha}`;
  const [meta, bench] = await Promise.all([
    fetchJson(`${at}/reader.json`, signal).catch(() => null),
    fetchJson(`${at}/bench.json`, signal).catch(() => null),
  ]);
  return {
    id,
    revision: detail.sha,
    files,
    weights: fp32 ? { int8, fp32 } : { int8 },
    bench: benchOf(bench),
    supported: isReaderMeta(meta),
  };
}

/** Every published reader, smallest first. */
async function fetchCatalogue(): Promise<Variant[]> {
  const signal = AbortSignal.timeout(CATALOGUE_TIMEOUT_MS);
  const list = (await fetchJson(
    `${HF}/api/models?author=${AUTHOR}&search=${PREFIX}&limit=100`,
    signal
  )) as { id?: string; modelId?: string }[];
  const ids = list
    .map((m) => m.id ?? m.modelId)
    .filter(isCanopyModelId)
    // Training checkpoints and the like share the prefix: only ones named for a size.
    .filter((id) => /^\d+[mb]$/.test(id.slice(id.lastIndexOf("/") + 1 + PREFIX.length)));
  const variants = await Promise.all(ids.map((id) => fetchVariant(id, signal).catch(() => null)));
  return variants.filter((v): v is Variant => v !== null);
}

/** Windows holds a file open until its reader process has exited: retried for a few seconds. */
function removeDir(dir: string): Promise<void> {
  return rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
}

function totalBytes(v: Variant, weights: CanopyWeights): number {
  return v.files.reduce((sum, f) => sum + f.size, 0) + (v.weights[weights] ?? v.weights.int8).size;
}

function paramsOf(id: string): number {
  const m = /(\d+)([mb])$/.exec(id);
  return m ? Number(m[1]) * (m[2] === "b" ? 1000 : 1) : Number.MAX_SAFE_INTEGER;
}

interface Installed {
  id: string;
  revision: string;
  weights: CanopyWeights;
}

interface Download {
  id: string;
  received: number;
  total: number;
  abort: AbortController;
}

/** One `ensure`, registered before its first await so it can be cancelled from the start. */
interface Operation {
  id: string;
  abort: AbortController;
  done: Promise<void>;
}

export class CanopyModels {
  private catalogue: Variant[] = BUNDLED;
  private fetchedAt = 0;
  private fetching: Promise<void> | null = null;
  private download: Download | null = null;
  private operation: Operation | null = null;
  private failure: { id: string; message: string } | null = null;
  private lastProgressAt = 0;
  private installed = new Map<string, Installed>();
  private scanned: Promise<void> | null = null;

  constructor(
    private readonly root: string,
    private readonly onChange: () => void,
    /** What this machine's CPU is, and the largest FP32 file worth fetching for it; tests set both. */
    private readonly platform: { arch?: string; fp32MaxBytes?: number } = {}
  ) {}

  /** The precision a model reads with here: FP32 on x86 where it is small, INT8 elsewhere. */
  weightsFor(variant: Variant | undefined): CanopyWeights {
    const arch = this.platform.arch ?? process.arch;
    const fp32 = variant?.weights.fp32;
    const x86 = arch === "x64" || arch === "ia32";
    return x86 && fp32 !== undefined && fp32.size <= (this.platform.fp32MaxBytes ?? FP32_MAX_BYTES)
      ? "fp32"
      : "int8";
  }

  private dirOf(id: string): string {
    return path.join(this.root, id.slice(id.indexOf("/") + 1));
  }

  /** The folder a ready model is in, or null when it isn't on this machine. */
  async installedDir(id: string): Promise<string | null> {
    await this.scan();
    return this.installed.has(id) ? this.dirOf(id) : null;
  }

  /** Every model installed here, published at build time or since. */
  private scan(): Promise<void> {
    this.scanned ??= (async () => {
      const names = await readdir(this.root).catch(() => [] as string[]);
      for (const name of names) {
        const id = `${AUTHOR}/${name}`;
        if (isCanopyModelId(id)) await this.readInstall(id);
      }
    })();
    return this.scanned;
  }

  private async readInstall(id: string): Promise<void> {
    try {
      const raw = JSON.parse(await readFile(path.join(this.dirOf(id), "install.json"), "utf8")) as {
        id?: unknown;
        revision?: unknown;
        weights?: unknown;
      };
      if (raw.id !== id || typeof raw.revision !== "string") return;
      // Valid as installed, in the precision it was made with: that was chosen
      // once, at download, and a catalogue that offers something else since
      // doesn't undo a model that reads right.
      this.installed.set(id, {
        id,
        revision: raw.revision,
        weights: raw.weights === "fp32" ? "fp32" : "int8",
      });
    } catch {
      // Not installed, or a half-written install that is not one.
    }
  }

  /** The published models, with what this machine has; asks Hugging Face when the list is stale. */
  async list(refresh = false): Promise<CanopyModelVariant[]> {
    await this.scan();
    if (refresh || Date.now() - this.fetchedAt > CATALOGUE_TTL_MS) {
      this.fetching ??= fetchCatalogue()
        .then(async (variants) => {
          if (variants.length > 0) {
            this.catalogue = variants;
            for (const v of variants) if (!this.installed.has(v.id)) await this.readInstall(v.id);
          }
          this.fetchedAt = Date.now();
        })
        .catch(() => {
          // Offline: the last list, or the bundled one, stands.
        })
        .finally(() => {
          this.fetching = null;
        });
      await this.fetching;
    }
    return [...this.catalogue]
      .sort((a, b) => paramsOf(a.id) - paramsOf(b.id))
      .map((v) => ({
        id: v.id,
        name: canopyModelName(v.id),
        downloadBytes: totalBytes(v, this.weightsFor(v)),
        installed: this.installed.has(v.id),
        supported: v.supported,
        bench: v.bench,
      }));
  }

  state(selected: string): CanopyModelState {
    const download = this.download;
    if (download?.id === selected) {
      return {
        id: selected,
        status: "downloading",
        received: download.received,
        total: download.total,
      };
    }
    if (this.installed.has(selected)) return { id: selected, status: "ready" };
    if (this.failure?.id === selected) {
      return { id: selected, status: "failed", error: this.failure.message };
    }
    return { id: selected, status: "missing" };
  }

  /**
   * Gets the model here, unless it is or is on its way. Resolves once it is
   * ready, failed or cancelled. Another model's download under way is stopped
   * first, and finished stopping before this one starts.
   */
  ensure(id: string): Promise<void> {
    const current = this.operation;
    if (current?.id === id && !current.abort.signal.aborted) return current.done;
    current?.abort.abort();
    const abort = new AbortController();
    const operation: Operation = {
      id,
      abort,
      done: this.run(id, abort.signal, current?.done ?? null),
    };
    this.operation = operation;
    void operation.done.finally(() => {
      if (this.operation === operation) this.operation = null;
    });
    return operation.done;
  }

  private async run(id: string, signal: AbortSignal, before: Promise<void> | null): Promise<void> {
    await before?.catch(() => {});
    await this.scan();
    if (signal.aborted || this.installed.has(id)) return;
    let variant = this.catalogue.find((v) => v.id === id);
    if (!variant) {
      await this.list(true);
      variant = this.catalogue.find((v) => v.id === id);
    }
    if (signal.aborted || this.installed.has(id)) return;
    if (!variant) {
      this.failure = { id, message: "This model isn't published any more." };
      this.onChange();
      return;
    }
    if (!variant.supported) {
      this.failure = { id, message: "This model needs a newer version of Daintree." };
      this.onChange();
      return;
    }
    const download: Download = {
      id,
      received: 0,
      total: totalBytes(variant, this.weightsFor(variant)),
      abort: new AbortController(),
    };
    signal.addEventListener("abort", () => download.abort.abort(), { once: true });
    this.download = download;
    this.failure = null;
    this.onChange();
    // Chosen once, for this download: what is fetched, recorded and marked
    // installed all agree, whatever the catalogue becomes meanwhile.
    const weights = this.weightsFor(variant);
    try {
      await this.fetchInto(variant, download, weights);
      this.installed.set(id, { id, revision: variant.revision, weights });
    } catch (error) {
      if (!download.abort.signal.aborted) {
        this.failure = { id, message: formatErrorMessage(error, "The download failed.") };
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
   * Deletes every model on this machine but `keep`, half-finished downloads
   * included, once any download of another model has stopped.
   */
  async removeAllBut(keep: string | null): Promise<void> {
    const running = this.operation;
    if (running && running.id !== keep) {
      running.abort.abort();
      await running.done.catch(() => {});
    }
    await this.scan();
    for (const id of [...this.installed.keys()]) {
      if (id === keep) continue;
      this.installed.delete(id);
      await removeDir(this.dirOf(id));
    }
    const names = await readdir(this.root).catch(() => [] as string[]);
    const kept = keep === null ? null : path.basename(this.dirOf(keep));
    for (const name of names) {
      if (!name.endsWith(".download") || name === `${kept}.download`) continue;
      if (!isCanopyModelId(`${AUTHOR}/${name.slice(0, -".download".length)}`)) continue;
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
  private async fetchInto(
    variant: Variant,
    download: Download,
    weights: CanopyWeights
  ): Promise<void> {
    const dir = this.dirOf(variant.id);
    const staging = `${dir}.download`;
    await mkdir(staging, { recursive: true });
    const signal = download.abort.signal;
    for (const file of [...variant.files, variant.weights[weights] ?? variant.weights.int8]) {
      const target = path.join(staging, file.name);
      const part = `${target}.${variant.revision.slice(0, 12)}.part`;
      if (await this.verified(target, file)) {
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
      const url = `${HF}/${variant.id}/resolve/${variant.revision}/${file.name}`;
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
      JSON.stringify({ id: variant.id, revision: variant.revision, weights }),
      "utf8"
    );
    await rm(dir, { recursive: true, force: true });
    await rename(staging, dir);
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
