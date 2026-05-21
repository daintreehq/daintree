import { extractLocalhostUrls, stripAnsiAndOscCodes } from "../../shared/utils/urlUtils.js";
import { detectDevServerError, type DevServerError } from "../../shared/utils/devServerErrors.js";

export interface ScanResult {
  url: string | null;
  error: DevServerError | null;
  buffer: string;
  readyMarker: boolean;
}

// Startup readiness lines printed by common dev servers once the HTTP server is
// bound and serving. Matched against ANSI/OSC-stripped output so colour-wrapped
// glyphs (Next.js green ✓, Vite bold) still match.
const READY_MARKERS: RegExp[] = [
  // Vite 5–8 (also SvelteKit/Remix/Astro on Vite): "VITE v6.3.1  ready in 312 ms"
  /VITE\s+v\d+[^\n]*ready\s+in\s+\d+/i,
  // Next.js 14/15 (Turbopack + webpack): "✓ Ready in 1234ms"
  /[✓✔]\s+Ready\s+in/u,
  // Next.js legacy / Windows fallback where the glyph degrades
  /ready\s+-\s+started\s+server\s+on/i,
  // webpack-dev-server / CRA / webpack-dev-middleware
  /webpack\s+compiled\s+successfully/i,
  /\[webpack-dev-middleware\]\s+compiled\s+successfully/i,
];

export class UrlDetector {
  scanOutput(data: string, buffer: string): ScanResult {
    const newBuffer =
      data.length < 8192
        ? buffer.slice(Math.max(0, buffer.length - 8192 + data.length)) + data
        : data.slice(-8192);

    let urls = extractLocalhostUrls(data);
    if (urls.length === 0) {
      const bufferUrls = extractLocalhostUrls(newBuffer);
      if (bufferUrls.length > 0) {
        urls = [bufferUrls[bufferUrls.length - 1]];
      }
    }

    const preferredUrl = urls.length > 0 ? this.selectPreferredUrl(urls) : null;
    const error = detectDevServerError(newBuffer);

    const strippedChunk = stripAnsiAndOscCodes(data);
    const readyMarker = READY_MARKERS.some((pattern) => pattern.test(strippedChunk));

    return {
      url: preferredUrl,
      error,
      buffer: newBuffer,
      readyMarker,
    };
  }

  private selectPreferredUrl(urls: string[]): string | null {
    if (urls.length === 0) return null;
    if (urls.length === 1) return urls[0];

    const localPattern = /localhost/i;
    const localUrls = urls.filter((url) => localPattern.test(url));
    return localUrls.length > 0 ? localUrls[localUrls.length - 1] : urls[urls.length - 1];
  }
}
