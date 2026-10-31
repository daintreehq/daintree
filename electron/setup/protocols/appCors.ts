import { app } from "electron";
import { getDevServerOrigins } from "../../../shared/config/devServer.js";
import { PATH_CANONICAL_HEADER, PREVIEW_REFUSAL_HEADER } from "../../../shared/types/ipc/files.js";

/**
 * The origin allowed to read this response via cross-origin fetch(), or null
 * for everyone else. Shared by the two corsEnabled schemes that need it:
 * daintree-file:// (the file viewer fetches media bytes for blob-URL playback)
 * and plugin:// (the renderer reads a view module's text to compile its
 * Tailwind classes, #12220).
 *
 * Eligibility alone must not grant reads: a browser panel hosting an arbitrary
 * remote site shares the scheme registration, and echoing its origin here would
 * hand it the user's local files. Only the trusted app document qualifies —
 * app:// in production, the Vite dev-server origins in development. Tag loads
 * (<img>, <video>) and ESM imports are no-cors and never consult this.
 */
export function trustedAppCorsOrigin(request: GlobalRequest): string | null {
  const origin = request.headers.get("origin");
  if (!origin) return null;
  if (origin === "app://daintree") return origin;
  // The dev-server allowance additionally requires an unpackaged build so a
  // packaged app launched with NODE_ENV=development in its environment can't
  // widen the trust set to localhost origins.
  if (
    !app.isPackaged &&
    process.env.NODE_ENV === "development" &&
    getDevServerOrigins().includes(origin)
  ) {
    return origin;
  }
  return null;
}

/**
 * Let the app read a response, including why a remote window's host refused
 * it and whether a Markdown image's path is canonical: headers the viewer's
 * probes can't see unless they are exposed.
 */
export function grantAppCors(response: Response, corsOrigin: string): void {
  response.headers.set("Access-Control-Allow-Origin", corsOrigin);
  response.headers.set(
    "Access-Control-Expose-Headers",
    `${PREVIEW_REFUSAL_HEADER}, ${PATH_CANONICAL_HEADER}`
  );
}
