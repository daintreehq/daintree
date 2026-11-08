import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getPluginManifestSchema } from "../../../../../electron/schemas/plugin.js";
import { validateForgeImplRoles } from "../../../../../electron/services/forgeProviderRegistry.js";
import { DEFAULT_DISABLED_PLUGIN_IDS } from "../../../../../shared/config/pluginDefaults.js";
import { BUILTIN_JIRA_PROVIDER_ID } from "../../../../../shared/utils/forgeProviderIds.js";
import type { PluginHostApi } from "../../../../../shared/types/plugin.js";

const getProjectByPath = vi.fn();
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
import { getToken } from "../JiraClient.js";

function makeHost(settings: Record<string, unknown> = {}) {
  const register = vi.fn(async () => () => undefined);
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
  } as unknown as PluginHostApi;
  return { host, register, listeners, disposed, get };
}

beforeEach(() => {
  getProjectByPath.mockReset();
  getSettingValuesForUi.mockReset();
  updateForgeSettingsForAllProjects.mockClear();
  vi.stubGlobal("fetch", vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
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
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ accountId: "abc", displayName: "Ada" }), { status: 200 })
    );
    await expect(jiraForgeProvider.validateToken("candidate")).resolves.toEqual({
      valid: true,
      account: "Ada",
    });
    expect(vi.mocked(fetch).mock.calls[0][0]).toBe("https://acme.atlassian.net/rest/api/3/myself");
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
    const { host, disposed, get } = makeHost({
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
    await expect(jiraForgeProvider.resolveIssueRepo!("/p")).resolves.toBeNull();
    await expect(jiraForgeProvider.validateToken("candidate")).resolves.toMatchObject({
      valid: false,
    });
    expect(get).not.toHaveBeenCalled();
    expect(getProjectByPath).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });
});
