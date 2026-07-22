import { createHash } from "crypto";
import fs from "fs/promises";
import { createWriteStream } from "fs";
import path from "path";
import { pipeline } from "node:stream/promises";
import yauzl from "yauzl";
import { getPluginManifestSchema } from "../schemas/plugin.js";
import { MAX_DNTR_BYTES } from "../utils/pluginArchiveConstants.js";
import type { PluginManifest } from "../../shared/types/plugin.js";

export const ZIP_EPOCH_DATE = new Date("1980-01-01T00:00:00Z");
// Cap on total zip entries. A plugin is a handful of compiled files plus
// assets; thousands of entries means an archive padded with tiny/empty members
// to force unbounded filesystem ops during extraction (zip-bomb-by-count).
export const MAX_DNTR_ENTRIES = 4096;

// Per-entry inactivity budget during extraction. Extraction is a local disk
// copy, so a window this wide can only be hit by a genuinely dead stream —
// never by a slow-but-live one. Without it a stalled read stream leaves
// `installPlugin` awaiting forever, holding `install.lock` and its
// `.install-tmp-*` dir until the app is quit (#11227). Per-entry and reset on
// every chunk, so a large archive isn't penalised for making steady progress.
export const PLUGIN_ARCHIVE_ENTRY_INACTIVITY_MS = 30_000;

/**
 * Absolute ceiling on a single extraction, independent of the per-entry
 * inactivity watchdog (#11302). A stream that trickles a byte every few seconds
 * resets {@link PLUGIN_ARCHIVE_ENTRY_INACTIVITY_MS} forever and never trips it,
 * so a hostile or pathological source could still hold `install.lock` and its
 * staging dir indefinitely. Four times the inactivity window and generous for
 * the 30 MB `MAX_DNTR_BYTES` cap — a legitimate local archive extracts in
 * well under a second.
 */
export const PLUGIN_ARCHIVE_TOTAL_DEADLINE_MS = 120_000;

/**
 * Thrown (as the abort `reason`) when {@link PLUGIN_ARCHIVE_TOTAL_DEADLINE_MS}
 * elapses. A distinct type rather than a message the installer greps for, so
 * the "too slow" outcome maps to its own install error code without coupling to
 * user-facing copy.
 */
export class PluginArchiveDeadlineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PluginArchiveDeadlineError";
  }
}

export interface ExtractOptions {
  /** Override the per-entry inactivity abort. Tests only — production uses the default. */
  inactivityTimeoutMs?: number;
  /** Override the absolute extraction deadline. Tests only — production uses the default. */
  totalDeadlineMs?: number;
  /**
   * Caller-owned cancellation (#11302). Aborting it fails the extraction with
   * the signal's own `reason`, so "the user cancelled" stays distinguishable
   * from a stall or the absolute deadline in the message the installer reports.
   */
  signal?: AbortSignal;
  /**
   * Called with each validated file entry's normalized path, just before it
   * streams to disk. Progress reporting only — the extraction ignores what it
   * returns and a throw from it is not caught, so keep it trivial.
   */
  onEntry?: (entryName: string) => void;
}

const REQUIRED_EXCLUSIONS: readonly string[] = ["node_modules/", ".git/"];

const SOURCE_EXTS = new Set([".ts", ".tsx"]);
const SOURCEMAP_EXTS = new Set([".js.map", ".mjs.map"]);

// Dev-only metadata that must never ship in a `.dntr`: package manifests,
// lockfiles, TS config, and build configs. `package.json` is the worst
// offender — it carries the author's full dependency layout and, in a
// monorepo/`file:` setup, leaks the author's absolute home path into every
// distributed copy (#10514); `package-lock.json` is also usually the bulk of
// the archive. A `.dntr` should contain only the manifest, built outputs, and
// declared assets, so these are excluded from packing AND rejected by
// {@link verifyPluginArchive}.
const ROOT_DEV_FILE_NAMES: ReadonlySet<string> = new Set([
  "package.json",
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "bun.lock",
  "bun.lockb",
]);

// `*.config.*` at the archive root: vite.config.ts, tsup.config.mjs,
// vitest.config.ts, etc.
const ROOT_CONFIG_FILE = /^[^/]+\.config\.[^/]+$/;

// Scope to the archive ROOT only (no `/` in the path) so a plugin that
// legitimately ships e.g. `dist/app.config.json` as a runtime asset keeps it —
// the leak and bloat we're guarding against live at the package root.
function isExcludedRootDevFile(name: string): boolean {
  if (name.includes("/")) return false;
  if (ROOT_DEV_FILE_NAMES.has(name)) return true;
  // tsconfig.json, tsconfig.build.json, tsconfig.node.json, …
  if (name.startsWith("tsconfig") && name.endsWith(".json")) return true;
  return ROOT_CONFIG_FILE.test(name);
}

export interface PackOptions {
  sourcemaps?: boolean;
}

export type VerifyResult =
  | {
      valid: false;
      error: string;
    }
  | {
      valid: true;
      manifest: PluginManifest;
      entryCount: number;
    };

function normalizePath(filePath: string): string {
  let normalised = filePath.replace(/\\/g, "/");
  if (normalised.startsWith("/")) {
    normalised = normalised.slice(1);
  }
  // Strip a leading `./` so a crafted entry like `./package.json` normalizes to
  // its bare root name — otherwise the leading dot keeps it out of the
  // root-level dev-file exclusion (the privacy/bloat guard). It also aligns with
  // the `stripLeading` the manifest.main/view checks already apply.
  if (normalised.startsWith("./")) {
    normalised = normalised.slice(2);
  }
  return normalised;
}

function isValidEntryName(name: string): string | null {
  const yauzlError = yauzl.validateFileName(name);
  if (yauzlError !== null) return yauzlError;
  if (name.length === 0) return "empty path";
  return null;
}

/**
 * Guard against a zip whose compressed form fits the cap but whose plugin.json
 * declares a multi-hundred-MB uncompressed size — without this the chunk buffer
 * that reads the manifest would exhaust the main-process heap. Shared by
 * {@link readArchiveManifest} and {@link verifyPluginArchive}.
 */
function manifestSizeError(entry: yauzl.Entry): string | null {
  if (entry.uncompressedSize > MAX_DNTR_BYTES) {
    return `plugin.json exceeds ${MAX_DNTR_BYTES} byte limit`;
  }
  return null;
}

function matchesExclusionPattern(name: string, sourcemaps: boolean): boolean {
  for (const pattern of REQUIRED_EXCLUSIONS) {
    if (name === pattern || name.startsWith(pattern)) return true;
  }
  const ext = path.extname(name);
  if (SOURCE_EXTS.has(ext)) return true;
  if (isExcludedRootDevFile(name)) return true;
  if (!sourcemaps) {
    for (const smExt of SOURCEMAP_EXTS) {
      if (name.endsWith(smExt)) return true;
    }
  }
  return false;
}

/**
 * Apply the normative `.dntr` exclusion list to a POSIX-relative path.
 * Shared with the `daintree-plugin` CLI packager (F32) so the CLI's
 * `.gitignore`-aware file collection still drops `node_modules/`, `.git/`,
 * source files, and (unless `sourcemaps`) source maps using the exact same
 * predicate the host packs with — keeping the wire format in one place.
 */
export function isExcludedArchiveEntry(name: string, sourcemaps = false): boolean {
  return matchesExclusionPattern(name, sourcemaps);
}

async function collectFiles(dir: string, baseDir: string, sourcemaps: boolean): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    const relativePath = normalizePath(path.relative(baseDir, fullPath));
    if (entry.isDirectory()) {
      if (matchesExclusionPattern(relativePath + "/", sourcemaps)) continue;
      const subFiles = await collectFiles(fullPath, baseDir, sourcemaps);
      files.push(...subFiles);
    } else if (entry.isFile()) {
      if (matchesExclusionPattern(relativePath, sourcemaps)) continue;
      files.push(relativePath);
    }
  }
  return files;
}

function sortEntries(files: string[]): string[] {
  return files.sort((a, b) => {
    if (a === "plugin.json" && b !== "plugin.json") return -1;
    if (b === "plugin.json" && a !== "plugin.json") return 1;
    if (a < b) return -1;
    if (a > b) return 1;
    return 0;
  });
}

/**
 * Pack a plugin directory into a deterministic `.dntr` archive.
 * Returns the SHA-256 hex digest of the written archive bytes.
 */
export async function packPluginArchive(
  sourceDir: string,
  outputPath: string,
  opts: PackOptions = {}
): Promise<string> {
  const sourcemaps = opts.sourcemaps ?? false;
  const files = await collectFiles(sourceDir, sourceDir, sourcemaps);
  return packPluginArchiveFromFiles(sourceDir, outputPath, files);
}

/**
 * Pack an explicit, pre-filtered list of POSIX-relative paths under
 * `sourceDir` into a deterministic `.dntr` archive. The `daintree-plugin` CLI
 * uses this after it has done its own `.gitignore`-aware collection (F32) so
 * the host's normative ordering, `plugin.json`-first rule, MS-DOS-epoch
 * timestamps, and pre-stat insertion guard all stay in this one place. The
 * caller owns exclusion filtering; this function still sorts and enforces the
 * `plugin.json`-present invariant. Returns the SHA-256 hex digest of the
 * written archive bytes.
 */
export async function packPluginArchiveFromFiles(
  sourceDir: string,
  outputPath: string,
  files: readonly string[]
): Promise<string> {
  const { ZipArchive } = await import("archiver");
  const sorted = sortEntries([...files]);

  if (!sorted.includes("plugin.json")) {
    throw new Error("plugin.json not found in source directory");
  }

  // Pre-stat all files so archiver's _statQueue doesn't reorder entries.
  // Without stats, archiver stats files asynchronously and entries can be
  // written in completion order rather than insertion order.
  interface FileEntry {
    name: string;
    fullPath: string;
    stats: import("fs").Stats;
  }
  const entries: FileEntry[] = [];
  for (const fileName of sorted) {
    const fullPath = path.join(sourceDir, fileName);
    entries.push({ name: fileName, fullPath, stats: await fs.stat(fullPath) });
  }

  const archive = new ZipArchive({
    zlib: { level: 9 },
    forceLocalTime: false,
    forceZip64: false,
  });

  const hash = createHash("sha256");

  const writeStream = createWriteStream(outputPath, { mode: 0o644 });

  await new Promise<void>((resolve, reject) => {
    writeStream.on("close", resolve);
    writeStream.on("error", reject);
    archive.on("error", reject);

    archive.pipe(writeStream);

    archive.on("data", (chunk: Buffer) => {
      hash.update(chunk);
    });

    for (const entry of entries) {
      archive.file(entry.fullPath, {
        name: entry.name,
        date: ZIP_EPOCH_DATE,
        stats: entry.stats,
      });
    }

    void archive.finalize();
  });

  return hash.digest("hex");
}

/**
 * Compute the SHA-256 hash of a `.dntr` archive.
 * Rejects archives larger than {@link MAX_DNTR_BYTES} to guard against
 * unbounded memory allocation.
 */
export async function computeArchiveHash(archivePath: string): Promise<string> {
  const stat = await fs.stat(archivePath);
  if (stat.size > MAX_DNTR_BYTES) {
    throw new Error(`Archive size ${stat.size} exceeds ${MAX_DNTR_BYTES} byte limit`);
  }
  const buf = await fs.readFile(archivePath);
  return createHash("sha256").update(buf).digest("hex");
}

/**
 * Open a `.dntr` archive with yauzl and walk entries.
 * Returns a promise that resolves with the zipfile — callers attach
 * 'entry' listeners before calling `readEntry()`.
 */
function openZip(archivePath: string): Promise<yauzl.ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.open(
      archivePath,
      {
        lazyEntries: true,
        // Pin the security-relevant defaults rather than inheriting them, so a
        // future yauzl bump can't silently weaken a guard. `validateEntrySizes`
        // enforces each entry's decompressed length against its header — the
        // cumulative-size zip-bomb guard below trusts it. `strictFileNames`
        // rejects backslash/invalid-char names at parse time (yauzl otherwise
        // rewrites `\` to `/` before we ever see the name), enforcing the
        // `.dntr` POSIX-forward-slash contract at the source. `decodeStrings`
        // keeps `entry.fileName` a decoded string, not a raw Buffer.
        strictFileNames: true,
        decodeStrings: true,
        validateEntrySizes: true,
      },
      (err, zipfile) => {
        if (err) return reject(err);
        resolve(zipfile);
      }
    );
  });
}

/**
 * Read and validate `plugin.json` from a `.dntr` archive without extracting
 * the rest. The entry must be the first in the zip's local file order.
 */
export async function readArchiveManifest(archivePath: string): Promise<PluginManifest> {
  const stat = await fs.stat(archivePath);
  if (stat.size > MAX_DNTR_BYTES) {
    throw new Error(`Archive size ${stat.size} exceeds ${MAX_DNTR_BYTES} byte limit`);
  }
  const zipfile = await openZip(archivePath);

  return new Promise((resolve, reject) => {
    let settled = false;

    zipfile.on("entry", (entry: yauzl.Entry) => {
      const name = normalizePath(entry.fileName);
      if (name !== "plugin.json") {
        settled = true;
        zipfile.close();
        return reject(new Error(`First entry must be plugin.json, got "${entry.fileName}"`));
      }

      const sizeErr = manifestSizeError(entry);
      if (sizeErr) {
        settled = true;
        zipfile.close();
        return reject(new Error(sizeErr));
      }

      zipfile.openReadStream(entry, (err, stream) => {
        if (err) {
          settled = true;
          zipfile.close();
          return reject(err);
        }
        const chunks: Buffer[] = [];
        stream.on("data", (chunk: Buffer) => chunks.push(chunk));
        stream.on("end", () => {
          settled = true;
          zipfile.close();
          let json: unknown;
          try {
            json = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
          } catch {
            return reject(new Error("plugin.json is not valid JSON"));
          }
          const result = getPluginManifestSchema(false).safeParse(json);
          if (!result.success) {
            return reject(
              new Error(`plugin.json failed schema validation: ${result.error.message}`)
            );
          }
          resolve(result.data);
        });
        stream.on("error", (streamErr) => {
          settled = true;
          zipfile.close();
          reject(streamErr);
        });
      });
    });

    zipfile.on("end", () => {
      if (!settled) {
        reject(new Error("Archive is empty or plugin.json not found"));
      }
    });

    zipfile.on("error", (err) => {
      if (!settled) {
        settled = true;
        reject(err);
      }
    });

    zipfile.readEntry();
  });
}

/**
 * Extract every entry of a `.dntr` archive into `destDir`. The caller owns
 * `destDir` (created beforehand) and is responsible for cleanup on failure.
 *
 * Each entry is guarded against path traversal: the resolved on-disk path must
 * stay within `destDir`. Backslashes, leading slashes, and drive letters are
 * rejected via {@link isValidEntryName} before resolution. Directory entries
 * (trailing `/`) only create the directory; file entries stream to disk and
 * the next entry is read only after the write stream closes (`lazyEntries`).
 *
 * A file entry that goes quiet for {@link PLUGIN_ARCHIVE_ENTRY_INACTIVITY_MS}
 * aborts the whole extraction with a rejection rather than hanging, so the
 * caller's cleanup always runs. {@link PLUGIN_ARCHIVE_TOTAL_DEADLINE_MS} bounds
 * the extraction as a whole, catching the trickling stream that resets the
 * per-entry timer forever, and `opts.signal` lets the caller cancel outright
 * (#11302). All three abort sources reject with their own `Error` reason.
 */
export async function extractPluginArchive(
  archivePath: string,
  destDir: string,
  opts?: ExtractOptions
): Promise<void> {
  const inactivityMs = opts?.inactivityTimeoutMs ?? PLUGIN_ARCHIVE_ENTRY_INACTIVITY_MS;
  const totalMs = opts?.totalDeadlineMs ?? PLUGIN_ARCHIVE_TOTAL_DEADLINE_MS;
  const stat = await fs.stat(archivePath);
  if (stat.size > MAX_DNTR_BYTES) {
    throw new Error(`Archive size ${stat.size} exceeds ${MAX_DNTR_BYTES} byte limit`);
  }

  const root = path.resolve(destDir);
  const zipfile = await openZip(archivePath);
  if (zipfile.entryCount > MAX_DNTR_ENTRIES) {
    zipfile.close();
    throw new Error(`Archive exceeds ${MAX_DNTR_ENTRIES} entry limit`);
  }

  // Absolute deadline + caller cancellation, composed once for the whole
  // extraction. A dedicated controller (rather than `AbortSignal.timeout`) so
  // the deadline rejects with a plain `Error` carrying a readable message —
  // `AbortSignal.timeout` raises a DOMException that isn't an `Error` in Node
  // and would fall through the `reason instanceof Error` unwrap below. Cleared
  // in the `finally` so a fast extraction doesn't leave a 2-minute timer
  // holding the event loop.
  const deadlineController = new AbortController();
  const deadlineTimer = setTimeout(
    () =>
      deadlineController.abort(
        new PluginArchiveDeadlineError(
          `Extraction exceeded the ${totalMs}ms limit before finishing`
        )
      ),
    totalMs
  );
  const outerSignal = opts?.signal
    ? AbortSignal.any([deadlineController.signal, opts.signal])
    : deadlineController.signal;

  try {
    return await runExtraction(zipfile, root, {
      inactivityMs,
      outerSignal,
      onEntry: opts?.onEntry,
    });
  } finally {
    clearTimeout(deadlineTimer);
  }
}

/**
 * The entry pump for {@link extractPluginArchive}. Split out only so the
 * deadline timer above has a `finally` to clear itself in without wrapping the
 * whole promise body.
 */
function runExtraction(
  zipfile: yauzl.ZipFile,
  root: string,
  opts: { inactivityMs: number; outerSignal: AbortSignal; onEntry?: (name: string) => void }
): Promise<void> {
  const { inactivityMs, outerSignal, onEntry } = opts;
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    // Running total of declared uncompressed bytes. yauzl validates each
    // entry's decompressed length against its `uncompressedSize` header by
    // default, so this is a trustworthy bound — it guards against a zip-bomb
    // whose compressed form fits under MAX_DNTR_BYTES but expands to many GB.
    let totalUncompressed = 0;
    let entryCount = 0;
    const seen = new Set<string>();
    // The transfer in flight, if any. `lazyEntries` guarantees at most one at a
    // time, so a single handle (not a set) is enough. `fail()` aborts it before
    // closing the zip so a zipfile-level error can't leave a live read stream
    // dangling on the shared file descriptor.
    let activeTransfer: { abort: () => void } | null = null;
    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      outerSignal.removeEventListener("abort", onOuterAbort);
      activeTransfer?.abort();
      zipfile.close();
      reject(err);
    };

    // A cancel or deadline that lands between entries (or during a directory
    // mkdir) has no in-flight pipeline to reject, so tear down here instead.
    // `fail` latches `settled` first, so whichever abort source fires first owns
    // the reported reason — the `activeTransfer.abort()` it then issues can't
    // overwrite it with the generic "was interrupted" message.
    function onOuterAbort() {
      const reason: unknown = outerSignal.reason;
      fail(reason instanceof Error ? reason : new Error("Extraction was cancelled"));
    }
    if (outerSignal.aborted) {
      onOuterAbort();
      return;
    }
    outerSignal.addEventListener("abort", onOuterAbort, { once: true });

    zipfile.on("entry", (entry: yauzl.Entry) => {
      const name = normalizePath(entry.fileName);

      if (++entryCount > MAX_DNTR_ENTRIES) {
        return fail(new Error(`Archive exceeds ${MAX_DNTR_ENTRIES} entry limit`));
      }

      // Reject any raw name that isn't already POSIX-normalized. Backslash and
      // other invalid-char names are already rejected upstream by yauzl's
      // `strictFileNames` (see openZip), so what this additionally catches is a
      // leading `/` or `./` prefix that `normalizePath` would otherwise strip.
      if (entry.fileName !== name) {
        return fail(
          new Error(
            `Invalid entry path "${entry.fileName}": path must use forward slashes, no leading / or drive letters`
          )
        );
      }
      const pathErr = isValidEntryName(name);
      if (pathErr) {
        return fail(new Error(`Invalid entry path "${name}": ${pathErr}`));
      }

      if (seen.has(name)) {
        return fail(new Error(`Duplicate entry "${name}" in archive`));
      }
      seen.add(name);

      totalUncompressed += entry.uncompressedSize;
      if (totalUncompressed > MAX_DNTR_BYTES) {
        return fail(new Error(`Uncompressed archive size exceeds ${MAX_DNTR_BYTES} byte limit`));
      }

      const resolved = path.resolve(root, name);
      if (resolved !== root && !resolved.startsWith(root + path.sep)) {
        return fail(new Error(`Entry "${name}" escapes the extraction directory`));
      }

      // Directory entry — create and advance.
      if (name.endsWith("/")) {
        fs.mkdir(resolved, { recursive: true }).then(() => zipfile.readEntry(), fail);
        return;
      }

      onEntry?.(name);

      fs.mkdir(path.dirname(resolved), { recursive: true }).then(() => {
        zipfile.openReadStream(entry, (err, stream) => {
          if (err) return fail(err);
          const out = createWriteStream(resolved, { mode: 0o644 });

          // Abort the transfer if the entry stalls. `pipeline` destroys both
          // streams on abort, then rejects with an AbortError carrying this
          // error, which flows to `fail()` below. The timer is reset on every
          // chunk, so only a truly dead stream trips it.
          const controller = new AbortController();
          let timer: ReturnType<typeof setTimeout>;
          const resetTimer = () => {
            clearTimeout(timer);
            timer = setTimeout(
              () =>
                controller.abort(
                  new Error(`Extraction of "${name}" stalled: no data for ${inactivityMs}ms`)
                ),
              inactivityMs
            );
          };
          const clearTimer = () => clearTimeout(timer);
          // Attaching this listener flips the stream to flowing mode; `pipeline`
          // below consumes it. Both must be wired in this same synchronous tick
          // — `resume()` only schedules the first read on the next tick — or a
          // chunk could be emitted before `pipeline` starts reading. Do not
          // split these two statements.
          stream.on("data", resetTimer);
          resetTimer();
          // Reuse the abort as the outer teardown hook: if the zip errors while
          // this transfer is live, `fail()` aborts the controller, which
          // destroys both streams and rejects the pipeline below.
          activeTransfer = {
            abort: () => controller.abort(new Error(`Extraction of "${name}" was interrupted`)),
          };

          // The per-entry stall controller plus the extraction-wide deadline /
          // cancel signal. `AbortSignal.any` preserves the `reason` of whichever
          // source fires first, so the single unwrap below reports the true
          // cause instead of collapsing all three into one message.
          const entrySignal = AbortSignal.any([controller.signal, outerSignal]);

          pipeline(stream, out, { signal: entrySignal }).then(
            () => {
              clearTimer();
              activeTransfer = null;
              if (!settled) zipfile.readEntry();
            },
            (pipelineErr: unknown) => {
              clearTimer();
              activeTransfer = null;
              const err =
                pipelineErr instanceof Error ? pipelineErr : new Error(String(pipelineErr));
              // `pipeline` surfaces a genuine stream/fs failure as-is and only
              // rejects with an AbortError when our abort was the sole cause —
              // and that AbortError drops the reason we passed, so recover the
              // stall / deadline / cancel error from the composed signal.
              // Discriminate on the rejection itself (not `signal.aborted`): a
              // real error that merely raced one of those deadlines must still
              // win over their messages.
              const reason: unknown = entrySignal.reason;
              fail(err.name === "AbortError" && reason instanceof Error ? reason : err);
            }
          );
        });
      }, fail);
    });

    zipfile.on("end", () => {
      if (!settled) {
        settled = true;
        outerSignal.removeEventListener("abort", onOuterAbort);
        zipfile.close();
        resolve();
      }
    });

    zipfile.on("error", (err) => fail(err));

    zipfile.readEntry();
  });
}

/**
 * Verify a `.dntr` archive against the format spec.
 * Checks: max size, first entry is plugin.json, path validity,
 * exclusion patterns, manifest schema.
 */
export async function verifyPluginArchive(archivePath: string): Promise<VerifyResult> {
  let stat: import("fs").Stats;
  try {
    stat = await fs.stat(archivePath);
  } catch {
    return { valid: false, error: "Archive file not found or inaccessible" };
  }

  if (stat.size === 0) {
    return { valid: false, error: "Archive is empty (0 bytes)" };
  }

  if (stat.size > MAX_DNTR_BYTES) {
    return {
      valid: false,
      error: `Archive size ${stat.size} exceeds ${MAX_DNTR_BYTES} byte limit`,
    };
  }

  let zipfile: yauzl.ZipFile;
  try {
    zipfile = await openZip(archivePath);
  } catch (err) {
    return {
      valid: false,
      error: `Not a valid ZIP file: ${(err as Error).message}`,
    };
  }

  let entryIndex = 0;
  let manifest: PluginManifest | null = null;
  const entryNames = new Set<string>();
  const seen = new Set<string>();

  return new Promise((resolve) => {
    let settled = false;

    zipfile.on("entry", (entry: yauzl.Entry) => {
      const name = normalizePath(entry.fileName);

      if (entryIndex + 1 > MAX_DNTR_ENTRIES) {
        settled = true;
        zipfile.close();
        return resolve({
          valid: false,
          error: `Archive exceeds ${MAX_DNTR_ENTRIES} entry limit`,
        });
      }

      // Validate the raw entry name before any normalization — backslashes
      // and absolute paths in the raw name are always invalid.
      if (entry.fileName !== name) {
        settled = true;
        zipfile.close();
        return resolve({
          valid: false,
          error: `Invalid entry path "${entry.fileName}": path must use forward slashes, no leading / or drive letters`,
        });
      }

      if (seen.has(name)) {
        settled = true;
        zipfile.close();
        return resolve({
          valid: false,
          error: `Duplicate entry "${name}" in archive`,
        });
      }
      seen.add(name);

      if (entryIndex === 0 && name !== "plugin.json") {
        settled = true;
        zipfile.close();
        return resolve({
          valid: false,
          error: `First entry must be plugin.json, got "${entry.fileName}"`,
        });
      }

      const pathErr = isValidEntryName(name);
      if (pathErr) {
        settled = true;
        zipfile.close();
        return resolve({
          valid: false,
          error: `Invalid entry path "${name}": ${pathErr}`,
        });
      }

      if (matchesExclusionPattern(name, true)) {
        settled = true;
        zipfile.close();
        return resolve({
          valid: false,
          error: `Excluded entry found in archive: "${name}"`,
        });
      }

      if (!name.endsWith("/")) {
        entryNames.add(name);
      }

      if (entryIndex === 0) {
        const sizeErr = manifestSizeError(entry);
        if (sizeErr) {
          settled = true;
          zipfile.close();
          return resolve({ valid: false, error: sizeErr });
        }
        zipfile.openReadStream(entry, (err, stream) => {
          if (err) {
            settled = true;
            zipfile.close();
            return resolve({ valid: false, error: `Failed to read plugin.json: ${err.message}` });
          }
          const chunks: Buffer[] = [];
          stream.on("data", (chunk: Buffer) => chunks.push(chunk));
          stream.on("end", () => {
            let json: unknown;
            try {
              json = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
            } catch {
              settled = true;
              zipfile.close();
              return resolve({ valid: false, error: "plugin.json is not valid JSON" });
            }
            const parseResult = getPluginManifestSchema(false).safeParse(json);
            if (!parseResult.success) {
              settled = true;
              zipfile.close();
              return resolve({
                valid: false,
                error: `plugin.json schema validation failed: ${parseResult.error.message}`,
              });
            }
            manifest = parseResult.data;
            zipfile.readEntry();
          });
          stream.on("error", (streamErr) => {
            settled = true;
            zipfile.close();
            resolve({ valid: false, error: `Failed to read plugin.json: ${streamErr.message}` });
          });
        });
      } else {
        zipfile.readEntry();
      }
      entryIndex++;
    });

    zipfile.on("end", () => {
      zipfile.close();
      if (!manifest) {
        return resolve({ valid: false, error: "plugin.json not found in archive" });
      }

      const stripLeading = (p: string) => (p.startsWith("./") ? p.slice(2) : p);

      if (manifest.main) {
        const mainPath = stripLeading(manifest.main);
        if (!entryNames.has(mainPath)) {
          return resolve({
            valid: false,
            error: `manifest.main "${manifest.main}" is not present in the archive`,
          });
        }
      }

      for (const view of manifest.contributes.views) {
        const viewPath = stripLeading(view.componentPath);
        if (!entryNames.has(viewPath)) {
          return resolve({
            valid: false,
            error: `view componentPath "${view.componentPath}" is not present in the archive`,
          });
        }
      }

      resolve({ valid: true, manifest, entryCount: entryIndex });
    });

    zipfile.on("error", (err) => {
      if (!settled) {
        settled = true;
        resolve({ valid: false, error: `ZIP read error: ${err.message}` });
      }
    });

    zipfile.readEntry();
  });
}
