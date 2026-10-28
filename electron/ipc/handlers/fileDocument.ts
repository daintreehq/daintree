import path from "path";
import fs from "fs/promises";
import { createHash } from "node:crypto";
import { z } from "zod";
import { defineIpcNamespace, opValidated } from "../define.js";
import { checkRateLimit } from "../utils.js";
import type { IpcContext } from "../types.js";
import { remoteCallerHoldsRoot } from "./files.js";
import { FILE_DOCUMENT_METHOD_CHANNELS } from "./fileDocument.preload.js";
import { readBoundedFromHandle } from "../../utils/boundedRead.js";
import { resilientAtomicWriteFile } from "../../utils/fs.js";
import { runExclusive } from "../../utils/keyedMutex.js";
import type {
  FileDocumentReadPayload,
  FileDocumentReadResult,
  FileDocumentSavePayload,
  FileDocumentSaveResult,
} from "../../../shared/types/ipc/fileDocument.js";
import { FILE_EDITOR_MAX_BYTES_CEILING } from "../../schemas/plugin.js";
import { formatErrorMessage } from "../../../shared/utils/errorMessage.js";

const readPayloadSchema = z.object({
  rootPath: z.string().min(1),
  filePath: z.string().min(1),
  maxBytes: z.number().int().positive().max(FILE_EDITOR_MAX_BYTES_CEILING),
});

const savePayloadSchema = readPayloadSchema.extend({
  // Bounded by `maxBytes` once encoded, below; this only caps the wire.
  text: z.string().max(FILE_EDITOR_MAX_BYTES_CEILING),
  expectedRevision: z.string().regex(/^[0-9a-f]{64}$/),
});

const BOM = Buffer.from([0xef, 0xbb, 0xbf]);
const strictUtf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function hasBom(bytes: Uint8Array): boolean {
  return bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
}

/** Dominant line ending of the file as it stands; ties and no endings fall to `\n`. */
function dominantEol(raw: string): "\n" | "\r\n" {
  let crlf = 0;
  let lf = 0;
  for (let i = 0; i < raw.length; i++) {
    if (raw.charCodeAt(i) !== 10) continue;
    if (i > 0 && raw.charCodeAt(i - 1) === 13) crlf++;
    else lf++;
  }
  return crlf > lf ? "\r\n" : "\n";
}

/**
 * The real path of `filePath`, or null when it is missing or resolves outside
 * `rootPath`. The same realpath containment `files:read` applies, so an
 * editor can reach exactly what the file panel can show.
 */
async function resolveContained(rootPath: string, filePath: string): Promise<string | null> {
  if (!path.isAbsolute(rootPath) || !path.isAbsolute(filePath)) return null;
  let realRoot: string;
  let realFile: string;
  try {
    realRoot = await fs.realpath(rootPath);
    realFile = await fs.realpath(filePath);
  } catch {
    return null;
  }
  const contained =
    realRoot === path.sep
      ? realFile.startsWith(path.sep)
      : realFile === realRoot || realFile.startsWith(realRoot + path.sep);
  return contained ? realFile : null;
}

type BoundedRead = { ok: true; bytes: Buffer; mode: number } | { ok: false; tooLarge: boolean };

/**
 * Read a regular file without following a link swapped in after the realpath
 * check: `O_NOFOLLOW` on the leaf where the platform has it, and everywhere a
 * check that the opened descriptor is the very file the path named.
 */
async function readBounded(realFile: string, maxBytes: number): Promise<BoundedRead> {
  let pathStat: Awaited<ReturnType<typeof fs.stat>>;
  try {
    pathStat = await fs.stat(realFile);
  } catch {
    return { ok: false, tooLarge: false };
  }
  let handle: Awaited<ReturnType<typeof fs.open>>;
  try {
    handle = await fs.open(
      realFile,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | (fs.constants.O_NONBLOCK ?? 0)
    );
  } catch {
    return { ok: false, tooLarge: false };
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) return { ok: false, tooLarge: false };
    if (String(stat.ino) !== String(pathStat.ino) || String(stat.dev) !== String(pathStat.dev)) {
      return { ok: false, tooLarge: false };
    }
    const bytes = await readBoundedFromHandle(handle, stat.size, maxBytes);
    if (bytes === null) return { ok: false, tooLarge: true };
    return { ok: true, bytes, mode: stat.mode & 0o777 };
  } catch {
    return { ok: false, tooLarge: false };
  } finally {
    await handle.close().catch(() => {});
  }
}

async function requireHeldRoot(ctx: IpcContext, rootPath: string): Promise<boolean> {
  return remoteCallerHoldsRoot(ctx, rootPath);
}

export async function readFileDocument(
  ctx: IpcContext,
  { rootPath, filePath, maxBytes }: FileDocumentReadPayload
): Promise<FileDocumentReadResult> {
  if (!(await requireHeldRoot(ctx, rootPath))) return { status: "unavailable" };
  const realFile = await resolveContained(rootPath, filePath);
  if (realFile === null) return { status: "unavailable" };
  const read = await readBounded(realFile, maxBytes);
  if (!read.ok) return read.tooLarge ? { status: "too-large" } : { status: "unavailable" };
  const body = hasBom(read.bytes) ? read.bytes.subarray(3) : read.bytes;
  let raw: string;
  try {
    raw = strictUtf8.decode(body);
  } catch {
    return { status: "not-text" };
  }
  return { status: "ok", text: raw.replace(/\r\n/g, "\n"), revision: sha256Hex(read.bytes) };
}

/**
 * Compare-and-replace: the write lands only if the file's bytes still hash to
 * `expectedRevision`, checked under the realpath-keyed writer lock the plugin
 * host's `fs.writeFile` and the file-mutation handlers share, so no other
 * host-mediated writer can interleave between the compare and the replace.
 * The file keeps its BOM, dominant line ending and mode.
 */
export async function saveFileDocument(
  ctx: IpcContext,
  { rootPath, filePath, maxBytes, text, expectedRevision }: FileDocumentSavePayload
): Promise<FileDocumentSaveResult> {
  if (!(await requireHeldRoot(ctx, rootPath))) {
    return { status: "refused", reason: "unavailable" };
  }
  const realFile = await resolveContained(rootPath, filePath);
  if (realFile === null) return { status: "conflict", revision: null };
  return runExclusive(realFile, async (): Promise<FileDocumentSaveResult> => {
    // Re-resolved under the lock: a directory swapped for a link while this
    // save waited must not carry the write outside the root, or under a lock
    // key that no longer names the file.
    if ((await resolveContained(rootPath, filePath)) !== realFile) {
      return { status: "conflict", revision: null };
    }
    const current = await readBounded(realFile, FILE_EDITOR_MAX_BYTES_CEILING);
    if (!current.ok) {
      return current.tooLarge
        ? { status: "refused", reason: "too-large" }
        : { status: "conflict", revision: null };
    }
    const currentRevision = sha256Hex(current.bytes);
    if (currentRevision !== expectedRevision) {
      return { status: "conflict", revision: currentRevision };
    }
    const bom = hasBom(current.bytes);
    const eol = dominantEol(current.bytes.toString("utf-8"));
    const body = eol === "\n" ? text : text.replace(/\n/g, eol);
    const bytes = bom ? Buffer.concat([BOM, Buffer.from(body, "utf-8")]) : Buffer.from(body);
    if (bytes.byteLength > maxBytes) return { status: "refused", reason: "too-large" };
    try {
      await resilientAtomicWriteFile(realFile, bytes, "utf-8", { mode: current.mode });
    } catch (error) {
      return { status: "error", message: formatErrorMessage(error, "Save failed") };
    }
    return { status: "saved", revision: sha256Hex(bytes) };
  });
}

export function registerFileDocumentHandlers(): () => void {
  const namespace = defineIpcNamespace({
    name: "fileDocument",
    ops: {
      read: opValidated(
        FILE_DOCUMENT_METHOD_CHANNELS.read,
        readPayloadSchema,
        async (ctx, payload): Promise<FileDocumentReadResult> => {
          checkRateLimit(FILE_DOCUMENT_METHOD_CHANNELS.read, 60, 10_000);
          return readFileDocument(ctx, payload);
        },
        { withContext: true }
      ),
      save: opValidated(
        FILE_DOCUMENT_METHOD_CHANNELS.save,
        savePayloadSchema,
        async (ctx, payload): Promise<FileDocumentSaveResult> => {
          checkRateLimit(FILE_DOCUMENT_METHOD_CHANNELS.save, 30, 10_000);
          return saveFileDocument(ctx, payload);
        },
        { withContext: true }
      ),
    },
  });
  return namespace.register();
}
