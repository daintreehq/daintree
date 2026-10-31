import { getMimeType } from "../../utils/appProtocol.js";
import {
  buildDaintreeFileErrorHeaders,
  buildDaintreeFileHeaders,
  isMediaMimeType,
  parseContainedFileRequest,
  readContainedDaintreeFile,
  resolveContainedRealPath,
  statContainedDaintreeFile,
  streamContainedMediaFile,
} from "./containedFile.js";
import { PATH_CANONICAL_HEADER } from "../../../shared/types/ipc/files.js";
import { grantAppCors, trustedAppCorsOrigin } from "./appCors.js";
import { answerArtifactRequest } from "./artifact.js";
import { answerHostScopedRequest } from "./hostScoped.js";

/**
 * Create the daintree-file:// protocol handler function.
 */
export function createDaintreeFileProtocolHandler() {
  return async (request: GlobalRequest) => {
    const response =
      (await answerArtifactRequest("daintree-file", request)) ??
      (await answerHostScopedRequest("daintree-file", request)) ??
      (await daintreeFileRequestCore(request));
    // Constructed Responses have mutable headers, so the CORS grant rides on
    // every path (success and error alike) — a blocked error response would
    // otherwise surface as an opaque TypeError instead of a readable status.
    const corsOrigin = trustedAppCorsOrigin(request);
    if (corsOrigin) grantAppCors(response, corsOrigin);
    return response;
  };
}

/** The daintree-file:// request core, minus the CORS header pass. */
function createDaintreeFileRequestCore() {
  return async (request: GlobalRequest) => {
    try {
      const parsed = parseContainedFileRequest(request);
      if (parsed instanceof Response) return parsed;
      const { normalizedRoot, normalizedFile } = parsed;

      // Audio and video take the streaming path instead of the buffer-and-cap
      // core. Classification must come from the canonical path, not the request
      // path: on Windows O_NOFOLLOW is a no-op, so a final-component symlink
      // (`clip.mp4` → `notes.txt`) opens fine, and request-path routing would
      // stream a non-media file uncapped under a media MIME. On POSIX ELOOP
      // rejects that symlink at open, so the two spellings agree either way.
      if (isMediaMimeType(getMimeType(normalizedFile))) {
        const contained = await resolveContainedRealPath(normalizedRoot, normalizedFile);
        if (contained instanceof Response) return contained;
        const realMimeType = getMimeType(contained.realFile);
        if (isMediaMimeType(realMimeType)) {
          return await streamContainedMediaFile(normalizedFile, realMimeType, request);
        }
        // A media-suffixed alias of a non-media file — fall through to the
        // buffered path, which redoes containment and applies its usual caps.
      }

      // HEAD is a Markdown image's canonical-path probe, sent after each of
      // its refreshes, so it answers from a stat instead of reading the bytes
      // only to discard them.
      if (request.method === "HEAD") {
        const stat = await statContainedDaintreeFile(normalizedRoot, normalizedFile, "file");
        if (stat instanceof Response) return stat;
        return new Response(null, {
          status: 200,
          headers: {
            ...buildDaintreeFileHeaders(getMimeType(stat.realFile), stat.size),
            [PATH_CANONICAL_HEADER]: String(stat.pathIsCanonical),
          },
        });
      }

      const result = await readContainedDaintreeFile(normalizedRoot, normalizedFile, "file");
      if (result instanceof Response) return result;

      // Content-Length reflects the bytes actually returned. If the file
      // changed size between stat() and the read, buffer.length is the truth.
      return new Response(result.buffer, {
        status: 200,
        headers: buildDaintreeFileHeaders(getMimeType(result.realFile), result.buffer.length),
      });
    } catch (err) {
      console.error("[MAIN] daintree-file protocol error:", err);
      return new Response("Internal Server Error", {
        status: 500,
        headers: buildDaintreeFileErrorHeaders(),
      });
    }
  };
}

export const daintreeFileRequestCore = createDaintreeFileRequestCore();
