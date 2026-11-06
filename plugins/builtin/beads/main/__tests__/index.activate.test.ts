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
import { beadsForgeProvider } from "../forgeProvider.js";
import { getToken } from "../BeadsClient.js";

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
  it("registers the issues-only provider without touching the network", async () => {
    const { host, register } = makeHost();
    const dispose = await activate(host);
    expect(register).toHaveBeenCalledWith({ id: "beads" }, beadsForgeProvider);
    expect(globalThis.fetch).not.toHaveBeenCalled();
    dispose();
  });

  it("reads the server URL of the project the host asked about, by its id", async () => {
    getProjectByPath.mockResolvedValue({ id: "proj-b", path: "/projects/b" });
    getSettingValuesForUi.mockResolvedValue({
      values: { serverUrl: "https://beads.example.com" },
      secretsSet: [],
    });
    (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      new Response(JSON.stringify({ database: "b", project_id: "pb" }), { status: 200 })
    );

    const dispose = await activate(makeHost().host);
    const repo = await beadsForgeProvider.resolveIssueRepo!("/projects/b");

    expect(getProjectByPath).toHaveBeenCalledWith("/projects/b");
    expect(getSettingValuesForUi).toHaveBeenCalledWith("daintree.beads", "project", "proj-b");
    expect(repo).toMatchObject({ owner: "https://beads.example.com", repo: "b" });
    dispose();
  });

  it("forgets the token and the settings reader on dispose", async () => {
    const dispose = await activate(makeHost().host);
    beadsForgeProvider.setCredentials!({ kind: "bearer", value: "tok" });
    dispose();
    expect(getToken()).toBeNull();
    await expect(beadsForgeProvider.resolveIssueRepo!("/no/such/project")).resolves.toBeNull();
    expect(getProjectByPath).not.toHaveBeenCalled();
  });

  it("drops the settings reader when registration fails", async () => {
    const register = vi.fn(async () => {
      throw new Error("refused");
    });
    await expect(activate(makeHost(register).host)).rejects.toThrow("refused");
    await expect(beadsForgeProvider.resolveIssueRepo!("/no/such/project")).resolves.toBeNull();
    expect(getProjectByPath).not.toHaveBeenCalled();
  });
});
