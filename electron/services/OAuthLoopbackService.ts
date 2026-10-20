/**
 * RFC 8252 OAuth loopback flow for dev-preview panels.
 * Ephemeral HTTP server on 127.0.0.1:0 captures the IdP callback after
 * the system browser (via openExternalUrl) handles the authorization.
 * Requires the IdP to accept http://127.0.0.1:* as a redirect_uri (RFC 8252 §7.3).
 */

import { createHash, timingSafeEqual } from "crypto";
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "http";
import { app } from "electron";
import { canOpenExternalUrl, openExternalUrl } from "../utils/openExternal.js";

export { looksLikeOAuthUrl } from "../../shared/utils/urlUtils.js";
export type { OAuthLoopbackResult } from "../../shared/types/oauth.js";
import type { OAuthLoopbackResult } from "../../shared/types/oauth.js";

const CALLBACK_PATH = "/oauth/callback";
const TIMEOUT_MS = 300_000; // 5 minutes

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function statesMatch(expected: string, actual: string): boolean {
  const a = createHash("sha256").update(expected).digest();
  const b = createHash("sha256").update(actual).digest();
  return timingSafeEqual(a, b);
}

/**
 * Decide whether a callback request is the authorization response this flow is
 * waiting for. Anything else is refused without settling, so a stray or forged
 * local request cannot consume the session before the real IdP redirect lands.
 * A flow whose auth URL carried no `state` has nothing to correlate the
 * callback with, so it accepts any well-formed response that also carries none
 * (RFC 6749 §4.1.2 only returns `state` when the request sent it).
 */
function isAuthorizationResponse(params: URLSearchParams, expectedState: string | null): boolean {
  const states = params.getAll("state");
  if (expectedState === null) {
    if (states.length !== 0) return false;
  } else if (states.length !== 1 || !statesMatch(expectedState, states[0])) {
    return false;
  }
  const codes = params.getAll("code");
  const errors = params.getAll("error");
  if (codes.length + errors.length !== 1) return false;
  return (codes[0] ?? errors[0]) !== "";
}

function refuse(res: ServerResponse, status: number, headers: Record<string, string> = {}): void {
  res.writeHead(status, {
    "Content-Type": "text/plain; charset=utf-8",
    Connection: "close",
    ...headers,
  });
  res.end(status === 405 ? "Method Not Allowed" : "Bad Request");
}

interface LoopbackSession {
  server: Server;
  timeout: NodeJS.Timeout;
  settle: (result: OAuthLoopbackResult) => void;
}

/** Active loopback sessions keyed by panelId */
const activeSessions = new Map<string, LoopbackSession>();

export function startOAuthLoopback(authUrl: string, panelId: string): Promise<OAuthLoopbackResult> {
  // Validate the whole request before any side effect: a malformed string
  // would otherwise throw out of the typed-result contract, and cancelling the
  // in-flight session before validation would kill a live flow on a bad input.
  let parsed: URL;
  try {
    parsed = new URL(authUrl);
  } catch {
    console.warn("[OAuthLoopback] Invalid auth URL");
    return Promise.resolve({ success: false, cause: "server-error" });
  }

  // A repeated or empty `state` in the auth URL leaves no single value to bind
  // the callback to.
  const authStates = parsed.searchParams.getAll("state");
  if (authStates.length > 1 || authStates[0] === "") {
    console.warn("[OAuthLoopback] Auth URL has an ambiguous state parameter");
    return Promise.resolve({ success: false, cause: "server-error" });
  }
  const expectedState = authStates[0] ?? null;

  const originalRedirectUri = parsed.searchParams.get("redirect_uri");

  if (!originalRedirectUri) {
    console.warn("[OAuthLoopback] No redirect_uri found in auth URL");
    return Promise.resolve({ success: false, cause: "server-error" });
  }

  // Validate redirect_uri is a parseable absolute URL — a relative path would
  // throw inside the HTTP server handler, leaving the promise unsettled.
  try {
    new URL(originalRedirectUri);
  } catch {
    console.warn("[OAuthLoopback] Invalid redirect_uri:", originalRedirectUri);
    return Promise.resolve({ success: false, cause: "server-error" });
  }

  if (!canOpenExternalUrl(authUrl)) {
    console.warn("[OAuthLoopback] Disallowed auth URL protocol:", parsed.protocol);
    return Promise.resolve({ success: false, cause: "open-external-failed" });
  }

  cancelOAuthLoopback(panelId);

  return new Promise((resolve) => {
    let settled = false;
    let capturedLoopbackUri = "";
    let expectedHost = "";

    const settle = (result: OAuthLoopbackResult) => {
      if (settled) return;
      settled = true;
      cleanup(panelId);
      resolve(result);
    };

    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      let reqUrl: URL;
      try {
        reqUrl = new URL(req.url ?? "/", "http://127.0.0.1");
      } catch {
        refuse(res, 400);
        return;
      }

      if (reqUrl.pathname !== CALLBACK_PATH) {
        res.writeHead(404);
        res.end("Not Found");
        return;
      }

      if (req.method !== "GET") {
        refuse(res, 405, { Allow: "GET" });
        return;
      }

      // A kept-alive socket can still deliver requests after the flow settled,
      // and the redirect we handed the IdP names 127.0.0.1 literally, so any
      // other Host is not the browser following it.
      if (settled || req.headers.host !== expectedHost) {
        refuse(res, 400);
        return;
      }

      // Validate the raw params before the rebuild below — `searchParams.set`
      // collapses repeated keys and would hide a duplicate `state`.
      const callbackParams = reqUrl.searchParams;
      if (!isAuthorizationResponse(callbackParams, expectedState)) {
        console.warn(`[OAuthLoopback] Refused a non-matching callback for panel ${panelId}`);
        refuse(res, 400);
        return;
      }

      const hasError = callbackParams.has("error");

      // Build the original callback URL with the captured params
      const originalCallback = new URL(originalRedirectUri);
      for (const [key, value] of callbackParams) {
        originalCallback.searchParams.set(key, value);
      }

      // Respond to the system browser
      const title = hasError ? "Authentication Failed" : "Authentication Complete";
      const rawDetail =
        callbackParams.get("error_description") || callbackParams.get("error") || "unknown error";
      const message = hasError
        ? `Authentication was not completed: ${escapeHtml(rawDetail)}`
        : "You can close this tab and return to Daintree.";

      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", Connection: "close" });
      res.end(
        `<!DOCTYPE html><html><head><title>${title}</title></head>` +
          `<body style="font-family:system-ui;display:flex;align-items:center;justify-content:center;` +
          `min-height:100vh;margin:0;background:#1a1a1a;color:#e0e0e0;">` +
          `<div style="text-align:center;"><h2>${title}</h2><p>${message}</p></div>` +
          `</body></html>`
      );

      // Forward to the webview regardless — the app handles error params itself
      settle({
        success: true,
        callbackUrl: originalCallback.toString(),
        loopbackRedirectUri: capturedLoopbackUri,
        originalRedirectUri,
      });
    });

    server.on("error", (err) => {
      console.error("[OAuthLoopback] Server error:", err);
      settle({ success: false, cause: "server-error" });
    });

    // Don't keep the event loop alive for this server
    server.unref();

    server.listen(0, "127.0.0.1", () => {
      if (settled) return;
      const address = server.address();
      if (!address || typeof address === "string") {
        console.error("[OAuthLoopback] Failed to get server address");
        settle({ success: false, cause: "server-error" });
        return;
      }

      const port = address.port;
      expectedHost = `127.0.0.1:${port}`;
      capturedLoopbackUri = `http://${expectedHost}${CALLBACK_PATH}`;

      parsed.searchParams.set("redirect_uri", capturedLoopbackUri);

      console.log(
        `[OAuthLoopback] Started on port ${port} for panel ${panelId}. ` +
          `Original redirect: ${originalRedirectUri} → Loopback: ${capturedLoopbackUri}`
      );

      // Funnel through the protocol allowlist — `authUrl` is renderer-supplied,
      // so a disallowed scheme (file:, javascript:, …) must not reach the
      // system browser. `openExternalUrl` throws on a disallowed protocol,
      // which the `.catch` below settles as an open-external failure.
      void openExternalUrl(parsed.toString()).catch((err) => {
        console.error("[OAuthLoopback] Failed to open system browser:", err);
        settle({ success: false, cause: "open-external-failed" });
      });
    });

    const timeout = setTimeout(() => {
      console.warn(`[OAuthLoopback] Timed out after ${TIMEOUT_MS}ms for panel ${panelId}`);
      settle({ success: false, cause: "timed-out" });
    }, TIMEOUT_MS);

    activeSessions.set(panelId, { server, timeout, settle });
  });
}

/**
 * Cancel an active OAuth loopback flow for a panel.
 */
export function cancelOAuthLoopback(panelId: string): void {
  const session = activeSessions.get(panelId);
  if (session) {
    session.settle({ success: false, cause: "cancelled" });
  }
}

/**
 * Shut down all active loopback servers. Called on app quit.
 */
export function shutdownAllLoopbacks(): void {
  for (const [, session] of activeSessions) {
    session.settle({ success: false, cause: "cancelled" });
  }
}

function cleanup(panelId: string): void {
  const session = activeSessions.get(panelId);
  if (!session) return;

  activeSessions.delete(panelId);
  clearTimeout(session.timeout);

  try {
    session.server.close();
  } catch {
    // Server may already be closed
  }
}

// Clean up on app quit
app?.on?.("before-quit", () => {
  shutdownAllLoopbacks();
});
