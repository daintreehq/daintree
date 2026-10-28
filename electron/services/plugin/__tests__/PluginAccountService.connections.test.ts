import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs/promises";
import path from "path";
import os from "os";
import type {
  PluginAccountContribution,
  PluginAccountState,
  PluginConnectionContribution,
  PluginManifest,
} from "../../../../shared/types/plugin.js";
import type { SecretCipher } from "../secretCipher.js";

vi.mock("electron", () => ({
  app: undefined,
  net: { fetch: vi.fn() },
  safeStorage: {},
  shell: { openExternal: vi.fn() },
}));

const { PluginAccountService } = await import("../PluginAccountService.js");

const PLUGIN_ID = "acme.tracker";
const PROJECT_A = "a".repeat(64);
const PROJECT_B = "b".repeat(64);
const PROJECT_PLUGIN_A = `project__${PROJECT_A}__${PLUGIN_ID}`;
const TOKEN_URL = "https://auth.example.com/oauth/token";
const TEST_URL = "https://api.example.com/ping";

const TOKEN_BASE: PluginAccountContribution = {
  kind: "token",
  label: "Tracker",
  test: { url: TEST_URL },
};

const OAUTH_BASE: PluginAccountContribution = {
  kind: "oauth2",
  label: "Tracker",
  authorizeUrl: "https://auth.example.com/oauth/authorize",
  tokenUrl: TOKEN_URL,
  clientId: "daintree-client",
  scopes: ["read"],
};

const WORK: PluginConnectionContribution = { ...TOKEN_BASE, id: "work", label: "Work" };
const PERSONAL: PluginConnectionContribution = {
  ...TOKEN_BASE,
  id: "personal",
  label: "Personal",
};

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "daintree-plugin-connections-"));
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function harness(manifests: Record<string, PluginManifest | undefined>) {
  let now = 1_000_000;
  const changes: string[] = [];
  const fetch = vi.fn<(url: string, init: RequestInit) => Promise<Response>>(async () =>
    jsonResponse({}, 200)
  );
  const service = new PluginAccountService({
    getSettingsRoot: () => path.join(tmpDir, "plugin-settings"),
    getManifest: (id) => manifests[id],
    onAccountChanged: (id) => changes.push(id),
    cipher: fakeCipher(),
    fetch,
    now: () => now,
    startLoopback: (async (
      _key: string,
      _state: string,
      build: (redirectUri: string) => string
    ) => {
      const redirectUri = "http://127.0.0.1:43123/oauth/callback";
      build(redirectUri);
      return { success: true, code: "code-1", redirectUri };
    }) as never,
    cancelLoopback: vi.fn(),
  });
  return {
    service,
    fetch,
    changes,
    manifests,
    setNow: (ms: number) => (now = ms),
    readFile: async (pluginId: string) =>
      JSON.parse(
        await fs.readFile(
          path.join(tmpDir, "plugin-settings", "accounts", `${pluginId}.json`),
          "utf8"
        )
      ) as Record<string, unknown>,
  };
}

describe("PluginAccountService named connections (#14102)", () => {
  it("keeps a contributes.account record readable as the default connection", async () => {
    const h = harness({ [PLUGIN_ID]: manifest({ account: TOKEN_BASE }) });
    await h.service.setToken(PLUGIN_ID, "synthetic-legacy-token");
    expect(Object.keys(await h.readFile(PLUGIN_ID)).sort()).toEqual(["config", "credentials"]);

    // The author moves to the keyed form under the same id: nothing to migrate.
    h.manifests[PLUGIN_ID] = manifest({ connections: [{ ...TOKEN_BASE, id: "default" }] });
    expect(await h.service.getState(PLUGIN_ID, "default")).toEqual({
      connected: true,
      identity: null,
    });
    expect(await h.service.getAccessTokenFor(PLUGIN_ID)).toEqual({
      accessToken: "synthetic-legacy-token",
      expiresAt: null,
    });
  });

  it("signs in and disconnects each connection on its own", async () => {
    const h = harness({ [PLUGIN_ID]: manifest({ connections: [WORK, PERSONAL] }) });
    await h.service.setToken(PLUGIN_ID, "synthetic-work", "work");
    await h.service.setToken(PLUGIN_ID, "synthetic-personal", "personal");

    expect((await h.service.getAccessToken(PLUGIN_ID, "work"))?.accessToken).toBe("synthetic-work");
    await h.service.disconnect(PLUGIN_ID, "work");
    expect(await h.service.getAccessToken(PLUGIN_ID, "work")).toBeNull();
    expect((await h.service.getAccessToken(PLUGIN_ID, "personal"))?.accessToken).toBe(
      "synthetic-personal"
    );
    const statuses = await h.service.listUiStatus(PLUGIN_ID);
    expect(statuses.map((s) => [s.connectionId, s.connected])).toEqual([
      ["work", false],
      ["personal", true],
    ]);
    expect(JSON.stringify(statuses)).not.toContain("synthetic-");
  });

  it("refuses a connection the plugin doesn't declare", async () => {
    const h = harness({ [PLUGIN_ID]: manifest({ connections: [WORK] }) });
    await expect(h.service.getAccessTokenFor(PLUGIN_ID, { connection: "other" })).rejects.toThrow(
      /declares no connection "other"/
    );
    await expect(h.service.setToken(PLUGIN_ID, "x", "../evil")).rejects.toThrow(/malformed/);
  });

  it("routes an installed plugin's calls through each project's binding", async () => {
    const h = harness({ [PLUGIN_ID]: manifest({ connections: [WORK, PERSONAL] }) });
    await h.service.setToken(PLUGIN_ID, "synthetic-work", "work");
    await h.service.setToken(PLUGIN_ID, "synthetic-personal", "personal");
    await h.service.setBinding(PLUGIN_ID, PROJECT_A, { connectionId: "personal", source: "own" });

    const token = async (projectId?: string) =>
      (await h.service.getAccessTokenFor(PLUGIN_ID, projectId ? { projectId } : {}))?.accessToken;
    expect(await token(PROJECT_A)).toBe("synthetic-personal");
    expect(await token(PROJECT_B)).toBe("synthetic-work");
    expect(await token()).toBe("synthetic-work");
    // A named connection always wins over the binding.
    expect(
      (await h.service.getAccessTokenFor(PLUGIN_ID, { connection: "work", projectId: PROJECT_A }))
        ?.accessToken
    ).toBe("synthetic-work");

    const status = await h.service.getBindingUiStatus(PLUGIN_ID, PROJECT_A);
    expect(status.binding).toEqual({ connectionId: "personal", source: "own" });
    expect(status.choices.map((c) => c.connectionId)).toEqual(["work", "personal"]);
    expect(JSON.stringify(status)).not.toContain("synthetic-");
  });

  it("never lets a project plugin speak for another project", async () => {
    const h = harness({ [PROJECT_PLUGIN_A]: manifest({ connections: [WORK] }) });
    await expect(
      h.service.getAccessTokenFor(PROJECT_PLUGIN_A, { projectId: PROJECT_B })
    ).rejects.toThrow(/another project/);
    await expect(
      h.service.setBinding(PROJECT_PLUGIN_A, PROJECT_B, { connectionId: "work", source: "own" })
    ).rejects.toThrow(/another project/);
    expect(() => h.service.subscribe(PROJECT_PLUGIN_A, () => {}, { projectId: PROJECT_B })).toThrow(
      /another project/
    );
  });

  it("lets a project plugin share the machine's connection only when declared the same way", async () => {
    const h = harness({
      [PLUGIN_ID]: manifest({ connections: [WORK] }),
      [PROJECT_PLUGIN_A]: manifest({ connections: [WORK] }),
    });
    await h.service.setToken(PLUGIN_ID, "synthetic-machine", "work");
    await h.service.setToken(PROJECT_PLUGIN_A, "synthetic-private", "work");

    expect((await h.service.getAccessTokenFor(PROJECT_PLUGIN_A))?.accessToken).toBe(
      "synthetic-private"
    );
    await h.service.setBinding(PROJECT_PLUGIN_A, PROJECT_A, {
      connectionId: "work",
      source: "machine",
    });
    expect((await h.service.getAccessTokenFor(PROJECT_PLUGIN_A))?.accessToken).toBe(
      "synthetic-machine"
    );

    // The installed plugin's declaration changes: the binding stays, but the
    // project gets nothing rather than tokens issued for something else.
    h.manifests[PLUGIN_ID] = manifest({
      connections: [{ ...WORK, test: { url: "https://other.example.com/ping" } }],
    });
    // Same fingerprint (test isn't part of it), so still shared.
    expect((await h.service.getAccessTokenFor(PROJECT_PLUGIN_A))?.accessToken).toBe(
      "synthetic-machine"
    );
    h.manifests[PLUGIN_ID] = manifest({ connections: [{ ...OAUTH_BASE, id: "work" }] });
    expect(await h.service.getAccessTokenFor(PROJECT_PLUGIN_A)).toBeNull();
    expect(await h.service.getStateFor(PROJECT_PLUGIN_A)).toEqual({
      connected: false,
      identity: null,
    });
    await expect(
      h.service.setBinding(PROJECT_PLUGIN_A, PROJECT_A, { connectionId: "work", source: "machine" })
    ).rejects.toThrow(/no matching connection/);
  });

  it("refuses a machine binding for an installed plugin or a mismatched declaration", async () => {
    const h = harness({
      [PLUGIN_ID]: manifest({ connections: [{ ...OAUTH_BASE, id: "work" }] }),
      [PROJECT_PLUGIN_A]: manifest({ connections: [WORK] }),
    });
    await expect(
      h.service.setBinding(PLUGIN_ID, PROJECT_A, { connectionId: "work", source: "machine" })
    ).rejects.toThrow(/no matching connection/);
    await expect(
      h.service.setBinding(PROJECT_PLUGIN_A, PROJECT_A, { connectionId: "work", source: "machine" })
    ).rejects.toThrow(/no matching connection/);
    const status = await h.service.getBindingUiStatus(PROJECT_PLUGIN_A, PROJECT_A);
    expect(status.choices).toHaveLength(1);
  });

  it("restarts a token read whose project binding moved under it", async () => {
    const work = { ...OAUTH_BASE, id: "work", label: "Work" } as PluginConnectionContribution;
    const h = harness({ [PLUGIN_ID]: manifest({ connections: [work, PERSONAL] }) });
    h.fetch.mockImplementation(async (url) =>
      url === TOKEN_URL
        ? jsonResponse({ access_token: "synthetic-work-1", refresh_token: "r1", expires_in: 3600 })
        : jsonResponse({})
    );
    await h.service.connect(PLUGIN_ID, "work");
    await h.service.setToken(PLUGIN_ID, "synthetic-personal", "personal");

    h.setNow(1_000_000 + 3_600_000);
    const refresh = deferred<Response>();
    h.fetch.mockClear();
    h.fetch.mockImplementation(async (url) =>
      url === TOKEN_URL ? refresh.promise : jsonResponse({})
    );
    const read = h.service.getAccessTokenFor(PLUGIN_ID, { projectId: PROJECT_A });
    await vi.waitFor(() => expect(h.fetch).toHaveBeenCalledWith(TOKEN_URL, expect.anything()));
    await h.service.setBinding(PLUGIN_ID, PROJECT_A, { connectionId: "personal", source: "own" });
    refresh.resolve(jsonResponse({ access_token: "synthetic-work-2", expires_in: 3600 }));

    expect((await read)?.accessToken).toBe("synthetic-personal");
  });

  it("spends a shared connection's refresh token once across projects", async () => {
    const work = { ...OAUTH_BASE, id: "work", label: "Work" } as PluginConnectionContribution;
    const h = harness({ [PLUGIN_ID]: manifest({ connections: [work] }) });
    h.fetch.mockImplementation(async (url) =>
      url === TOKEN_URL
        ? jsonResponse({ access_token: "synthetic-1", refresh_token: "r1", expires_in: 3600 })
        : jsonResponse({})
    );
    await h.service.connect(PLUGIN_ID, "work");
    h.setNow(1_000_000 + 3_600_000);
    h.fetch.mockClear();
    h.fetch.mockImplementation(async () =>
      jsonResponse({ access_token: "synthetic-2", refresh_token: "r2", expires_in: 3600 })
    );

    const [a, b] = await Promise.all([
      h.service.getAccessTokenFor(PLUGIN_ID, { projectId: PROJECT_A }),
      h.service.getAccessTokenFor(PLUGIN_ID, { projectId: PROJECT_B }),
    ]);
    expect(a?.accessToken).toBe("synthetic-2");
    expect(b?.accessToken).toBe("synthetic-2");
    expect(h.fetch).toHaveBeenCalledTimes(1);
    expect((await h.service.getUiStatus(PLUGIN_ID, "work"))?.verification.status).toBe("ok");
  });

  it("marks a revoked grant, keeps the binding, and leaves other connections alone", async () => {
    const work = { ...OAUTH_BASE, id: "work", label: "Work" } as PluginConnectionContribution;
    const h = harness({ [PLUGIN_ID]: manifest({ connections: [work, PERSONAL] }) });
    h.fetch.mockImplementation(async (url) =>
      url === TOKEN_URL
        ? jsonResponse({ access_token: "synthetic-1", refresh_token: "r1", expires_in: 3600 })
        : jsonResponse({})
    );
    await h.service.connect(PLUGIN_ID, "work");
    await h.service.setToken(PLUGIN_ID, "synthetic-personal", "personal");
    await h.service.setBinding(PLUGIN_ID, PROJECT_A, { connectionId: "work", source: "own" });
    h.setNow(1_000_000 + 3_600_000);
    h.fetch.mockImplementation(async () => jsonResponse({ error: "invalid_grant" }, 400));

    expect(await h.service.getAccessTokenFor(PLUGIN_ID, { projectId: PROJECT_A })).toBeNull();
    const status = await h.service.getUiStatus(PLUGIN_ID, "work");
    expect(status?.connected).toBe(false);
    expect(status?.verification.status).toBe("revoked");
    expect((await h.service.getBindingUiStatus(PLUGIN_ID, PROJECT_A)).binding).toEqual({
      connectionId: "work",
      source: "own",
    });
    expect((await h.service.getAccessToken(PLUGIN_ID, "personal"))?.accessToken).toBe(
      "synthetic-personal"
    );

    // Connecting the revoked one again clears its mark.
    h.fetch.mockImplementation(async () =>
      jsonResponse({ access_token: "synthetic-2", refresh_token: "r2", expires_in: 3600 })
    );
    expect((await h.service.connect(PLUGIN_ID, "work")).status).toBe("connected");
    const reconnected = await h.service.getUiStatus(PLUGIN_ID, "work");
    expect(reconnected?.connected).toBe(true);
    expect(reconnected?.verification.status).toBe("unchecked");
  });

  it("never writes a refresh that finishes after the connection was disconnected", async () => {
    const work = { ...OAUTH_BASE, id: "work", label: "Work" } as PluginConnectionContribution;
    const h = harness({ [PLUGIN_ID]: manifest({ connections: [work] }) });
    h.fetch.mockImplementation(async () =>
      jsonResponse({ access_token: "synthetic-1", refresh_token: "r1", expires_in: 3600 })
    );
    await h.service.connect(PLUGIN_ID, "work");
    h.setNow(1_000_000 + 3_600_000);
    const refresh = deferred<Response>();
    h.fetch.mockClear();
    h.fetch.mockImplementation(() => refresh.promise);

    const read = h.service.getAccessToken(PLUGIN_ID, "work");
    await vi.waitFor(() => expect(h.fetch).toHaveBeenCalled());
    await h.service.disconnect(PLUGIN_ID, "work");
    refresh.resolve(
      jsonResponse({ access_token: "synthetic-late", refresh_token: "r2", expires_in: 3600 })
    );

    expect(await read).toBeNull();
    expect(await h.service.getState(PLUGIN_ID, "work")).toEqual({
      connected: false,
      identity: null,
    });
    const file = await h.readFile(PLUGIN_ID);
    expect(Object.keys(file)).toEqual([]);
  });

  it("tests a connection and reports what the service said", async () => {
    const h = harness({ [PLUGIN_ID]: manifest({ connections: [WORK] }) });
    await h.service.setToken(PLUGIN_ID, "synthetic-work", "work");
    expect((await h.service.getUiStatus(PLUGIN_ID, "work"))?.verification.status).toBe("unchecked");

    h.fetch.mockImplementation(async () => new Response(null, { status: 204 }));
    expect((await h.service.testConnection(PLUGIN_ID, "work")).status).toBe("ok");
    const [url, init] = h.fetch.mock.calls.at(-1)!;
    expect(url).toBe(TEST_URL);
    expect(init.redirect).toBe("error");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer synthetic-work");

    h.fetch.mockImplementation(async () => new Response(null, { status: 401 }));
    const rejected = await h.service.testConnection(PLUGIN_ID, "work");
    expect(rejected.status).toBe("rejected");
    expect(rejected.message).not.toContain("synthetic-");
    // A refusal is shown, never acted on: the tokens stay until the user decides.
    expect((await h.service.getState(PLUGIN_ID, "work")).connected).toBe(true);

    h.fetch.mockImplementation(async () => {
      throw new Error("offline");
    });
    expect((await h.service.testConnection(PLUGIN_ID, "work")).status).toBe("unreachable");
  });

  it("drops a test result that lands after a new sign-in", async () => {
    const h = harness({ [PLUGIN_ID]: manifest({ connections: [WORK] }) });
    await h.service.setToken(PLUGIN_ID, "synthetic-old", "work");
    const answer = deferred<Response>();
    h.fetch.mockImplementation(() => answer.promise);
    const testing = h.service.testConnection(PLUGIN_ID, "work");
    await vi.waitFor(() => expect(h.fetch).toHaveBeenCalled());
    h.fetch.mockImplementation(async () => jsonResponse({}));
    await h.service.setToken(PLUGIN_ID, "synthetic-new", "work");
    answer.resolve(new Response(null, { status: 401 }));

    expect((await testing).status).toBe("unchecked");
    expect((await h.service.getUiStatus(PLUGIN_ID, "work"))?.verification.status).toBe("unchecked");
  });

  it("moves a subscription when the project's binding changes", async () => {
    const h = harness({
      [PLUGIN_ID]: manifest({ connections: [{ ...WORK, test: undefined }, PERSONAL] }),
    });
    await h.service.setToken(PLUGIN_ID, "synthetic-personal", "personal");
    const inA: PluginAccountState[] = [];
    const inB: PluginAccountState[] = [];
    h.service.subscribe(PLUGIN_ID, (state) => void inA.push(state), { projectId: PROJECT_A });
    h.service.subscribe(PLUGIN_ID, (state) => void inB.push(state), { projectId: PROJECT_B });

    await h.service.setBinding(PLUGIN_ID, PROJECT_A, { connectionId: "personal", source: "own" });
    await vi.waitFor(() => expect(inA).toEqual([{ connected: true, identity: null }]));
    expect(inB).toEqual([]);

    // Only the connection a subscriber resolves to reaches it.
    await h.service.setToken(PLUGIN_ID, "synthetic-work", "work");
    expect(inA).toHaveLength(1);
    expect(inB).toEqual([{ connected: true, identity: null }]);
    await h.service.disconnect(PLUGIN_ID, "personal");
    expect(inA.at(-1)).toEqual({ connected: false, identity: null });
    expect(h.changes).toContain(PLUGIN_ID);
  });

  it("unloading one instance keeps a shared connection's other listeners", async () => {
    const h = harness({
      [PLUGIN_ID]: manifest({ connections: [WORK] }),
      [PROJECT_PLUGIN_A]: manifest({ connections: [WORK] }),
    });
    await h.service.setBinding(PROJECT_PLUGIN_A, PROJECT_A, {
      connectionId: "work",
      source: "machine",
    });
    const machine: PluginAccountState[] = [];
    const project: PluginAccountState[] = [];
    h.service.subscribe(PLUGIN_ID, (state) => void machine.push(state));
    h.service.subscribe(PROJECT_PLUGIN_A, (state) => void project.push(state));
    h.service.clearPluginState(PLUGIN_ID);

    await h.service.setToken(PLUGIN_ID, "synthetic-machine", "work");
    expect(machine).toEqual([]);
    expect(project).toEqual([{ connected: true, identity: null }]);
    expect(h.changes).toContain(PROJECT_PLUGIN_A);
  });

  it("hands out nothing once the project's bound connection is no longer declared", async () => {
    const h = harness({ [PLUGIN_ID]: manifest({ connections: [WORK, PERSONAL] }) });
    await h.service.setToken(PLUGIN_ID, "synthetic-work", "work");
    await h.service.setBinding(PLUGIN_ID, PROJECT_A, { connectionId: "personal", source: "own" });

    const third: PluginConnectionContribution = { ...TOKEN_BASE, id: "third", label: "Third" };
    h.manifests[PLUGIN_ID] = manifest({ connections: [WORK, third] });
    expect(await h.service.getAccessTokenFor(PLUGIN_ID, { projectId: PROJECT_A })).toBeNull();
    const status = await h.service.getBindingUiStatus(PLUGIN_ID, PROJECT_A);
    expect(status.selected).toEqual({ connectionId: "personal", source: "own" });
    expect(status.choices.map((c) => c.connectionId)).toEqual(["work", "third"]);

    // With one connection left there is nothing to choose between.
    h.manifests[PLUGIN_ID] = manifest({ connections: [WORK] });
    expect(
      (await h.service.getAccessTokenFor(PLUGIN_ID, { projectId: PROJECT_A }))?.accessToken
    ).toBe("synthetic-work");
  });

  it("retries a failed read against the connection the project moved to", async () => {
    const work = { ...OAUTH_BASE, id: "work", label: "Work" } as PluginConnectionContribution;
    const h = harness({ [PLUGIN_ID]: manifest({ connections: [work, PERSONAL] }) });
    h.fetch.mockImplementation(async () =>
      jsonResponse({ access_token: "synthetic-work", refresh_token: "r1", expires_in: 3600 })
    );
    await h.service.connect(PLUGIN_ID, "work");
    await h.service.setToken(PLUGIN_ID, "synthetic-personal", "personal");
    h.setNow(1_000_000 + 3_600_000);
    const refresh = deferred<Response>();
    h.fetch.mockClear();
    h.fetch.mockImplementation(() => refresh.promise);

    const read = h.service.getAccessTokenFor(PLUGIN_ID, { projectId: PROJECT_A });
    await vi.waitFor(() => expect(h.fetch).toHaveBeenCalled());
    await h.service.setBinding(PLUGIN_ID, PROJECT_A, { connectionId: "personal", source: "own" });
    refresh.resolve(jsonResponse({ error: "server_error" }, 503));

    expect((await read)?.accessToken).toBe("synthetic-personal");
  });

  it("doesn't let a test of the old token speak for a refreshed one", async () => {
    const work = {
      ...OAUTH_BASE,
      id: "work",
      label: "Work",
      test: { url: TEST_URL },
    } as PluginConnectionContribution;
    const h = harness({ [PLUGIN_ID]: manifest({ connections: [work] }) });
    h.fetch.mockImplementation(async () =>
      jsonResponse({ access_token: "synthetic-1", refresh_token: "r1", expires_in: 3600 })
    );
    await h.service.connect(PLUGIN_ID, "work");

    const answer = deferred<Response>();
    h.fetch.mockClear();
    h.fetch.mockImplementation((url) =>
      url === TEST_URL
        ? answer.promise
        : Promise.resolve(
            jsonResponse({ access_token: "synthetic-2", refresh_token: "r2", expires_in: 3600 })
          )
    );
    const testing = h.service.testConnection(PLUGIN_ID, "work");
    await vi.waitFor(() => expect(h.fetch).toHaveBeenCalledWith(TEST_URL, expect.anything()));
    h.setNow(1_000_000 + 3_600_000);
    expect((await h.service.getAccessToken(PLUGIN_ID, "work"))?.accessToken).toBe("synthetic-2");
    answer.resolve(new Response(null, { status: 401 }));

    await testing;
    expect((await h.service.getUiStatus(PLUGIN_ID, "work"))?.verification.status).toBe("ok");
  });

  it("cancels the sign-in Connect started when neither names a connection", async () => {
    const work = { ...OAUTH_BASE, id: "work", label: "Work" } as PluginConnectionContribution;
    const h = harness({ [PLUGIN_ID]: manifest({ connections: [work] }) });
    const browser = deferred<never>();
    const service = new PluginAccountService({
      getSettingsRoot: () => path.join(tmpDir, "plugin-settings"),
      getManifest: (id) => h.manifests[id],
      cipher: fakeCipher(),
      fetch: h.fetch,
      startLoopback: (() => browser.promise) as never,
      cancelLoopback: vi.fn(),
    });
    const connecting = service.connect(PLUGIN_ID);
    await vi.waitFor(async () =>
      expect((await service.getUiStatus(PLUGIN_ID))?.pending).toBe(true)
    );
    service.cancelConnect(PLUGIN_ID);
    expect((await service.getUiStatus(PLUGIN_ID, "work"))?.pending).toBe(false);
    void connecting.catch(() => undefined);
  });

  it("delivers only the newest binding's state when reads finish out of order", async () => {
    const h = harness({ [PLUGIN_ID]: manifest({ connections: [WORK, PERSONAL] }) });
    await h.service.setToken(PLUGIN_ID, "synthetic-work", "work");
    const heard: PluginAccountState[] = [];
    h.service.subscribe(PLUGIN_ID, (state) => void heard.push(state), { projectId: PROJECT_A });

    const reads: Array<{
      id: string;
      settled: boolean;
      done: ReturnType<typeof deferred<PluginAccountState>>;
    }> = [];
    vi.spyOn(h.service, "getState").mockImplementation((_owner, connectionId) => {
      const done = deferred<PluginAccountState>();
      reads.push({ id: connectionId ?? "", settled: false, done });
      return done.promise;
    });
    const settle = async (id: string, state: PluginAccountState) => {
      for (let round = 0; round < 5; round++) {
        for (const read of reads.filter((r) => r.id === id && !r.settled)) {
          read.settled = true;
          read.done.resolve(state);
        }
        await new Promise((r) => setTimeout(r, 0));
      }
    };
    void h.service
      .setBinding(PLUGIN_ID, PROJECT_A, { connectionId: "personal", source: "own" })
      .catch(() => undefined);
    void h.service
      .setBinding(PLUGIN_ID, PROJECT_A, { connectionId: "work", source: "own" })
      .catch(() => undefined);

    // The newer binding's read finishes first; the older one's lands late.
    await settle("work", { connected: true, identity: "work-user" });
    await settle("personal", { connected: false, identity: "personal-user" });
    await settle("work", { connected: true, identity: "work-user" });
    expect(heard).toEqual([{ connected: true, identity: "work-user" }]);
    expect(heard.some((state) => state.identity === "personal-user")).toBe(false);
  });
});
