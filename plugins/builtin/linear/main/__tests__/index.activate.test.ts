import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
import { linearForgeProvider } from "../forgeProvider.js";
import { getToken } from "../LinearClient.js";

function gql(data: unknown) {
  return new Response(JSON.stringify({ data }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function makeHost(register = vi.fn(async () => () => undefined)) {
  return { host: { registerForgeProvider: register } as unknown as PluginHostApi, register };
}

beforeEach(() => {
  getProjectByPath.mockReset();
  getSettingValuesForUi.mockReset();
  vi.stubGlobal("fetch", vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("activate", () => {
  it("registers the issues-only provider", async () => {
    const { host, register } = makeHost();
    const dispose = await activate(host);
    expect(register).toHaveBeenCalledWith({ id: "linear" }, linearForgeProvider);
    dispose();
  });

  it("reads the team key of the project the host asked about, by its id", async () => {
    getProjectByPath.mockResolvedValue({ id: "proj-b", path: "/projects/b" });
    getSettingValuesForUi.mockResolvedValue({ values: { teamKey: "des" }, secretsSet: [] });
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock
      .mockResolvedValueOnce(
        gql({
          viewer: { id: "u", name: "Ada", displayName: "ada", organization: { urlKey: "acme" } },
        })
      )
      .mockResolvedValueOnce(gql({ teams: { nodes: [{ id: "team-des", key: "DES" }] } }));

    const dispose = await activate(makeHost().host);
    linearForgeProvider.setCredentials!({ kind: "bearer", value: "lin_api_key" });
    const repo = await linearForgeProvider.resolveIssueRepo!("/projects/b");

    expect(getProjectByPath).toHaveBeenCalledWith("/projects/b");
    expect(getSettingValuesForUi).toHaveBeenCalledWith("daintree.linear", "project", "proj-b");
    expect(repo).toMatchObject({ owner: "acme", repo: "DES", rawData: { teamId: "team-des" } });
    dispose();
  });

  it("treats a path that names no project as unconfigured", async () => {
    getProjectByPath.mockResolvedValue(null);
    const dispose = await activate(makeHost().host);
    await expect(linearForgeProvider.resolveIssueRepo!("/elsewhere")).resolves.toBeNull();
    expect(getSettingValuesForUi).not.toHaveBeenCalled();
    dispose();
  });

  it("forgets the key and the team reader on dispose", async () => {
    const dispose = await activate(makeHost().host);
    linearForgeProvider.setCredentials!({ kind: "bearer", value: "lin_api_key" });
    dispose();
    expect(getToken()).toBeNull();
    await expect(linearForgeProvider.resolveIssueRepo!("/projects/b")).resolves.toBeNull();
    expect(getProjectByPath).not.toHaveBeenCalled();
  });
});
