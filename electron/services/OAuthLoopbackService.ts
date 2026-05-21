/**
 * RFC 8252 OAuth loopback flow for dev-preview panels.
 * Ephemeral HTTP server on 127.0.0.1:0 captures the IdP callback after
 * shell.openExternal handles the authorization in the system browser.
 * Requires the IdP to accept http://127.0.0.1:* as a redirect_uri (RFC 8252 §7.3).
 */

import { createServer, type Server, type IncomingMessage, type ServerResponse } from "http";
import { app, shell } from "electron";

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

interface LoopbackSession {
  server: Server;
  timeout: NodeJS.Timeout;
  settle: (result: OAuthLoopbackResult) => void;
}

/** Active loopback sessions keyed by panelId */
const activeSessions = new Map<string, LoopbackSession>();

export function startOAuthLoopback(authUrl: string, panelId: string): Promise<OAuthLoopbackResult> {
  cancelOAuthLoopback(panelId);

  const parsed = new URL(authUrl);
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

  return new Promise((resolve) => {
    let settled = false;
    let capturedLoopbackUri = "";

    const settle = (result: OAuthLoopbackResult) => {
      if (settled) return;
      settled = true;
      cleanup(panelId);
      resolve(result);
    };

    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const reqUrl = new URL(req.url ?? "/", "http://127.0.0.1");

      if (reqUrl.pathname !== CALLBACK_PATH) {
        res.writeHead(404);
        res.end("Not Found");
        return;
      }

      // Capture all query params from the callback (code, state, error, etc.)
      const callbackParams = reqUrl.searchParams;
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

      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
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
      const address = server.address();
      if (!address || typeof address === "string") {
        console.error("[OAuthLoopback] Failed to get server address");
        settle({ success: false, cause: "server-error" });
        return;
      }

      const port = address.port;
      capturedLoopbackUri = `http://127.0.0.1:${port}${CALLBACK_PATH}`;

      parsed.searchParams.set("redirect_uri", capturedLoopbackUri);

      console.log(
        `[OAuthLoopback] Started on port ${port} for panel ${panelId}. ` +
          `Original redirect: ${originalRedirectUri} → Loopback: ${capturedLoopbackUri}`
      );

      void shell.openExternal(parsed.toString()).catch((err) => {
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
