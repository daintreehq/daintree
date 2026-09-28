import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../../window/webContentsRegistry.js", () => ({
  getWindowForWebContents: vi.fn(() => null),
}));

vi.mock("../../../utils.js", () => ({
  broadcastToRenderer: vi.fn(),
  sendToRenderer: vi.fn(),
  sendToRendererContext: vi.fn(),
}));

const provider = vi.hoisted(() => ({
  capability: undefined as
    | {
        probeAuth: () => Promise<{ authenticated: boolean }>;
        cloneRepository?: ReturnType<typeof vi.fn>;
        getAuthenticatedCloneUrl?: (url: string) => Promise<string>;
      }
    | undefined,
}));

vi.mock("../../../../services/forgeProviderRegistry.js", () => ({
  getActiveProvider: () =>
    provider.capability ? { pluginId: "github", contribution: { id: "github" } } : undefined,
  getForgeProviderImpl: () => (provider.capability ? { clone: provider.capability } : undefined),
}));

vi.mock("../../../../services/PluginService.js", () => ({
  pluginService: { activatePluginForForgeProvider: vi.fn(async () => {}) },
}));

const calls = vi.hoisted(() => ({
  clones: [] as Array<{ url: string; folder: string; args: string[] }>,
  raws: [] as Array<{ cwd: string; args: string[] }>,
}));

vi.mock("../../../../utils/hardenedGit.js", () => ({
  createAuthenticatedGit: vi.fn(async (cwd: string) => ({
    _plugins: { append: vi.fn() },
    clone: vi.fn(async (url: string, folder: string, args: string[]) => {
      calls.clones.push({ url, folder, args });
    }),
    raw: vi.fn(async (args: string[]) => {
      calls.raws.push({ cwd, args });
      return "";
    }),
  })),
}));

import { executeClone } from "../gitClone.js";
import { isSupportedCloneUrl } from "../../../../../shared/utils/gitRemoteUrl.js";

const base = {
  url: "https://github.com/daintreehq/daintree.git",
  parentPath: "/tmp/parent",
  folderName: "daintree",
  targetPath: "/tmp/parent/daintree",
  signal: new AbortController().signal,
  onProgress: () => {},
};

beforeEach(() => {
  calls.clones.length = 0;
  calls.raws.length = 0;
  provider.capability = undefined;
});

describe("executeClone options", () => {
  it("runs a full clone with no extra flags", async () => {
    await executeClone({ ...base, depth: "full" });
    expect(calls.clones).toEqual([{ url: base.url, folder: "daintree", args: [] }]);
    expect(calls.raws).toEqual([]);
  });

  it("maps shallow and partial to their git flags", async () => {
    await executeClone({ ...base, depth: "shallow" });
    await executeClone({ ...base, depth: "partial" });
    expect(calls.clones.map((c) => c.args)).toEqual([["--depth", "1"], ["--filter=blob:none"]]);
  });

  it("initialises submodules in the new clone when asked", async () => {
    await executeClone({ ...base, recurseSubmodules: true });
    expect(calls.raws).toEqual([
      { cwd: base.targetPath, args: ["submodule", "update", "--init", "--recursive"] },
    ]);
  });

  it("routes a partial clone through git with the provider's authenticated URL", async () => {
    const cloneRepository = vi.fn();
    provider.capability = {
      probeAuth: async () => ({ authenticated: true }),
      cloneRepository,
      getAuthenticatedCloneUrl: async () =>
        "https://x-access-token:t@github.com/daintreehq/daintree.git",
    };
    await executeClone({ ...base, depth: "partial" });
    expect(cloneRepository).not.toHaveBeenCalled();
    expect(calls.clones[0]).toMatchObject({ args: ["--filter=blob:none"] });

    await executeClone({ ...base, depth: "full" });
    expect(cloneRepository).toHaveBeenCalledTimes(1);
  });
});

describe("isSupportedCloneUrl", () => {
  it("accepts HTTPS, SCP-style SSH and ssh:// remotes", () => {
    expect(isSupportedCloneUrl("https://github.com/a/b")).toBe(true);
    expect(isSupportedCloneUrl("git@github.com:a/b.git")).toBe(true);
    expect(isSupportedCloneUrl("ssh://git@git.example.com:2222/a/b.git")).toBe(true);
    expect(isSupportedCloneUrl("file:///srv/repo")).toBe(false);
    expect(isSupportedCloneUrl("/srv/repo")).toBe(false);
  });
});
