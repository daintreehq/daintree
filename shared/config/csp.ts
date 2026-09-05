import { getDevServerOrigins, getDevServerWebSocketOrigins } from "./devServer.js";

// Custom protocol scheme the renderer fetches/loads from.
const FILE_SCHEMES = "daintree-file:";

// Sandboxed HTML file preview scheme (#11191). Only appears in `frame-src` so
// the file panel can mount a `daintree-html://<token>/…` iframe; the framed
// document's own scripts/assets are governed by the per-document CSP the
// protocol handler serves (scoped to its exact token authority), never this one.
const HTML_PREVIEW_SCHEME = "daintree-html:";

// Inline PDF preview (#11427). Only appears in `frame-src`, so the file viewer
// can mount a `daintree-pdf://load?…` iframe that Chromium hands to its built-in
// PDFium viewer. `daintree-file:` is deliberately NOT granted this: it serves
// arbitrary repo files under extension-derived MIME types, so framing it would
// let a repo-controlled document render as a live page. The PDF scheme's handler
// rejects any canonical path that isn't `.pdf` and answers with a hard-coded
// `application/pdf`, so this allowance can never resolve to anything else.
const PDF_PREVIEW_SCHEME = "daintree-pdf:";

// Direct media playback (#12242). Only appears in `media-src`, so
// `<video>`/`<audio>` can point straight at `daintree-media://load/?…` instead
// of playing a blob of the whole file. `standard: true` — the privilege the
// upstream report behind that blob detour identified as missing — lives on this
// scheme rather than `daintree-file:` so that scheme's consumers (markdown
// images, WebAudio fetch, the file viewer) keep their existing registration.
// The handler serves nothing but audio/video under a caller-supplied root.
const MEDIA_SCHEME = "daintree-media:";

// Plugin-served renderer modules. `plugin:` is a hardened first-party scheme
// (`standard: true, secure: true`, no `bypassCSP`) — see
// `electron/main.ts:120-130` — that resolves to the plugin's installed-on-disk
// root via the handler in `electron/setup/protocols.ts`. Non-PTY plugin panel
// views are lazy-loaded via `React.lazy(() => import("plugin://..."))` (see
// `src/components/Panel/PluginViewHost.tsx`), so `plugin:` must appear in
// `script-src` for the dynamic module load to clear CSP in production. Per
// past lesson #3757, the alternative — `bypassCSP: true` — is the nuclear
// option and is explicitly rejected; this narrow directive expansion is the
// minimum surface to make the feature work without weakening defense-in-depth.
const PLUGIN_SCHEME = "plugin:";

// Localhost origins allowed for embedded <webview> guests in BrowserPane and
// DevPreviewPane. Without these in frame-src the host page cannot mount its
// webview elements at all.
const FRAME_LOCALHOST =
  "http://localhost:* http://127.0.0.1:* https://localhost:* https://127.0.0.1:*";

const GITHUB_AVATARS = "https://avatars.githubusercontent.com";

// Custom commit-author avatars. `getGravatarUrl()` requests
// `https://www.gravatar.com/avatar/<hash>?d=404`; with `d=404` there is no
// redirect to *.wp.com on a miss, so only this origin needs allowing.
const GRAVATAR = "https://www.gravatar.com";

// Daintree documentation images surfaced inline by the assistant via the
// `help.displayImage` MCP tool (#9828). The tool validates each URL against
// the same daintree.org allowlist before dispatch; this directive lets the
// renderer actually load the figure. Chromium 148 does NOT match the apex
// (`https://daintree.org`) against a wildcard, so both the apex and the
// `*.daintree.org` subdomain form must be listed explicitly.
const DAINTREE_DOCS = "https://daintree.org https://*.daintree.org";

// Named Trusted Types policy backing all DOM HTML-sink writes in the renderer.
// 'allow-duplicates' is required so Vite HMR can re-evaluate the policy module
// on hot reload without throwing 'Policy with name "<x>" already exists'.
export const TRUSTED_TYPES_POLICY_NAME = "daintree-svg";

/**
 * Optional CSP customization knobs.
 *
 * `scriptSrcHashes` carries SHA-256 hashes (formatted as `'sha256-<base64>'`)
 * for any inline `<script>` elements injected into the production document
 * — primarily the host import map (`<script type="importmap">`) emitted by
 * the build. Without the hash entry the strict `script-src 'self'` directive
 * silently discards the inline element, and bare `react` / `react-dom`
 * specifiers from externalized plugin bundles fail to resolve at runtime.
 *
 * The hash MUST be computed over the exact byte sequence of the inline
 * children, including whitespace. The build emits both halves (meta tag and
 * sidecar `dist/importmap-meta.json`) from the same serialized JSON to keep
 * them aligned.
 */
export interface DaintreeCspOptions {
  readonly scriptSrcHashes?: readonly string[];
}

function buildScriptSrc(base: string, scriptSrcHashes?: readonly string[]): string {
  if (!scriptSrcHashes || scriptSrcHashes.length === 0) return base;
  return `${base} ${scriptSrcHashes.join(" ")}`;
}

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
 *
 * Per the W3C CSP3 spec, `frame-ancestors`, `report-uri`, and `sandbox` are
 * not supported when delivered via `<meta http-equiv>` — Chromium 146 drops
 * them with a DevTools warning. Those directives must appear on the HTTP
 * response header only (layer 2 above); adding them to the meta layer is a
 * no-op and gives a false sense of coverage. `report-to` is technically
 * honored in meta but its endpoint mapping requires the `Reporting-Endpoints`
 * HTTP response header, so it is also effectively header-only.
 */
export function getDaintreeAppProdCSP(options?: DaintreeCspOptions): string {
  return [
    "default-src 'self'",
    buildScriptSrc(
      `script-src 'self' 'wasm-unsafe-eval' ${PLUGIN_SCHEME}`,
      options?.scriptSrcHashes
    ),
    "style-src 'self' 'unsafe-inline'",
    `connect-src 'self' ${FILE_SCHEMES} ${PLUGIN_SCHEME}`,
    `img-src 'self' ${GITHUB_AVATARS} ${GRAVATAR} ${DAINTREE_DOCS} ${FILE_SCHEMES} data: blob:`,
    "font-src 'self' data:",
    // daintree-media:: the file viewer points <video>/<audio> straight at the
    // range-serving scheme rather than a blob of the whole file (#12242).
    // FILE_SCHEMES stays here for media loaded by tag from that scheme; the
    // viewer's size probe and WebAudio read it via fetch(), which connect-src
    // governs. blob: stays for renderer-minted object URLs.
    `media-src 'self' ${MEDIA_SCHEME} ${FILE_SCHEMES} blob:`,
    "worker-src 'self' blob:",
    `frame-src 'self' ${HTML_PREVIEW_SCHEME} ${PDF_PREVIEW_SCHEME} ${FRAME_LOCALHOST}`,
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'none'",
    "require-trusted-types-for 'script'",
    `trusted-types ${TRUSTED_TYPES_POLICY_NAME} default 'allow-duplicates'`,
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
    `script-src 'self' ${origins} 'unsafe-inline' 'unsafe-eval' ${PLUGIN_SCHEME}`,
    `style-src 'self' ${origins} 'unsafe-inline'`,
    `connect-src 'self' ${origins} ${wsOrigins} ${FILE_SCHEMES} ${PLUGIN_SCHEME}`,
    `img-src 'self' ${origins} ${GITHUB_AVATARS} ${GRAVATAR} ${DAINTREE_DOCS} ${FILE_SCHEMES} data: blob:`,
    `font-src 'self' ${origins} data:`,
    // Mirrors the production policy — see getDaintreeAppProdCSP.
    `media-src 'self' ${MEDIA_SCHEME} ${FILE_SCHEMES} blob:`,
    "worker-src 'self' blob:",
    `frame-src 'self' ${HTML_PREVIEW_SCHEME} ${PDF_PREVIEW_SCHEME} ${FRAME_LOCALHOST}`,
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'none'",
    "require-trusted-types-for 'script'",
    `trusted-types ${TRUSTED_TYPES_POLICY_NAME} default 'allow-duplicates'`,
  ].join("; ");
}

/**
 * Returns the appropriate CSP for the trusted Daintree renderer based on
 * whether the process is running in development mode.
 *
 * `options.scriptSrcHashes` only takes effect in production — the dev CSP
 * already permits inline scripts via `'unsafe-inline'`, so any hash entries
 * would be ignored by the browser.
 */
export function getDaintreeAppCSP(isDev: boolean, options?: DaintreeCspOptions): string {
  return isDev ? getDaintreeAppDevCSP() : getDaintreeAppProdCSP(options);
}
