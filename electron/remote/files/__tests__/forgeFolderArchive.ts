import zlib from "node:zlib";
import { folderArchiveMode } from "../folderUploadLinkMethods.js";

/*
 * A stored-zip writer for unpacker tests, laid out the way the packer writes
 * one, with every header field open to a lie. Defaults produce a valid folder
 * archive; each override forges one field of one record.
 */

export interface ForgedEntry {
  name: string | Buffer;
  /** File content; a folder entry (name ending in `/`) has none by default. */
  data?: string | Buffer;
  executable?: boolean;
  /** The full mode in the external attributes' upper 16 bits, type bits included. */
  mode?: number;
  madeBy?: number;
  flags?: number;
  method?: number;
  crc?: number;
  /** The central record's uncompressed size. */
  size?: number;
  /** The central record's compressed size. */
  compressedSize?: number;
  /** Fields of the local header that differ from the central record. */
  local?: Partial<{
    name: string | Buffer;
    flags: number;
    method: number;
    crc: number;
    size: number;
    compressedSize: number;
  }>;
  /** Write the sizes and CRC in a data descriptor after the data, as a streaming packer does. */
  descriptor?: boolean;
  /** Fields of the data descriptor that differ from the central record. */
  descriptorFields?: Partial<{ crc: number; size: number; compressedSize: number }>;
  extra?: Buffer;
  /** Bytes after this entry's data that no header accounts for. */
  padding?: Buffer;
  /** Point the central record at another entry's local header, by index. */
  localHeaderOf?: number;
  /** Point the central record at this absolute offset, and write no local record of its own. */
  localHeaderAt?: number;
}

export interface ForgeOptions {
  /** The end record's entry count, which may disagree with the records written. */
  entryCount?: number;
  comment?: Buffer;
  /** Bytes before the first local header. */
  prefix?: Buffer;
  /** The order the central records are written in, as indexes into the entries. */
  centralOrder?: number[];
}

const DOS_DATE_1980 = (0 << 9) | (1 << 5) | 1;
const UTF8_FLAG = 0x0800;
const DESCRIPTOR_FLAG = 0x0008;
const MADE_BY_UNIX = (3 << 8) | 20;

function bytes(value: string | Buffer): Buffer {
  return typeof value === "string" ? Buffer.from(value, "utf8") : value;
}

function isFolder(name: string | Buffer): boolean {
  return bytes(name).at(-1) === 0x2f;
}

/** One entry's local header, data and data descriptor, as the forge writes it. */
export function forgeLocalRecord(entry: ForgedEntry): Buffer {
  const data = bytes(entry.data ?? "");
  const crc = entry.crc ?? zlib.crc32(data);
  const descriptor = entry.descriptor === true;
  const flags = entry.flags ?? UTF8_FLAG | (descriptor ? DESCRIPTOR_FLAG : 0);
  const size = entry.size ?? data.length;
  const compressedSize = entry.compressedSize ?? size;
  const name = bytes(entry.local?.name ?? entry.name);
  const extra = entry.extra ?? Buffer.alloc(0);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(entry.local?.flags ?? flags, 6);
  local.writeUInt16LE(entry.local?.method ?? entry.method ?? 0, 8);
  local.writeUInt16LE(0, 10);
  local.writeUInt16LE(DOS_DATE_1980, 12);
  local.writeUInt32LE(entry.local?.crc ?? (descriptor ? 0 : crc), 14);
  local.writeUInt32LE(entry.local?.compressedSize ?? (descriptor ? 0 : compressedSize), 18);
  local.writeUInt32LE(entry.local?.size ?? (descriptor ? 0 : size), 22);
  local.writeUInt16LE(name.length, 26);
  local.writeUInt16LE(extra.length, 28);
  const parts = [local, name, extra, data];
  if (descriptor) {
    const dd = Buffer.alloc(16);
    dd.writeUInt32LE(0x08074b50, 0);
    dd.writeUInt32LE(entry.descriptorFields?.crc ?? crc, 4);
    dd.writeUInt32LE(entry.descriptorFields?.compressedSize ?? compressedSize, 8);
    dd.writeUInt32LE(entry.descriptorFields?.size ?? size, 12);
    parts.push(dd);
  }
  return Buffer.concat(parts);
}

export function forgeFolderArchive(entries: ForgedEntry[], options: ForgeOptions = {}): Buffer {
  const chunks: Buffer[] = [];
  let offset = 0;
  const push = (chunk: Buffer) => {
    chunks.push(chunk);
    offset += chunk.length;
  };
  if (options.prefix) push(options.prefix);

  const records: Array<{ entry: ForgedEntry; headerOffset: number; crc: number; data: Buffer }> =
    [];
  for (const entry of entries) {
    const data = bytes(entry.data ?? "");
    const crc = entry.crc ?? zlib.crc32(data);
    if (entry.localHeaderAt !== undefined) {
      records.push({ entry, headerOffset: entry.localHeaderAt, crc, data });
      continue;
    }
    records.push({ entry, headerOffset: offset, crc, data });
    push(forgeLocalRecord(entry));
    if (entry.padding) push(entry.padding);
  }

  const centralOffset = offset;
  const order = options.centralOrder ?? records.map((_, index) => index);
  for (const { entry, headerOffset, crc, data } of order.map((index) => records[index]!)) {
    const name = bytes(entry.name);
    const extra = entry.extra ?? Buffer.alloc(0);
    const descriptor = entry.descriptor === true;
    const size = entry.size ?? data.length;
    const mode =
      entry.mode ?? folderArchiveMode(isFolder(entry.name) ? "folder" : "file", entry.executable);
    const record = Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50, 0);
    record.writeUInt16LE(entry.madeBy ?? MADE_BY_UNIX, 4);
    record.writeUInt16LE(20, 6);
    record.writeUInt16LE(entry.flags ?? UTF8_FLAG | (descriptor ? DESCRIPTOR_FLAG : 0), 8);
    record.writeUInt16LE(entry.method ?? 0, 10);
    record.writeUInt16LE(0, 12);
    record.writeUInt16LE(DOS_DATE_1980, 14);
    record.writeUInt32LE(crc, 16);
    record.writeUInt32LE(entry.compressedSize ?? size, 20);
    record.writeUInt32LE(size, 24);
    record.writeUInt16LE(name.length, 28);
    record.writeUInt16LE(extra.length, 30);
    record.writeUInt16LE(0, 32);
    record.writeUInt16LE(0, 34);
    record.writeUInt16LE(0, 36);
    record.writeUInt32LE((mode << 16) >>> 0, 38);
    const target =
      entry.localHeaderOf === undefined ? headerOffset : records[entry.localHeaderOf]!.headerOffset;
    record.writeUInt32LE(target, 42);
    push(Buffer.concat([record, name, extra]));
  }
  const centralSize = offset - centralOffset;

  const comment = options.comment ?? Buffer.alloc(0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(options.entryCount ?? records.length, 8);
  end.writeUInt16LE(options.entryCount ?? records.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(centralOffset, 16);
  end.writeUInt16LE(comment.length, 20);
  push(Buffer.concat([end, comment]));
  return Buffer.concat(chunks);
}
