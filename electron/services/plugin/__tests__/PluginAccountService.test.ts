import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { createHash } from "crypto";
import type {
  PluginAccountContribution,
  PluginAccountState,
  PluginManifest,
} from "../../../../shared/types/plugin.js";
import type { SecretCipher } from "../secretCipher.js";
import type { AuthorizationCodeLoopbackResult } from "../../OAuthLoopbackService.js";

vi.mock("electron", () => ({
  app: undefined,
  net: { fetch: vi.fn() },
  safeStorage: {},
  shell: { openExternal: vi.fn() },
}));

const { PluginAccountService, ACCOUNT_REFRESH_SKEW_MS } =
  await import("../PluginAccountService.js");

const PLUGIN_ID = "acme.tracker";
const PROJECT_ID = "a".repeat(64);
const TOKEN_URL = "https://auth.example.com/oauth/token";

const OAUTH_ACCOUNT: PluginAccountContribution = {
  kind: "oauth2",
  label: "Tracker",
  authorizeUrl: "https://auth.example.com/oauth/authorize?prompt=consent",
  tokenUrl: TOKEN_URL,
  clientId: "daintree-client",
  scopes: ["read", "write"],
  identity: { url: "https://api.example.com/me", field: "user.login" },
};

const TOKEN_ACCOUNT: PluginAccountContribution = {
  kind: "token",
  label: "Tracker",
  identity: { url: "https://api.example.com/me", field: "user.login" },
};

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "daintree-plugin-account-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

function fakeCipher(available = true): SecretCipher {
  return {
    tier: () => (available ? "keychain" : "unavailable"),
    encrypt: async (plaintext) =>
      available ? Buffer.from(`enc:${plaintext}`, "utf-8").toString("base64") : null,
    decrypt: async (c) => ({
      plaintext: Buffer.from(c, "base64").toString("utf-8").slice("enc:".length),
      reencrypt: false,
    }),
  };
}

function manifestWith(account: PluginAccountContribution | undefined): PluginManifest {
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
      ...(account ? { account } : {}),
    },
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

interface Harness {
  service: InstanceType<typeof PluginAccountService>;
  fetch: ReturnType<typeof vi.fn>;
  loopback: ReturnType<typeof vi.fn>;
  changes: string[];
  setAccount(account: PluginAccountContribution | undefined): void;
  setNow(ms: number): void;
}

function harness(
  account: PluginAccountContribution | undefined,
  options: {
    cipher?: SecretCipher;
    loopbackResult?: (redirectUri: string) => AuthorizationCodeLoopbackResult;
  } = {}
): Harness {
  let manifest = manifestWith(account);
  let now = 1_000_000;
  const changes: string[] = [];
  const fetch = vi.fn<(url: string, init: RequestInit) => Promise<Response>>();
  const loopback = vi.fn(
    async (
      _key: string,
      _state: string,
      buildAuthUrl: (redirectUri: string) => string
    ): Promise<AuthorizationCodeLoopbackResult> => {
      const redirectUri = "http://127.0.0.1:43123/oauth/callback";
      buildAuthUrl(redirectUri);
      return (
        options.loopbackResult?.(redirectUri) ?? { success: true, code: "code-1", redirectUri }
      );
    }
  );
  const service = new PluginAccountService({
    getSettingsRoot: () => path.join(tmpDir, "plugin-settings"),
    getManifest: (id) => (id === PLUGIN_ID || id.endsWith(`__${PLUGIN_ID}`) ? manifest : undefined),
    onAccountChanged: (id) => changes.push(id),
    cipher: options.cipher ?? fakeCipher(),
    fetch,
    now: () => now,
    startLoopback: loopback as never,
    cancelLoopback: vi.fn(),
  });
  return {
    service,
    fetch,
    loopback,
    changes,
    setAccount: (next) => {
      manifest = manifestWith(next);
    },
    setNow: (ms) => {
      now = ms;
    },
  };
}

function requestBody(init: RequestInit | undefined): URLSearchParams {
  return new URLSearchParams(String(init?.body ?? ""));
}

async function connectOAuth(
  h: Harness,
  tokens: Record<string, unknown> = {
    access_token: "at-1",
    refresh_token: "rt-1",
    expires_in: 3600,
    token_type: "Bearer",
  }
) {
  h.fetch.mockResolvedValueOnce(jsonResponse(tokens));
  h.fetch.mockResolvedValueOnce(jsonResponse({ user: { login: "octo" } }));
  return h.service.connect(PLUGIN_ID);
}

describe("PluginAccountService OAuth sign-in", () => {
  it("sends an S256 PKCE request and exchanges the code only with the declared token URL", async () => {
    const h = harness(OAUTH_ACCOUNT);
    const result = await connectOAuth(h);
    expect(result.status).toBe("connected");

    const buildAuthUrl = h.loopback.mock.calls[0]![2] as (uri: string) => string;
    const authUrl = new URL(buildAuthUrl("http://127.0.0.1:43123/oauth/callback"));
    expect(authUrl.origin + authUrl.pathname).toBe("https://auth.example.com/oauth/authorize");
    // The manifest's own query survives.
    expect(authUrl.searchParams.get("prompt")).toBe("consent");
    expect(authUrl.searchParams.get("response_type")).toBe("code");
    expect(authUrl.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authUrl.searchParams.get("scope")).toBe("read write");
    expect(authUrl.searchParams.get("state")).toBe(h.loopback.mock.calls[0]![1]);

    const [tokenUrl, init] = h.fetch.mock.calls[0]!;
    expect(tokenUrl).toBe(TOKEN_URL);
    expect(init.method).toBe("POST");
    expect(init.redirect).toBe("error");
    const body = requestBody(init);
    expect(body.get("grant_type")).toBe("authorization_code");
    expect(body.get("code")).toBe("code-1");
    expect(body.get("redirect_uri")).toBe("http://127.0.0.1:43123/oauth/callback");
    expect(body.has("client_secret")).toBe(false);
    const verifier = body.get("code_verifier")!;
    expect(verifier.length).toBeGreaterThanOrEqual(43);
    expect(authUrl.searchParams.get("code_challenge")).toBe(
      createHash("sha256").update(verifier).digest("base64url")
    );
  });

  it("reports the identity, notifies subscribers and never writes a token in plaintext", async () => {
    const h = harness(OAUTH_ACCOUNT);
    const seen: PluginAccountState[] = [];
    h.service.subscribe(PLUGIN_ID, (state) => seen.push(state));

    const result = await connectOAuth(h);

    expect(result).toMatchObject({
      status: "connected",
      account: { connected: true, identity: "octo", kind: "oauth2" },
    });
    expect(JSON.stringify(result)).not.toContain("at-1");
    expect(seen).toEqual([{ connected: true, identity: "octo" }]);
    expect(h.changes).toEqual([PLUGIN_ID]);
    const identityInit = h.fetch.mock.calls[1]![1];
    expect((identityInit.headers as Record<string, string>).Authorization).toBe("Bearer at-1");
    const raw = await fs.readFile(h.service.accountFilePath(PLUGIN_ID), "utf-8");
    expect(raw).not.toContain("at-1");
    expect(raw).not.toContain("rt-1");
  });

  it("stays connected without a name when the identity lookup fails", async () => {
    const h = harness(OAUTH_ACCOUNT);
    h.fetch.mockResolvedValueOnce(jsonResponse({ access_token: "at-1" }));
    h.fetch.mockRejectedValueOnce(new Error("offline"));
    await h.service.connect(PLUGIN_ID);
    expect(await h.service.getState(PLUGIN_ID)).toEqual({ connected: true, identity: null });
  });

  it("names a declined sign-in and stores nothing", async () => {
    const h = harness(OAUTH_ACCOUNT, {
      loopbackResult: () => ({ success: false, cause: "denied", error: "access_denied" }),
    });
    const result = await h.service.connect(PLUGIN_ID);
    expect(result).toEqual({ status: "failed", message: "Sign-in was declined in the browser" });
    expect(h.fetch).not.toHaveBeenCalled();
    expect((await h.service.getState(PLUGIN_ID)).connected).toBe(false);
  });

  it("reads a cancelled sign-in as cancelled, not failed", async () => {
    const h = harness(OAUTH_ACCOUNT, {
      loopbackResult: () => ({ success: false, cause: "cancelled" }),
    });
    expect(await h.service.connect(PLUGIN_ID)).toEqual({ status: "cancelled" });
  });

  it("refuses to start without an OS keychain", async () => {
    const h = harness(OAUTH_ACCOUNT, { cipher: fakeCipher(false) });
    const result = await h.service.connect(PLUGIN_ID);
    expect(result.status).toBe("failed");
    expect(h.loopback).not.toHaveBeenCalled();
  });

  it("does not send the code when the token URL changed while the browser was open", async () => {
    const h = harness(OAUTH_ACCOUNT, {
      loopbackResult: (redirectUri) => {
        h.setAccount({ ...OAUTH_ACCOUNT, tokenUrl: "https://other.example.com/token" });
        return { success: true, code: "code-1", redirectUri };
      },
    });
    const result = await h.service.connect(PLUGIN_ID);
    expect(result.status).toBe("failed");
    expect(h.fetch).not.toHaveBeenCalled();
  });

  it("surfaces the OAuth error code from a refused exchange, not its free text", async () => {
    const h = harness(OAUTH_ACCOUNT);
    h.fetch.mockResolvedValueOnce(
      jsonResponse({ error: "invalid_client", error_description: "secret at-1 leaked" }, 401)
    );
    const result = await h.service.connect(PLUGIN_ID);
    expect(result).toEqual({
      status: "failed",
      message: "The service refused the request (invalid_client)",
    });
  });
});

describe("PluginAccountService access tokens", () => {
  it("hands back the stored token while it is fresh", async () => {
    const h = harness(OAUTH_ACCOUNT);
    await connectOAuth(h);
    expect(await h.service.getAccessToken(PLUGIN_ID)).toEqual({
      accessToken: "at-1",
      expiresAt: 1_000_000 + 3_600_000,
    });
    expect(h.fetch).toHaveBeenCalledTimes(2);
  });

  it("refreshes once for concurrent callers inside the expiry skew and keeps a rotated refresh token", async () => {
    const h = harness(OAUTH_ACCOUNT);
    await connectOAuth(h);
    h.setNow(1_000_000 + 3_600_000 - ACCOUNT_REFRESH_SKEW_MS + 1);
    let answer!: (r: Response) => void;
    h.fetch.mockReturnValueOnce(new Promise<Response>((resolve) => (answer = resolve)));

    const first = h.service.getAccessToken(PLUGIN_ID);
    const second = h.service.getAccessToken(PLUGIN_ID);
    await vi.waitFor(() => expect(h.fetch).toHaveBeenCalledTimes(3));
    answer(jsonResponse({ access_token: "at-2", refresh_token: "rt-2", expires_in: 60 }));

    const [a, b] = await Promise.all([first, second]);
    expect(a?.accessToken).toBe("at-2");
    expect(b?.accessToken).toBe("at-2");
    const body = requestBody(h.fetch.mock.calls[2]![1]);
    expect(body.get("grant_type")).toBe("refresh_token");
    expect(body.get("refresh_token")).toBe("rt-1");

    // The rotated refresh token is the one used next time.
    h.setNow(10_000_000);
    h.fetch.mockResolvedValueOnce(jsonResponse({ access_token: "at-3", expires_in: 60 }));
    await h.service.getAccessToken(PLUGIN_ID);
    expect(requestBody(h.fetch.mock.calls[3]![1]).get("refresh_token")).toBe("rt-2");

    // A response without a new refresh token keeps the last one.
    h.setNow(20_000_000);
    h.fetch.mockResolvedValueOnce(jsonResponse({ access_token: "at-4", expires_in: 60 }));
    await h.service.getAccessToken(PLUGIN_ID);
    expect(requestBody(h.fetch.mock.calls[4]![1]).get("refresh_token")).toBe("rt-2");
  });

  it("disconnects when the service answers invalid_grant", async () => {
    const h = harness(OAUTH_ACCOUNT);
    await connectOAuth(h);
    const seen: PluginAccountState[] = [];
    h.service.subscribe(PLUGIN_ID, (state) => seen.push(state));
    h.setNow(10_000_000);
    h.fetch.mockResolvedValueOnce(jsonResponse({ error: "invalid_grant" }, 400));

    expect(await h.service.getAccessToken(PLUGIN_ID)).toBeNull();
    expect(seen).toEqual([{ connected: false, identity: null }]);
    expect(await h.service.getState(PLUGIN_ID)).toEqual({ connected: false, identity: null });
  });

  it("keeps the account through a refresh that fails for a reason that may pass", async () => {
    const h = harness(OAUTH_ACCOUNT);
    await connectOAuth(h);
    h.setNow(10_000_000);
    h.fetch.mockRejectedValueOnce(new TypeError("fetch failed"));

    await expect(h.service.getAccessToken(PLUGIN_ID)).rejects.toThrow("Couldn't reach the service");
    expect((await h.service.getState(PLUGIN_ID)).connected).toBe(true);
  });

  it("drops a refresh that lands after a disconnect", async () => {
    const h = harness(OAUTH_ACCOUNT);
    await connectOAuth(h);
    h.setNow(10_000_000);
    let answer!: (r: Response) => void;
    h.fetch.mockReturnValueOnce(new Promise<Response>((resolve) => (answer = resolve)));
    const pending = h.service.getAccessToken(PLUGIN_ID);
    await vi.waitFor(() => expect(h.fetch).toHaveBeenCalledTimes(3));

    await h.service.disconnect(PLUGIN_ID);
    answer(jsonResponse({ access_token: "at-late", refresh_token: "rt-late" }));

    expect(await pending).toBeNull();
    expect((await h.service.getState(PLUGIN_ID)).connected).toBe(false);
    const raw = await fs.readFile(h.service.accountFilePath(PLUGIN_ID), "utf-8");
    expect(JSON.parse(raw)).toEqual({});
  });

  it("does not hand tokens issued for an earlier account declaration to a changed one", async () => {
    const h = harness(OAUTH_ACCOUNT);
    await connectOAuth(h);
    h.setAccount({ ...OAUTH_ACCOUNT, scopes: ["read", "write", "admin"] });

    expect((await h.service.getState(PLUGIN_ID)).connected).toBe(false);
    expect(await h.service.getAccessToken(PLUGIN_ID)).toBeNull();
  });

  it("rejects for a plugin that declares no account", async () => {
    const h = harness(undefined);
    await expect(h.service.getAccessToken(PLUGIN_ID)).rejects.toThrow(
      "declares no contributes.account"
    );
  });
});

describe("PluginAccountService pasted tokens", () => {
  it("refuses a token the identity endpoint rejects and stores nothing", async () => {
    const h = harness(TOKEN_ACCOUNT);
    h.fetch.mockResolvedValueOnce(jsonResponse({ message: "Bad credentials" }, 401));
    await expect(h.service.setToken(PLUGIN_ID, "pat-bad")).rejects.toThrow(
      "The service didn't accept this token"
    );
    expect((await h.service.getState(PLUGIN_ID)).connected).toBe(false);
  });

  it("stores an accepted token and returns it without expiry", async () => {
    const h = harness(TOKEN_ACCOUNT);
    h.fetch.mockResolvedValueOnce(jsonResponse({ user: { login: "octo" } }));
    const status = await h.service.setToken(PLUGIN_ID, "  pat-good  ");
    expect(status).toMatchObject({ connected: true, identity: "octo", kind: "token" });
    expect(await h.service.getAccessToken(PLUGIN_ID)).toEqual({
      accessToken: "pat-good",
      expiresAt: null,
    });
  });

  it("refuses a sign-in for a token account and a token for an OAuth account", async () => {
    await expect(harness(TOKEN_ACCOUNT).service.connect(PLUGIN_ID)).rejects.toThrow();
    await expect(harness(OAUTH_ACCOUNT).service.setToken(PLUGIN_ID, "x")).rejects.toThrow();
  });
});

describe("PluginAccountService scoping", () => {
  it("keeps a project plugin's account apart from the installed plugin's", async () => {
    const h = harness(TOKEN_ACCOUNT);
    const projectPlugin = `project__${PROJECT_ID}__${PLUGIN_ID}`;
    h.fetch.mockResolvedValueOnce(jsonResponse({ user: { login: "octo" } }));
    await h.service.setToken(projectPlugin, "pat-project");

    expect(h.service.accountFilePath(projectPlugin)).not.toBe(h.service.accountFilePath(PLUGIN_ID));
    expect((await h.service.getState(projectPlugin)).connected).toBe(true);
    expect((await h.service.getState(PLUGIN_ID)).connected).toBe(false);
  });

  it("refuses an id that isn't a plugin instance id", () => {
    const h = harness(TOKEN_ACCOUNT);
    expect(() => h.service.accountFilePath("../escape")).toThrow();
  });
});
