import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_DISABLED_PLUGIN_IDS } from "../../../../../shared/config/pluginDefaults.js";
import { BUILTIN_JIRA_PROVIDER_ID } from "../../../../../shared/utils/forgeProviderIds.js";
import type { PluginHostApi } from "../../../../../shared/types/plugin.js";

const getProjectByPath = vi.fn();
const getSettingValuesForUi = vi.fn();

vi.mock("../../../../../electron/services/ProjectStore.js", () => ({
  projectStore: { getProjectByPath: (p: string) => getProjectByPath(p) },
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
  const host = {
    registerForgeProvider: register,
    settings: { get: vi.fn(async (key: string) => settings[key]) },
  } as unknown as PluginHostApi;
  return { host, register };
}

beforeEach(() => {
  getProjectByPath.mockReset();
  getSettingValuesForUi.mockReset();
  vi.stubGlobal("fetch", vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("manifest", () => {
  const manifest = JSON.parse(readFileSync(resolve(__dirname, "../../plugin.json"), "utf8"));
  const provider = manifest.contributes.forgeProviders[0];

  it("agrees with the id the host knows it by", () => {
    expect(`${manifest.name}.${provider.id}`).toBe(BUILTIN_JIRA_PROVIDER_ID);
  });

  it("is off by default", () => {
    expect(DEFAULT_DISABLED_PLUGIN_IDS).toContain(manifest.name);
  });

  it("only ever hands the provider the token as its credential, and never stores it as a setting", () => {
    const secretField = provider.credentialFields.find(
      (field: { type: string }) => field.type === "password"
    );
    expect(secretField.id).toBe(provider.credentialFields[0].id);
    const settingIds = manifest.contributes.settings.map((s: { id: string }) => s.id);
    expect(settingIds).not.toContain(secretField.id);
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
    jiraForgeProvider.setCredentials?.({ kind: "bearer", value: "token" });
    getProjectByPath.mockResolvedValue({ id: "project-id" });
    getSettingValuesForUi.mockResolvedValue({ values: { projectKey: "eng" } });
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ id: "10000", key: "ENG" }), { status: 200 })
    );

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
    expect(vi.mocked(fetch).mock.calls[0][0]).toBe(
      "https://acme.atlassian.net/rest/api/3/myself"
    );
    dispose();
  });

  it("forgets the token and readers on disposal", async () => {
    const { host } = makeHost();
    const dispose = await activate(host);
    jiraForgeProvider.setCredentials?.({ kind: "bearer", value: "token" });
    expect(getToken()).toBe("token");

    dispose();

    expect(getToken()).toBeNull();
    await expect(jiraForgeProvider.resolveIssueRepo!("/p")).resolves.toBeNull();
    await expect(jiraForgeProvider.validateToken("candidate")).resolves.toMatchObject({
      valid: false,
    });
    expect(fetch).not.toHaveBeenCalled();
  });
});
