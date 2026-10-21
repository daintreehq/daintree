import { describe, it, expect, vi, beforeEach } from "vitest";
import type {
  ForgeProviderContribution,
  RegisteredForgeProvider,
} from "../../../shared/types/forge.js";

const registryMock = vi.hoisted(() => ({
  getRegisteredForgeProviders: vi.fn<() => RegisteredForgeProvider[]>(() => []),
  listMatchingProviders: vi.fn<(remoteUrl: string) => RegisteredForgeProvider[]>(() => []),
}));

vi.mock("../forgeProviderRegistry.js", () => registryMock);

import { resolveForgeProvider } from "../forgeProviderResolver.js";

function makeProvider(
  pluginId: string,
  id: string,
  matches: string[] = []
): RegisteredForgeProvider {
  const contribution: ForgeProviderContribution = {
    id,
    name: id,
    matches,
  };
  return { pluginId, contribution };
}

/**
 * The resolver's result with no issues override: the code entry serves issues
 * too, so the issues half mirrors it.
 */
function resolvedTo(
  entry: RegisteredForgeProvider | null,
  resolvedVia: "override" | "default" | "hostname" | null
) {
  return {
    entry,
    resolvedVia,
    issues: entry ? { entry, resolvedVia: "code" } : { entry: null, resolvedVia: null },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  registryMock.getRegisteredForgeProviders.mockReturnValue([]);
  registryMock.listMatchingProviders.mockReturnValue([]);
});

describe("resolveForgeProvider", () => {
  it("returns the override match when forgeProviderOverride names a registered provider", () => {
    const gitea = makeProvider("acme.gitea", "gitea", ["gitea.example.com"]);
    const github = makeProvider("builtin", "github", ["github.com"]);
    registryMock.getRegisteredForgeProviders.mockReturnValue([github, gitea]);

    const result = resolveForgeProvider({
      remoteUrl: "https://github.com/owner/repo.git",
      forgeProviderOverride: "gitea",
      globalDefaultProviderId: null,
    });
    expect(result).toEqual(resolvedTo(gitea, "override"));
    // Override path bypasses hostname matching entirely.
    expect(registryMock.listMatchingProviders).not.toHaveBeenCalled();
  });

  it("accepts namespaced ids ({pluginId}.{contributionId}) for the override", () => {
    const gitea = makeProvider("acme.gitea", "gitea", ["gitea.example.com"]);
    registryMock.getRegisteredForgeProviders.mockReturnValue([gitea]);

    expect(
      resolveForgeProvider({
        remoteUrl: "https://github.com/owner/repo.git",
        forgeProviderOverride: "acme.gitea.gitea",
        globalDefaultProviderId: null,
      })
    ).toEqual(resolvedTo(gitea, "override"));
  });

  it("returns no-match when forgeProviderOverride names an unregistered provider (no fallthrough)", () => {
    const github = makeProvider("builtin", "github", ["github.com"]);
    registryMock.getRegisteredForgeProviders.mockReturnValue([github]);
    registryMock.listMatchingProviders.mockReturnValue([github]);

    expect(
      resolveForgeProvider({
        remoteUrl: "https://github.com/owner/repo.git",
        forgeProviderOverride: "gone.away",
        // Both lower tiers would otherwise resolve to `github` — proving they
        // are not consulted when an override names an unregistered provider.
        globalDefaultProviderId: "github",
      })
    ).toEqual(resolvedTo(null, null));
    expect(registryMock.listMatchingProviders).not.toHaveBeenCalled();
  });

  it("treats forgeProviderOverride undefined as auto-detect (falls through)", () => {
    const github = makeProvider("builtin", "github", ["github.com"]);
    registryMock.listMatchingProviders.mockReturnValue([github]);

    expect(
      resolveForgeProvider({
        remoteUrl: "https://github.com/owner/repo.git",
        forgeProviderOverride: undefined,
        globalDefaultProviderId: undefined,
      })
    ).toEqual(resolvedTo(github, "hostname"));
  });

  it("returns the global default when it matches one of the remote candidates", () => {
    const enterprise = makeProvider("acme.gh-enterprise", "gh-enterprise", ["github.com"]);
    const github = makeProvider("builtin", "github", ["github.com"]);
    registryMock.listMatchingProviders.mockReturnValue([github, enterprise]);

    expect(
      resolveForgeProvider({
        remoteUrl: "https://github.com/owner/repo.git",
        forgeProviderOverride: null,
        globalDefaultProviderId: "gh-enterprise",
      })
    ).toEqual(resolvedTo(enterprise, "default"));
  });

  it("returns no-match when the global default is not a hostname match for the remote", () => {
    const github = makeProvider("builtin", "github", ["github.com"]);
    const gitea = makeProvider("acme.gitea", "gitea", ["gitea.example.com"]);
    // The default IS registered globally — but not for this remote's hostname.
    // Rule 2 must filter through listMatchingProviders, not the full registry.
    registryMock.getRegisteredForgeProviders.mockReturnValue([github, gitea]);
    registryMock.listMatchingProviders.mockReturnValue([github]);

    expect(
      resolveForgeProvider({
        remoteUrl: "https://github.com/owner/repo.git",
        forgeProviderOverride: null,
        globalDefaultProviderId: "gitea",
      })
    ).toEqual(resolvedTo(null, null));
  });

  it("accepts namespaced ids for the global default", () => {
    const github = makeProvider("builtin", "github", ["github.com"]);
    registryMock.listMatchingProviders.mockReturnValue([github]);

    expect(
      resolveForgeProvider({
        remoteUrl: "https://github.com/owner/repo.git",
        forgeProviderOverride: null,
        globalDefaultProviderId: "builtin.github",
      })
    ).toEqual(resolvedTo(github, "default"));
  });

  it("returns the first hostname match when no override or default is set", () => {
    const github = makeProvider("builtin", "github", ["github.com"]);
    const other = makeProvider("acme.other", "other", ["github.com"]);
    registryMock.listMatchingProviders.mockReturnValue([github, other]);

    expect(
      resolveForgeProvider({
        remoteUrl: "https://github.com/owner/repo.git",
        forgeProviderOverride: null,
        globalDefaultProviderId: null,
      })
    ).toEqual(resolvedTo(github, "hostname"));
  });

  it("returns no-match when there are no hostname matches", () => {
    registryMock.listMatchingProviders.mockReturnValue([]);
    expect(
      resolveForgeProvider({
        remoteUrl: "https://github.com/owner/repo.git",
        forgeProviderOverride: null,
        globalDefaultProviderId: null,
      })
    ).toEqual(resolvedTo(null, null));
  });

  it("returns no-match when remoteUrl is null and no override is set", () => {
    const github = makeProvider("builtin", "github", ["github.com"]);
    registryMock.listMatchingProviders.mockReturnValue([github]);

    expect(
      resolveForgeProvider({
        remoteUrl: null,
        forgeProviderOverride: null,
        globalDefaultProviderId: null,
      })
    ).toEqual(resolvedTo(null, null));
    expect(registryMock.listMatchingProviders).not.toHaveBeenCalled();
  });

  it("still resolves the override when remoteUrl is null", () => {
    const gitea = makeProvider("acme.gitea", "gitea", ["gitea.example.com"]);
    registryMock.getRegisteredForgeProviders.mockReturnValue([gitea]);

    expect(
      resolveForgeProvider({
        remoteUrl: null,
        forgeProviderOverride: "gitea",
        globalDefaultProviderId: null,
      })
    ).toEqual(resolvedTo(gitea, "override"));
  });

  it("returns no-match when remoteUrl is empty and no override is set", () => {
    const github = makeProvider("builtin", "github", ["github.com"]);
    registryMock.listMatchingProviders.mockReturnValue([github]);

    expect(
      resolveForgeProvider({
        remoteUrl: "",
        forgeProviderOverride: null,
        globalDefaultProviderId: null,
      })
    ).toEqual(resolvedTo(null, null));
  });

  it("does no caching — registry is re-read on each call", () => {
    const github = makeProvider("builtin", "github", ["github.com"]);
    registryMock.listMatchingProviders.mockReturnValue([github]);

    resolveForgeProvider({
      remoteUrl: "https://github.com/owner/repo.git",
      forgeProviderOverride: null,
      globalDefaultProviderId: null,
    });
    resolveForgeProvider({
      remoteUrl: "https://github.com/owner/repo.git",
      forgeProviderOverride: null,
      globalDefaultProviderId: null,
    });

    expect(registryMock.listMatchingProviders).toHaveBeenCalledTimes(2);
  });
});

describe("resolveForgeProvider — roles (#13700)", () => {
  function makeIssuesOnly(pluginId: string, id: string): RegisteredForgeProvider {
    return { pluginId, contribution: { id, name: id, matches: [], roles: ["issues"] } };
  }

  it("serves issues from the issues override while the code forge keeps code", () => {
    const github = makeProvider("daintree.github", "github", ["github.com"]);
    const tracker = makeIssuesOnly("acme.tracker", "tracker");
    registryMock.getRegisteredForgeProviders.mockReturnValue([github, tracker]);
    registryMock.listMatchingProviders.mockReturnValue([github]);

    expect(
      resolveForgeProvider({
        remoteUrl: "https://github.com/owner/repo.git",
        forgeProviderOverride: null,
        globalDefaultProviderId: null,
        issueProviderOverride: "acme.tracker.tracker",
      })
    ).toEqual({
      entry: github,
      resolvedVia: "hostname",
      issues: { entry: tracker, resolvedVia: "override" },
    });
  });

  it("resolves the issues override with no remote and no code provider", () => {
    const tracker = makeIssuesOnly("acme.tracker", "tracker");
    registryMock.getRegisteredForgeProviders.mockReturnValue([tracker]);

    expect(
      resolveForgeProvider({
        remoteUrl: null,
        forgeProviderOverride: null,
        globalDefaultProviderId: null,
        issueProviderOverride: "acme.tracker.tracker",
      })
    ).toEqual({
      entry: null,
      resolvedVia: null,
      issues: { entry: tracker, resolvedVia: "override" },
    });
  });

  it("never falls back to the code forge's issues when the issues override names nothing", () => {
    const github = makeProvider("daintree.github", "github", ["github.com"]);
    registryMock.getRegisteredForgeProviders.mockReturnValue([github]);
    registryMock.listMatchingProviders.mockReturnValue([github]);

    const result = resolveForgeProvider({
      remoteUrl: "https://github.com/owner/repo.git",
      forgeProviderOverride: null,
      globalDefaultProviderId: null,
      issueProviderOverride: "acme.tracker.tracker",
    });
    expect(result.entry).toBe(github);
    expect(result.issues).toEqual({ entry: null, resolvedVia: null });
  });

  it("never picks an issues-only provider for code — by override, default or hostname", () => {
    const tracker: RegisteredForgeProvider = {
      pluginId: "acme.tracker",
      contribution: { id: "tracker", name: "tracker", matches: [], roles: ["issues"] },
    };
    registryMock.getRegisteredForgeProviders.mockReturnValue([tracker]);
    // Even if a registry bug surfaced it as a hostname candidate.
    registryMock.listMatchingProviders.mockReturnValue([tracker]);

    for (const inputs of [
      { forgeProviderOverride: "acme.tracker.tracker", globalDefaultProviderId: null },
      { forgeProviderOverride: null, globalDefaultProviderId: "acme.tracker.tracker" },
      { forgeProviderOverride: null, globalDefaultProviderId: null },
    ]) {
      const result = resolveForgeProvider({ remoteUrl: "https://github.com/o/r.git", ...inputs });
      expect(result.entry).toBeNull();
      expect(result.issues).toEqual({ entry: null, resolvedVia: null });
    }
  });

  it("accepts a full provider as the issues override", () => {
    const github = makeProvider("daintree.github", "github", ["github.com"]);
    const gitlab = makeProvider("daintree.gitlab", "gitlab", ["gitlab.com"]);
    registryMock.getRegisteredForgeProviders.mockReturnValue([github, gitlab]);
    registryMock.listMatchingProviders.mockReturnValue([github]);

    expect(
      resolveForgeProvider({
        remoteUrl: "https://github.com/owner/repo.git",
        forgeProviderOverride: null,
        globalDefaultProviderId: null,
        issueProviderOverride: "daintree.gitlab.gitlab",
      }).issues
    ).toEqual({ entry: gitlab, resolvedVia: "override" });
  });
});
