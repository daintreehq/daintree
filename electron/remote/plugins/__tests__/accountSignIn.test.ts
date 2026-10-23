import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthorizationCodeLoopbackResult } from "../../../services/OAuthLoopbackService.js";

vi.mock("electron", () => ({
  app: undefined,
  shell: { openExternal: vi.fn() },
}));

import {
  _resetReverseRequestMethodsForTesting,
  answerReverseRequest,
} from "../../client/reverseRequests.js";
import { expectAccountSignIn, installAccountSignInRequests } from "../accountSignIn.js";

const PLUGIN = "acme.tracker";
const VIEW = 11;
const LOOPBACK = "http://127.0.0.1:50001/oauth/callback";
const CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";

function authUrl(edit: (params: URLSearchParams) => void = () => {}): string {
  const url = new URL("https://auth.example.com/oauth/authorize?prompt=consent");
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", "daintree-client");
  url.searchParams.set("state", "synthetic-state");
  url.searchParams.set("code_challenge", CHALLENGE);
  url.searchParams.set("code_challenge_method", "S256");
  edit(url.searchParams);
  return url.toString();
}

/** This machine's loopback, held open until a test sends the browser back. */
function fakeLoopback() {
  const open = new Map<
    string,
    { state: string; url: string; settle: (r: AuthorizationCodeLoopbackResult) => void }
  >();
  const start = vi.fn(
    (sessionKey: string, state: string, buildAuthUrl: (redirectUri: string) => string) =>
      new Promise<AuthorizationCodeLoopbackResult>((settle) => {
        open.set(sessionKey, { state, url: buildAuthUrl(LOOPBACK), settle });
      })
  );
  const cancel = vi.fn((sessionKey: string) => {
    const session = open.get(sessionKey);
    if (!session) return;
    open.delete(sessionKey);
    session.settle({ success: false, cause: "cancelled" });
  });
  const only = () => {
    expect(open.size).toBe(1);
    return [...open.values()][0]!;
  };
  return { start, cancel, open, only };
}

function ask(
  payload: unknown,
  { hostId = "studio", webContentsId = VIEW }: { hostId?: string; webContentsId?: number } = {}
): Promise<unknown> {
  return answerReverseRequest({
    hostId,
    webContentsId,
    method: "plugin.account-sign-in",
    payload,
  });
}

type SignInPayload = {
  signInId: string;
  pluginId: string;
  connectionId: string | null;
  authUrl: string;
};

function signIn(signInId: string, over: Partial<SignInPayload> = {}): SignInPayload {
  return { signInId, pluginId: PLUGIN, connectionId: null, authUrl: authUrl(), ...over };
}

let loopback: ReturnType<typeof fakeLoopback>;
let dispose: () => void;

beforeEach(() => {
  _resetReverseRequestMethodsForTesting();
  loopback = fakeLoopback();
  dispose = installAccountSignInRequests({ loopback });
});

afterEach(() => {
  dispose();
  _resetReverseRequestMethodsForTesting();
});

describe("account sign-ins a host asks this Shell to open (#14111)", () => {
  it("opens nothing for a sign-in no view here started", async () => {
    await expect(ask(signIn("made-up"))).rejects.toMatchObject({ code: "PERMISSION" });
    expect(loopback.start).not.toHaveBeenCalled();
  });

  it("runs the browser half on this machine's loopback for the view that clicked Connect", async () => {
    const { signInId, release } = expectAccountSignIn("studio", VIEW, PLUGIN, null);
    const answer = ask(signIn(signInId));

    const session = loopback.only();
    expect(session.state).toBe("synthetic-state");
    const opened = new URL(session.url);
    expect(opened.origin + opened.pathname).toBe("https://auth.example.com/oauth/authorize");
    expect(opened.searchParams.get("redirect_uri")).toBe(LOOPBACK);
    expect(opened.searchParams.get("prompt")).toBe("consent");
    expect(opened.searchParams.get("code_challenge")).toBe(CHALLENGE);

    session.settle({ success: true, code: "synthetic-code", redirectUri: LOOPBACK });
    await expect(answer).resolves.toEqual({
      success: true,
      code: "synthetic-code",
      redirectUri: LOOPBACK,
    });
    release();
  });

  it("gives every click its own id", () => {
    const first = expectAccountSignIn("studio", VIEW, PLUGIN, null);
    const second = expectAccountSignIn("studio", VIEW, PLUGIN, "work");
    expect(first.signInId).not.toBe(second.signInId);
    first.release();
    second.release();
  });

  const elsewhere: Array<
    [string, { hostId?: string; webContentsId?: number }, Partial<SignInPayload>]
  > = [
    ["another host", { hostId: "build-box" }, {}],
    ["another view", { webContentsId: VIEW + 1 }, {}],
    ["another plugin", {}, { pluginId: "acme.other" }],
    ["another connection", {}, { connectionId: "personal" }],
    ["no connection", {}, { connectionId: null }],
  ];
  it.each(elsewhere)("refuses a request for %s", async (_name, where, over) => {
    const { signInId, release } = expectAccountSignIn("studio", VIEW, PLUGIN, "work");
    await expect(
      ask(signIn(signInId, { connectionId: "work", ...over }), where)
    ).rejects.toMatchObject({ code: "PERMISSION" });
    expect(loopback.start).not.toHaveBeenCalled();
    release();
  });

  it("refuses a request that names another click", async () => {
    const { release } = expectAccountSignIn("studio", VIEW, PLUGIN, null);
    await expect(ask(signIn("someone-elses-click"))).rejects.toMatchObject({ code: "PERMISSION" });
    expect(loopback.start).not.toHaveBeenCalled();
    release();
  });

  it("opens a sign-in's browser once, however often the host asks", async () => {
    const { signInId, release } = expectAccountSignIn("studio", VIEW, PLUGIN, null);
    void ask(signIn(signInId));
    await expect(ask(signIn(signInId))).rejects.toMatchObject({ code: "PERMISSION" });
    expect(loopback.start).toHaveBeenCalledTimes(1);
    release();
  });

  it.each([
    ["a non-https URL", authUrl().replace("https:", "http:")],
    [
      "a redirect of the host's own",
      authUrl((p) => p.set("redirect_uri", "https://evil.example.com/cb")),
    ],
    ["a loopback address", authUrl().replace("auth.example.com", "127.0.0.1")],
    ["an IPv6 loopback address", authUrl().replace("auth.example.com", "[::1]")],
    ["a private address", authUrl().replace("auth.example.com", "192.168.1.20")],
    ["localhost", authUrl().replace("auth.example.com", "localhost")],
    ["a single-label name", authUrl().replace("auth.example.com", "intranet")],
    ["a single-label name with a root dot", authUrl().replace("auth.example.com", "intranet.")],
    ["no state", authUrl((p) => p.delete("state"))],
    ["an empty state", authUrl((p) => p.set("state", ""))],
    ["two states", authUrl((p) => p.append("state", "other"))],
    ["no PKCE challenge", authUrl((p) => p.delete("code_challenge"))],
    ["an empty PKCE challenge", authUrl((p) => p.set("code_challenge", ""))],
    ["a PKCE challenge that isn't a digest", authUrl((p) => p.set("code_challenge", "abc"))],
    ["a plain PKCE challenge", authUrl((p) => p.set("code_challenge_method", "plain"))],
    ["an implicit grant", authUrl((p) => p.set("response_type", "token"))],
    ["credentials in the URL", authUrl().replace("https://", "https://user:pw@")],
    ["a fragment", `${authUrl()}#frag`],
    ["something that isn't a URL", "not a url"],
  ])("refuses to open %s", async (_name, url) => {
    const { signInId, release } = expectAccountSignIn("studio", VIEW, PLUGIN, null);
    await expect(ask(signIn(signInId, { authUrl: url }))).rejects.toMatchObject({
      code: "VALIDATION",
    });
    expect(loopback.start).not.toHaveBeenCalled();
    // A refused request doesn't use up the sign-in.
    void ask(signIn(signInId));
    expect(loopback.start).toHaveBeenCalledTimes(1);
    release();
  });

  it("opens a fully qualified name written with its root dot", async () => {
    const { signInId, release } = expectAccountSignIn("studio", VIEW, PLUGIN, null);
    void ask(
      signIn(signInId, { authUrl: authUrl().replace("auth.example.com", "auth.example.com.") })
    );
    expect(loopback.start).toHaveBeenCalledTimes(1);
    release();
  });

  it("refuses a malformed request", async () => {
    const { release } = expectAccountSignIn("studio", VIEW, PLUGIN, null);
    await expect(ask({ pluginId: PLUGIN })).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(ask(null)).rejects.toMatchObject({ code: "VALIDATION" });
    expect(loopback.start).not.toHaveBeenCalled();
    release();
  });

  it("takes the loopback down when the call settles, and opens nothing after", async () => {
    const { signInId, release } = expectAccountSignIn("studio", VIEW, PLUGIN, null);
    const answer = ask(signIn(signInId));
    expect(loopback.open.size).toBe(1);

    release();
    expect(loopback.open.size).toBe(0);
    await expect(answer).resolves.toEqual({ success: false, cause: "cancelled" });
    await expect(ask(signIn(signInId))).rejects.toMatchObject({ code: "PERMISSION" });
  });

  it("lets a newer click in the same view supersede the older one's loopback", async () => {
    const older = expectAccountSignIn("studio", VIEW, PLUGIN, null);
    const oldAnswer = ask(signIn(older.signInId));
    const newer = expectAccountSignIn("studio", VIEW, PLUGIN, null);
    await expect(oldAnswer).resolves.toEqual({ success: false, cause: "cancelled" });

    const newAnswer = ask(signIn(newer.signInId));
    // The older call settling late leaves the newer sign-in alone.
    older.release();
    loopback.only().settle({ success: true, code: "synthetic-new", redirectUri: LOOPBACK });
    await expect(newAnswer).resolves.toMatchObject({ success: true, code: "synthetic-new" });
    newer.release();
  });

  it("won't let a superseded click's late request claim the newer sign-in", async () => {
    const older = expectAccountSignIn("studio", VIEW, PLUGIN, null);
    const newer = expectAccountSignIn("studio", VIEW, PLUGIN, null);

    // The host sent the older request before it saw the newer click.
    await expect(ask(signIn(older.signInId))).rejects.toMatchObject({ code: "PERMISSION" });
    expect(loopback.start).not.toHaveBeenCalled();

    const answer = ask(signIn(newer.signInId));
    loopback.only().settle({ success: true, code: "synthetic-new", redirectUri: LOOPBACK });
    await expect(answer).resolves.toMatchObject({ success: true, code: "synthetic-new" });
    older.release();
    newer.release();
  });

  it("keeps two hosts' sign-ins in the same view apart", async () => {
    const studio = expectAccountSignIn("studio", VIEW, PLUGIN, null);
    const build = expectAccountSignIn("build-box", VIEW, PLUGIN, null);
    // Each host can only name its own click.
    await expect(ask(signIn(build.signInId), { hostId: "studio" })).rejects.toMatchObject({
      code: "PERMISSION",
    });
    const studioAnswer = ask(signIn(studio.signInId), { hostId: "studio" });
    const buildAnswer = ask(signIn(build.signInId), { hostId: "build-box" });
    expect(loopback.open.size).toBe(2);
    const [, buildKey] = [...loopback.open.keys()];

    studio.release();
    await expect(studioAnswer).resolves.toEqual({ success: false, cause: "cancelled" });
    expect([...loopback.open.keys()]).toEqual([buildKey]);
    loopback.only().settle({ success: true, code: "synthetic-build", redirectUri: LOOPBACK });
    await expect(buildAnswer).resolves.toMatchObject({ code: "synthetic-build" });
    build.release();
  });

  it("takes every loopback down on teardown and stops answering", async () => {
    const { signInId } = expectAccountSignIn("studio", VIEW, PLUGIN, null);
    const answer = ask(signIn(signInId));
    dispose();
    await expect(answer).resolves.toEqual({ success: false, cause: "cancelled" });
    await expect(ask(signIn(signInId))).rejects.toMatchObject({ code: "UNSUPPORTED" });
    dispose = () => {};
  });
});
