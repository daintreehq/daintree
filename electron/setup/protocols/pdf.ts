import path from "path";
import {
  buildDaintreeFileErrorHeaders,
  parseContainedFileRequest,
  readContainedDaintreeFile,
  statContainedDaintreeFile,
} from "./containedFile.js";
import { grantAppCors, trustedAppCorsOrigin } from "./appCors.js";
import { answerHostScopedRequest } from "./hostScoped.js";

/**
 * `Content-Disposition` for a PDF response. The URL's own last segment is
 * `load`, so without an explicit filename PDFium's download button and title
 * would both use that. Ships a quoted ASCII fallback plus an RFC 5987
 * `filename*` so non-ASCII names survive.
 */
export function buildPdfContentDisposition(realFile: string): string {
  const base = path.basename(realFile);
  // Drop everything outside printable ASCII (control chars, CR/LF) before
  // neutralizing the quote and backslash that would otherwise escape the
  // quoted-string.
  const ascii = base.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  // encodeURIComponent leaves ' ( ) * unescaped, but RFC 8187 `attr-char`
  // excludes them, so a conforming parser would reject the extended value and
  // silently fall back to the lossy ASCII one.
  const encoded = encodeURIComponent(base).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`
  );
  return `inline; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

/**
 * Response headers for a daintree-pdf:// document.
 *
 * Content-Type is hard-coded, never derived from the path: the canonical-path
 * `.pdf` gate in the read core plus a fixed `application/pdf` here is what
 * makes the `frame-src daintree-pdf:` allowance safe — a repo file holding
 * active HTML under a `.pdf` name reaches PDFium as PDF bytes and fails as a
 * malformed document rather than executing.
 *
 * Deliberately absent: `Content-Security-Policy` (a `sandbox` policy blocks
 * PDFium) and `Cross-Origin-Embedder-Policy` (blocks PDFium's own viewer
 * frame). The iframe carries `credentialless` instead, which is what lets a
 * COEP-credentialless app shell embed a document that asserts no COEP at all.
 */
export function buildDaintreePdfHeaders(
  realFile: string,
  contentLength: number
): Record<string, string> {
  return {
    "Content-Type": "application/pdf",
    "Content-Length": String(contentLength),
    "Content-Disposition": buildPdfContentDisposition(realFile),
    "Cross-Origin-Resource-Policy": "cross-origin",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Cache-Control": "no-store",
  };
}

/**
 * Create the daintree-pdf:// protocol handler — inline PDF preview (#11427).
 * URL shape mirrors daintree-file://: `daintree-pdf://load?path=…&root=…`.
 *
 * Range headers are ignored: PDFium renders fine from a single buffered 200
 * with an accurate Content-Length, so there is no reason to carry the video
 * path's ranged-streaming machinery here.
 *
 * The viewer HEADs the same URL before framing it (#12598), so the trusted app
 * origin gets the CORS grant on every path — an error response it can't read
 * would surface as an opaque TypeError instead of the status it needs to name.
 */
export function createDaintreePdfProtocolHandler() {
  return async (request: GlobalRequest) => {
    const response =
      (await answerHostScopedRequest("daintree-pdf", request)) ??
      (await respondToDaintreePdfRequest(request));
    const corsOrigin = trustedAppCorsOrigin(request);
    if (corsOrigin) grantAppCors(response, corsOrigin);
    return response;
  };
}

export async function respondToDaintreePdfRequest(request: GlobalRequest): Promise<Response> {
  try {
    const parsed = parseContainedFileRequest(request);
    if (parsed instanceof Response) return parsed;

    // HEAD is the viewer's admission probe, sent before every frame load, so
    // it answers from a stat rather than reading up to the PDF cap to discard.
    if (request.method === "HEAD") {
      const stat = await statContainedDaintreeFile(
        parsed.normalizedRoot,
        parsed.normalizedFile,
        "pdf"
      );
      if (stat instanceof Response) return stat;
      return new Response(null, {
        status: 200,
        headers: buildDaintreePdfHeaders(stat.realFile, stat.size),
      });
    }

    const result = await readContainedDaintreeFile(
      parsed.normalizedRoot,
      parsed.normalizedFile,
      "pdf"
    );
    if (result instanceof Response) return result;

    return new Response(result.buffer, {
      status: 200,
      headers: buildDaintreePdfHeaders(result.realFile, result.buffer.length),
    });
  } catch (err) {
    console.error("[MAIN] daintree-pdf protocol error:", err);
    return new Response("Internal Server Error", {
      status: 500,
      headers: buildDaintreeFileErrorHeaders(),
    });
  }
}
