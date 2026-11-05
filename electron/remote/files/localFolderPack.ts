import crypto from "node:crypto";
import { constants as fsConstants, type Dirent, type Stats } from "node:fs";
import fs, { type FileHandle } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import type { FolderUploadTotals } from "../../../shared/types/folderUpload.js";
import type {
  FolderNotCopiedReason,
  FolderPackChange,
} from "../../../shared/types/ipc/fileTransfer.js";
import { ensureOwnerOnlyDir, OWNER_RW_FILE_MODE, resilientUnlink } from "../../utils/fs.js";
import { BULK_CHUNK_BYTES } from "../link/frames.js";
import type { TransferSource } from "../link/transfer.js";
import { NEW_FILE_FLAGS } from "./exclusiveCopy.js";
import {
  FOLDER_ARCHIVE_FLAG_UTF8,
  FOLDER_ARCHIVE_METHOD_STORED,
  folderArchiveMode,
} from "./folderUploadLinkMethods.js";
import type { FolderSnapshot, FolderSnapshotEntry } from "./localFolderWalk.js";

/*
 * Packs exactly what a folder summary counted (`FolderSnapshot`) into the
 * stored zip a folder upload sends, in a private folder on this machine. A
 * bulk transfer announces its size and sha256 before its first byte, so the
 * archive is written whole first, hashed as it is written, and sent after.
 *
 * Nothing new is picked up and no link is followed at the leaf: each file is
 * opened with O_NOFOLLOW (where the platform has it) and held, on the handle
 * itself, to the identity, size and modification time it was summarized
 * with, and each folder is listed again, before and after the files are
 * copied, and held to the names it had. Anything that differs stops the pack
 * with the path responsible, since the person was asked about what the
 * summary showed and nothing else. As in the walk, a folder swapped for a
 * link between its check and a later open is caught by the identity checks
 * after the fact, not prevented: Node has no descriptor-relative open.
 */

/** Only names the packer makes are ever swept. */
const ARCHIVE_NAME = /^[0-9a-f]{32}\.zip$/;

const LOCAL_SIGNATURE = 0x04034b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const END_SIGNATURE = 0x06054b50;
const DESCRIPTOR_SIGNATURE = 0x08074b50;
const LOCAL_HEADER_BYTES = 30;
const CENTRAL_HEADER_BYTES = 46;
const END_RECORD_BYTES = 22;
const DESCRIPTOR_BYTES = 16;
/** Version 2.0: folders and data descriptors. */
const VERSION_NEEDED = 20;
const MADE_BY_UNIX = (3 << 8) | VERSION_NEEDED;
// General-purpose bit 3. The contract names it alongside the host's unpacker (#16250).
const FLAG_DATA_DESCRIPTOR = 0x0008;
/** 1980-01-01 00:00, the earliest a zip can say: no time is carried. */
const DOS_TIME = 0;
const DOS_DATE = (1 << 5) | 1;
/** Without ZIP64, which the limits keep the archive well inside. */
const MAX_ENTRIES = 0xffff - 1;
const MAX_OFFSET = 0xffffffff - 1;

// O_NONBLOCK so a file swapped for a FIFO can't hold the open waiting for a
// writer. Windows has neither flag; the handle's own stat stands in.
const SOURCE_FLAGS =
  fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0);
const ARCHIVE_READ_FLAGS = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0);

export type { FolderPackChange };

export type LocalFolderPackFailure = "cancelled" | "no-space" | "write-failed";

/**
 * A pack that produced no archive, and left none behind. It names nothing
 * from inside the folder: errors get logged whole, so a changed path comes
 * back as a result instead.
 */
export class LocalFolderPackError extends Error {
  constructor(readonly reason: LocalFolderPackFailure) {
    super(`Folder pack failed: ${reason}`);
    this.name = "LocalFolderPackError";
  }
}

export interface FolderPackProgress {
  filesDone: number;
  filesTotal: number;
  bytesDone: number;
  bytesTotal: number;
}

/** A packed folder, ready for its prepare. */
export interface PackedFolderArchive {
  /** Where the archive is, inside the folder it was packed in. */
  readonly path: string;
  readonly archiveBytes: number;
  /** Lowercase hex sha256 of the whole archive. */
  readonly sha256: string;
  /** What the archive holds, as the prepare declares it. */
  readonly totals: FolderUploadTotals;
  /**
   * The archive as a transfer source, from a handle of its own, without
   * hashing it again. Each send attempt opens one; the transfer closes it.
   */
  openSource(): Promise<TransferSource>;
  /** Closes every source still open and deletes the archive; safe to call more than once. */
  remove(): Promise<void>;
}

/**
 * A summarized folder packed, or the first entry found to differ from its
 * summary, in archive form (`Root/src/app.ts`), with nothing left behind.
 */
export type LocalFolderPackResult =
  | { status: "packed"; archive: PackedFolderArchive }
  | { status: "changed"; path: string; change: FolderPackChange };

export interface PackLocalFolderOptions {
  signal: AbortSignal;
  /** Where the archive goes: an owner-only folder, made if missing ({@link folderPackDir}). */
  dir: string;
  /** At the start, after each chunk and after each file; the caller throttles. */
  onProgress?: (progress: FolderPackProgress) => void;
  platform?: NodeJS.Platform;
}

/** Archives this process is still writing or holding, never swept. */
const liveArchives = new Set<string>();

/**
 * The private folder archives are packed in: per user, so on a shared /tmp
 * another user can't hold the name first, and per userData, which the app's
 * single-instance lock is keyed by, so it belongs to one running Daintree at
 * a time and a dev build never sweeps a packaged build's archive.
 */
export function folderPackDir(userDataPath: string): string {
  const uid = typeof process.getuid === "function" ? `-${process.getuid()}` : "";
  const instance = crypto.createHash("sha256").update(userDataPath).digest("hex").slice(0, 16);
  return path.join(os.tmpdir(), `daintree-folder-packs${uid}-${instance}`);
}

/** Unwinds a mismatch to the one place that removes the archive and reports it. */
class Changed extends Error {
  constructor(
    readonly entryPath: string,
    readonly change: FolderPackChange
  ) {
    super(`Folder entry ${change}`);
    this.name = "FolderPackChanged";
  }
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new LocalFolderPackError("cancelled");
}

function writeFailure(error: unknown): LocalFolderPackError {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return new LocalFolderPackError(
    code === "ENOSPC" || code === "EDQUOT" ? "no-space" : "write-failed"
  );
}

function localPathOf(snapshot: Readonly<FolderSnapshot>, entryPath: string): string {
  const trimmed = entryPath.endsWith("/") ? entryPath.slice(0, -1) : entryPath;
  return path.join(snapshot.localPath, ...trimmed.split("/").slice(1));
}

/** The folder an archive path sits in, with its trailing `/`, and its own name. */
function splitParent(entryPath: string): { parent: string; name: string } | null {
  const trimmed = entryPath.endsWith("/") ? entryPath.slice(0, -1) : entryPath;
  const slash = trimmed.lastIndexOf("/");
  if (slash === -1) return null;
  return { parent: trimmed.slice(0, slash + 1), name: trimmed.slice(slash + 1) };
}

interface ExpectedChild {
  path: string;
  /** What a copied item is; null for one left out. */
  kind: "file" | "folder" | null;
  /** Set for an item left out; null for one that is copied. */
  notCopied: FolderNotCopiedReason | null;
}

/** For each summarized folder, every name it held: copied or left out. */
function expectedChildren(
  snapshot: Readonly<FolderSnapshot>
): Map<string, Map<string, ExpectedChild>> {
  const byFolder = new Map<string, Map<string, ExpectedChild>>();
  const add = (child: ExpectedChild) => {
    const split = splitParent(child.path);
    if (!split) return;
    let children = byFolder.get(split.parent);
    if (!children) {
      children = new Map();
      byFolder.set(split.parent, children);
    }
    children.set(split.name, child);
  };
  for (const entry of snapshot.entries)
    add({ path: entry.path, kind: entry.kind, notCopied: null });
  for (const item of snapshot.notCopied)
    add({ path: item.path, kind: null, notCopied: item.reason });
  return byFolder;
}

type ListedKind = "file" | "folder" | "other" | "unknown";

/**
 * What a listing says an item is. Some filesystems don't say, and the
 * listing can't be held to a type it never gave.
 */
function listedKind(dirent: Dirent): ListedKind {
  if (dirent.isSymbolicLink()) return "other";
  if (dirent.isFile()) return "file";
  if (dirent.isDirectory()) return "folder";
  if (dirent.isFIFO() || dirent.isSocket() || dirent.isBlockDevice()) return "other";
  return dirent.isCharacterDevice() ? "other" : "unknown";
}

/**
 * A copied item that now lists as something else, a link above all (which
 * Windows would open through), or a left-out item that now lists as a plain
 * file or folder, is not what the summary showed. One left out as unreadable
 * may simply read now, and stays left out.
 */
function listedAsChanged(dirent: Dirent, child: ExpectedChild): boolean {
  const listed = listedKind(dirent);
  if (child.notCopied === null) return listed !== "unknown" && listed !== child.kind;
  if (child.notCopied === "unreadable") return false;
  return listed === "file" || listed === "folder";
}

function sameFolder(entry: FolderSnapshotEntry, stat: Stats): boolean {
  return (
    stat.isDirectory() && !stat.isSymbolicLink() && stat.dev === entry.dev && stat.ino === entry.ino
  );
}

/**
 * The file the summary counted, unchanged. ctime is left out on purpose: it
 * moves with metadata the archive never carries (extended attributes a sync
 * client or indexer sets), so it would stop packs over nothing that is sent.
 * A change to the one mode bit that is carried counts.
 */
function sameFile(entry: FolderSnapshotEntry, stat: Stats, platform: NodeJS.Platform): boolean {
  const executable = platform !== "win32" && (stat.mode & 0o111) !== 0;
  return (
    stat.isFile() &&
    stat.dev === entry.dev &&
    stat.ino === entry.ino &&
    stat.size === entry.size &&
    stat.mtimeMs === entry.mtimeMs &&
    executable === entry.executable
  );
}

interface CentralRecord {
  name: Buffer;
  flags: number;
  crc: number;
  size: number;
  mode: number;
  offset: number;
}

/** Appends to the archive, hashing every byte as it goes. */
class ArchiveWriter {
  private readonly hash = crypto.createHash("sha256");
  offset = 0;

  constructor(private readonly handle: FileHandle) {}

  async write(bytes: Uint8Array): Promise<void> {
    if (this.offset + bytes.byteLength > MAX_OFFSET) {
      throw new LocalFolderPackError("write-failed");
    }
    this.hash.update(bytes);
    let written = 0;
    while (written < bytes.byteLength) {
      let result: { bytesWritten: number };
      try {
        result = await this.handle.write(
          bytes,
          written,
          bytes.byteLength - written,
          this.offset + written
        );
      } catch (error) {
        throw writeFailure(error);
      }
      if (result.bytesWritten <= 0) throw new LocalFolderPackError("write-failed");
      written += result.bytesWritten;
    }
    this.offset += bytes.byteLength;
  }

  digest(): string {
    return this.hash.digest("hex");
  }
}

function localHeader(name: Buffer, flags: number): Buffer {
  // A file's CRC and sizes follow its data; a folder's are all zero anyway.
  const header = Buffer.alloc(LOCAL_HEADER_BYTES + name.byteLength);
  header.writeUInt32LE(LOCAL_SIGNATURE, 0);
  header.writeUInt16LE(VERSION_NEEDED, 4);
  header.writeUInt16LE(flags, 6);
  header.writeUInt16LE(FOLDER_ARCHIVE_METHOD_STORED, 8);
  header.writeUInt16LE(DOS_TIME, 10);
  header.writeUInt16LE(DOS_DATE, 12);
  header.writeUInt16LE(name.byteLength, 26);
  name.copy(header, LOCAL_HEADER_BYTES);
  return header;
}

function dataDescriptor(crc: number, size: number): Buffer {
  const descriptor = Buffer.alloc(DESCRIPTOR_BYTES);
  descriptor.writeUInt32LE(DESCRIPTOR_SIGNATURE, 0);
  descriptor.writeUInt32LE(crc, 4);
  descriptor.writeUInt32LE(size, 8);
  descriptor.writeUInt32LE(size, 12);
  return descriptor;
}

function centralDirectory(records: CentralRecord[], directoryOffset: number): Buffer {
  let size = 0;
  for (const record of records) size += CENTRAL_HEADER_BYTES + record.name.byteLength;
  const out = Buffer.alloc(size + END_RECORD_BYTES);
  let at = 0;
  for (const record of records) {
    out.writeUInt32LE(CENTRAL_SIGNATURE, at);
    out.writeUInt16LE(MADE_BY_UNIX, at + 4);
    out.writeUInt16LE(VERSION_NEEDED, at + 6);
    out.writeUInt16LE(record.flags, at + 8);
    out.writeUInt16LE(FOLDER_ARCHIVE_METHOD_STORED, at + 10);
    out.writeUInt16LE(DOS_TIME, at + 12);
    out.writeUInt16LE(DOS_DATE, at + 14);
    out.writeUInt32LE(record.crc, at + 16);
    out.writeUInt32LE(record.size, at + 20);
    out.writeUInt32LE(record.size, at + 24);
    out.writeUInt16LE(record.name.byteLength, at + 28);
    // Extra field, comment, start disk and internal attributes stay zero.
    out.writeUInt32LE((record.mode << 16) >>> 0, at + 38);
    out.writeUInt32LE(record.offset, at + 42);
    record.name.copy(out, at + CENTRAL_HEADER_BYTES);
    at += CENTRAL_HEADER_BYTES + record.name.byteLength;
  }
  out.writeUInt32LE(END_SIGNATURE, at);
  out.writeUInt16LE(records.length, at + 8);
  out.writeUInt16LE(records.length, at + 10);
  out.writeUInt32LE(size, at + 12);
  out.writeUInt32LE(directoryOffset, at + 16);
  return out;
}

/**
 * Lists a summarized folder again and holds it to the names the summary saw
 * in it: a name it never saw is new, and one it copied that is missing has
 * gone. The folder itself is checked to be the same one before and after.
 */
async function verifyFolder(
  snapshot: Readonly<FolderSnapshot>,
  entry: FolderSnapshotEntry,
  expected: Map<string, ExpectedChild> | undefined,
  signal: AbortSignal
): Promise<void> {
  const local = localPathOf(snapshot, entry.path);
  const check = async () => {
    const stat = await fs.lstat(local).catch(() => null);
    if (!stat) throw new Changed(entry.path, "gone");
    if (!sameFolder(entry, stat)) throw new Changed(entry.path, "type");
  };
  await check();
  let dir: Awaited<ReturnType<typeof fs.opendir>>;
  try {
    dir = await fs.opendir(local, { bufferSize: 64 });
  } catch {
    throw new Changed(entry.path, "gone");
  }
  const seen = new Set<string>();
  try {
    // Leaving the loop early closes the directory.
    for await (const dirent of dir) {
      throwIfAborted(signal);
      const known = expected?.get(dirent.name);
      if (!known) throw new Changed(`${entry.path}${dirent.name}`, "new");
      if (listedAsChanged(dirent, known)) throw new Changed(known.path, "type");
      seen.add(dirent.name);
    }
  } catch (error) {
    if (error instanceof Changed || error instanceof LocalFolderPackError) throw error;
    throw new Changed(entry.path, "gone");
  }
  for (const [name, child] of expected ?? []) {
    if (!child.notCopied && !seen.has(name)) throw new Changed(child.path, "gone");
  }
  await check();
}

/** A copied file, by its path, still as the summary counted it. */
async function verifyCopiedFile(
  snapshot: Readonly<FolderSnapshot>,
  entry: FolderSnapshotEntry,
  platform: NodeJS.Platform
): Promise<void> {
  const stat = await fs.lstat(localPathOf(snapshot, entry.path)).catch(() => null);
  if (!stat) throw new Changed(entry.path, "gone");
  if (!stat.isFile()) throw new Changed(entry.path, "type");
  if (!sameFile(entry, stat, platform)) throw new Changed(entry.path, "modified");
}

/**
 * Copies one summarized file into the archive and returns its CRC-32. The
 * handle is held to the summary before anything is read and again after,
 * so a file swapped, grown, shrunk or written to meanwhile stops the pack.
 */
async function packFile(
  snapshot: Readonly<FolderSnapshot>,
  entry: FolderSnapshotEntry,
  writer: ArchiveWriter,
  buffer: Buffer,
  platform: NodeJS.Platform,
  signal: AbortSignal,
  onChunk: (bytes: number) => void
): Promise<number> {
  let source: FileHandle;
  try {
    source = await fs.open(localPathOf(snapshot, entry.path), SOURCE_FLAGS);
  } catch (error) {
    // ELOOP for a link, and anything else that stops a file the walk could read.
    const code = (error as NodeJS.ErrnoException | null)?.code;
    throw new Changed(entry.path, code === "ENOENT" ? "gone" : "type");
  }
  try {
    const before = await source.stat().catch(() => null);
    if (!before) throw new Changed(entry.path, "gone");
    if (!before.isFile()) throw new Changed(entry.path, "type");
    if (!sameFile(entry, before, platform)) throw new Changed(entry.path, "modified");

    let crc = 0;
    let position = 0;
    while (position < entry.size) {
      throwIfAborted(signal);
      const wanted = Math.min(buffer.byteLength, entry.size - position);
      let bytesRead: number;
      try {
        ({ bytesRead } = await source.read(buffer, 0, wanted, position));
      } catch {
        throw new Changed(entry.path, "modified");
      }
      if (bytesRead === 0) throw new Changed(entry.path, "modified");
      const chunk = buffer.subarray(0, bytesRead);
      crc = zlib.crc32(chunk, crc);
      await writer.write(chunk);
      position += bytesRead;
      onChunk(bytesRead);
    }
    // Anything past the summarized size means it grew while it was read.
    const extra = await source.read(buffer, 0, 1, position).catch(() => null);
    if (!extra || extra.bytesRead !== 0) throw new Changed(entry.path, "modified");
    const after = await source.stat().catch(() => null);
    if (!after || !sameFile(entry, after, platform)) throw new Changed(entry.path, "modified");
    return crc;
  } finally {
    await source.close().catch(() => {});
  }
}

async function removeArchive(archivePath: string): Promise<void> {
  try {
    await resilientUnlink(archivePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code !== "ENOENT") throw error;
  }
}

function packedArchive(
  archivePath: string,
  archiveBytes: number,
  sha256: string,
  totals: FolderUploadTotals
): PackedFolderArchive {
  const sources = new Set<FileHandle>();
  /** Sources still opening, which a removal waits out so none outlives it. */
  const opening = new Set<Promise<unknown>>();
  let removal: Promise<void> | null = null;
  const open = async (): Promise<FileHandle> => {
    const handle = await fs.open(archivePath, ARCHIVE_READ_FLAGS);
    const stat = await handle.stat().catch(() => null);
    if (removal || !stat?.isFile() || stat.size !== archiveBytes) {
      await handle.close().catch(() => {});
      throw new Error("The folder archive is no longer as it was packed");
    }
    sources.add(handle);
    return handle;
  };
  return {
    path: archivePath,
    archiveBytes,
    sha256,
    totals,
    async openSource() {
      if (removal) throw new Error("The folder archive has been removed");
      const opened = open();
      opening.add(opened);
      let handle: FileHandle;
      try {
        handle = await opened;
      } finally {
        opening.delete(opened);
      }
      let closed: Promise<void> | null = null;
      return {
        size: archiveBytes,
        sha256,
        read: async (offset, length) => {
          const out = Buffer.alloc(length);
          let got = 0;
          while (got < length) {
            const { bytesRead } = await handle.read(out, got, length - got, offset + got);
            if (bytesRead === 0) break;
            got += bytesRead;
          }
          return out.subarray(0, got);
        },
        close: () => {
          closed ??= handle.close().finally(() => sources.delete(handle));
          return closed;
        },
      };
    },
    remove() {
      removal ??= (async () => {
        await Promise.allSettled([...opening]);
        await Promise.all([...sources].map((handle) => handle.close().catch(() => {})));
        sources.clear();
        try {
          await removeArchive(archivePath);
        } catch (error) {
          // Asked again, it tries again; never asked, it is the startup sweep's.
          removal = null;
          throw error;
        }
        liveArchives.delete(archivePath);
      })();
      return removal;
    },
  };
}

/**
 * Packs `snapshot` into a new archive in `dir`. A folder that differs from
 * its summary is a `changed` result; a cancel, or an archive that can't be
 * written, rejects with {@link LocalFolderPackError}. Either way nothing is
 * left behind, and the promise settles only once it has been removed.
 */
export async function packLocalFolder(
  snapshot: Readonly<FolderSnapshot>,
  options: PackLocalFolderOptions
): Promise<LocalFolderPackResult> {
  const { signal, dir } = options;
  const platform = options.platform ?? process.platform;
  throwIfAborted(signal);
  if (snapshot.entries.length > MAX_ENTRIES) throw new LocalFolderPackError("write-failed");

  const files = snapshot.entries.filter((entry) => entry.kind === "file");
  const totals: FolderUploadTotals = {
    fileCount: files.length,
    // The root has an entry of its own but is never counted.
    folderCount: snapshot.entries.length - files.length - 1,
    totalBytes: files.reduce((sum, entry) => sum + entry.size, 0),
  };
  const progress: FolderPackProgress = {
    filesDone: 0,
    filesTotal: totals.fileCount,
    bytesDone: 0,
    bytesTotal: totals.totalBytes,
  };
  const report = () => options.onProgress?.({ ...progress });

  try {
    await ensureOwnerOnlyDir(dir);
  } catch (error) {
    throw writeFailure(error);
  }
  throwIfAborted(signal);
  const archivePath = path.join(dir, `${crypto.randomBytes(16).toString("hex")}.zip`);
  // Before the file exists, so a sweep that lists it already knows it is held.
  liveArchives.add(archivePath);
  let handle: FileHandle | null = null;
  try {
    try {
      handle = await fs.open(archivePath, NEW_FILE_FLAGS, OWNER_RW_FILE_MODE);
    } catch (error) {
      throw writeFailure(error);
    }
    const writer = new ArchiveWriter(handle);
    const children = expectedChildren(snapshot);
    const records: CentralRecord[] = [];
    const buffer = Buffer.allocUnsafe(BULK_CHUNK_BYTES);
    report();
    for (const entry of snapshot.entries) {
      throwIfAborted(signal);
      const name = Buffer.from(entry.path, "utf8");
      const offset = writer.offset;
      if (entry.kind === "folder") {
        await verifyFolder(snapshot, entry, children.get(entry.path), signal);
        await writer.write(localHeader(name, FOLDER_ARCHIVE_FLAG_UTF8));
        records.push({
          name,
          flags: FOLDER_ARCHIVE_FLAG_UTF8,
          crc: 0,
          size: 0,
          mode: folderArchiveMode("folder"),
          offset,
        });
        continue;
      }
      // The CRC is known only once the data is read, so it follows the data.
      const flags = FOLDER_ARCHIVE_FLAG_UTF8 | FLAG_DATA_DESCRIPTOR;
      await writer.write(localHeader(name, flags));
      const crc = await packFile(snapshot, entry, writer, buffer, platform, signal, (bytes) => {
        progress.bytesDone += bytes;
        report();
      });
      await writer.write(dataDescriptor(crc, entry.size));
      records.push({
        name,
        flags,
        crc,
        size: entry.size,
        mode: folderArchiveMode("file", entry.executable),
        offset,
      });
      progress.filesDone += 1;
      report();
    }
    // Anything that changed after it was copied or listed (a file grown,
    // swapped or arrived in a folder already listed) is caught here, so what
    // is sent still matches the folder when packing ends.
    for (const entry of snapshot.entries) {
      throwIfAborted(signal);
      if (entry.kind === "folder") {
        await verifyFolder(snapshot, entry, children.get(entry.path), signal);
      } else {
        await verifyCopiedFile(snapshot, entry, platform);
      }
    }
    await writer.write(centralDirectory(records, writer.offset));
    const written = handle;
    handle = null;
    try {
      await written.sync();
    } catch (error) {
      await written.close().catch(() => {});
      throw writeFailure(error);
    }
    try {
      await written.close();
    } catch (error) {
      throw writeFailure(error);
    }
    throwIfAborted(signal);
    return {
      status: "packed",
      archive: packedArchive(archivePath, writer.offset, writer.digest(), totals),
    };
  } catch (error) {
    await handle?.close().catch(() => {});
    await removeArchive(archivePath).catch(() => {});
    liveArchives.delete(archivePath);
    if (error instanceof Changed) {
      return { status: "changed", path: error.entryPath, change: error.change };
    }
    if (error instanceof LocalFolderPackError) throw error;
    throw writeFailure(error);
  }
}

/**
 * Removes archives a crash left behind. The folder belongs to this running
 * Daintree alone ({@link folderPackDir}), so every archive in it that this
 * process isn't holding is one. Only names the packer makes, only regular
 * files, and only when the folder is a real one this user owns; everything
 * else is left alone. Returns how many it removed.
 */
export async function sweepFolderPacks(dir: string): Promise<number> {
  const stat = await fs.lstat(dir).catch(() => null);
  if (!stat || stat.isSymbolicLink() || !stat.isDirectory()) return 0;
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  if (uid !== null && stat.uid !== uid) return 0;
  let removed = 0;
  for (const name of await fs.readdir(dir).catch(() => [] as string[])) {
    if (!ARCHIVE_NAME.test(name)) continue;
    const archivePath = path.join(dir, name);
    if (liveArchives.has(archivePath)) continue;
    const entry = await fs.lstat(archivePath).catch(() => null);
    if (!entry?.isFile()) continue;
    try {
      await removeArchive(archivePath);
      removed += 1;
    } catch {
      // Still held open on Windows: the next sweep tries again.
    }
  }
  return removed;
}
