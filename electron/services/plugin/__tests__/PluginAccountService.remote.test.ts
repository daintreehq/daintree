import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { createHash } from "crypto";
import type {
  PluginAccountContribution,
  PluginConnectionContribution,
  PluginManifest,
} from "../../../../shared/types/plugin.js";
import type { ClientEndpoint, EndpointRequestOptions } from "../../../ipc/endpoint.js";
import type { SecretCipher } from "../secretCipher.js";
import type { AuthorizationCodeLoopbackResult } from "../../OAuthLoopbackService.js";

vi.mock("electron", () => ({
  app: undefined,
  net: { fetch: vi.fn() },
  safeStorage: {},
  shell: { openExternal: vi.fn() },
}));

const { PluginAccountService } = await import("../PluginAccountService.js");
const { remoteAccountSignIn, REMOTE_ACCOUNT_SIGN_IN_TIMEOUT_MS } =
  await import("../remoteAccountSignIn.js");

const PLUGIN_ID = "acme.tracker";
const TOKEN_URL = "https://auth.example.com/oauth/token";
const SHELL_REDIRECT = "http://127.0.0.1:50001/oauth/callback";

const OAUTH: PluginAccountContribution = {
  kind: "oauth2",
  label: "Tracker",
  authorizeUrl: "https://auth.example.com/oauth/authorize",
  tokenUrl: TOKEN_URL,
  clientId: "daintree-client",
  scopes: ["read"],
};
const WORK: PluginConnectionContribution = { ...OAUTH, id: "work", label: "Work" };
const PERSONAL: PluginConnectionContribution = { ...OAUTH, id: "personal", label: "Personal" };

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "daintree-plugin-remote-account-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

function fakeCipher(): SecretCipher {
  return {
    tier: () => "keychain",
    encrypt: async (plaintext) => Buffer.from(`enc:${plaintext}`, "utf-8").toString("base64"),
    decrypt: async (c) => ({
      plaintext: Buffer.from(c, "base64").toString("utf-8").slice("enc:".length),
      reencrypt: false,
    }),
  };
}

function manifest(
  contributes: Pick<PluginManifest["contributes"], "account" | "connections">
): PluginManifest {
  return {
    name: PLUGIN_ID,
    version: "1.0.0",
    contributes: {
      panels: [],
      toolbarButtons: [],
      menuItems: [],
      keybindings: [],
      contextMenus: [],
      commands: [],
      views: [],
      mcpServers: [],
      skills: [],
      forgeProviders: [],
      fileDecorationProviders: [],
      fileEditors: [],
      agents: [],
      processTools: [],
      recipes: [],
      ...contributes,
    },
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** One host: its own account files, its own token endpoint answers. */
function host(
  contributes: Pick<PluginManifest["contributes"], "account" | "connections">,
  name = "host"
) {
  const fetch = vi.fn<(url: string, init: RequestInit) => Promise<Response>>();
  const localLoopback = vi.fn();
  const cancelLoopback = vi.fn();
  const service = new PluginAccountService({
    getSettingsRoot: () => path.join(tmpDir, name, "plugin-settings"),
    getManifest: (id) => (id === PLUGIN_ID ? manifest(contributes) : undefined),
    cipher: fakeCipher(),
    fetch,
    now: () => 1_000_000,
    startLoopback: localLoopback as never,
    cancelLoopback,
  });
  /** The token endpoint issues `accessToken` for the next exchange. */
  const issue = (accessToken: string) =>
    fetch.mockResolvedValueOnce(
      jsonResponse({
        access_token: accessToken,
        refresh_token: `r-${accessToken}`,
        expires_in: 3600,
      })
    );
  return { service, fetch, localLoopback, cancelLoopback, issue };
}

interface SignInRequest {
  method: string;
  payload: { signInId: string; pluginId: string; connectionId: string | null; authUrl: string };
  options: EndpointRequestOptions | undefined;
  answer: (value: unknown) => void;
  fail: (code: string) => void;
}

/** A window on another machine: its endpoint as the host sees it, answering by hand. */
function remoteWindow() {
  const requests: SignInRequest[] = [];
  const request = vi.fn(
    (method: string, payload: unknown, options?: EndpointRequestOptions) =>
      new Promise<unknown>((resolve, reject) => {
        const fail = (code: string) => reject(Object.assign(new Error(code), { code }));
        options?.signal?.addEventListener("abort", () => fail("OUTCOME_UNKNOWN"), { once: true });
        requests.push({
          method,
          payload: payload as SignInRequest["payload"],
          options,
          answer: resolve,
          fail,
        });
      })
  );
  const endpoint = {
    endpointId: "s1:ep-1",
    clientId: "client-laptop",
    projectId: null,
    kind: "remote-view",
    handle: -7,
    send: vi.fn(),
    request,
    onClose: () => ({ dispose: () => {} }),
    isClosed: () => false,
  } as unknown as ClientEndpoint;
  const asked = async (count = 1) => {
    await vi.waitFor(() => expect(requests.length).toBeGreaterThanOrEqual(count));
    return requests[count - 1]!;
  };
  return { endpoint, requests, asked };
}

function caught(code: string, redirectUri = SHELL_REDIRECT) {
  return { success: true, code, redirectUri };
}

function tokenRequest(fetch: ReturnType<typeof vi.fn>, call = 0): URLSearchParams {
  const init = fetch.mock.calls[call]![1] as RequestInit;
  return new URLSearchParams(String(init.body ?? ""));
}

describe("PluginAccountService sign-in from a window on another machine (#14111)", () => {
  it("exchanges the code the window caught with a verifier that never left this host", async () => {
    const h = host({ account: OAUTH });
    const win = remoteWindow();
    h.issue("synthetic-at-1");
    const connecting = h.service.connect(
      PLUGIN_ID,
      undefined,
      remoteAccountSignIn(win.endpoint, PLUGIN_ID, undefined, "click-1")
    );

    const asked = await win.asked();
    expect(asked.method).toBe("plugin.account-sign-in");
    expect(asked.options?.timeoutMs).toBe(REMOTE_ACCOUNT_SIGN_IN_TIMEOUT_MS);
    expect(asked.payload.signInId).toBe("click-1");
    expect(asked.payload.pluginId).toBe(PLUGIN_ID);
    expect(asked.payload.connectionId).toBeNull();
    const authUrl = new URL(asked.payload.authUrl);
    expect(authUrl.searchParams.has("redirect_uri")).toBe(false);
    expect(authUrl.searchParams.get("code_challenge_method")).toBe("S256");
    asked.answer(caught("synthetic-code-1"));

    expect((await connecting).status).toBe("connected");
    expect(h.localLoopback).not.toHaveBeenCalled();
    const body = tokenRequest(h.fetch);
    expect(h.fetch.mock.calls[0]![0]).toBe(TOKEN_URL);
    expect(body.get("code")).toBe("synthetic-code-1");
    expect(body.get("redirect_uri")).toBe(SHELL_REDIRECT);
    expect(body.has("client_secret")).toBe(false);
    const verifier = body.get("code_verifier")!;
    expect(authUrl.searchParams.get("code_challenge")).toBe(
      createHash("sha256").update(verifier).digest("base64url")
    );
    // Nothing the window was sent could redeem the code without this host.
    expect(JSON.stringify(asked.payload)).not.toContain(verifier);
    expect(await h.service.getAccessToken(PLUGIN_ID)).toMatchObject({
      accessToken: "synthetic-at-1",
    });
  });

  it.each([
    "https://evil.example.com/oauth/callback",
    "http://localhost:50001/oauth/callback",
    "http://127.0.0.2:50001/oauth/callback",
    "http://[::1]:50001/oauth/callback",
    "http://2130706433:50001/oauth/callback",
    "http://user@127.0.0.1:50001/oauth/callback",
    "http://127.0.0.1:50001/other",
    "http://127.0.0.1:50001/oauth/callback?next=https://evil.example.com",
    "http://127.0.0.1:50001/oauth/callback#x",
    "http://127.0.0.1:0/oauth/callback",
    "http://127.0.0.1:70000/oauth/callback",
  ])("refuses a code that came back with the redirect %s", async (redirectUri) => {
    const h = host({ account: OAUTH });
    const win = remoteWindow();
    const connecting = h.service.connect(
      PLUGIN_ID,
      undefined,
      remoteAccountSignIn(win.endpoint, PLUGIN_ID, undefined, "click-1")
    );
    (await win.asked()).answer(caught("synthetic-code-1", redirectUri));

    expect(await connecting).toEqual({ status: "failed", message: "Couldn't start the sign-in" });
    expect(h.fetch).not.toHaveBeenCalled();
    expect((await h.service.getState(PLUGIN_ID)).connected).toBe(false);
  });

  it("refuses an answer that isn't a sign-in result", async () => {
    const h = host({ account: OAUTH });
    const win = remoteWindow();
    const connecting = h.service.connect(
      PLUGIN_ID,
      undefined,
      remoteAccountSignIn(win.endpoint, PLUGIN_ID, undefined, "click-1")
    );
    (await win.asked()).answer({ success: true, code: "", redirectUri: SHELL_REDIRECT });

    expect((await connecting).status).toBe("failed");
    expect(h.fetch).not.toHaveBeenCalled();
  });

  it("names a sign-in declined in the remote browser by its OAuth code only", async () => {
    const h = host({ account: OAUTH });
    const win = remoteWindow();
    const connecting = h.service.connect(
      PLUGIN_ID,
      undefined,
      remoteAccountSignIn(win.endpoint, PLUGIN_ID, undefined, "click-1")
    );
    (await win.asked()).answer({ success: false, cause: "denied", error: "access_denied" });

    expect(await connecting).toEqual({
      status: "failed",
      message: "Sign-in was declined in the browser",
    });
  });

  it("lets a newer Connect from another window supersede one still in its browser", async () => {
    const h = host({ account: OAUTH });
    const first = remoteWindow();
    const second = remoteWindow();
    const firstConnect = h.service.connect(
      PLUGIN_ID,
      undefined,
      remoteAccountSignIn(first.endpoint, PLUGIN_ID, undefined, "click-first")
    );
    const firstAsked = await first.asked();

    h.issue("synthetic-at-second");
    const secondConnect = h.service.connect(
      PLUGIN_ID,
      undefined,
      remoteAccountSignIn(second.endpoint, PLUGIN_ID, undefined, "click-second")
    );
    // The first window's browser half is stopped, not left to finish.
    expect(firstAsked.options?.signal?.aborted).toBe(true);
    expect(await firstConnect).toEqual({ status: "cancelled" });
    // A code the first window catches anyway goes nowhere.
    firstAsked.answer(caught("synthetic-code-first"));

    (await second.asked()).answer(caught("synthetic-code-second"));
    expect((await secondConnect).status).toBe("connected");
    expect(h.fetch).toHaveBeenCalledTimes(1);
    expect(tokenRequest(h.fetch).get("code")).toBe("synthetic-code-second");
    expect(await h.service.getAccessToken(PLUGIN_ID)).toMatchObject({
      accessToken: "synthetic-at-second",
    });
  });

  it("signs two windows in to two connections at once, each to its own", async () => {
    const h = host({ connections: [WORK, PERSONAL] });
    const laptop = remoteWindow();
    const desktop = remoteWindow();
    const work = h.service.connect(
      PLUGIN_ID,
      "work",
      remoteAccountSignIn(laptop.endpoint, PLUGIN_ID, "work", "click-work")
    );
    const personal = h.service.connect(
      PLUGIN_ID,
      "personal",
      remoteAccountSignIn(desktop.endpoint, PLUGIN_ID, "personal", "click-personal")
    );
    const workAsked = await laptop.asked();
    const personalAsked = await desktop.asked();
    expect(workAsked.payload.connectionId).toBe("work");
    expect(personalAsked.payload.connectionId).toBe("personal");
    expect(new URL(workAsked.payload.authUrl).searchParams.get("state")).not.toBe(
      new URL(personalAsked.payload.authUrl).searchParams.get("state")
    );

    h.issue("synthetic-at-personal");
    personalAsked.answer(caught("synthetic-code-personal"));
    expect((await personal).status).toBe("connected");
    h.issue("synthetic-at-work");
    workAsked.answer(caught("synthetic-code-work", "http://127.0.0.1:50002/oauth/callback"));
    expect((await work).status).toBe("connected");

    expect((await h.service.getAccessToken(PLUGIN_ID, "work"))?.accessToken).toBe(
      "synthetic-at-work"
    );
    expect((await h.service.getAccessToken(PLUGIN_ID, "personal"))?.accessToken).toBe(
      "synthetic-at-personal"
    );
  });

  it("stops the window's browser half on Cancel and stores nothing that arrives late", async () => {
    const h = host({ account: OAUTH });
    const win = remoteWindow();
    const connecting = h.service.connect(
      PLUGIN_ID,
      undefined,
      remoteAccountSignIn(win.endpoint, PLUGIN_ID, undefined, "click-1")
    );
    const asked = await win.asked();
    expect((await h.service.getUiStatus(PLUGIN_ID))?.pending).toBe(true);

    h.service.cancelConnect(PLUGIN_ID);
    expect(asked.options?.signal?.aborted).toBe(true);
    asked.answer(caught("synthetic-code-late"));

    expect(await connecting).toEqual({ status: "cancelled" });
    expect(h.fetch).not.toHaveBeenCalled();
    expect((await h.service.getUiStatus(PLUGIN_ID))?.pending).toBe(false);
  });

  it("stores nothing when the account is disconnected while the window's browser is open", async () => {
    const h = host({ account: OAUTH });
    const win = remoteWindow();
    const connecting = h.service.connect(
      PLUGIN_ID,
      undefined,
      remoteAccountSignIn(win.endpoint, PLUGIN_ID, undefined, "click-1")
    );
    const asked = await win.asked();

    await h.service.disconnect(PLUGIN_ID);
    expect(asked.options?.signal?.aborted).toBe(true);
    expect(await connecting).toEqual({ status: "cancelled" });
    expect(h.fetch).not.toHaveBeenCalled();
    expect((await h.service.getState(PLUGIN_ID)).connected).toBe(false);
  });

  it("ends a window's sign-in when the plugin unloads", async () => {
    const h = host({ account: OAUTH });
    const win = remoteWindow();
    const connecting = h.service.connect(
      PLUGIN_ID,
      undefined,
      remoteAccountSignIn(win.endpoint, PLUGIN_ID, undefined, "click-1")
    );
    const asked = await win.asked();

    h.service.clearPluginState(PLUGIN_ID);
    expect(asked.options?.signal?.aborted).toBe(true);
    expect(await connecting).toEqual({ status: "cancelled" });
    expect(h.fetch).not.toHaveBeenCalled();
  });

  it("fails a sign-in whose window lost its link, and stores nothing", async () => {
    const h = host({ account: OAUTH });
    const win = remoteWindow();
    const connecting = h.service.connect(
      PLUGIN_ID,
      undefined,
      remoteAccountSignIn(win.endpoint, PLUGIN_ID, undefined, "click-1")
    );
    (await win.asked()).fail("HOST_DISCONNECTED");

    expect(await connecting).toEqual({
      status: "failed",
      message: "The window signing in lost its connection to this machine",
    });
    expect(h.fetch).not.toHaveBeenCalled();
    expect((await h.service.getUiStatus(PLUGIN_ID))?.pending).toBe(false);
  });

  it("drops a sign-in whose window moved to another project meanwhile", async () => {
    const h = host({ account: OAUTH });
    const win = remoteWindow();
    const connecting = h.service.connect(
      PLUGIN_ID,
      undefined,
      remoteAccountSignIn(win.endpoint, PLUGIN_ID, undefined, "click-1")
    );
    (await win.asked()).fail("STALE_GENERATION");

    expect(await connecting).toEqual({ status: "cancelled" });
    expect(h.fetch).not.toHaveBeenCalled();
  });

  it("fails a sign-in the window refused to open", async () => {
    const h = host({ account: OAUTH });
    const win = remoteWindow();
    const connecting = h.service.connect(
      PLUGIN_ID,
      undefined,
      remoteAccountSignIn(win.endpoint, PLUGIN_ID, undefined, "click-1")
    );
    (await win.asked()).fail("PERMISSION");

    expect(await connecting).toEqual({ status: "failed", message: "Couldn't start the sign-in" });
  });

  it("reports a window that never answered as timed out", async () => {
    const h = host({ account: OAUTH });
    const win = remoteWindow();
    const connecting = h.service.connect(
      PLUGIN_ID,
      undefined,
      remoteAccountSignIn(win.endpoint, PLUGIN_ID, undefined, "click-1")
    );
    (await win.asked()).fail("OUTCOME_UNKNOWN");

    expect(await connecting).toEqual({
      status: "failed",
      message: "Sign-in timed out before the browser came back to Daintree",
    });
  });

  it("replaces the tokens when the account is reconnected from another machine", async () => {
    const h = host({ account: OAUTH });
    const win = remoteWindow();
    h.issue("synthetic-at-1");
    const first = h.service.connect(
      PLUGIN_ID,
      undefined,
      remoteAccountSignIn(win.endpoint, PLUGIN_ID, undefined, "click-1")
    );
    (await win.asked(1)).answer(caught("synthetic-code-1"));
    expect((await first).status).toBe("connected");

    h.issue("synthetic-at-2");
    const second = h.service.connect(
      PLUGIN_ID,
      undefined,
      remoteAccountSignIn(win.endpoint, PLUGIN_ID, undefined, "click-1")
    );
    (await win.asked(2)).answer(caught("synthetic-code-2"));
    expect((await second).status).toBe("connected");
    expect(await h.service.getAccessToken(PLUGIN_ID)).toMatchObject({
      accessToken: "synthetic-at-2",
    });
  });

  it("keeps each host's connection on that host", async () => {
    const studio = host({ account: OAUTH }, "studio");
    const build = host({ account: OAUTH }, "build");
    const studioWindow = remoteWindow();
    const buildWindow = remoteWindow();
    studio.issue("synthetic-at-studio");
    build.issue("synthetic-at-build");
    const onStudio = studio.service.connect(
      PLUGIN_ID,
      undefined,
      remoteAccountSignIn(studioWindow.endpoint, PLUGIN_ID, undefined, "click-studio")
    );
    const onBuild = build.service.connect(
      PLUGIN_ID,
      undefined,
      remoteAccountSignIn(buildWindow.endpoint, PLUGIN_ID, undefined, "click-build")
    );
    const studioAsked = await studioWindow.asked();
    const buildAsked = await buildWindow.asked();
    buildAsked.answer(caught("synthetic-code-build"));
    studioAsked.answer(caught("synthetic-code-studio"));
    expect((await onStudio).status).toBe("connected");
    expect((await onBuild).status).toBe("connected");

    expect(tokenRequest(studio.fetch).get("code")).toBe("synthetic-code-studio");
    expect(tokenRequest(build.fetch).get("code")).toBe("synthetic-code-build");
    expect((await studio.service.getAccessToken(PLUGIN_ID))?.accessToken).toBe(
      "synthetic-at-studio"
    );
    expect((await build.service.getAccessToken(PLUGIN_ID))?.accessToken).toBe("synthetic-at-build");
  });
});

/**
 * A browser half that ignores being stopped and comes back with a code
 * anyway: what reaches the host from a window that answered after its
 * sign-in was ended. Only the host's own stale check stands in the way.
 */
function stubbornBroker() {
  let finish: ((code: string) => void) | null = null;
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => (markStarted = resolve));
  const broker = {
    start: vi.fn(
      () =>
        new Promise<AuthorizationCodeLoopbackResult>((resolve) => {
          finish = (code) => resolve({ success: true, code, redirectUri: SHELL_REDIRECT });
          markStarted();
        })
    ),
    cancel: vi.fn(),
  };
  return { broker, started, finish: (code: string) => finish?.(code) };
}

type Host = ReturnType<typeof host>;

describe("PluginAccountService against a window that answers after it was stopped (#14111)", () => {
  const stops: Array<[string, (h: Host) => unknown]> = [
    ["Cancel", (h) => h.service.cancelConnect(PLUGIN_ID)],
    ["Disconnect", (h) => h.service.disconnect(PLUGIN_ID)],
    ["the plugin unloading", (h) => h.service.clearPluginState(PLUGIN_ID)],
  ];
  it.each(stops)("never exchanges a code that comes back after %s", async (_name, stop) => {
    const h = host({ account: OAUTH });
    const late = stubbornBroker();
    const connecting = h.service.connect(PLUGIN_ID, undefined, late.broker);
    await late.started;

    const stopping = stop(h);
    expect(late.broker.cancel).toHaveBeenCalled();
    late.finish("synthetic-code-late");
    await stopping;

    expect(await connecting).toEqual({ status: "cancelled" });
    expect(h.fetch).not.toHaveBeenCalled();
    expect((await h.service.getState(PLUGIN_ID)).connected).toBe(false);
  });

  it("lets a sign-in on this machine supersede one another window is running", async () => {
    const h = host({ account: OAUTH });
    const late = stubbornBroker();
    const remote = h.service.connect(PLUGIN_ID, undefined, late.broker);
    await late.started;
    h.localLoopback.mockImplementation(
      async (_key: string, _state: string, build: (uri: string) => string) => {
        build("http://127.0.0.1:43123/oauth/callback");
        return {
          success: true,
          code: "synthetic-code-local",
          redirectUri: "http://127.0.0.1:43123/oauth/callback",
        };
      }
    );

    h.issue("synthetic-at-local");
    const local = h.service.connect(PLUGIN_ID);
    expect(late.broker.cancel).toHaveBeenCalled();
    late.finish("synthetic-code-remote");

    expect(await remote).toEqual({ status: "cancelled" });
    expect((await local).status).toBe("connected");
    expect(h.fetch).toHaveBeenCalledTimes(1);
    expect(tokenRequest(h.fetch).get("code")).toBe("synthetic-code-local");
  });

  it("lets another window supersede a sign-in running on this machine", async () => {
    const h = host({ account: OAUTH });
    let finishLocal!: (result: AuthorizationCodeLoopbackResult) => void;
    h.localLoopback.mockImplementation(
      () => new Promise<AuthorizationCodeLoopbackResult>((resolve) => (finishLocal = resolve))
    );
    const local = h.service.connect(PLUGIN_ID);
    await vi.waitFor(() => expect(h.localLoopback).toHaveBeenCalled());

    const win = remoteWindow();
    h.issue("synthetic-at-remote");
    const remote = h.service.connect(
      PLUGIN_ID,
      undefined,
      remoteAccountSignIn(win.endpoint, PLUGIN_ID, undefined, "click-1")
    );
    // This machine's loopback comes down; the code it catches anyway goes nowhere.
    expect(h.cancelLoopback).toHaveBeenCalledWith(h.localLoopback.mock.calls[0]![0]);
    finishLocal({
      success: true,
      code: "synthetic-code-local",
      redirectUri: "http://127.0.0.1:43123/oauth/callback",
    });
    (await win.asked()).answer(caught("synthetic-code-remote"));

    expect(await local).toEqual({ status: "cancelled" });
    expect((await remote).status).toBe("connected");
    expect(h.fetch).toHaveBeenCalledTimes(1);
    expect(tokenRequest(h.fetch).get("code")).toBe("synthetic-code-remote");
  });
});
