import { getDevServerOrigins } from "../config/devServer.js";

const PRODUCTION_ORIGINS = ["app://daintree"] as const;

function getTrustedRendererOrigins(): readonly string[] {
  const isDev = process.env.NODE_ENV === "development";
  return isDev ? [...PRODUCTION_ORIGINS, ...getDevServerOrigins()] : PRODUCTION_ORIGINS;
}

function getRendererOrigin(urlString: string): string | null {
  try {
    const url = new URL(urlString);

    if (!url.protocol || !url.host) return null;

    return `${url.protocol}//${url.host}`;
  } catch {
    return null;
  }
}

/**
 * Returns true if the renderer URL belongs to a trusted origin
 * (`app://daintree` in production; Vite dev-server origins in development).
 *
 * Trust is origin-scoped, not route-scoped: any path under `app://daintree`
 * passes. The preload guards `window.electron` exposure with
 * `window.top === window` so it is not directly available in sub-frames, but a
 * same-origin sub-frame can still reach the parent's `window.electron` via
 * `window.parent` (DOM same-origin access), and `event.senderFrame.url` on the
 * resulting IPC call resolves to the trusted origin. Adding a route beyond
 * `index.html` / `recovery.html` under `app://daintree/` therefore widens the
 * effective IPC trust surface.
 *
 * For route-specific narrowing see {@link isRecoveryPageUrl}.
 */
export function isTrustedRendererUrl(urlString: string): boolean {
  const origin = getRendererOrigin(urlString);
  if (!origin) return false;
  const trustedOrigins = getTrustedRendererOrigins();
  return trustedOrigins.includes(origin as any);
}

export function isRecoveryPageUrl(urlString: string): boolean {
  if (!isTrustedRendererUrl(urlString)) return false;
  try {
    const url = new URL(urlString);
    return url.pathname === "/recovery.html";
  } catch {
    return false;
  }
}

/**
 * Returns true if the renderer URL is the main application entry point on a
 * trusted origin. The main app loads at `app://daintree/index.html` in
 * production and at the dev-server root (`http://localhost:5173/`) in
 * development, so both the root path and `/index.html` count as the main app.
 *
 * This is the route-scoped complement to {@link isRecoveryPageUrl}: it
 * identifies the full-surface route, while `isRecoveryPageUrl` identifies the
 * narrow recovery surface. The preload uses `isRecoveryPageUrl` as the exposure
 * discriminator so any future trusted route defaults to the full surface; this
 * helper exists for callers that need to affirmatively recognise the main app.
 */
export function isMainAppRoute(urlString: string): boolean {
  if (!isTrustedRendererUrl(urlString)) return false;
  try {
    const url = new URL(urlString);
    return url.pathname === "" || url.pathname === "/" || url.pathname === "/index.html";
  } catch {
    return false;
  }
}

export function getTrustedOrigins(): readonly string[] {
  return getTrustedRendererOrigins();
}
