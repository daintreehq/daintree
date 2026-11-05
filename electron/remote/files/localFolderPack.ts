import crypto from "node:crypto";
import { constants as fsConstants, type Dirent, type Stats } from "node:fs";
import fs, { type FileHandle } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import type { FolderUploadTotals } from "../../../shared/types/folderUpload.js";
import type { FolderNotCopiedReason } from "../../../shared/types/ipc/fileTransfer.js";
import { ensureOwnerOnlyDir, OWNER_RW_FILE_MODE } from "../../utils/fs.js";
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
 * Nothing is followed and nothing new is picked up: each file is opened
 * without following a link and held to the identity, size and modification
 * time it was summarized with, and each folder is listed again and held to
 * the names it had. Anything that differs stops the pack, naming the path,
 * since the person was asked about what the summary showed and nothing else.
 */

/** Archives left behind this long are swept whoever made them. */
const STALE_ARCHIVE_MS = 24 * 60 * 60_000;
/** `<pid>-<id>.zip`: the pid tells a crashed run's archive from one another Daintree is sending. */
const ARCHIVE_NAME = /^(\d{1,10})-[0-9a-f]{32}\.zip$/;

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
// The contract's own constant lands with the host's unpacker.
const FLAG_DATA_DESCRIPTOR = 0x0008;
/** 1980-01-01 00:00, the earliest a zip can say: no time is carried. */
const DOS_TIME = 0;
const DOS_DATE = (1 << 5) | 1;
/** Without ZIP64, which the limits keep the archive well inside. */
const MAX_ENTRIES = 0xffff - 1;
const MAX_OFFSET = 0xffffffff - 1;

const SOURCE_FLAGS =
  fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0);
const ARCHIVE_READ_FLAGS = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0);

/** How a summarized entry no longer matches what is on disk. */
export type FolderPackChange = "gone" | "modified" | "type" | "new";

export type LocalFolderPackFailure = "cancelled" | "changed" | "no-space" | "write-failed";

/**
 * A pack that produced no archive, and left none behind. `path` is the entry
 * responsible in archive form (`Root/src/app.ts`), for the person to be told;
 * it is never part of the message, since packaged builds log errors whole.
 */
export class LocalFolderPackError extends Error {
  constructor(
    readonly reason: LocalFolderPackFailure,
    readonly path?: string,
    readonly change?: FolderPackChange
  ) {
    super(`Folder pack failed: ${change ? `${reason} (${change})` : reason}`);
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
  /** Where the archive is, inside {@link folderPackDir}. */
  readonly path: string;
  readonly archiveBytes: number;
  /** Lowercase hex sha256 of the whole archive. */
  readonly sha256: string;
  /** What the archive holds, as the prepare declares it. */
  readonly totals: FolderUploadTotals;
  /** The archive as a transfer source, without hashing it again. */
  openSource(): Promise<TransferSource>;
  /** Deletes the archive; safe to call more than once. */
  remove(): Promise<void>;
}

export interface PackLocalFolderOptions {
  signal: AbortSignal;
  /** After each file and each chunk written; the caller throttles. */
  onProgress?: (progress: FolderPackProgress) => void;
  /** Where the archive goes; {@link folderPackDir} by default. */
  dir?: string;
  platform?: NodeJS.Platform;
}

/** Archives this process is still writing or holding, never swept. */
const liveArchives = new Set<string>();

/**
 * The private folder archives are packed in. Per user, so on a shared /tmp
 * another user can't hold the name first.
 */
export function folderPackDir(): string {
  const uid = typeof process.getuid === "function" ? `-${process.getuid()}` : "";
  return path.join(os.tmpdir(), `daintree-folder-packs${uid}`);
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new LocalFolderPackError("cancelled");
}

function changed(entryPath: string, change: FolderPackChange): LocalFolderPackError {
  return new LocalFolderPackError("changed", entryPath, change);
}

function writeFailure(error: unknown): LocalFolderPackError {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return new LocalFolderPackError(
    code === "ENOSPC" || code === "EDQUOT" ? "no-space" : "write-failed"
  );
}

function localPathOf(snapshot: FolderSnapshot, entryPath: string): string {
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
  /** Set for an item left out; null for one that is copied. */
  notCopied: FolderNotCopiedReason | null;
}

/** For each summarized folder, every name it held: copied or left out. */
function expectedChildren(snapshot: FolderSnapshot): Map<string, Map<string, ExpectedChild>> {
  const byFolder = new Map<string, Map<string, ExpectedChild>>();
  const add = (entryPath: string, notCopied: FolderNotCopiedReason | null) => {
    const split = splitParent(entryPath);
    if (!split) return;
    let children = byFolder.get(split.parent);
    if (!children) {
      children = new Map();
      byFolder.set(split.parent, children);
    }
    children.set(split.name, { path: entryPath, notCopied });
  };
  for (const entry of snapshot.entries) add(entry.path, null);
  for (const item of snapshot.notCopied) add(item.path, item.reason);
  return byFolder;
}

/**
 * A left-out item that now lists as a plain file or folder is something the
 * summary never showed. One left out as unreadable may simply read now, and
 * is still left out.
 */
function nowCopyable(dirent: Dirent, reason: FolderNotCopiedReason): boolean {
  if (reason === "unreadable") return false;
  return !dirent.isSymbolicLink() && (dirent.isFile() || dirent.isDirectory());
}

function sameFolder(entry: FolderSnapshotEntry, stat: Stats): boolean {
  return (
    stat.isDirectory() && !stat.isSymbolicLink() && stat.dev === entry.dev && stat.ino === entry.ino
  );
}

function sameFile(entry: FolderSnapshotEntry, stat: Stats, platform: NodeJS.Platform): boolean {
  const executable = platform !== "win32" && (stat.mode & 0o111) !== 0;
  return (
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
      throw new Error("The folder archive outgrew a zip without ZIP64");
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

function localHeader(name: Buffer, flags: number, crc: number, size: number): Buffer {
  const header = Buffer.alloc(LOCAL_HEADER_BYTES + name.byteLength);
  header.writeUInt32LE(LOCAL_SIGNATURE, 0);
  header.writeUInt16LE(VERSION_NEEDED, 4);
  header.writeUInt16LE(flags, 6);
  header.writeUInt16LE(FOLDER_ARCHIVE_METHOD_STORED, 8);
  header.writeUInt16LE(DOS_TIME, 10);
  header.writeUInt16LE(DOS_DATE, 12);
  header.writeUInt32LE(crc, 14);
  header.writeUInt32LE(size, 18);
  header.writeUInt32LE(size, 22);
  header.writeUInt16LE(name.byteLength, 26);
  header.writeUInt16LE(0, 28);
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
    // Extra field, comment, start disk and internal attributes are all zero.
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
  snapshot: FolderSnapshot,
  entry: FolderSnapshotEntry,
  expected: Map<string, ExpectedChild> | undefined,
  signal: AbortSignal
): Promise<void> {
  const local = localPathOf(snapshot, entry.path);
  const check = async () => {
    const stat = await fs.lstat(local).catch(() => null);
    if (!stat) throw changed(entry.path, "gone");
    if (!sameFolder(entry, stat)) throw changed(entry.path, "type");
  };
  await check();
  let dir: Awaited<ReturnType<typeof fs.opendir>>;
  try {
    dir = await fs.opendir(local, { bufferSize: 64 });
  } catch {
    throw changed(entry.path, "gone");
  }
  const seen = new Set<string>();
  try {
    for await (const dirent of dir) {
      throwIfAborted(signal);
      const known = expected?.get(dirent.name);
      if (!known) throw changed(`${entry.path}${dirent.name}`, "new");
      if (known.notCopied && nowCopyable(dirent, known.notCopied)) {
        throw changed(known.path, "type");
      }
      seen.add(dirent.name);
    }
  } catch (error) {
    if (error instanceof LocalFolderPackError) throw error;
    throw changed(entry.path, "gone");
  }
  for (const [name, child] of expected ?? []) {
    if (!child.notCopied && !seen.has(name)) throw changed(child.path, "gone");
  }
  await check();
}

/**
 * Copies one summarized file into the archive. It is opened without
 * following a link and without waiting on a FIFO, then held to what was
 * summarized on the handle itself, before and after it is read, so a file
 * swapped, grown, shrunk or written to meanwhile stops the pack.
 */
async function packFile(
  snapshot: FolderSnapshot,
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
    const code = (error as NodeJS.ErrnoException | null)?.code;
    throw changed(entry.path, code === "ENOENT" ? "gone" : "type");
  }
  try {
    const before = await source.stat().catch(() => null);
    if (!before) throw changed(entry.path, "gone");
    if (!before.isFile()) throw changed(entry.path, "type");
    if (!sameFile(entry, before, platform)) throw changed(entry.path, "modified");

    let crc = 0;
    let position = 0;
    while (position < entry.size) {
      throwIfAborted(signal);
      const wanted = Math.min(buffer.byteLength, entry.size - position);
      let bytesRead: number;
      try {
        ({ bytesRead } = await source.read(buffer, 0, wanted, position));
      } catch {
        throw changed(entry.path, "modified");
      }
      if (bytesRead === 0) throw changed(entry.path, "modified");
      const chunk = buffer.subarray(0, bytesRead);
      crc = zlib.crc32(chunk, crc);
      await writer.write(chunk);
      position += bytesRead;
      onChunk(bytesRead);
    }
    // Anything past the summarized size means it grew while it was read.
    const extra = await source.read(buffer, 0, 1, position).catch(() => null);
    if (!extra || extra.bytesRead !== 0) throw changed(entry.path, "modified");
    const after = await source.stat().catch(() => null);
    if (!after || !sameFile(entry, after, platform)) throw changed(entry.path, "modified");
    return crc;
  } finally {
    await source.close().catch(() => {});
  }
}

async function removeArchive(archivePath: string): Promise<void> {
  try {
    await fs.unlink(archivePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code !== "ENOENT") throw error;
  }
}

async function archiveSource(
  archivePath: string,
  size: number,
  sha256: string
): Promise<TransferSource> {
  const handle = await fs.open(archivePath, ARCHIVE_READ_FLAGS);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size !== size) throw new Error("The folder archive has changed");
  } catch (error) {
    await handle.close().catch(() => {});
    throw error;
  }
  return {
    size,
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
    close: () => handle.close(),
  };
}

/**
 * Packs `snapshot` into a new archive in {@link folderPackDir}. Rejects with
 * {@link LocalFolderPackError}, having removed what it wrote, when the folder
 * has changed since it was summarized, when the archive can't be written, or
 * when `signal` aborts.
 */
export async function packLocalFolder(
  snapshot: Readonly<FolderSnapshot>,
  options: PackLocalFolderOptions
): Promise<PackedFolderArchive> {
  const { signal } = options;
  const platform = options.platform ?? process.platform;
  const dir = options.dir ?? folderPackDir();
  throwIfAborted(signal);

  const files = snapshot.entries.filter((entry) => entry.kind === "file");
  const totals: FolderUploadTotals = {
    fileCount: files.length,
    folderCount: snapshot.entries.length - files.length - 1,
    totalBytes: files.reduce((sum, entry) => sum + entry.size, 0),
  };
  if (snapshot.entries.length > MAX_ENTRIES) {
    throw new Error("The folder holds more entries than a zip without ZIP64");
  }
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
  const archivePath = path.join(dir, `${process.pid}-${crypto.randomBytes(16).toString("hex")}.zip`);
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
        await writer.write(localHeader(name, FOLDER_ARCHIVE_FLAG_UTF8, 0, 0));
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
      // Sizes and CRC follow the data, since the CRC is only known once it is read.
      const flags = FOLDER_ARCHIVE_FLAG_UTF8 | FLAG_DATA_DESCRIPTOR;
      await writer.write(localHeader(name, flags, 0, 0));
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
    throwIfAborted(signal);
    await writer.write(centralDirectory(records, writer.offset));
    try {
      await handle.sync();
      await handle.close();
    } catch (error) {
      throw writeFailure(error);
    } finally {
      handle = null;
    }
    const archiveBytes = writer.offset;
    const sha256 = writer.digest();
    let removed: Promise<void> | null = null;
    return {
      path: archivePath,
      archiveBytes,
      sha256,
      totals,
      openSource: () => archiveSource(archivePath, archiveBytes, sha256),
      remove: () => {
        removed ??= removeArchive(archivePath).finally(() => liveArchives.delete(archivePath));
        return removed;
      },
    };
  } catch (error) {
    await handle?.close().catch(() => {});
    await removeArchive(archivePath).catch(() => {});
    liveArchives.delete(archivePath);
    if (error instanceof LocalFolderPackError) throw error;
    throw writeFailure(error);
  }
}

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: a process by that pid exists, it just isn't ours to signal.
    return (error as NodeJS.ErrnoException | null)?.code === "EPERM";
  }
}

/**
 * Removes archives a crash left behind: those of a process that is gone,
 * this process's own that it no longer holds, and any older than a day. Only
 * names the packer makes, only in its own folder, and only when that folder
 * is a real one this user owns; everything else is left alone.
 */
export async function sweepFolderPacks(dir = folderPackDir(), now = Date.now()): Promise<number> {
  const stat = await fs.lstat(dir).catch(() => null);
  if (!stat || stat.isSymbolicLink() || !stat.isDirectory()) return 0;
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  if (uid !== null && stat.uid !== uid) return 0;
  let removed = 0;
  for (const name of await fs.readdir(dir).catch(() => [] as string[])) {
    const match = ARCHIVE_NAME.exec(name);
    if (!match) continue;
    const archivePath = path.join(dir, name);
    if (liveArchives.has(archivePath)) continue;
    const pid = Number(match[1]);
    const entry = await fs.lstat(archivePath).catch(() => null);
    if (!entry?.isFile()) continue;
    const stale =
      pid === process.pid || !isRunning(pid) || now - entry.mtimeMs > STALE_ARCHIVE_MS;
    if (!stale) continue;
    try {
      await removeArchive(archivePath);
      removed += 1;
    } catch {
      // Held open elsewhere on Windows, or already gone: the next sweep tries again.
    }
  }
  return removed;
}
