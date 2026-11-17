import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { getPluginManifestSchema } from "../../../../../electron/schemas/plugin.js";
import { validateForgeImplRoles } from "../../../../../electron/services/forgeProviderRegistry.js";
import { DEFAULT_DISABLED_PLUGIN_IDS } from "../../../../../shared/config/pluginDefaults.js";
import { BUILTIN_JIRA_PROVIDER_ID } from "../../../../../shared/utils/forgeProviderIds.js";
import type { PluginHostApi } from "../../../../../shared/types/plugin.js";

const getProjectByPath = vi.fn();
let fetchMock: Mock<JiraFetch>;
const getSettingValuesForUi = vi.fn();

vi.mock("../../../../../electron/services/ProjectStore.js", () => ({
  projectStore: { getProjectByPath: (p: string) => getProjectByPath(p) },
}));

const updateForgeSettingsForAllProjects = vi.fn(async () => undefined);
vi.mock("../../../../../electron/services/WorkspaceClient.js", () => ({
  getWorkspaceClient: () => ({
    updateForgeSettingsForAllProjects: () => updateForgeSettingsForAllProjects(),
  }),
}));

vi.mock("../../../../../electron/services/PluginService.js", () => ({
  pluginService: {
    getSettingValuesForUi: (...args: unknown[]) => getSettingValuesForUi(...args),
  },
}));

import { activate } from "../index.js";
import { jiraForgeProvider } from "../forgeProvider.js";
import { digestToken, getToken, tokenMayGoTo } from "../JiraAuth.js";
import { setJiraTransport, type JiraFetch } from "../JiraClient.js";

function makeHost(settings: Record<string, unknown> = {}, storage: Record<string, unknown> = {}) {
  const register = vi.fn(async () => () => undefined);
  const storageApi = {
    get: vi.fn(async (key: string) => storage[key]),
    set: vi.fn(async (key: string, value: unknown) => {
      storage[key] = value;
    }),
    delete: vi.fn(async (key: string) => {
      delete storage[key];
    }),
  };
  const listeners = new Map<string, () => void>();
  const disposed: string[] = [];
  const onDidChange = vi.fn(async (key: string, callback: () => void) => {
    listeners.set(key, callback);
    return () => {
      disposed.push(key);
      listeners.delete(key);
    };
  });
  const get = vi.fn(async (key: string) => settings[key]);
  const host = {
    registerForgeProvider: register,
    settings: { get, onDidChange },
    storage: storageApi,
  } as unknown as PluginHostApi;
  return { host, register, listeners, disposed, get, storage, storageApi };
}

beforeEach(() => {
  getProjectByPath.mockReset();
  getSettingValuesForUi.mockReset();
  updateForgeSettingsForAllProjects.mockClear();
  fetchMock = vi.fn<JiraFetch>();
  setJiraTransport(fetchMock);
});

afterEach(() => {
  setJiraTransport(null);
});

describe("manifest", () => {
  const manifest = JSON.parse(readFileSync(resolve(__dirname, "../../plugin.json"), "utf8"));
  const provider = manifest.contributes.forgeProviders[0];

  it("is a manifest the host accepts", () => {
    const parsed = getPluginManifestSchema("builtin").safeParse(manifest);
    expect(parsed.success ? null : parsed.error.issues).toBeNull();
  });

  it("declares roles its implementation can serve", () => {
    expect(validateForgeImplRoles(provider, jiraForgeProvider)).toBeNull();
  });

  it("agrees with the id the host knows it by", () => {
    expect(`${manifest.name}.${provider.id}`).toBe(BUILTIN_JIRA_PROVIDER_ID);
  });

  it("is off by default", () => {
    expect(DEFAULT_DISABLED_PLUGIN_IDS).toContain(manifest.name);
  });

  it("never stores the credential as a setting", () => {
    const settingIds = manifest.contributes.settings.map((s: { id: string }) => s.id);
    for (const field of provider.credentialFields) {
      expect(settingIds).not.toContain(field.id);
    }
  });
});

describe("activate", () => {
  it("registers the issues-only provider", async () => {
    const { host, register } = makeHost();
    const dispose = await activate(host);
    expect(register).toHaveBeenCalledWith({ id: "jira" }, jiraForgeProvider);
    dispose();
  });

  it("reads the project key of the project the host asked about, by its id", async () => {
    const { host } = makeHost({ siteUrl: "https://acme.atlassian.net", email: "ada@example.com" });
    const dispose = await activate(host);
    getProjectByPath.mockResolvedValue({ id: "project-id" });
    getSettingValuesForUi.mockResolvedValue({ values: { projectKey: "eng" } });

    await expect(jiraForgeProvider.resolveIssueRepo!("/projects/one")).resolves.toMatchObject({
      repo: "ENG",
      host: "acme.atlassian.net",
    });
    expect(getProjectByPath).toHaveBeenCalledWith("/projects/one");
    expect(getSettingValuesForUi).toHaveBeenCalledWith("daintree.jira", "project", "project-id");
    dispose();
  });

  it("is unconfigured for a project the store doesn't know", async () => {
    const { host } = makeHost();
    const dispose = await activate(host);
    getProjectByPath.mockResolvedValue(null);
    await expect(jiraForgeProvider.resolveIssueRepo!("/nowhere")).resolves.toBeNull();
    dispose();
  });

  it("reads the connection through the host's settings", async () => {
    const { host } = makeHost({ siteUrl: "acme.atlassian.net", email: "ada@example.com" });
    const dispose = await activate(host);
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ accountId: "abc", displayName: "Ada" }), { status: 200 })
    );
    await expect(jiraForgeProvider.validateToken("candidate")).resolves.toEqual({
      valid: true,
      account: "Ada",
    });
    expect(fetchMock.mock.calls[0][0]).toBe("https://acme.atlassian.net/rest/api/3/myself");
    dispose();
  });

  it.each(["projectKey", "siteUrl"])(
    "has the workspace hosts re-read their branch keys when %s changes",
    async (key) => {
      const { host, listeners } = makeHost();
      const dispose = await activate(host);
      expect(updateForgeSettingsForAllProjects).not.toHaveBeenCalled();

      listeners.get(key)?.();

      await vi.waitFor(() => expect(updateForgeSettingsForAllProjects).toHaveBeenCalledTimes(1));
      dispose();
    }
  );

  it("activates even when it can't subscribe to a setting", async () => {
    const { host, register } = makeHost();
    vi.mocked(host.settings.onDidChange).mockRejectedValueOnce(new Error("revoked"));
    const dispose = await activate(host);
    expect(register).toHaveBeenCalled();
    expect(() => dispose()).not.toThrow();
  });

  it("lets go of the token, readers and subscriptions on disposal", async () => {
    const { host, disposed, get, storageApi } = makeHost({
      siteUrl: "https://acme.atlassian.net",
      email: "ada@example.com",
    });
    const dispose = await activate(host);
    jiraForgeProvider.setCredentials?.({ kind: "bearer", value: "token" });
    getProjectByPath.mockResolvedValue({ id: "project-id" });
    getSettingValuesForUi.mockResolvedValue({ values: { projectKey: "ENG" } });
    // Working up to here, so what follows is down to the disposal.
    await expect(jiraForgeProvider.resolveIssueRepo!("/p")).resolves.toMatchObject({ repo: "ENG" });
    expect(getToken()).toBe("token");

    dispose();
    get.mockClear();
    getProjectByPath.mockClear();

    expect(getToken()).toBeNull();
    expect(disposed.sort()).toEqual(["projectKey", "siteUrl"]);
    // Disabling isn't clearing: re-enabling must still know where the token goes.
    expect(storageApi.delete).not.toHaveBeenCalled();
    await expect(jiraForgeProvider.resolveIssueRepo!("/p")).resolves.toBeNull();
    await expect(jiraForgeProvider.validateToken("candidate")).resolves.toMatchObject({
      valid: false,
    });
    expect(get).not.toHaveBeenCalled();
    expect(getProjectByPath).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("where the stored token may go", () => {
  const BASE = "https://example.com/jira";
  // What the host's replay does as part of registration.
  const replaying = (host: PluginHostApi, token: string) =>
    vi.mocked(host.registerForgeProvider).mockImplementation(async (_id, impl) => {
      impl.setCredentials?.({ kind: "bearer", value: token });
      return () => undefined;
    });

  it("loads the record before the host replays the token", async () => {
    const { host } = makeHost(
      { siteUrl: BASE },
      { credentialProvenance: { binding: BASE, tokenDigest: digestToken("pat") } }
    );
    replaying(host, "pat");
    const dispose = await activate(host);
    expect(tokenMayGoTo(BASE)).toBe(true);
    expect(tokenMayGoTo("https://acme.atlassian.net")).toBe(false);
    dispose();
  });

  it.each([
    ["unreadable", () => Promise.reject(new Error("EACCES"))],
    ["malformed", async () => ({ binding: 42 })],
    ["a stored null", async () => null],
  ])("sends a token whose record is %s nowhere", async (_name, read) => {
    const { host, storageApi } = makeHost({ siteUrl: BASE });
    storageApi.get.mockImplementation(read);
    replaying(host, "pat");
    const dispose = await activate(host);
    expect(getToken()).toBe("pat");
    expect(tokenMayGoTo(BASE)).toBe(false);
    expect(tokenMayGoTo("https://acme.atlassian.net")).toBe(false);
    dispose();
  });

  it("takes a token from before records were kept as Cloud, once, and marks records as kept", async () => {
    const { host, storage } = makeHost({
      siteUrl: "https://acme.atlassian.net",
      email: "ada@example.com",
    });
    replaying(host, "legacy");
    const dispose = await activate(host);
    expect(tokenMayGoTo("https://acme.atlassian.net")).toBe(true);
    expect(tokenMayGoTo(BASE)).toBe(false);
    expect(storage).toEqual({
      credentialProvenanceTracked: true,
      credentialProvenance: { binding: "cloud", tokenDigest: digestToken("legacy") },
    });
    dispose();
  });

  it("adopts a pre-record token as Cloud even when a save has just written a Data Center site", async () => {
    // A lazy first activation, from a save that wrote its site before the token.
    const { host, storage } = makeHost({ siteUrl: BASE });
    replaying(host, "legacy");
    const dispose = await activate(host);
    expect(tokenMayGoTo("https://acme.atlassian.net")).toBe(true);
    expect(tokenMayGoTo(BASE)).toBe(false);
    expect(storage.credentialProvenance).toEqual({
      binding: "cloud",
      tokenDigest: digestToken("legacy"),
    });
    dispose();
  });

  it("marks records as kept only after the replay's own record is written", async () => {
    const { host, storageApi } = makeHost({ siteUrl: "https://acme.atlassian.net" });
    let land!: () => void;
    storageApi.set.mockImplementationOnce(() => new Promise<void>((resolve) => (land = resolve)));
    replaying(host, "legacy");
    const activating = activate(host);
    await vi.waitFor(() => expect(storageApi.set).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(storageApi.set).toHaveBeenCalledTimes(1);
    land();
    const dispose = await activating;
    expect(storageApi.set.mock.calls.map(([key]) => key)).toEqual([
      "credentialProvenance",
      "credentialProvenanceTracked",
    ]);
    dispose();
  });

  it("leaves records unmarked when the replay's record couldn't be written", async () => {
    const { host, storage, storageApi } = makeHost({ siteUrl: "https://acme.atlassian.net" });
    storageApi.set.mockRejectedValueOnce(new Error("ENOSPC"));
    replaying(host, "legacy");
    const dispose = await activate(host);
    expect(storage).toEqual({});
    dispose();
  });

  it("sends a token nowhere once its record is missing where records are kept", async () => {
    // A save whose record never landed: the marker from an earlier activation is there.
    const { host } = makeHost(
      { siteUrl: "https://acme.atlassian.net", email: "ada@example.com" },
      { credentialProvenanceTracked: true }
    );
    replaying(host, "pat");
    const dispose = await activate(host);
    expect(getToken()).toBe("pat");
    expect(tokenMayGoTo("https://acme.atlassian.net")).toBe(false);
    expect(tokenMayGoTo(BASE)).toBe(false);
    dispose();
  });

  it("drops a token a retired save delivers while the activation reads its records", async () => {
    const { host, storageApi } = makeHost({ siteUrl: BASE });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    storageApi.get.mockImplementation(async () => {
      await gate;
      return undefined;
    });
    const activating = activate(host);
    await Promise.resolve();
    jiraForgeProvider.setCredentials?.({ kind: "bearer", value: "stray" });
    release();
    const dispose = await activating;
    expect(getToken()).toBeNull();
    dispose();
  });

  it("starts each activation with no token but the one the host replays", async () => {
    const { host, storage } = makeHost(
      { siteUrl: BASE },
      { credentialProvenance: { binding: BASE, tokenDigest: digestToken("pat") } }
    );
    const first = await activate(host);
    first();
    // A save that finished after disposal, on the retired provider.
    jiraForgeProvider.setCredentials?.({ kind: "bearer", value: "stray" });
    expect(getToken()).toBe("stray");

    const second = await activate(host);
    expect(getToken()).toBeNull();
    expect(storage.credentialProvenance).toEqual({
      binding: BASE,
      tokenDigest: digestToken("pat"),
    });
    second();
  });

  it("records a saved token where it was proven, and forgets it on a clear", async () => {
    const { host, storage } = makeHost({ siteUrl: BASE });
    const dispose = await activate(host);
    fetchMock.mockImplementation(async (url: string) =>
      String(url).endsWith("/serverInfo")
        ? new Response(JSON.stringify({ deploymentType: "DataCenter", versionNumbers: [9, 12] }))
        : new Response(JSON.stringify({ name: "ada", displayName: "Ada" }))
    );
    await expect(jiraForgeProvider.validateToken("pat")).resolves.toMatchObject({ valid: true });
    jiraForgeProvider.setCredentials?.({ kind: "bearer", value: "pat" });

    await vi.waitFor(() =>
      expect(storage.credentialProvenance).toEqual({
        binding: BASE,
        tokenDigest: digestToken("pat"),
      })
    );
    expect(JSON.stringify(storage)).not.toContain('"pat"');

    jiraForgeProvider.setCredentials?.(null);
    await vi.waitFor(() => expect(storage.credentialProvenance).toBeUndefined());
    dispose();
  });
});
