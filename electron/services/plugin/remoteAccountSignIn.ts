import type { ClientEndpoint } from "../../ipc/endpoint.js";
import { OAUTH_LOOPBACK_TIMEOUT_MS } from "../../../shared/types/oauth.js";
import type { AuthorizationCodeLoopbackResult } from "../OAuthLoopbackService.js";
import type { AccountSignInBroker } from "./PluginAccountService.js";
import { PluginAccountSignInAnswerSchema, PluginFrontendMethod } from "./pluginFrontendRequests.js";

/** The Shell's own loopback wait, plus room for its answer to come back. */
export const REMOTE_ACCOUNT_SIGN_IN_TIMEOUT_MS = OAUTH_LOOPBACK_TIMEOUT_MS + 15_000;

const SHELL_LOOPBACK_REDIRECT = /^http:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})\/oauth\/callback$/;

/**
 * Whether `uri` is the redirect a Shell's loopback hands the provider: the
 * literal IPv4 loopback, a real port and the fixed callback path, nothing
 * else. It goes into this host's token request, so nothing that could name
 * another machine or carry extra parameters is accepted.
 */
export function isShellLoopbackRedirect(uri: string): boolean {
  const match = SHELL_LOOPBACK_REDIRECT.exec(uri);
  return match !== null && Number(match[1]) <= 65_535;
}

/** The error's code, when it looks like one: the window's answer is not trusted text. */
function errorCode(error: unknown): string | null {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && /^[A-Z_]{1,64}$/.test(code) ? code : null;
}

/**
 * The browser half of a sign-in that a window on another machine started,
 * asked of that window's own Shell: it opens the URL in its browser, catches
 * the redirect on its loopback and answers with the one-use code. The PKCE
 * verifier and the tokens never leave this host. `signInId` is the window's
 * own name for the click, and `connectionId` the connection it asked for, so
 * its Shell can match the request to that click and no other. The endpoint
 * is the caller's, never the project's driver: a window that takes control
 * meanwhile doesn't receive someone else's sign-in.
 */
export function remoteAccountSignIn(
  endpoint: ClientEndpoint,
  pluginId: string,
  connectionId: string | undefined,
  signInId: string
): AccountSignInBroker {
  const controller = new AbortController();
  return {
    async start(_sessionKey, _state, buildAuthUrl): Promise<AuthorizationCodeLoopbackResult> {
      let authUrl: string;
      try {
        authUrl = buildAuthUrl(null);
      } catch {
        return { success: false, cause: "server-error" };
      }
      let answer: unknown;
      try {
        answer = await endpoint.request(
          PluginFrontendMethod.ACCOUNT_SIGN_IN,
          { signInId, pluginId, connectionId: connectionId ?? null, authUrl },
          { timeoutMs: REMOTE_ACCOUNT_SIGN_IN_TIMEOUT_MS, signal: controller.signal }
        );
      } catch (error) {
        if (controller.signal.aborted) return { success: false, cause: "cancelled" };
        switch (errorCode(error)) {
          case "HOST_DISCONNECTED":
            return { success: false, cause: "disconnected" };
          case "OUTCOME_UNKNOWN":
            return { success: false, cause: "timed-out" };
          // The window was moved to another project while its browser was open.
          case "STALE_GENERATION":
            return { success: false, cause: "cancelled" };
          default:
            console.warn(
              `[PluginAccount] The window signing in to "${pluginId}" refused the sign-in: ${errorCode(error) ?? "error"}`
            );
            return { success: false, cause: "server-error" };
        }
      }
      const parsed = PluginAccountSignInAnswerSchema.safeParse(answer);
      if (!parsed.success) return { success: false, cause: "server-error" };
      const result = parsed.data;
      if (!result.success) {
        return result.cause === "denied"
          ? { success: false, cause: "denied", error: result.error ?? "" }
          : { success: false, cause: result.cause };
      }
      if (!isShellLoopbackRedirect(result.redirectUri)) {
        return { success: false, cause: "server-error" };
      }
      return { success: true, code: result.code, redirectUri: result.redirectUri };
    },
    cancel: () => controller.abort(),
  };
}
