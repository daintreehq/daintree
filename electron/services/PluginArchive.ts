import { createHash } from "crypto";
import fs from "fs/promises";
import { createWriteStream } from "fs";
import path from "path";
import { ZipArchive } from "archiver";
import yauzl from "yauzl";
import { getPluginManifestSchema } from "../schemas/plugin.js";
import type { PluginManifest } from "../../shared/types/plugin.js";

export const ZIP_EPOCH_DATE = new Date("1980-01-01T00:00:00Z");
export const MAX_DNTR_BYTES = 30 * 1024 * 1024;

const REQUIRED_EXCLUSIONS: readonly string[] = ["node_modules/", ".git/"];

const SOURCE_EXTS = new Set([".ts", ".tsx"]);
const SOURCEMAP_EXTS = new Set([".js.map", ".mjs.map"]);

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
  return normalised;
}

function isValidEntryName(name: string): string | null {
  const yauzlError = yauzl.validateFileName(name);
  if (yauzlError !== null) return yauzlError;
  if (name.length === 0) return "empty path";
  return null;
}

function matchesExclusionPattern(name: string, sourcemaps: boolean): boolean {
  for (const pattern of REQUIRED_EXCLUSIONS) {
    if (name === pattern || name.startsWith(pattern)) return true;
  }
  const ext = path.extname(name);
  if (SOURCE_EXTS.has(ext)) return true;
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
    yauzl.open(archivePath, { lazyEntries: true }, (err, zipfile) => {
      if (err) return reject(err);
      resolve(zipfile);
    });
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

      // Guard against a zip whose compressed form fits the cap but whose
      // plugin.json declares a multi-hundred-MB uncompressed size — without
      // this, the chunk buffer below would exhaust the main-process heap.
      if (entry.uncompressedSize > MAX_DNTR_BYTES) {
        settled = true;
        zipfile.close();
        return reject(new Error(`plugin.json exceeds ${MAX_DNTR_BYTES} byte limit`));
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
 */
export async function extractPluginArchive(archivePath: string, destDir: string): Promise<void> {
  const stat = await fs.stat(archivePath);
  if (stat.size > MAX_DNTR_BYTES) {
    throw new Error(`Archive size ${stat.size} exceeds ${MAX_DNTR_BYTES} byte limit`);
  }

  const root = path.resolve(destDir);
  const zipfile = await openZip(archivePath);

  return new Promise<void>((resolve, reject) => {
    let settled = false;
    // Running total of declared uncompressed bytes. yauzl validates each
    // entry's decompressed length against its `uncompressedSize` header by
    // default, so this is a trustworthy bound — it guards against a zip-bomb
    // whose compressed form fits under MAX_DNTR_BYTES but expands to many GB.
    let totalUncompressed = 0;
    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      zipfile.close();
      reject(err);
    };

    zipfile.on("entry", (entry: yauzl.Entry) => {
      const name = normalizePath(entry.fileName);

      // Reject any raw name that isn't already POSIX-normalized — backslashes,
      // leading slashes, and drive letters are always invalid in a `.dntr`.
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

      fs.mkdir(path.dirname(resolved), { recursive: true }).then(() => {
        zipfile.openReadStream(entry, (err, stream) => {
          if (err) return fail(err);
          const out = createWriteStream(resolved, { mode: 0o644 });
          stream.on("error", fail);
          out.on("error", fail);
          out.on("finish", () => zipfile.readEntry());
          stream.pipe(out);
        });
      }, fail);
    });

    zipfile.on("end", () => {
      if (!settled) {
        settled = true;
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

  return new Promise((resolve) => {
    let settled = false;

    zipfile.on("entry", (entry: yauzl.Entry) => {
      const name = normalizePath(entry.fileName);

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

      if (entryIndex === 0) {
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
