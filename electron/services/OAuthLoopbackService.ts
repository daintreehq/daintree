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
import { OAUTH_LOOPBACK_TIMEOUT_MS, type OAuthLoopbackResult } from "../../shared/types/oauth.js";

const CALLBACK_PATH = "/oauth/callback";
const TIMEOUT_MS = OAUTH_LOOPBACK_TIMEOUT_MS;
const LOOPBACK_BASE = "http://127.0.0.1";

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

interface CallbackGate {
  expectedHost: string;
  expectedState: string | null;
  settled: boolean;
  /** Names the flow in a refusal log line; never the request itself. */
  label: string;
}

/**
 * Answer every request that is not the authorization response the flow waits
 * for, and return the response's params when it is. The caller writes the
 * page for an accepted one.
 */
function acceptCallback(
  req: IncomingMessage,
  res: ServerResponse,
  gate: CallbackGate
): URLSearchParams | null {
  // `req.url` is client-controlled and Node's parser accepts targets the URL
  // constructor rejects (`//[`). A malformed target, or one whose authority
  // resolves anywhere but the bare loopback base (absolute-form with a port or
  // foreign host, protocol-relative, backslash escapes), is answered here and
  // must never settle the pending flow; neither the target nor its query is logged.
  let reqUrl: URL;
  try {
    reqUrl = new URL(req.url ?? "/", LOOPBACK_BASE);
  } catch {
    refuse(res, 400);
    return null;
  }
  if (reqUrl.origin !== LOOPBACK_BASE) {
    refuse(res, 400);
    return null;
  }

  if (reqUrl.pathname !== CALLBACK_PATH) {
    res.writeHead(404);
    res.end("Not Found");
    return null;
  }

  if (req.method !== "GET") {
    refuse(res, 405, { Allow: "GET" });
    return null;
  }

  // A kept-alive socket can still deliver requests after the flow settled,
  // and the redirect we handed the IdP names 127.0.0.1 literally, so any
  // other Host is not the browser following it.
  if (gate.settled || req.headers.host !== gate.expectedHost) {
    refuse(res, 400);
    return null;
  }

  // Validate the raw params before any rebuild — `searchParams.set`
  // collapses repeated keys and would hide a duplicate `state`.
  const callbackParams = reqUrl.searchParams;
  if (!isAuthorizationResponse(callbackParams, gate.expectedState)) {
    console.warn(`[OAuthLoopback] Refused a non-matching callback for ${gate.label}`);
    refuse(res, 400);
    return null;
  }
  return callbackParams;
}

function writeResultPage(res: ServerResponse, callbackParams: URLSearchParams): void {
  const hasError = callbackParams.has("error");
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
}

interface LoopbackSession {
  server: Server;
  timeout: NodeJS.Timeout;
  settle: (result: OAuthLoopbackResult) => void;
}

/** Active loopback sessions keyed by panelId, or a caller-namespaced key for host flows */
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
      const callbackParams = acceptCallback(req, res, {
        expectedHost,
        expectedState,
        settled,
        label: `panel ${panelId}`,
      });
      if (!callbackParams) return;

      // Build the original callback URL with the captured params
      const originalCallback = new URL(originalRedirectUri);
      for (const [key, value] of callbackParams) {
        originalCallback.searchParams.set(key, value);
      }

      writeResultPage(res, callbackParams);

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

/** How a host-run authorization request ended. Never carries the code past its one use. */
export type AuthorizationCodeLoopbackResult =
  | { success: true; code: string; redirectUri: string }
  | { success: false; cause: "denied"; error: string }
  | { success: false; cause: OAuthLoopbackFailureCause }
  /** The window on another machine that was catching the redirect went away. */
  | { success: false; cause: "disconnected" };

type OAuthLoopbackFailureCause = Extract<OAuthLoopbackResult, { success: false }>["cause"];

/**
 * The host's own authorization-code request (RFC 8252 §7.3), for a flow whose
 * URL the host builds: the server binds first, `buildAuthUrl` receives the
 * exact loopback redirect URI, and the browser is sent to what it returns.
 * The callback must carry `state`; the code is handed back to the caller and
 * nothing is forwarded anywhere. `sessionKey` shares the session map with
 * panel flows, so callers namespace it.
 */
export function startAuthorizationCodeLoopback(
  sessionKey: string,
  state: string,
  buildAuthUrl: (redirectUri: string) => string
): Promise<AuthorizationCodeLoopbackResult> {
  if (state.length === 0) {
    return Promise.resolve({ success: false, cause: "server-error" });
  }
  cancelOAuthLoopback(sessionKey);

  return new Promise((resolve) => {
    let settled = false;
    let expectedHost = "";
    let redirectUri = "";

    const settle = (result: AuthorizationCodeLoopbackResult) => {
      if (settled) return;
      settled = true;
      cleanup(sessionKey);
      resolve(result);
    };

    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const callbackParams = acceptCallback(req, res, {
        expectedHost,
        expectedState: state,
        settled,
        label: sessionKey,
      });
      if (!callbackParams) return;
      writeResultPage(res, callbackParams);
      const code = callbackParams.get("code");
      settle(
        code !== null
          ? { success: true, code, redirectUri }
          : { success: false, cause: "denied", error: callbackParams.get("error") ?? "" }
      );
    });

    server.on("error", (err) => {
      console.error("[OAuthLoopback] Server error:", err);
      settle({ success: false, cause: "server-error" });
    });

    server.unref();

    server.listen(0, "127.0.0.1", () => {
      if (settled) return;
      const address = server.address();
      if (!address || typeof address === "string") {
        console.error("[OAuthLoopback] Failed to get server address");
        settle({ success: false, cause: "server-error" });
        return;
      }
      expectedHost = `127.0.0.1:${address.port}`;
      redirectUri = `http://${expectedHost}${CALLBACK_PATH}`;
      let authUrl: string;
      try {
        authUrl = buildAuthUrl(redirectUri);
      } catch {
        settle({ success: false, cause: "server-error" });
        return;
      }
      void openExternalUrl(authUrl).catch((err) => {
        console.error("[OAuthLoopback] Failed to open system browser:", err);
        settle({ success: false, cause: "open-external-failed" });
      });
    });

    const timeout = setTimeout(() => {
      console.warn(`[OAuthLoopback] Timed out after ${TIMEOUT_MS}ms for ${sessionKey}`);
      settle({ success: false, cause: "timed-out" });
    }, TIMEOUT_MS);

    activeSessions.set(sessionKey, {
      server,
      timeout,
      settle: (result) => {
        if (!result.success) settle({ success: false, cause: result.cause });
      },
    });
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
