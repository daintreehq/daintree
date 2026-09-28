import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HOST_INBOX_DIR_NAME } from "../../../shared/types/ipc/fileTransfer.js";
import { ensureOwnerOnlyDir, OWNER_RWX_DIR_MODE, OWNER_RW_FILE_MODE } from "../../utils/fs.js";
import { logWarn } from "../../utils/logger.js";
import { BULK_CHUNK_BYTES } from "../link/frames.js";

/**
 * The host inbox: where files dropped, pasted or attached in a remote window
 * land, outside every worktree so they never show up in `git status`.
 *
 *   <tmpdir>/daintree-inbox/clipboard/clipboard-<yyyymmdd-hhmmss>-<id>.<ext>
 *   <tmpdir>/daintree-inbox/files/<yyyymmdd-hhmmss>-<id>/<original name>
 *
 * Every directory is owner-only and lstat-checked (a planted symlink or a
 * directory owned by someone else is refused); every file is created 0600 with
 * O_EXCL|O_NOFOLLOW. `<id>` is the start of the content's sha256, so the same
 * bytes dropped again reuse the file already here. Entries expire after a day,
 * the newest 50 clipboard images are kept, and the whole inbox stays under a
 * size cap; cleanup runs at host start and after every write.
 */

export type InboxBucket = "clipboard" | "files";

export interface HostInboxOptions {
  /** The inbox folder itself; `<tmpdir>/daintree-inbox` by default. */
  root?: string;
  now?: () => number;
  ttlMs?: number;
  maxTotalBytes?: number;
  maxClipboardImages?: number;
  /** A part file untouched this long belongs to no live upload. */
  stalePartMs?: number;
}

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_MAX_TOTAL_BYTES = 1024 * 1024 * 1024;
const DEFAULT_MAX_CLIPBOARD_IMAGES = 50;
const DEFAULT_STALE_PART_MS = 60 * 60 * 1000;
const MAX_NAME_LENGTH = 200;
const ID_LENGTH = 12;
const PART_PREFIX = ".part-";
const MAX_DIR_ATTEMPTS = 100;

export function defaultInboxRoot(): string {
  return path.join(os.tmpdir(), HOST_INBOX_DIR_NAME);
}

/** A name from the Shell, made safe to create here: no control characters or separators, bounded. */
export function sanitizeInboxName(name: string): string {
  let cleaned = "";
  for (const char of name) {
    const code = char.codePointAt(0)!;
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) continue;
    if (char === "/" || char === "\\") continue;
    cleaned += char;
  }
  cleaned = cleaned.replace(/^[.\s]+/, "").trim();
  if (cleaned.length > MAX_NAME_LENGTH) {
    const ext = path.extname(cleaned).slice(0, 20);
    cleaned = cleaned.slice(0, MAX_NAME_LENGTH - ext.length) + ext;
  }
  return cleaned || "file";
}

const IMAGE_EXTENSIONS: Record<string, string> = {
  png: "png",
  jpg: "jpeg",
  jpeg: "jpeg",
  gif: "gif",
  webp: "webp",
  bmp: "bmp",
  tif: "tiff",
  tiff: "tiff",
  heic: "heic",
  avif: "avif",
};

const PREFERRED_EXTENSION: Record<string, string> = {
  png: "png",
  jpeg: "jpg",
  gif: "gif",
  webp: "webp",
  bmp: "bmp",
  tiff: "tiff",
  heic: "heic",
  avif: "avif",
};

function startsWith(head: Uint8Array, bytes: number[], offset = 0): boolean {
  if (head.byteLength < offset + bytes.length) return false;
  return bytes.every((byte, index) => head[offset + index] === byte);
}

function ascii(head: Uint8Array, offset: number, length: number): string {
  return Buffer.from(head.subarray(offset, offset + length)).toString("latin1");
}

/** The image type the content really is, from its magic bytes. */
export function detectImageType(head: Uint8Array): string | null {
  if (startsWith(head, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "png";
  if (startsWith(head, [0xff, 0xd8, 0xff])) return "jpeg";
  if (ascii(head, 0, 6) === "GIF87a" || ascii(head, 0, 6) === "GIF89a") return "gif";
  if (ascii(head, 0, 4) === "RIFF" && ascii(head, 8, 4) === "WEBP") return "webp";
  if (ascii(head, 0, 2) === "BM") return "bmp";
  if (startsWith(head, [0x49, 0x49, 0x2a, 0x00]) || startsWith(head, [0x4d, 0x4d, 0x00, 0x2a])) {
    return "tiff";
  }
  if (ascii(head, 4, 4) === "ftyp") {
    const brand = ascii(head, 8, 4);
    if (brand === "avif" || brand === "avis") return "avif";
    if (["heic", "heix", "hevc", "hevx", "mif1", "msf1"].includes(brand)) return "heic";
  }
  return null;
}

/**
 * Never trust the extension over the content for an image: a name that claims
 * an image type the bytes are not gets the extension the bytes say, and one
 * that is no image at all loses the image extension, so an agent never opens
 * it as a picture.
 */
export function reconcileImageExtension(name: string, head: Uint8Array): string {
  const ext = path.extname(name);
  const claimed = IMAGE_EXTENSIONS[ext.slice(1).toLowerCase()];
  if (!claimed) return name;
  const actual = detectImageType(head);
  if (actual === claimed) return name;
  const stem = name.slice(0, name.length - ext.length) || "file";
  return actual ? `${stem}.${PREFERRED_EXTENSION[actual]}` : `${stem}.bin`;
}

function stemOf(name: string): string {
  const ext = path.extname(name);
  return ext ? name.slice(0, name.length - ext.length) : name;
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

export function inboxTimestamp(at: number): string {
  const date = new Date(at);
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-` +
    `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  );
}

async function sha256OfFile(filePath: string): Promise<string | null> {
  let handle: Awaited<ReturnType<typeof fs.open>>;
  try {
    handle = await fs.open(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  } catch {
    return null;
  }
  try {
    const hash = crypto.createHash("sha256");
    const buf = Buffer.allocUnsafe(BULK_CHUNK_BYTES);
    for (;;) {
      const { bytesRead } = await handle.read(buf, 0, buf.byteLength, null);
      if (bytesRead === 0) break;
      hash.update(buf.subarray(0, bytesRead));
    }
    return hash.digest("hex");
  } catch {
    return null;
  } finally {
    await handle.close().catch(() => {});
  }
}

async function readHead(filePath: string, length = 32): Promise<Uint8Array> {
  const handle = await fs.open(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const buf = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buf, 0, length, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    await handle.close().catch(() => {});
  }
}

interface InboxEntry {
  path: string;
  kind: "clipboard" | "files" | "part";
  mtimeMs: number;
  bytes: number;
}

export class HostInbox {
  readonly root: string;
  private readonly now: () => number;
  private cleanupChain: Promise<void> = Promise.resolve();
  private readonly activeParts = new Set<string>();

  constructor(private readonly options: HostInboxOptions = {}) {
    this.root = options.root ?? defaultInboxRoot();
    this.now = options.now ?? Date.now;
  }

  bucketDir(bucket: InboxBucket): string {
    return path.join(this.root, bucket);
  }

  /** Create (or verify and tighten) the inbox and its buckets. */
  async ensure(): Promise<void> {
    await ensureOwnerOnlyDir(this.root);
    await ensureOwnerOnlyDir(this.bucketDir("clipboard"));
    await ensureOwnerOnlyDir(this.bucketDir("files"));
  }

  /** A fresh owner-only part file for an upload in flight; the caller owns the handle. */
  async createPart(): Promise<{ path: string; handle: Awaited<ReturnType<typeof fs.open>> }> {
    await this.ensure();
    const partPath = path.join(
      this.root,
      `${PART_PREFIX}${crypto.randomBytes(16).toString("hex")}`
    );
    const handle = await fs.open(
      partPath,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
      OWNER_RW_FILE_MODE
    );
    this.activeParts.add(partPath);
    return { path: partPath, handle };
  }

  /** The part file is gone or placed: cleanup may treat it as stale again. */
  releasePart(partPath: string): void {
    this.activeParts.delete(partPath);
  }

  /**
   * The inbox file that already holds exactly these bytes under this name, or
   * null. The candidate is re-hashed, never trusted from its name alone; a hit
   * is touched so it lives another day.
   */
  async findDuplicate(
    bucket: InboxBucket,
    name: string,
    sha256: string,
    size: number
  ): Promise<string | null> {
    const id = sha256.slice(0, ID_LENGTH);
    const dir = this.bucketDir(bucket);
    let names: string[];
    try {
      names = await fs.readdir(dir);
    } catch {
      return null;
    }
    for (const entry of names) {
      let candidate: string;
      if (bucket === "clipboard") {
        if (!entry.startsWith("clipboard-") || !entry.includes(`-${id}.`)) continue;
        candidate = path.join(dir, entry);
      } else {
        if (!new RegExp(`^\\d{8}-\\d{6}-${id}(?:-\\d+)?$`).test(entry)) continue;
        const entryDir = path.join(dir, entry);
        const dirStat = await fs.lstat(entryDir).catch(() => null);
        if (!dirStat?.isDirectory()) continue;
        // The placed name may have had its image extension corrected; the stem is what the user named.
        const wanted = stemOf(sanitizeInboxName(name));
        const inner = (await fs.readdir(entryDir).catch(() => [] as string[])).find(
          (innerName) => stemOf(innerName) === wanted
        );
        if (!inner) continue;
        candidate = path.join(entryDir, inner);
      }
      const stat = await fs.lstat(candidate).catch(() => null);
      if (!stat?.isFile() || stat.size !== size) continue;
      if ((await sha256OfFile(candidate)) !== sha256) continue;
      const at = new Date(this.now());
      await fs.utimes(candidate, at, at).catch(() => {});
      if (bucket === "files") await fs.utimes(path.dirname(candidate), at, at).catch(() => {});
      return candidate;
    }
    return null;
  }

  /**
   * Move a verified part file to its place in the bucket and return the host
   * path. Never overwrites: each file gets a directory (or name) of its own.
   */
  async place(
    bucket: InboxBucket,
    partPath: string,
    name: string,
    sha256: string
  ): Promise<string> {
    const id = sha256.slice(0, ID_LENGTH);
    const stamp = inboxTimestamp(this.now());
    const head = await readHead(partPath);
    const safeName = reconcileImageExtension(sanitizeInboxName(name), head);
    await this.ensure();
    if (bucket === "clipboard") {
      const detected = detectImageType(head);
      const ext = detected ? PREFERRED_EXTENSION[detected] : "bin";
      for (let attempt = 0; attempt < MAX_DIR_ATTEMPTS; attempt++) {
        const suffix = attempt === 0 ? "" : `-${attempt}`;
        const target = path.join(
          this.bucketDir("clipboard"),
          `clipboard-${stamp}-${id}${suffix}.${ext}`
        );
        if (await this.linkInto(partPath, target)) return target;
      }
      throw new Error("No free name in the inbox");
    }
    for (let attempt = 0; attempt < MAX_DIR_ATTEMPTS; attempt++) {
      const suffix = attempt === 0 ? "" : `-${attempt}`;
      const dir = path.join(this.bucketDir("files"), `${stamp}-${id}${suffix}`);
      try {
        await fs.mkdir(dir, { mode: OWNER_RWX_DIR_MODE });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
        throw error;
      }
      const target = path.join(dir, safeName);
      if (await this.linkInto(partPath, target)) return target;
      throw new Error("The inbox folder was taken while placing the file");
    }
    throw new Error("No free folder in the inbox");
  }

  /** Hard-link the part file to `target` (which must not exist), then drop the part name. */
  private async linkInto(partPath: string, target: string): Promise<boolean> {
    try {
      await fs.link(partPath, target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw error;
    }
    await fs.unlink(partPath).catch(() => {});
    this.activeParts.delete(partPath);
    return true;
  }

  /** Queue a cleanup pass; passes never overlap. */
  cleanup(): Promise<void> {
    const run = this.cleanupChain.then(() => this.cleanupOnce());
    this.cleanupChain = run.catch(() => {});
    return run;
  }

  private async cleanupOnce(): Promise<void> {
    try {
      const rootStat = await fs.lstat(this.root).catch(() => null);
      // Not ours (or not there): never sweep through something someone else planted.
      if (!rootStat || rootStat.isSymbolicLink() || !rootStat.isDirectory()) return;
      const uid = typeof process.getuid === "function" ? process.getuid() : null;
      if (uid !== null && rootStat.uid !== uid) return;

      const entries = await this.listEntries();
      const now = this.now();
      const ttl = this.options.ttlMs ?? DEFAULT_TTL_MS;
      const stalePart = this.options.stalePartMs ?? DEFAULT_STALE_PART_MS;
      const doomed = new Set<InboxEntry>();
      for (const entry of entries) {
        const age = now - entry.mtimeMs;
        if (entry.kind === "part") {
          if (!this.activeParts.has(entry.path) && age > stalePart) doomed.add(entry);
        } else if (age > ttl) {
          doomed.add(entry);
        }
      }

      const byAge = (a: InboxEntry, b: InboxEntry) =>
        a.mtimeMs - b.mtimeMs || a.path.localeCompare(b.path);
      const images = entries.filter((e) => e.kind === "clipboard" && !doomed.has(e)).sort(byAge);
      const maxImages = this.options.maxClipboardImages ?? DEFAULT_MAX_CLIPBOARD_IMAGES;
      for (const entry of images.slice(0, Math.max(0, images.length - maxImages))) {
        doomed.add(entry);
      }

      const maxBytes = this.options.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES;
      const survivors = entries
        .filter((e) => !doomed.has(e) && !(e.kind === "part" && this.activeParts.has(e.path)))
        .sort(byAge);
      let total = entries
        .filter((e) => !doomed.has(e))
        .reduce((sum, entry) => sum + entry.bytes, 0);
      for (const entry of survivors) {
        if (total <= maxBytes) break;
        doomed.add(entry);
        total -= entry.bytes;
      }

      await Promise.all(
        [...doomed].map((entry) =>
          fs.rm(entry.path, { recursive: true, force: true }).catch(() => {})
        )
      );
    } catch (error) {
      logWarn("remote.inbox.cleanup-failed", {
        code: (error as NodeJS.ErrnoException).code ?? "unknown",
      });
    }
  }

  private async listEntries(): Promise<InboxEntry[]> {
    const entries: InboxEntry[] = [];
    const rootNames = await fs.readdir(this.root).catch(() => [] as string[]);
    for (const name of rootNames) {
      if (!name.startsWith(PART_PREFIX)) continue;
      const entryPath = path.join(this.root, name);
      const stat = await fs.lstat(entryPath).catch(() => null);
      if (stat)
        entries.push({ path: entryPath, kind: "part", mtimeMs: stat.mtimeMs, bytes: stat.size });
    }
    for (const bucket of ["clipboard", "files"] as const) {
      const dir = this.bucketDir(bucket);
      const dirStat = await fs.lstat(dir).catch(() => null);
      if (!dirStat?.isDirectory()) continue;
      for (const name of await fs.readdir(dir).catch(() => [] as string[])) {
        const entryPath = path.join(dir, name);
        const stat = await fs.lstat(entryPath).catch(() => null);
        if (!stat) continue;
        let bytes = stat.isFile() ? stat.size : 0;
        let mtimeMs = stat.mtimeMs;
        if (stat.isDirectory()) {
          for (const inner of await fs.readdir(entryPath).catch(() => [] as string[])) {
            const innerStat = await fs.lstat(path.join(entryPath, inner)).catch(() => null);
            if (!innerStat) continue;
            if (innerStat.isFile()) bytes += innerStat.size;
            mtimeMs = Math.max(mtimeMs, innerStat.mtimeMs);
          }
        }
        entries.push({ path: entryPath, kind: bucket, mtimeMs, bytes });
      }
    }
    return entries;
  }
}
