import { getMimeType } from "../../utils/appProtocol.js";
import {
  buildDaintreeFileErrorHeaders,
  isMediaMimeType,
  parseContainedFileRequest,
  resolveContainedRealPath,
  streamContainedMediaFile,
} from "./containedFile.js";
import { answerArtifactRequest } from "./artifact.js";
import { answerHostScopedRequest } from "./hostScoped.js";

/**
 * Create the daintree-media:// protocol handler — direct range-streamed
 * playback for <video>/<audio> (#12242). URL shape mirrors daintree-file://:
 * `daintree-media://load?path=…&root=…`.
 *
 * Media-only by construction: a canonical path that isn't audio or video 404s
 * rather than falling through to a buffered read, so this scheme can never
 * serve an arbitrary repo file the way daintree-file:// legitimately does. That
 * is the same narrowing daintree-pdf:// applies, and it is what makes the extra
 * `standard: true` privilege cheap — the scheme's whole reachable surface is
 * media files under a caller-supplied root.
 *
 * The streaming, containment, O_NOFOLLOW and range handling are
 * streamContainedMediaFile's, unchanged and shared with daintree-file://.
 */
export function createDaintreeMediaProtocolHandler() {
  return async (request: GlobalRequest) =>
    (await answerArtifactRequest("daintree-media", request)) ??
    (await answerHostScopedRequest("daintree-media", request)) ??
    respondToDaintreeMediaRequest(request);
}

export async function respondToDaintreeMediaRequest(request: GlobalRequest): Promise<Response> {
  try {
    const parsed = parseContainedFileRequest(request);
    if (parsed instanceof Response) return parsed;
    const { normalizedRoot, normalizedFile } = parsed;

    const contained = await resolveContainedRealPath(normalizedRoot, normalizedFile);
    if (contained instanceof Response) return contained;

    // Classified from the canonical path, not the request path: on Windows
    // O_NOFOLLOW is a no-op, so a final-component symlink (`clip.mp4` →
    // `secrets.env`) opens fine and request-path routing would stream it
    // under a media MIME. On POSIX ELOOP rejects that symlink at open, so the
    // two spellings agree either way.
    const realMimeType = getMimeType(contained.realFile);
    if (!isMediaMimeType(realMimeType)) {
      return new Response("Not Found", {
        status: 404,
        headers: buildDaintreeFileErrorHeaders(),
      });
    }

    return await streamContainedMediaFile(normalizedFile, realMimeType, request);
  } catch (err) {
    console.error("[MAIN] daintree-media protocol error:", err);
    return new Response("Internal Server Error", {
      status: 500,
      headers: buildDaintreeFileErrorHeaders(),
    });
  }
}
