import { getDevServerOrigins, getDevServerWebSocketOrigins } from "./devServer.js";

// Custom protocol scheme the renderer fetches/loads from.
const FILE_SCHEMES = "daintree-file:";

// Localhost origins allowed for embedded <webview> guests in BrowserPane and
// DevPreviewPane. Without these in frame-src the host page cannot mount its
// webview elements at all.
const FRAME_LOCALHOST =
  "http://localhost:* http://127.0.0.1:* https://localhost:* https://127.0.0.1:*";

const GITHUB_AVATARS = "https://avatars.githubusercontent.com";

// Named Trusted Types policy backing all DOM HTML-sink writes in the renderer.
// 'allow-duplicates' is required so Vite HMR can re-evaluate the policy module
// on hot reload without throwing 'Policy with name "<x>" already exists'.
export const TRUSTED_TYPES_POLICY_NAME = "daintree-svg";

/**
 * Production CSP for the trusted Daintree renderer (`persist:daintree`).
 *
 * Loaded from `app://daintree` in production. Defense-in-depth — limits the
 * blast radius of a hypothetical XSS by forbidding `unsafe-inline` scripts
 * and external script sources. `'wasm-unsafe-eval'` stays for any future
 * library that compiles WASM at runtime.
 *
 * Applied at two layers (must stay aligned to avoid the browser intersecting
 * them into a stricter effective policy that breaks the app):
 *   1. `<meta http-equiv="Content-Security-Policy">` injected into index.html
 *      at build time by the Vite plugin in vite.config.ts.
 *   2. `Content-Security-Policy` HTTP response header set by the main process
 *      via `webRequest.onHeadersReceived` on the persist:daintree session.
 */
export function getDaintreeAppProdCSP(): string {
  return [
    "default-src 'self'",
    "script-src 'self' 'wasm-unsafe-eval'",
    "style-src 'self' 'unsafe-inline'",
    `connect-src 'self' ${FILE_SCHEMES}`,
    `img-src 'self' ${GITHUB_AVATARS} ${FILE_SCHEMES} data: blob:`,
    "font-src 'self' data:",
    "media-src 'self'",
    "worker-src 'self' blob:",
    `frame-src 'self' ${FRAME_LOCALHOST}`,
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'none'",
    "require-trusted-types-for 'script'",
    `trusted-types ${TRUSTED_TYPES_POLICY_NAME} 'allow-duplicates'`,
  ].join("; ");
}

/**
 * Development CSP for the trusted Daintree renderer.
 *
 * Loaded from the Vite dev server in development. Loosens script-src with
 * `'unsafe-inline' 'unsafe-eval'` — Vite's `@vitejs/plugin-react` injects an
 * inline `<script type="module">` React Refresh preamble at the top of <head>
 * (before the CSP meta tag), and the HTTP response header CSP applies before
 * any parsing, so without `'unsafe-inline'` the preamble is blocked and React
 * never bootstraps (grey screen). Adds dev-server HTTP/WebSocket origins. The
 * strict floor (object-src 'none', base-uri 'self', form-action 'none') still
 * applies.
 */
export function getDaintreeAppDevCSP(): string {
  const origins = getDevServerOrigins().join(" ");
  const wsOrigins = getDevServerWebSocketOrigins().join(" ");

  return [
    `default-src 'self' ${origins} ${wsOrigins}`,
    `script-src 'self' ${origins} 'unsafe-inline' 'unsafe-eval'`,
    `style-src 'self' ${origins} 'unsafe-inline'`,
    `connect-src 'self' ${origins} ${wsOrigins} ${FILE_SCHEMES}`,
    `img-src 'self' ${origins} ${GITHUB_AVATARS} ${FILE_SCHEMES} data: blob:`,
    `font-src 'self' ${origins} data:`,
    "media-src 'self'",
    "worker-src 'self' blob:",
    `frame-src 'self' ${FRAME_LOCALHOST}`,
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'none'",
    "require-trusted-types-for 'script'",
    `trusted-types ${TRUSTED_TYPES_POLICY_NAME} 'allow-duplicates'`,
  ].join("; ");
}

/**
 * Returns the appropriate CSP for the trusted Daintree renderer based on
 * whether the process is running in development mode.
 */
export function getDaintreeAppCSP(isDev: boolean): string {
  return isDev ? getDaintreeAppDevCSP() : getDaintreeAppProdCSP();
}
