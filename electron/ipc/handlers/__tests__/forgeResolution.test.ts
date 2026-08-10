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

import { resolveForCwd, resolveForgeRemoteNameForCwd } from "../forgeResolution.js";

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
    // Mirrors the `getRemoteUrl` default above: a plain single-origin repo.
    gitServiceMock.listRemotes.mockResolvedValue([
      { name: "origin", fetchUrl: "https://gitea.example.com/owner/repo.git" },
    ]);
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

    it("rejects instead of retargeting when forgeRemote names a missing remote", async () => {
      // Auto-detecting here would silently point assign/close/merge at a
      // different repository than the one the user named.
      projectStoreMock.getProjectSettings.mockResolvedValue({
        runCommands: [],
        forgeRemote: "renamed-away",
      });
      gitServiceMock.listRemotes.mockResolvedValue([{ name: "origin", fetchUrl: FORK }]);
      resolvesToGitea();

      await expect(resolveForCwd("/repo")).rejects.toThrow(/isn't available/);
      expect(resolverMock.resolveForgeProvider).not.toHaveBeenCalled();
    });

    it("rejects rather than auto-detecting when the settings read fails", async () => {
      // A registered project whose settings are unreadable may well have a
      // forgeRemote — auto-detecting past it could point a mutation at origin.
      projectStoreMock.getProjectSettings.mockRejectedValue(new Error("db locked"));
      gitServiceMock.listRemotes.mockResolvedValue([{ name: "origin", fetchUrl: FORK }]);
      resolvesToGitea();

      await expect(resolveForCwd("/repo")).rejects.toThrow(/forge settings/);
      expect(resolverMock.resolveForgeProvider).not.toHaveBeenCalled();
    });

    it("still auto-detects when the path is not a registered project", async () => {
      // No project means there is no setting to honour, so this stays on the
      // pre-fix behaviour rather than going dark.
      projectStoreMock.getProjectByPath.mockResolvedValue(null);
      gitServiceMock.listRemotes.mockResolvedValue([{ name: "origin", fetchUrl: CANONICAL }]);
      resolvesToGitea();

      await resolveForCwd("/repo");

      expect(lastResolverInputs()?.remoteUrl).toBe(CANONICAL);
    });

    it("does not let hostname matching veto a remote when a provider override is set", async () => {
      // The override bypasses hostname matching by design, so a self-hosted
      // origin it exists to support must not be filtered out in favour of a
      // sibling that happens to match some other provider's hostname.
      projectStoreMock.getProjectSettings.mockResolvedValue({
        runCommands: [],
        forgeProviderOverride: "acme.gitea",
      });
      gitServiceMock.listRemotes.mockResolvedValue([
        { name: "origin", fetchUrl: "https://self-hosted.internal/owner/repo.git" },
        { name: "mirror", fetchUrl: CANONICAL },
      ]);
      registryMock.listMatchingProviders.mockImplementation((url: string) =>
        url.includes("gitea.example.com") ? [{}] : []
      );
      resolvesToGitea();

      await resolveForCwd("/repo");

      expect(lastResolverInputs()?.remoteUrl).toBe("https://self-hosted.internal/owner/repo.git");
    });

    it("falls back to the origin lookup when listRemotes fails and nothing is configured", async () => {
      // A transient git failure must not become a hard "no provider" — that
      // would read downstream as a genuinely unlinked repo and wipe counts.
      gitServiceMock.listRemotes.mockRejectedValue(new Error("git exploded"));
      resolvesToGitea();

      await resolveForCwd("/repo");

      expect(lastResolverInputs()?.remoteUrl).toBe(CANONICAL);
      expect(gitServiceMock.getRemoteUrl).toHaveBeenCalled();
    });

    it("does NOT substitute origin when listRemotes fails and a remote is configured", async () => {
      // We cannot tell whether the configured remote still exists, so origin
      // would be a guess at which repo to talk to.
      projectStoreMock.getProjectSettings.mockResolvedValue({
        runCommands: [],
        forgeRemote: "upstream",
      });
      gitServiceMock.listRemotes.mockRejectedValue(new Error("git exploded"));
      resolvesToGitea();

      await expect(resolveForCwd("/repo")).rejects.toThrow("No remote URL found");
      expect(gitServiceMock.getRemoteUrl).not.toHaveBeenCalled();
    });

    it("enumerates the remote table only once for a repo with no remotes", async () => {
      gitServiceMock.listRemotes.mockResolvedValue([]);
      resolvesToGitea();

      await expect(resolveForCwd("/repo")).rejects.toThrow("No remote URL found");
      expect(gitServiceMock.getRemoteUrl).not.toHaveBeenCalled();
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

  it("refuses to resolve at all when the settings fetch rejects", async () => {
    // Was "passes a null override": treating an unreadable settings row as
    // "no settings" also discards any `forgeRemote` it holds, which would let
    // a mutation resolve against origin instead of the selected repo (#11408).
    projectStoreMock.getProjectSettings.mockRejectedValue(new Error("db locked"));

    await expect(resolveForCwd("/repo")).rejects.toThrow(/forge settings/);
    expect(resolverMock.resolveForgeProvider).not.toHaveBeenCalled();
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
describe("resolveForgeRemoteNameForCwd", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    gitServiceCacheMock.getGitService.mockReturnValue(gitServiceMock);
    gitServiceMock.getRemoteUrl.mockResolvedValue("https://github.com/owner/repo.git");
    gitServiceMock.listWorktrees.mockResolvedValue([
      { path: "/repo", branch: "main", bare: false, isMainWorktree: true },
    ]);
    gitServiceMock.getRepositoryRoot.mockResolvedValue("/repo");
    projectStoreMock.getProjectByPath.mockResolvedValue({ id: "project-1", path: "/repo" });
    projectStoreMock.getProjectSettings.mockResolvedValue({ runCommands: [] });
    gitServiceMock.listRemotes.mockResolvedValue([
      { name: "origin", fetchUrl: "https://github.com/owner/repo.git" },
    ]);
    registryMock.listMatchingProviders.mockReturnValue([{}]);
  });

  it("returns the remote name, not its URL", async () => {
    // The PR-head refspec addresses the forge by remote name, so the name is
    // the part that has to survive resolution (#11747).
    await expect(resolveForgeRemoteNameForCwd("/repo")).resolves.toBe("origin");
  });

  it("returns the configured forgeRemote when the project names one", async () => {
    projectStoreMock.getProjectSettings.mockResolvedValue({
      runCommands: [],
      forgeRemote: "upstream",
    });
    gitServiceMock.listRemotes.mockResolvedValue([
      { name: "origin", fetchUrl: "https://github.com/me/fork.git" },
      { name: "upstream", fetchUrl: "https://github.com/owner/repo.git" },
    ]);

    await expect(resolveForgeRemoteNameForCwd("/repo")).resolves.toBe("upstream");
  });

  it("picks the provider-parseable remote when the forge is not origin", async () => {
    gitServiceMock.listRemotes.mockResolvedValue([
      { name: "origin", fetchUrl: "https://internal.example/mirror.git" },
      { name: "github", fetchUrl: "https://github.com/owner/repo.git" },
    ]);
    registryMock.listMatchingProviders.mockImplementation((url: string) =>
      url.includes("github.com") ? [{}] : []
    );

    await expect(resolveForgeRemoteNameForCwd("/repo")).resolves.toBe("github");
  });

  it("propagates a stale configured remote instead of falling back to origin", async () => {
    // PR numbers are per-repository, so substituting a remote could fetch a
    // completely unrelated PR that happens to share the number.
    projectStoreMock.getProjectSettings.mockResolvedValue({
      runCommands: [],
      forgeRemote: "gone",
    });
    gitServiceMock.listRemotes.mockResolvedValue([
      { name: "origin", fetchUrl: "https://github.com/owner/repo.git" },
    ]);

    await expect(resolveForgeRemoteNameForCwd("/repo")).rejects.toThrow(/gone/);
  });

  it("returns null for a path that is not a git repository", async () => {
    gitServiceCacheMock.getGitService.mockReturnValue(null);

    await expect(resolveForgeRemoteNameForCwd("/not-a-repo")).resolves.toBeNull();
  });

  it("returns null when the repo has no usable remote", async () => {
    gitServiceMock.listRemotes.mockResolvedValue([]);

    await expect(resolveForgeRemoteNameForCwd("/repo")).resolves.toBeNull();
  });
});
