import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ForgeProviderEntry, ResolvedForgeProvider } from "../../../../shared/types/forge.js";
import type { ResolveForgeProviderInputs } from "../../../services/forgeProviderResolver.js";

const storeMock = vi.hoisted(() => {
  const data: Record<string, unknown> = {};
  return {
    get: vi.fn((key: string) => data[key]),
    set: vi.fn((key: string, value: unknown) => {
      data[key] = value;
    }),
    _data: data,
  };
});

vi.mock("../../../store.js", () => ({ store: storeMock }));

const registryMock = vi.hoisted(() => ({
  getForgeProviderImpl: vi.fn<(id: string) => unknown>(() => undefined),
}));

vi.mock("../../../services/forgeProviderRegistry.js", () => registryMock);

const resolverMock = vi.hoisted(() => ({
  resolveForgeProvider: vi.fn<(inputs: ResolveForgeProviderInputs) => ResolvedForgeProvider>(
    () => ({ entry: null, resolvedVia: null })
  ),
}));

vi.mock("../../../services/forgeProviderResolver.js", () => resolverMock);

const projectStoreMock = vi.hoisted(() => ({
  getProjectByPath: vi.fn(),
  getProjectSettings: vi.fn(),
}));

vi.mock("../../../services/ProjectStore.js", () => ({ projectStore: projectStoreMock }));

const gitServiceMock = vi.hoisted(() => ({
  getRemoteUrl: vi.fn(),
  listWorktrees: vi.fn(),
  getRepositoryRoot: vi.fn(),
}));
const gitServiceCacheMock = vi.hoisted(() => ({
  getGitService: vi.fn<() => typeof gitServiceMock | null>(() => gitServiceMock),
}));

vi.mock("../../../services/GitServiceCache.js", () => ({
  gitServiceCache: gitServiceCacheMock,
}));

import { resolveForCwd } from "../forgeResolution.js";

const giteaEntry: ForgeProviderEntry = {
  pluginId: "acme",
  contribution: { id: "gitea", name: "Gitea", matches: ["gitea.example.com"] },
};

function lastResolverInputs(): ResolveForgeProviderInputs {
  const calls = resolverMock.resolveForgeProvider.mock.calls;
  if (calls.length === 0) throw new Error("resolveForgeProvider was not called");
  return calls[calls.length - 1]![0];
}

describe("resolveForCwd", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    for (const key of Object.keys(storeMock._data)) {
      delete storeMock._data[key];
    }
    gitServiceCacheMock.getGitService.mockReturnValue(gitServiceMock);
    gitServiceMock.getRemoteUrl.mockResolvedValue("https://gitea.example.com/owner/repo.git");
    gitServiceMock.listWorktrees.mockResolvedValue([
      { path: "/repo", branch: "main", bare: false, isMainWorktree: true },
    ]);
    gitServiceMock.getRepositoryRoot.mockResolvedValue("/repo");
    projectStoreMock.getProjectByPath.mockImplementation(async (p: string) =>
      p === "/repo" ? { id: "project-1", path: "/repo" } : null
    );
    projectStoreMock.getProjectSettings.mockResolvedValue({ runCommands: [] });
    registryMock.getForgeProviderImpl.mockReturnValue(undefined);
    resolverMock.resolveForgeProvider.mockReturnValue({ entry: null, resolvedVia: null });
  });

  it("passes the per-project forgeProviderOverride to the resolver (#9984)", async () => {
    projectStoreMock.getProjectSettings.mockResolvedValue({
      runCommands: [],
      forgeProviderOverride: "acme.gitea",
    });
    const parseRemote = vi.fn(() => ({ owner: "owner", repo: "repo" }));
    registryMock.getForgeProviderImpl.mockReturnValue({ parseRemote });
    resolverMock.resolveForgeProvider.mockReturnValue({
      entry: giteaEntry,
      resolvedVia: "override",
    });

    const result = await resolveForCwd("/repo");

    expect(lastResolverInputs()).toEqual({
      remoteUrl: "https://gitea.example.com/owner/repo.git",
      forgeProviderOverride: "acme.gitea",
      globalDefaultProviderId: null,
    });
    expect(result.providerId).toBe("gitea");
    expect(result.namespaceId).toBe("acme.gitea");
    // `projectPath` is the worktree root, stamped onto the parsed ref (#10563).
    expect(result.repoRef).toEqual({ owner: "owner", repo: "repo", projectPath: "/repo" });
    expect(parseRemote).toHaveBeenCalledWith("https://gitea.example.com/owner/repo.git");
  });

  it("stamps the worktree root onto repoRef.projectPath (#10563)", async () => {
    gitServiceMock.getRepositoryRoot.mockResolvedValue("/repo-worktrees/feature");
    const parseRemote = vi.fn(() => ({ owner: "owner", repo: "repo", rawData: null }));
    registryMock.getForgeProviderImpl.mockReturnValue({ parseRemote });
    resolverMock.resolveForgeProvider.mockReturnValue({
      entry: giteaEntry,
      resolvedVia: "hostname",
    });

    const result = await resolveForCwd("/repo-worktrees/feature/src");

    expect(result.repoRef.projectPath).toBe("/repo-worktrees/feature");
    expect(gitServiceMock.getRepositoryRoot).toHaveBeenCalledWith("/repo-worktrees/feature/src");
  });

  it("falls back to the raw cwd for projectPath when getRepositoryRoot fails (#10563)", async () => {
    gitServiceMock.getRepositoryRoot.mockRejectedValue(new Error("not a git repo"));
    const parseRemote = vi.fn(() => ({ owner: "owner", repo: "repo", rawData: null }));
    registryMock.getForgeProviderImpl.mockReturnValue({ parseRemote });
    resolverMock.resolveForgeProvider.mockReturnValue({
      entry: giteaEntry,
      resolvedVia: "hostname",
    });

    const result = await resolveForCwd("/repo/src");

    expect(result.repoRef.projectPath).toBe("/repo/src");
  });

  it("looks up the project by the main worktree path, not the linked-worktree cwd", async () => {
    gitServiceMock.listWorktrees.mockResolvedValue([
      { path: "/repo", branch: "main", bare: false, isMainWorktree: true },
      { path: "/repo-worktrees/feature", branch: "feature", bare: false, isMainWorktree: false },
    ]);

    await resolveForCwd("/repo-worktrees/feature/src").catch(() => null);

    expect(projectStoreMock.getProjectByPath).toHaveBeenCalledWith("/repo");
    expect(projectStoreMock.getProjectSettings).toHaveBeenCalledWith("project-1");
  });

  it("falls back to the repository root when listWorktrees fails and cwd is a subdirectory", async () => {
    gitServiceMock.listWorktrees.mockRejectedValue(new Error("not a work tree"));
    projectStoreMock.getProjectSettings.mockResolvedValue({
      runCommands: [],
      forgeProviderOverride: "acme.gitea",
    });

    await resolveForCwd("/repo/src").catch(() => null);

    expect(projectStoreMock.getProjectByPath).toHaveBeenCalledWith("/repo");
    expect(lastResolverInputs().forgeProviderOverride).toBe("acme.gitea");
  });

  it("falls back to the raw cwd when both listWorktrees and getRepositoryRoot fail", async () => {
    gitServiceMock.listWorktrees.mockRejectedValue(new Error("not a work tree"));
    gitServiceMock.getRepositoryRoot.mockRejectedValue(new Error("not a git repo"));

    await resolveForCwd("/repo/src").catch(() => null);

    expect(projectStoreMock.getProjectByPath).toHaveBeenCalledWith("/repo/src");
    expect(lastResolverInputs().forgeProviderOverride).toBeNull();
  });

  it("falls back to the repository root when no worktree entry is marked main", async () => {
    gitServiceMock.listWorktrees.mockResolvedValue([
      { path: "/elsewhere", branch: "main", bare: false, isMainWorktree: false },
    ]);

    await resolveForCwd("/repo/src").catch(() => null);

    expect(projectStoreMock.getProjectByPath).toHaveBeenCalledWith("/repo");
  });

  it("passes a null override when no project matches the path", async () => {
    projectStoreMock.getProjectByPath.mockResolvedValue(null);

    await resolveForCwd("/repo").catch(() => null);

    expect(projectStoreMock.getProjectSettings).not.toHaveBeenCalled();
    expect(lastResolverInputs().forgeProviderOverride).toBeNull();
  });

  it("passes a null override when the project lookup rejects", async () => {
    projectStoreMock.getProjectByPath.mockRejectedValue(new Error("db locked"));

    await resolveForCwd("/repo").catch(() => null);

    expect(lastResolverInputs().forgeProviderOverride).toBeNull();
  });

  it("passes a null override when the settings fetch rejects", async () => {
    projectStoreMock.getProjectSettings.mockRejectedValue(new Error("db locked"));

    await resolveForCwd("/repo").catch(() => null);

    expect(lastResolverInputs().forgeProviderOverride).toBeNull();
  });

  it("passes a null override when project settings have no override set", async () => {
    await resolveForCwd("/repo").catch(() => null);

    expect(lastResolverInputs().forgeProviderOverride).toBeNull();
  });

  it("still forwards the global default provider id alongside the override", async () => {
    storeMock._data["forgeDefaultProviderId"] = "daintree.github.github";
    projectStoreMock.getProjectSettings.mockResolvedValue({
      runCommands: [],
      forgeProviderOverride: "acme.gitea",
    });

    await resolveForCwd("/repo").catch(() => null);

    expect(lastResolverInputs()).toEqual({
      remoteUrl: "https://gitea.example.com/owner/repo.git",
      forgeProviderOverride: "acme.gitea",
      globalDefaultProviderId: "daintree.github.github",
    });
  });

  it("fails closed when the override names an unregistered provider", async () => {
    projectStoreMock.getProjectSettings.mockResolvedValue({
      runCommands: [],
      forgeProviderOverride: "acme.unregistered",
    });
    resolverMock.resolveForgeProvider.mockReturnValue({ entry: null, resolvedVia: null });

    await expect(resolveForCwd("/repo")).rejects.toThrow("No forge provider registered");
    expect(lastResolverInputs().forgeProviderOverride).toBe("acme.unregistered");
  });

  it("rejects invalid cwd payloads before any lookup", async () => {
    await expect(resolveForCwd("")).rejects.toThrow("Invalid working directory");
    expect(gitServiceCacheMock.getGitService).not.toHaveBeenCalled();
    expect(resolverMock.resolveForgeProvider).not.toHaveBeenCalled();
  });

  it("rejects when no remote URL is found, without touching project settings", async () => {
    gitServiceMock.getRemoteUrl.mockResolvedValue(null);

    await expect(resolveForCwd("/repo")).rejects.toThrow("No remote URL found");
    expect(projectStoreMock.getProjectByPath).not.toHaveBeenCalled();
    expect(resolverMock.resolveForgeProvider).not.toHaveBeenCalled();
  });
});

describe("resolveForCwd — cwd validation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    gitServiceCacheMock.getGitService.mockReturnValue(null);
  });

  it("rejects an empty cwd before touching git", async () => {
    await expect(resolveForCwd("")).rejects.toThrow("Invalid working directory");
    expect(gitServiceCacheMock.getGitService).not.toHaveBeenCalled();
  });

  it("rejects a non-string cwd", async () => {
    await expect(resolveForCwd(42 as unknown as string)).rejects.toThrow(
      "Invalid working directory"
    );
    expect(gitServiceCacheMock.getGitService).not.toHaveBeenCalled();
  });

  it.each(["./relative", "relative/path", "../escape", "   "])(
    "rejects the non-absolute cwd %s before touching git",
    async (cwd) => {
      await expect(resolveForCwd(cwd)).rejects.toThrow(
        "Working directory must be an absolute path"
      );
      expect(gitServiceCacheMock.getGitService).not.toHaveBeenCalled();
    }
  );

  it("lets an absolute cwd through to git resolution", async () => {
    // gitService is null in this fixture, so passing the path gate surfaces
    // the next failure in the chain rather than the validation error.
    await expect(resolveForCwd("/abs/path")).rejects.toThrow("Not a git repository");
    expect(gitServiceCacheMock.getGitService).toHaveBeenCalledWith("/abs/path");
  });
});
