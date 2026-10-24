import fs from "fs/promises";
import type { EventEmitter } from "node:events";
import { getArtifactSourceResolver } from "../artifactSourceResolver.js";
import {
  buildDaintreeFileErrorHeaders,
  isMediaMimeType,
  streamOpenedMediaFile,
} from "./containedFile.js";

/**
 * `daintree-media://artifact/<id>?lease=<token>` (audio and video) and
 * `daintree-file://artifact/<id>?lease=<token>` (images): a plugin artifact,
 * streamed with the same Range/HEAD handling and descriptor discipline as a
 * contained file. The lease is the request's only authority — a protocol
 * request names no sender — so a missing, expired, released or mismatched one
 * is a 404, and nothing on this route ever falls through to the
 * `path`/`root` form. Each scheme keeps its narrowing: media only for
 * `daintree-media`, images only for `daintree-file`.
 */
export async function answerArtifactRequest(
  scheme: "daintree-media" | "daintree-file",
  request: GlobalRequest
): Promise<Response | null> {
  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    return null;
  }
  if (url.hostname !== "artifact") return null;
  const notFound = () =>
    new Response("Not Found", { status: 404, headers: buildDaintreeFileErrorHeaders() });
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Method Not Allowed", {
      status: 405,
      headers: buildDaintreeFileErrorHeaders(),
    });
  }
  const id = /^\/([0-9a-f]{32})\/?$/.exec(url.pathname)?.[1];
  const lease = url.searchParams.get("lease");
  if (!id || !lease || !/^[0-9a-f]{48}$/.test(lease)) return notFound();
  const resolved = getArtifactSourceResolver()?.(id, lease) ?? null;
  if (!resolved) return notFound();
  const allowed =
    scheme === "daintree-media"
      ? isMediaMimeType(resolved.mimeType)
      : resolved.mimeType.startsWith("image/") && resolved.mimeType !== "image/svg+xml";
  if (!allowed) {
    resolved.unpin();
    return notFound();
  }
  let fileHandle: Awaited<ReturnType<typeof fs.open>>;
  try {
    fileHandle = await fs.open(
      resolved.filePath,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | (fs.constants.O_NONBLOCK ?? 0)
    );
  } catch {
    resolved.unpin();
    return notFound();
  }
  // The pin lasts as long as the descriptor: the response body's end, a
  // cancelled body, or the handler closing it on HEAD and error paths.
  // A FileHandle is an EventEmitter at runtime; @types/node doesn't say so.
  (fileHandle as unknown as EventEmitter).once("close", resolved.unpin);
  try {
    return await streamOpenedMediaFile(fileHandle, resolved.mimeType, request);
  } catch (err) {
    resolved.unpin();
    console.error(`[MAIN] ${scheme} artifact error:`, err);
    return new Response("Internal Server Error", {
      status: 500,
      headers: buildDaintreeFileErrorHeaders(),
    });
  }
}
