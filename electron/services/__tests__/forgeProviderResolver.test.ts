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
    expect(result).toEqual({ entry: gitea, resolvedVia: "override" });
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
    ).toEqual({ entry: gitea, resolvedVia: "override" });
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
    ).toEqual({ entry: null, resolvedVia: null });
    expect(registryMock.listMatchingProviders).not.toHaveBeenCalled();
  });

  it("treats forgeProviderOverride === null as auto-detect (falls through)", () => {
    const github = makeProvider("builtin", "github", ["github.com"]);
    registryMock.listMatchingProviders.mockReturnValue([github]);

    expect(
      resolveForgeProvider({
        remoteUrl: "https://github.com/owner/repo.git",
        forgeProviderOverride: null,
        globalDefaultProviderId: null,
      })
    ).toEqual({ entry: github, resolvedVia: "hostname" });
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
    ).toEqual({ entry: github, resolvedVia: "hostname" });
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
    ).toEqual({ entry: enterprise, resolvedVia: "default" });
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
    ).toEqual({ entry: null, resolvedVia: null });
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
    ).toEqual({ entry: github, resolvedVia: "default" });
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
    ).toEqual({ entry: github, resolvedVia: "hostname" });
  });

  it("returns no-match when there are no hostname matches", () => {
    registryMock.listMatchingProviders.mockReturnValue([]);
    expect(
      resolveForgeProvider({
        remoteUrl: "https://github.com/owner/repo.git",
        forgeProviderOverride: null,
        globalDefaultProviderId: null,
      })
    ).toEqual({ entry: null, resolvedVia: null });
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
    ).toEqual({ entry: null, resolvedVia: null });
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
    ).toEqual({ entry: gitea, resolvedVia: "override" });
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
    ).toEqual({ entry: null, resolvedVia: null });
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
