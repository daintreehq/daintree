import fs from "node:fs/promises";
import path from "node:path";
import zlib from "node:zlib";
import {
  FOLDER_UPLOAD_MAX_ARCHIVE_BYTES,
  type FolderUploadEntryKind,
  type FolderUploadProblem,
  type FolderUploadTotals,
} from "../../../shared/types/folderUpload.js";
import { checkFolderUploadRootName, FolderUploadTally } from "../../../shared/utils/folderUpload.js";
import { OWNER_RWX_DIR_MODE } from "../../utils/fs.js";
import { BULK_CHUNK_BYTES } from "../link/frames.js";
import { NEW_FILE_FLAGS } from "./exclusiveCopy.js";
import {
  FOLDER_ARCHIVE_EXECUTABLE_MODE,
  FOLDER_ARCHIVE_FILE_MODE,
  FOLDER_ARCHIVE_FLAG_DATA_DESCRIPTOR,
  FOLDER_ARCHIVE_FLAG_UTF8,
  FOLDER_ARCHIVE_METHOD_STORED,
  readFolderArchiveMode,
  type FolderUploadFailureReason,
} from "./folderUploadLinkMethods.js";

/*
 * Turns a received folder archive (#16248) into the folder it holds, inside a
 * staging folder the inbox made for it (#16249), trusting nothing the archive
 * says. Every record is read and checked before anything is written: the
 * end record, each central record and the local header and data descriptor
 * it points at must agree, the entries must tile the archive from its first
 * byte to the central directory with nothing between them, and the names,
 * modes and counts must pass the same content rules the Shell checked. Only
 * then are the folders made and the files copied, each created exclusively
 * without following links, with every byte counted and its CRC-32 checked as
 * it is written.
 *
 * A refusal or a cancel removes everything this call created, so the staging
 * folder is left as empty as it was given. Node has no descriptor-relative
 * `mkdirat`/`openat`, so each folder a create lands in is first re-checked to
 * be the one this call made: a folder swapped for a link mid-unpack stops it,
 * but a process already running as this user and racing inside staging still
 * has a window between the check and the create.
 */

export const FOLDER_ARCHIVE_RULES = [
  /** One of the content rules both sides check; `problem` says which. */
  "content",
  /** Not a single-disk zip without ZIP64 whose end record and central directory agree. */
  "format",
  /** Bytes no entry accounts for, entries that overlap, or data where it can't be. */
  "layout",
  /** A name that isn't UTF-8, or isn't flagged as UTF-8 while not plain ASCII. */
  "name-encoding",
  /** Encryption, or any flag beyond UTF-8 names and a data descriptor. */
  "flags",
  /** A compressed entry: every entry is stored. */
  "method",
  "link",
  /** A device, FIFO, socket or anything else that is neither a file nor a folder. */
  "special-file",
  /** Not made by Unix, or a file or folder mode the packer never writes. */
  "mode",
  /** Stored sizes that differ, or a folder with data. */
  "size",
  /** A local header or data descriptor that disagrees with its central record. */
  "header-mismatch",
  /** Content that doesn't match its CRC-32. */
  "crc",
  /** A folder that holds entries but has no entry of its own, the root included. */
  "missing-folder",
  /** More or fewer files, folders or bytes than the upload declared. */
  "declared",
] as const;
export type FolderArchiveRule = (typeof FOLDER_ARCHIVE_RULES)[number];

export interface FolderArchiveRefusal {
  reason: Extract<FolderUploadFailureReason, "over-limits" | "name-clash" | "unsafe-archive">;
  rule: FolderArchiveRule;
  /** The entry's name as the archive spells it; absent when the archive as a whole is at fault. */
  entry?: string;
  /** Set for a `content` refusal, as the failed status carries it. */
  problem?: FolderUploadProblem;
}

export type FolderArchiveUnpackResult =
  | { ok: true; totals: FolderUploadTotals }
  | ({ ok: false } & FolderArchiveRefusal);

export interface UnpackFolderArchiveOptions {
  /** The received archive, already verified against its digest and never written again. */
  archivePath: string;
  /** An existing, empty, owner-only folder: the archive's root folder becomes it. */
  stagingDir: string;
  /** The dropped folder's name, the first component of every entry. */
  rootName: string;
  /** What the upload was prepared with; the archive must hold exactly this. */
  declared: FolderUploadTotals;
  /** Aborting stops the unpack, removes what it wrote, and rejects with the signal's reason. */
  signal?: AbortSignal;
  /** Called after each file is complete; a throw from it fails the unpack. */
  onProgress?: (progress: { filesDone: number; filesTotal: number }) => void;
}

const LOCAL_SIGNATURE = 0x04034b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const END_SIGNATURE = 0x06054b50;
const DESCRIPTOR_SIGNATURE = 0x08074b50;
const LOCAL_HEADER_BYTES = 30;
const CENTRAL_HEADER_BYTES = 46;
const END_RECORD_BYTES = 22;
const DESCRIPTOR_BYTES = 16;
const MAX_COMMENT_BYTES = 0xffff;
const MADE_BY_UNIX = 3;
const ALLOWED_FLAGS = FOLDER_ARCHIVE_FLAG_UTF8 | FOLDER_ARCHIVE_FLAG_DATA_DESCRIPTOR;
const S_IFMT = 0o170000;
const S_IFREG = 0o100000;
const S_IFDIR = 0o040000;
const S_IFLNK = 0o120000;

type ArchiveHandle = Awaited<ReturnType<typeof fs.open>>;

/** What pass one keeps of an entry: enough to write it, and nothing it didn't check. */
interface PlannedEntry {
  path: string;
  kind: FolderUploadEntryKind;
  executable: boolean;
  crc: number;
  size: number;
  headerOffset: number;
  dataStart: number;
  /** Just past its data, and past its data descriptor when it has one. */
  end: number;
}

/** Unwinds a refusal to the one place that rolls back and turns it into a result. */
class Refused extends Error {
  constructor(readonly refusal: FolderArchiveRefusal) {
    super(`The folder archive broke the ${refusal.rule} rule`);
    this.name = "FolderArchiveRefused";
  }
}

function refuse(rule: Exclude<FolderArchiveRule, "content">, entry?: string): Refused {
  return new Refused(entry === undefined ? { reason: "unsafe-archive", rule } : { reason: "unsafe-archive", rule, entry });
}

function refuseContent(problem: FolderUploadProblem, entry?: string): Refused {
  const reason =
    problem.kind === "limit" ? "over-limits" : problem.kind === "clash" ? "name-clash" : "unsafe-archive";
  return new Refused(
    entry === undefined ? { reason, rule: "content", problem } : { reason, rule: "content", entry, problem }
  );
}

function assertCount(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`The declared ${name} must be a whole, non-negative number`);
  }
}

async function readExactly(
  archive: ArchiveHandle,
  length: number,
  position: number
): Promise<Buffer | null> {
  const buffer = Buffer.alloc(length);
  let filled = 0;
  while (filled < length) {
    const { bytesRead } = await archive.read(buffer, filled, length - filled, position + filled);
    if (bytesRead === 0) return null;
    filled += bytesRead;
  }
  return buffer;
}

/** The end record's offset and fields, found the one way a comment allows. */
async function readEndRecord(
  archive: ArchiveHandle,
  size: number
): Promise<{ offset: number; entries: number; centralSize: number; centralOffset: number }> {
  const tailLength = Math.min(size, END_RECORD_BYTES + MAX_COMMENT_BYTES);
  const tail = await readExactly(archive, tailLength, size - tailLength);
  if (!tail) throw refuse("format");
  for (let at = tailLength - END_RECORD_BYTES; at >= 0; at--) {
    if (tail.readUInt32LE(at) !== END_SIGNATURE) continue;
    // A signature inside the comment isn't the record unless the comment it
    // declares runs exactly to the end of the archive.
    if (at + END_RECORD_BYTES + tail.readUInt16LE(at + 20) !== tailLength) continue;
    const disk = tail.readUInt16LE(at + 4);
    const centralDisk = tail.readUInt16LE(at + 6);
    const diskEntries = tail.readUInt16LE(at + 8);
    const entries = tail.readUInt16LE(at + 10);
    const centralSize = tail.readUInt32LE(at + 12);
    const centralOffset = tail.readUInt32LE(at + 16);
    const offset = size - tailLength + at;
    // ZIP64 marks its end record with these sentinels and puts its own
    // records between the central directory and this one, so the exact
    // adjacency below refuses it whichever way it is spelled.
    if (
      disk !== 0 ||
      centralDisk !== 0 ||
      diskEntries !== entries ||
      entries === 0xffff ||
      centralSize === 0xffffffff ||
      centralOffset === 0xffffffff ||
      centralOffset + centralSize !== offset
    ) {
      throw refuse("format");
    }
    return { offset, entries, centralSize, centralOffset };
  }
  throw refuse("format");
}

const strictUtf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const lenientUtf8 = new TextDecoder("utf-8", { ignoreBOM: true });

function decodeName(raw: Buffer, flags: number): string {
  const ascii = raw.every((byte) => byte < 0x80);
  // An unflagged name is CP437 by the spec; plain ASCII reads the same either way.
  if (!ascii && (flags & FOLDER_ARCHIVE_FLAG_UTF8) === 0) {
    throw refuse("name-encoding", lenientUtf8.decode(raw));
  }
  try {
    return strictUtf8.decode(raw);
  } catch {
    throw refuse("name-encoding", lenientUtf8.decode(raw));
  }
}

function entryKind(madeBy: number, externalAttributes: number, name: string) {
  if (madeBy >> 8 !== MADE_BY_UNIX) throw refuse("mode", name);
  const mode = externalAttributes >>> 16;
  const type = mode & S_IFMT;
  if (type === S_IFLNK) throw refuse("link", name);
  if (type !== S_IFREG && type !== S_IFDIR) throw refuse("special-file", name);
  const kind: FolderUploadEntryKind = type === S_IFDIR ? "folder" : "file";
  const read = readFolderArchiveMode(kind, mode);
  if (!read) throw refuse("mode", name);
  return { kind, executable: read.executable };
}

function parentOf(entryPath: string): string | null {
  const trimmed = entryPath.endsWith("/") ? entryPath.slice(0, -1) : entryPath;
  const slash = trimmed.lastIndexOf("/");
  return slash === -1 ? null : trimmed.slice(0, slash);
}

/**
 * Pass one: every record checked, nothing written. Returns the entries in
 * the order they sit in the archive.
 */
async function planArchive(
  archive: ArchiveHandle,
  archiveSize: number,
  rootName: string,
  declared: FolderUploadTotals,
  signal: AbortSignal | undefined
): Promise<PlannedEntry[]> {
  const end = await readEndRecord(archive, archiveSize);
  const tally = new FolderUploadTally(rootName);
  const planned: PlannedEntry[] = [];
  const folders = new Set<string>();
  let cursor = end.centralOffset;
  while (cursor < end.offset) {
    signal?.throwIfAborted();
    if (end.offset - cursor < CENTRAL_HEADER_BYTES) throw refuse("format");
    const header = await readExactly(archive, CENTRAL_HEADER_BYTES, cursor);
    if (!header || header.readUInt32LE(0) !== CENTRAL_SIGNATURE) throw refuse("format");
    const madeBy = header.readUInt16LE(4);
    const flags = header.readUInt16LE(8);
    const method = header.readUInt16LE(10);
    const crc = header.readUInt32LE(16);
    const compressedSize = header.readUInt32LE(20);
    const size = header.readUInt32LE(24);
    const nameLength = header.readUInt16LE(28);
    const variableLength = nameLength + header.readUInt16LE(30) + header.readUInt16LE(32);
    const startDisk = header.readUInt16LE(34);
    const externalAttributes = header.readUInt32LE(38);
    const headerOffset = header.readUInt32LE(42);
    if (end.offset - cursor - CENTRAL_HEADER_BYTES < variableLength || startDisk !== 0) {
      throw refuse("format");
    }
    const rawName = await readExactly(archive, nameLength, cursor + CENTRAL_HEADER_BYTES);
    if (!rawName) throw refuse("format");
    cursor += CENTRAL_HEADER_BYTES + variableLength;

    const name = decodeName(rawName, flags);
    if ((flags & ~ALLOWED_FLAGS) !== 0) throw refuse("flags", name);
    if (method !== FOLDER_ARCHIVE_METHOD_STORED) throw refuse("method", name);
    const { kind, executable } = entryKind(madeBy, externalAttributes, name);
    // A size of 0xffffffff is ZIP64's sentinel; the limits keep every real
    // entry far below it, so it is refused as the lie it would be here.
    if (compressedSize !== size || size === 0xffffffff || (kind === "folder" && size !== 0)) {
      throw refuse("size", name);
    }

    const problem = tally.add({ path: name, kind, bytes: size });
    if (problem) throw refuseContent(problem, name);
    const totals = tally.totals;
    if (
      totals.fileCount > declared.fileCount ||
      totals.folderCount > declared.folderCount ||
      totals.totalBytes > declared.totalBytes
    ) {
      throw refuse("declared", name);
    }
    if (kind === "folder") folders.add(name.slice(0, -1));

    const descriptor = (flags & FOLDER_ARCHIVE_FLAG_DATA_DESCRIPTOR) !== 0;
    const local = await readLocalRecord(archive, end.centralOffset, {
      name,
      rawName,
      flags,
      crc,
      size,
      headerOffset,
      descriptor,
    });
    planned.push({ path: name, kind, executable, crc, size, headerOffset, ...local });
  }
  if (planned.length !== end.entries) throw refuse("format");
  if (!folders.has(rootName)) throw refuse("missing-folder", `${rootName}/`);
  for (const entry of planned) {
    const parent = parentOf(entry.path);
    if (parent !== null && !folders.has(parent)) throw refuse("missing-folder", entry.path);
  }

  // The entries must tile the archive in the order they sit in it: from its
  // first byte to the central directory, each starting where the last ended.
  // Data a header understates leaves bytes nothing accounts for, and two
  // records sharing data overlap, so either way the tiling breaks.
  const byOffset = [...planned].sort((a, b) => a.headerOffset - b.headerOffset);
  let expected = 0;
  let previous: PlannedEntry | undefined;
  for (const entry of byOffset) {
    if (entry.headerOffset !== expected) throw refuse("layout", (previous ?? entry).path);
    expected = entry.end;
    previous = entry;
  }
  if (expected !== end.centralOffset) throw refuse("layout", previous?.path);

  const totals = tally.totals;
  if (
    totals.fileCount !== declared.fileCount ||
    totals.folderCount !== declared.folderCount ||
    totals.totalBytes !== declared.totalBytes
  ) {
    throw refuse("declared");
  }
  return byOffset;
}

/** The local header (and data descriptor) a central record points at, held to agree with it. */
async function readLocalRecord(
  archive: ArchiveHandle,
  centralOffset: number,
  record: {
    name: string;
    rawName: Buffer;
    flags: number;
    crc: number;
    size: number;
    headerOffset: number;
    descriptor: boolean;
  }
): Promise<{ dataStart: number; end: number }> {
  const { name, rawName, flags, crc, size, headerOffset, descriptor } = record;
  if (headerOffset + LOCAL_HEADER_BYTES + rawName.length > centralOffset) {
    throw refuse("layout", name);
  }
  const header = await readExactly(archive, LOCAL_HEADER_BYTES + rawName.length, headerOffset);
  if (!header || header.readUInt32LE(0) !== LOCAL_SIGNATURE) throw refuse("layout", name);
  const localCrc = header.readUInt32LE(14);
  const localCompressed = header.readUInt32LE(18);
  const localSize = header.readUInt32LE(22);
  // A streaming packer writes zeros here and the real values after the data.
  const sizesAgree = descriptor
    ? (localCrc === 0 && localCompressed === 0 && localSize === 0) ||
      (localCrc === crc && localCompressed === size && localSize === size)
    : localCrc === crc && localCompressed === size && localSize === size;
  if (
    header.readUInt16LE(6) !== flags ||
    header.readUInt16LE(8) !== FOLDER_ARCHIVE_METHOD_STORED ||
    header.readUInt16LE(26) !== rawName.length ||
    !header.subarray(LOCAL_HEADER_BYTES).equals(rawName) ||
    !sizesAgree
  ) {
    throw refuse("header-mismatch", name);
  }
  const dataStart = headerOffset + LOCAL_HEADER_BYTES + rawName.length + header.readUInt16LE(28);
  const dataEnd = dataStart + size;
  const end = descriptor ? dataEnd + DESCRIPTOR_BYTES : dataEnd;
  if (end > centralOffset) throw refuse("layout", name);
  if (descriptor) {
    const dd = await readExactly(archive, DESCRIPTOR_BYTES, dataEnd);
    if (
      !dd ||
      dd.readUInt32LE(0) !== DESCRIPTOR_SIGNATURE ||
      dd.readUInt32LE(4) !== crc ||
      dd.readUInt32LE(8) !== size ||
      dd.readUInt32LE(12) !== size
    ) {
      throw refuse("header-mismatch", name);
    }
  }
  return { dataStart, end };
}

function identityOf(stat: { dev: number; ino: number }): string {
  return `${stat.dev}:${stat.ino}`;
}

interface Created {
  absPath: string;
  identity: string;
  isDir: boolean;
}

/** chmod through a descriptor, so a link swapped in after the mkdir is never followed. */
async function restoreFolderMode(absPath: string, identity: string): Promise<void> {
  const handle = await fs.open(
    absPath,
    fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW
  );
  try {
    if (identityOf(await handle.stat()) !== identity) {
      throw new Error("The staging folder changed while the archive was being unpacked");
    }
    await handle.chmod(OWNER_RWX_DIR_MODE);
  } finally {
    await handle.close();
  }
}

/**
 * Pass two: the folders, parents first, then the files in archive order. Each
 * create is journaled the moment it succeeds, before anything else can throw.
 */
async function writeTree(
  archive: ArchiveHandle,
  entries: PlannedEntry[],
  options: UnpackFolderArchiveOptions,
  stagingIdentity: string,
  created: Created[]
): Promise<void> {
  const { stagingDir, rootName, declared, signal, onProgress } = options;
  const folderIdentities = new Map<string, string>([[rootName, stagingIdentity]]);
  const absolute = (entryPath: string) => {
    const components = (entryPath.endsWith("/") ? entryPath.slice(0, -1) : entryPath).split("/");
    return path.join(stagingDir, ...components.slice(1));
  };
  const assertParentUnchanged = async (entryPath: string): Promise<void> => {
    const parent = parentOf(entryPath)!;
    const stat = await fs.lstat(absolute(`${parent}/`));
    if (!stat.isDirectory() || identityOf(stat) !== folderIdentities.get(parent)) {
      throw new Error("The staging folder changed while the archive was being unpacked");
    }
  };

  // A parent is a prefix of its children's paths, so it sorts before them.
  const folders = entries
    .filter((entry) => entry.kind === "folder" && entry.path !== `${rootName}/`)
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  for (const folder of folders) {
    signal?.throwIfAborted();
    await assertParentUnchanged(folder.path);
    const absPath = absolute(folder.path);
    await fs.mkdir(absPath, { mode: OWNER_RWX_DIR_MODE });
    const stat = await fs.lstat(absPath);
    if (!stat.isDirectory()) {
      throw new Error("The staging folder changed while the archive was being unpacked");
    }
    const identity = identityOf(stat);
    created.push({ absPath, identity, isDir: true });
    folderIdentities.set(folder.path.slice(0, -1), identity);
    // The umask can only take bits away from mkdir's mode; put back any it took.
    if ((stat.mode & 0o777) !== OWNER_RWX_DIR_MODE) await restoreFolderMode(absPath, identity);
  }

  const buffer = Buffer.allocUnsafe(BULK_CHUNK_BYTES);
  let filesDone = 0;
  let bytesWritten = 0;
  for (const file of entries) {
    if (file.kind !== "file") continue;
    signal?.throwIfAborted();
    await assertParentUnchanged(file.path);
    const absPath = absolute(file.path);
    const mode = file.executable ? FOLDER_ARCHIVE_EXECUTABLE_MODE : FOLDER_ARCHIVE_FILE_MODE;
    const out = await fs.open(absPath, NEW_FILE_FLAGS, mode);
    try {
      const stat = await out.stat();
      created.push({ absPath, identity: identityOf(stat), isDir: false });
      if ((stat.mode & 0o777) !== mode) await out.chmod(mode);
      let crc = 0;
      let copied = 0;
      while (copied < file.size) {
        signal?.throwIfAborted();
        const want = Math.min(buffer.byteLength, file.size - copied);
        const { bytesRead } = await archive.read(buffer, 0, want, file.dataStart + copied);
        // Pass one bounded every entry inside the archive, so it can only end
        // early if it was changed underneath this call.
        if (bytesRead === 0) throw refuse("layout", file.path);
        // Held to what the upload declared on what is actually written, not
        // only on what the headers said in pass one.
        if (bytesWritten + bytesRead > declared.totalBytes) throw refuse("declared", file.path);
        crc = zlib.crc32(buffer.subarray(0, bytesRead), crc);
        for (let offset = 0; offset < bytesRead; ) {
          const { bytesWritten: wrote } = await out.write(
            buffer,
            offset,
            bytesRead - offset,
            copied + offset
          );
          if (wrote <= 0) throw new Error("The file could not be written");
          offset += wrote;
        }
        copied += bytesRead;
        bytesWritten += bytesRead;
      }
      if (crc !== file.crc) throw refuse("crc", file.path);
    } finally {
      await out.close();
    }
    filesDone++;
    onProgress?.({ filesDone, filesTotal: declared.fileCount });
  }
}

/** Remove what this call created, newest first, leaving anything put in its place alone. */
async function rollBack(created: Created[]): Promise<boolean> {
  let clean = true;
  for (const entry of [...created].reverse()) {
    try {
      const stat = await fs.lstat(entry.absPath).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
      if (!stat) continue;
      if (stat.isSymbolicLink() || identityOf(stat) !== entry.identity) {
        clean = false;
        continue;
      }
      await (entry.isDir ? fs.rmdir(entry.absPath) : fs.unlink(entry.absPath));
    } catch {
      clean = false;
    }
  }
  return clean;
}

/**
 * Unpack `archivePath` into `stagingDir`. Resolves with the totals written,
 * or with a refusal naming the rule the archive broke and, where one entry
 * broke it, that entry; nothing is left in staging after a refusal. Rejects
 * on a cancel (with the signal's reason) or a disk failure, also after
 * removing what it wrote, and rejects too when that removal couldn't finish.
 */
export async function unpackFolderArchive(
  options: UnpackFolderArchiveOptions
): Promise<FolderArchiveUnpackResult> {
  const { archivePath, stagingDir, rootName, declared, signal } = options;
  assertCount(declared.fileCount, "file count");
  assertCount(declared.folderCount, "folder count");
  assertCount(declared.totalBytes, "byte count");
  signal?.throwIfAborted();

  const staging = await fs.lstat(stagingDir);
  if (!staging.isDirectory() || (await fs.readdir(stagingDir)).length > 0) {
    throw new Error("The staging folder must be an empty folder");
  }

  const created: Created[] = [];
  let archive: ArchiveHandle | undefined;
  try {
    const rootProblem = checkFolderUploadRootName(rootName);
    if (rootProblem) throw refuseContent(rootProblem);
    archive = await fs.open(
      archivePath,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK
    );
    const stat = await archive.stat();
    if (!stat.isFile()) throw new Error("The folder archive is not a regular file");
    if (stat.size > FOLDER_UPLOAD_MAX_ARCHIVE_BYTES) {
      throw refuseContent({
        kind: "limit",
        limit: "archive-bytes",
        maximum: FOLDER_UPLOAD_MAX_ARCHIVE_BYTES,
        actual: stat.size,
        paths: [],
      });
    }
    const entries = await planArchive(archive, stat.size, rootName, declared, signal);
    await writeTree(archive, entries, options, identityOf(staging), created);
    signal?.throwIfAborted();
    return { ok: true, totals: { ...declared } };
  } catch (error) {
    await archive?.close().catch(() => {});
    archive = undefined;
    if (!(await rollBack(created))) {
      throw new Error("The unpack stopped and couldn't remove everything it wrote to staging", {
        cause: error,
      });
    }
    if (error instanceof Refused) return { ok: false, ...error.refusal };
    throw error;
  } finally {
    await archive?.close().catch(() => {});
  }
}
