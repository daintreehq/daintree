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
  // Remote selection asks the registry whether a URL is parseable at all
  // (#11408). Default: every remote is supported, so selection falls through
  // to name preference and these tests stay about provider resolution.
  listMatchingProviders: vi.fn<(remoteUrl: string) => unknown[]>(() => [{}]),
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
  listRemotes: vi.fn<() => Promise<Array<{ name: string; fetchUrl: string }>>>(async () => []),
  listWorktrees: vi.fn(),
  getRepositoryRoot: vi.fn(),
}));
const gitServiceCacheMock = vi.hoisted(() => ({
  getGitService: vi.fn<() => typeof gitServiceMock | null>(() => gitServiceMock),
}));

vi.mock("../../../services/GitServiceCache.js", () => ({
  gitServiceCache: gitServiceCacheMock,
}));

const pluginServiceMock = vi.hoisted(() => ({
  activatePluginForForgeProvider: vi.fn<(namespacedId: string) => Promise<void>>(async () => {}),
}));

vi.mock("../../../services/PluginService.js", () => ({ pluginService: pluginServiceMock }));

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
    gitServiceMock.listRemotes.mockResolvedValue([]);
    registryMock.getForgeProviderImpl.mockReturnValue(undefined);
    registryMock.listMatchingProviders.mockReturnValue([{}]);
    resolverMock.resolveForgeProvider.mockReturnValue({ entry: null, resolvedVia: null });
  });

  describe("remote selection (#11408)", () => {
    const FORK = "https://gitea.example.com/me/repo.git";
    const CANONICAL = "https://gitea.example.com/owner/repo.git";

    function resolvesToGitea() {
      registryMock.getForgeProviderImpl.mockReturnValue({
        parseRemote: vi.fn(() => ({ owner: "owner", repo: "repo" })),
      });
      resolverMock.resolveForgeProvider.mockReturnValue({
        entry: giteaEntry,
        resolvedVia: "hostname",
      });
    }

    it("resolves against the remote named by forgeRemote, not origin", async () => {
      projectStoreMock.getProjectSettings.mockResolvedValue({
        runCommands: [],
        forgeRemote: "upstream",
      });
      gitServiceMock.listRemotes.mockResolvedValue([
        { name: "origin", fetchUrl: FORK },
        { name: "upstream", fetchUrl: CANONICAL },
      ]);
      resolvesToGitea();

      await resolveForCwd("/repo");

      expect(lastResolverInputs()?.remoteUrl).toBe(CANONICAL);
    });

    it("honours the legacy githubRemote alias", async () => {
      projectStoreMock.getProjectSettings.mockResolvedValue({
        runCommands: [],
        githubRemote: "upstream",
      });
      gitServiceMock.listRemotes.mockResolvedValue([
        { name: "origin", fetchUrl: FORK },
        { name: "upstream", fetchUrl: CANONICAL },
      ]);
      resolvesToGitea();

      await resolveForCwd("/repo");

      expect(lastResolverInputs()?.remoteUrl).toBe(CANONICAL);
    });

    it("auto-detects the only provider-matching remote when no setting is stored", async () => {
      gitServiceMock.listRemotes.mockResolvedValue([
        { name: "origin", fetchUrl: "https://internal.example/owner/repo.git" },
        { name: "backup", fetchUrl: CANONICAL },
      ]);
      registryMock.listMatchingProviders.mockImplementation((url: string) =>
        url.includes("gitea.example.com") ? [{}] : []
      );
      resolvesToGitea();

      await resolveForCwd("/repo");

      expect(lastResolverInputs()?.remoteUrl).toBe(CANONICAL);
    });

    it("falls back to the origin lookup when listRemotes fails", async () => {
      // A transient git failure must not become a hard "no provider" — that
      // would read downstream as a genuinely unlinked repo.
      gitServiceMock.listRemotes.mockRejectedValue(new Error("git exploded"));
      resolvesToGitea();

      await resolveForCwd("/repo");

      expect(lastResolverInputs()?.remoteUrl).toBe(CANONICAL);
      expect(gitServiceMock.getRemoteUrl).toHaveBeenCalled();
    });

    it("falls back to the origin lookup when the repo reports no remotes", async () => {
      gitServiceMock.listRemotes.mockResolvedValue([]);
      resolvesToGitea();

      await resolveForCwd("/repo");

      expect(lastResolverInputs()?.remoteUrl).toBe(CANONICAL);
    });
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

  it("stamps the project root (main worktree), not the linked-worktree cwd, onto projectPath (#10563)", async () => {
    gitServiceMock.listWorktrees.mockResolvedValue([
      { path: "/repo", branch: "main", bare: false, isMainWorktree: true },
      { path: "/repo-worktrees/feature", branch: "feature", bare: false, isMainWorktree: false },
    ]);
    const parseRemote = vi.fn(() => ({ owner: "owner", repo: "repo", rawData: null }));
    registryMock.getForgeProviderImpl.mockReturnValue({ parseRemote });
    resolverMock.resolveForgeProvider.mockReturnValue({
      entry: giteaEntry,
      resolvedVia: "hostname",
    });

    const result = await resolveForCwd("/repo-worktrees/feature/src");

    // Project root, not the linked worktree the call came from — matches the
    // path PullRequestService stamps on the RPC path.
    expect(result.repoRef.projectPath).toBe("/repo");
  });

  it("falls back to getRepositoryRoot for projectPath when no worktree is marked main (#10563)", async () => {
    gitServiceMock.listWorktrees.mockResolvedValue([
      { path: "/elsewhere", branch: "x", bare: false, isMainWorktree: false },
    ]);
    gitServiceMock.getRepositoryRoot.mockResolvedValue("/repo");
    const parseRemote = vi.fn(() => ({ owner: "owner", repo: "repo", rawData: null }));
    registryMock.getForgeProviderImpl.mockReturnValue({ parseRemote });
    resolverMock.resolveForgeProvider.mockReturnValue({
      entry: giteaEntry,
      resolvedVia: "hostname",
    });

    const result = await resolveForCwd("/repo/src");

    expect(result.repoRef.projectPath).toBe("/repo");
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

  it("implicitly activates the owning plugin when the impl is not yet bound (#10523)", async () => {
    const parseRemote = vi.fn(() => ({ owner: "owner", repo: "repo" }));
    // First lookup misses (lazy plugin not activated); after activation the
    // impl is bound — mirrors the forge RPC server's implicit-activation path.
    registryMock.getForgeProviderImpl.mockReturnValueOnce(undefined);
    pluginServiceMock.activatePluginForForgeProvider.mockImplementationOnce(async () => {
      registryMock.getForgeProviderImpl.mockReturnValue({ parseRemote });
    });
    resolverMock.resolveForgeProvider.mockReturnValue({
      entry: giteaEntry,
      resolvedVia: "hostname",
    });

    const result = await resolveForCwd("/repo");

    expect(pluginServiceMock.activatePluginForForgeProvider).toHaveBeenCalledWith("acme.gitea");
    expect(result.namespaceId).toBe("acme.gitea");
    expect(result.repoRef).toEqual({ owner: "owner", repo: "repo", projectPath: "/repo" });
  });

  it("skips implicit activation when the impl is already bound", async () => {
    const parseRemote = vi.fn(() => ({ owner: "owner", repo: "repo" }));
    registryMock.getForgeProviderImpl.mockReturnValue({ parseRemote });
    resolverMock.resolveForgeProvider.mockReturnValue({
      entry: giteaEntry,
      resolvedVia: "hostname",
    });

    await resolveForCwd("/repo");

    expect(pluginServiceMock.activatePluginForForgeProvider).not.toHaveBeenCalled();
  });

  it("still fails closed when the impl stays unbound after activation", async () => {
    registryMock.getForgeProviderImpl.mockReturnValue(undefined);
    resolverMock.resolveForgeProvider.mockReturnValue({
      entry: giteaEntry,
      resolvedVia: "hostname",
    });

    await expect(resolveForCwd("/repo")).rejects.toThrow(
      'Forge provider "gitea" not activated. Activate it in Settings.'
    );
    expect(pluginServiceMock.activatePluginForForgeProvider).toHaveBeenCalledWith("acme.gitea");
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

  it("rejects when the repo has no usable remote", async () => {
    // Project settings are now read BEFORE the remote lookup (#11408): the
    // `forgeRemote` setting decides which remote to read, so it cannot be
    // deferred until after one has been chosen. The reject itself still
    // short-circuits provider resolution.
    gitServiceMock.getRemoteUrl.mockResolvedValue(null);
    gitServiceMock.listRemotes.mockResolvedValue([]);

    await expect(resolveForCwd("/repo")).rejects.toThrow("No remote URL found");
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
