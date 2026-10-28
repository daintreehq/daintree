import type fs from "fs/promises";
import { getMimeType } from "../../utils/appProtocol.js";
import {
  buildDaintreeFileErrorHeaders,
  buildDaintreeFileHeaders,
  isMediaMimeType,
  isPdfPath,
  maxBytesForFile,
  streamOpenedMediaFile,
  type DaintreeReadKind,
} from "./containedFile.js";
import type { ContainedFileScheme } from "./hostScoped.js";
import { daintreeFileRequestCore } from "./file.js";
import { respondToDaintreeMediaRequest } from "./media.js";
import { buildDaintreePdfHeaders, respondToDaintreePdfRequest } from "./pdf.js";

/**
 * Answer a contained-file request exactly as this machine's own handler would
 * for its own views: same validation, containment, caps and range handling,
 * minus the CORS grant (the caller decides who may read it). A host uses this
 * to serve an attached Shell's previews.
 */
export function serveContainedFileRequest(
  scheme: ContainedFileScheme,
  request: GlobalRequest
): Promise<Response> {
  switch (scheme) {
    case "daintree-file":
      return daintreeFileRequestCore(request);
    case "daintree-pdf":
      return respondToDaintreePdfRequest(request);
    case "daintree-media":
      return respondToDaintreeMediaRequest(request);
  }
}

/** A descriptor a host opened for {@link serveOpenedContainedFile}. */
export type OpenedContainedFile = Awaited<ReturnType<typeof fs.open>>;

// Return type inferred for the same reason as readContainedDaintreeFile's.
async function readUpTo(fileHandle: OpenedContainedFile, limit: number) {
  const chunks: Buffer[] = [];
  let total = 0;
  while (total < limit) {
    const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, limit - total));
    const { bytesRead } = await fileHandle.read(chunk, 0, chunk.byteLength, total);
    if (bytesRead === 0) break;
    chunks.push(chunk.subarray(0, bytesRead));
    total += bytesRead;
  }
  return Buffer.concat(chunks, total);
}

/**
 * A host's answer to an attached Shell's preview, served from a descriptor the
 * host opened itself beneath the admitted root, so nothing is resolved by path
 * again after admission. The scheme's gates, caps, headers and Range handling
 * are the local handlers' (minus CORS, as {@link serveContainedFileRequest}).
 *
 * Takes ownership of `fileHandle`. `admitBuffered` is asked for the file's size
 * before a buffered read and may refuse it (503), so the host can bound the
 * bytes it holds across previews before reading any of them.
 */
export async function serveOpenedContainedFile(
  scheme: ContainedFileScheme,
  fileHandle: OpenedContainedFile,
  canonicalPath: string,
  request: GlobalRequest,
  admitBuffered: (bytes: number) => boolean = () => true
): Promise<Response> {
  const refuse = async (status: number, text: string): Promise<Response> => {
    await fileHandle.close().catch(() => {});
    return new Response(text, { status, headers: buildDaintreeFileErrorHeaders() });
  };
  try {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return await refuse(405, "Method Not Allowed");
    }
    const mimeType = getMimeType(canonicalPath);
    if (scheme === "daintree-media" && !isMediaMimeType(mimeType)) {
      return await refuse(404, "Not Found");
    }
    if (scheme !== "daintree-pdf" && isMediaMimeType(mimeType)) {
      return await streamOpenedMediaFile(fileHandle, mimeType, request);
    }

    const kind: DaintreeReadKind = scheme === "daintree-pdf" ? "pdf" : "file";
    if (kind === "pdf" && !isPdfPath(canonicalPath)) {
      return await refuse(415, "Unsupported Media Type");
    }
    const stats = await fileHandle.stat();
    if (!stats.isFile()) return await refuse(404, "Not Found");
    const maxBytes = maxBytesForFile(canonicalPath, kind);
    if (stats.size > maxBytes) return await refuse(413, "Payload Too Large");
    const headersFor = (length: number) =>
      kind === "pdf"
        ? buildDaintreePdfHeaders(canonicalPath, length)
        : buildDaintreeFileHeaders(mimeType, length);

    if (request.method === "HEAD") {
      await fileHandle.close().catch(() => {});
      return new Response(null, { status: 200, headers: headersFor(stats.size) });
    }
    if (!admitBuffered(stats.size)) return await refuse(503, "Too many open previews");
    let buffer: Awaited<ReturnType<typeof readUpTo>>;
    try {
      buffer = await readUpTo(fileHandle, maxBytes + 1);
    } finally {
      await fileHandle.close().catch(() => {});
    }
    // Growth after the stat is caught on the bytes actually read, as locally.
    if (buffer.length > maxBytes) {
      return new Response("Payload Too Large", {
        status: 413,
        headers: buildDaintreeFileErrorHeaders(),
      });
    }
    return new Response(buffer, { status: 200, headers: headersFor(buffer.length) });
  } catch (err) {
    await fileHandle.close().catch(() => {});
    console.error(`[MAIN] ${scheme} host serve error:`, err);
    return new Response("Internal Server Error", {
      status: 500,
      headers: buildDaintreeFileErrorHeaders(),
    });
  }
}
