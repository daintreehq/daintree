import { randomUUID } from "node:crypto";
import type { HostId } from "../../../shared/types/remoteHosts.js";
import { isPrivateOrLoopbackHostname } from "../../schemas/pluginIdentifiers.js";
import {
  cancelOAuthLoopback,
  startAuthorizationCodeLoopback,
} from "../../services/OAuthLoopbackService.js";
import {
  PluginAccountSignInPayloadSchema,
  PluginFrontendMethod,
} from "../../services/plugin/pluginFrontendRequests.js";
import { AppError } from "../../utils/errorTypes.js";
import type { ViewReverseRequest } from "../client/RemoteHostManager.js";
import { registerReverseRequestMethod } from "../client/reverseRequests.js";

/** This machine's loopback, the one a host's sign-in redirect comes back to. */
export interface AccountSignInLoopback {
  start: typeof startAuthorizationCodeLoopback;
  cancel: typeof cancelOAuthLoopback;
}

const defaultLoopback: AccountSignInLoopback = {
  start: startAuthorizationCodeLoopback,
  cancel: cancelOAuthLoopback,
};
let loopback = defaultLoopback;

interface SignInExpectation {
  /** The host, view, plugin and connection it was started for. */
  scope: string;
  /** Its own loopback session, so ending it can never take down another sign-in's. */
  sessionKey: string;
  /** A sign-in opens the browser once; a second request for it is refused. */
  claimed: boolean;
}

/**
 * Sign-ins this machine's views asked a host for and are still waiting on,
 * by the id the host echoes back. The id tells one click from the next, so a
 * request for a superseded sign-in, however late it arrives, can't claim the
 * newer one.
 */
const expectations = new Map<string, SignInExpectation>();

function signInScope(
  hostId: HostId,
  webContentsId: number,
  pluginId: string,
  connectionId: string | null
): string {
  return `${hostId}\0${webContentsId}\0${pluginId}\0${connectionId ?? ""}`;
}

/**
 * Note a sign-in a view here asked `hostId` for, for as long as that call is
 * in flight, under a fresh id the call carries to the host. The host's request
 * to open the browser is answered only against one, so a host can't open a
 * browser tab or a listener here that nobody asked for. A later click in the
 * same view for the same connection supersedes it, as the host's newest
 * sign-in does. `release` ends it and takes down its loopback, whatever ended
 * the call.
 */
export function expectAccountSignIn(
  hostId: HostId,
  webContentsId: number,
  pluginId: string,
  connectionId: string | null
): { signInId: string; release: () => void } {
  const scope = signInScope(hostId, webContentsId, pluginId, connectionId);
  for (const [id, previous] of [...expectations]) {
    if (previous.scope !== scope) continue;
    expectations.delete(id);
    loopback.cancel(previous.sessionKey);
  }
  const signInId = randomUUID();
  const entry: SignInExpectation = {
    scope,
    sessionKey: `remote-plugin-account\0${signInId}`,
    claimed: false,
  };
  expectations.set(signInId, entry);
  return {
    signInId,
    release: () => {
      if (expectations.get(signInId) === entry) expectations.delete(signInId);
      loopback.cancel(entry.sessionKey);
    },
  };
}

function refuse(message: string): AppError {
  return new AppError({ code: "VALIDATION", message });
}

/** An S256 challenge: the unpadded base64url of a SHA-256 digest (RFC 7636 §4.2). */
const S256_CHALLENGE = /^[A-Za-z0-9_-]{43}$/;

/**
 * The authorization request the host built, checked here before this
 * machine's browser is sent anywhere, since the host's own manifest checks
 * ran on the host: a public `https:` URL on a qualified name, a code request
 * carrying an S256 PKCE challenge and exactly one `state` for the loopback to
 * bind its callback to, and no redirect, which only this machine's own
 * loopback supplies.
 */
function authorizationRequest(authUrl: string): { url: URL; state: string } | null {
  let url: URL;
  try {
    url = new URL(authUrl);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "" || url.hash !== "") {
    return null;
  }
  if (isPrivateOrLoopbackHostname(url.hostname) || !url.hostname.includes(".")) return null;
  const params = url.searchParams;
  const states = params.getAll("state");
  if (states.length !== 1 || states[0] === "") return null;
  if (params.has("redirect_uri")) return null;
  if (params.getAll("response_type").join() !== "code") return null;
  if (params.getAll("code_challenge_method").join() !== "S256") return null;
  const challenges = params.getAll("code_challenge");
  if (challenges.length !== 1 || !S256_CHALLENGE.test(challenges[0]!)) return null;
  return { url, state: states[0]! };
}

/**
 * A host's request to run the browser half of a sign-in a view here started:
 * open its authorization URL in this machine's browser, catch the redirect on
 * this machine's loopback and answer with the one-use code. The host keeps
 * the PKCE verifier and exchanges the code itself, so the tokens never come
 * here.
 */
async function answerSignIn(request: ViewReverseRequest): Promise<unknown> {
  const parsed = PluginAccountSignInPayloadSchema.safeParse(request.payload);
  if (!parsed.success) throw refuse("Malformed account sign-in request from the host");
  const { signInId, pluginId, connectionId, authUrl } = parsed.data;
  const entry = expectations.get(signInId);
  if (
    !entry ||
    entry.claimed ||
    entry.scope !== signInScope(request.hostId, request.webContentsId, pluginId, connectionId)
  ) {
    throw new AppError({
      code: "PERMISSION",
      message: "No sign-in for that account was started in this window",
    });
  }
  const authorization = authorizationRequest(authUrl);
  if (!authorization) throw refuse("The host's sign-in request isn't one this window opens");
  entry.claimed = true;
  const { url, state } = authorization;
  return loopback.start(entry.sessionKey, state, (redirectUri) => {
    url.searchParams.set("redirect_uri", redirectUri);
    return url.toString();
  });
}

/** Shell side: answer hosts' sign-in requests for the views here that started them. */
export function installAccountSignInRequests(
  deps: { loopback?: AccountSignInLoopback } = {}
): () => void {
  loopback = deps.loopback ?? defaultLoopback;
  const unregister = registerReverseRequestMethod(
    PluginFrontendMethod.ACCOUNT_SIGN_IN,
    answerSignIn
  );
  return () => {
    unregister();
    for (const entry of expectations.values()) loopback.cancel(entry.sessionKey);
    expectations.clear();
    loopback = defaultLoopback;
  };
}
