import { beforeEach, describe, expect, it } from "vitest";
import type {
  ForgeProviderContribution,
  ForgeProviderImpl,
  RepoRef,
} from "../../../shared/types/forge.js";
import {
  clearForgeProviderImplRegistry,
  clearForgeProviderRegistry,
  getActiveProvider,
  getForgeProviderImpl,
  getRegisteredForgeProviders,
  listMatchingProviders,
  registerForgeProviderImpl,
  registerForgeProviders,
  unregisterForgeProviderImpl,
  unregisterForgeProviderImpls,
  unregisterForgeProviders,
} from "../forgeProviderRegistry.js";

beforeEach(() => {
  clearForgeProviderRegistry();
  clearForgeProviderImplRegistry();
});

function makeImpl(label: string): ForgeProviderImpl {
  // Minimal stub — the registry doesn't introspect the impl shape; tests only
  // need identity to verify the right impl is stored/returned.
  return {
    label,
    getCredentials: async () => null,
    validateCredentials: async () => ({ valid: false }),
    parseRemote: () => null,
    listIssues: async () => ({ items: [], nextCursor: null, hasMore: false }),
    listPRs: async () => ({ items: [], nextCursor: null, hasMore: false }),
    getIssue: async () => null,
    getPR: async () => null,
    findPRByBranch: async () => null,
    getCIStatus: async () => null,
    getRepoMetadata: async () => ({
      defaultBranch: "main",
      isPrivate: false,
      isFork: false,
      isArchived: false,
      rawData: null,
    }),
    buildIssueUrl: () => "",
    buildPRUrl: () => "",
  } as unknown as ForgeProviderImpl;
}

function makeContribution(
  id: string,
  matches: string[],
  extra: Partial<ForgeProviderContribution> = {}
): ForgeProviderContribution {
  return {
    id,
    name: id,
    matches,
    ...extra,
  };
}

function makeRepoRef(host: string): RepoRef {
  return { host, owner: "o", repo: "r", rawData: null };
}

describe("forgeProviderRegistry — registration", () => {
  it("stores registered contributions and exposes them via getRegisteredForgeProviders", () => {
    registerForgeProviders("acme.github", [makeContribution("github", ["github.com"])]);
    const entries = getRegisteredForgeProviders();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toEqual({
      pluginId: "acme.github",
      contribution: makeContribution("github", ["github.com"]),
    });
  });

  it("preserves registration order across plugins (first-registered first)", () => {
    registerForgeProviders("acme.first", [makeContribution("a", ["a.example"])]);
    registerForgeProviders("acme.second", [makeContribution("b", ["b.example"])]);
    registerForgeProviders("acme.third", [makeContribution("c", ["c.example"])]);

    const entries = getRegisteredForgeProviders();
    expect(entries.map((e) => e.pluginId)).toEqual(["acme.first", "acme.second", "acme.third"]);
  });

  it("supports multiple contributions per plugin and preserves their order", () => {
    registerForgeProviders("acme.multi", [
      makeContribution("primary", ["one.example"]),
      makeContribution("secondary", ["two.example"]),
    ]);

    const entries = getRegisteredForgeProviders();
    expect(entries.map((e) => e.contribution.id)).toEqual(["primary", "secondary"]);
  });

  it("replaces existing contributions for the same plugin when re-registered", () => {
    registerForgeProviders("acme.repeat", [makeContribution("initial", ["initial.example"])]);
    registerForgeProviders("acme.repeat", [
      makeContribution("replacement", ["replacement.example"]),
    ]);

    const entries = getRegisteredForgeProviders();
    expect(entries).toHaveLength(1);
    expect(entries[0].contribution.id).toBe("replacement");
  });

  it("is a no-op when registering an empty array", () => {
    registerForgeProviders("acme.empty", []);
    expect(getRegisteredForgeProviders()).toHaveLength(0);
  });

  it("is a no-op when pluginId is empty or non-string", () => {
    registerForgeProviders("", [makeContribution("x", ["x.example"])]);
    registerForgeProviders(undefined as unknown as string, [makeContribution("y", ["y.example"])]);
    expect(getRegisteredForgeProviders()).toHaveLength(0);
  });

  it("copies the input array so external mutation does not leak in", () => {
    const contributions = [makeContribution("a", ["a.example"])];
    registerForgeProviders("acme.copy", contributions);
    contributions.push(makeContribution("b", ["b.example"]));

    const entries = getRegisteredForgeProviders();
    expect(entries).toHaveLength(1);
    expect(entries[0].contribution.id).toBe("a");
  });

  it("freezes stored contributions so callers cannot corrupt the registry", () => {
    registerForgeProviders("acme.frozen", [
      makeContribution("x", ["frozen.example"], {
        capabilities: ["issues"],
        viewRefs: ["v"],
      }),
    ]);

    const entries = getRegisteredForgeProviders();
    expect(() => entries[0].contribution.matches.push("evil.example")).toThrow();
    expect(() => (entries[0].contribution.capabilities as string[])?.push("evil")).toThrow();
    expect(() => (entries[0].contribution.viewRefs as string[])?.push("evil")).toThrow();
    expect(listMatchingProviders("https://evil.example/r")).toEqual([]);
  });

  it("treats an empty contributions array as an unregister (replace-with-nothing)", () => {
    registerForgeProviders("acme.reset", [makeContribution("a", ["reset.example"])]);
    expect(getRegisteredForgeProviders()).toHaveLength(1);

    registerForgeProviders("acme.reset", []);
    expect(getRegisteredForgeProviders()).toHaveLength(0);
  });
});

describe("forgeProviderRegistry — unregister and clear", () => {
  it("unregisters only the target plugin's contributions", () => {
    registerForgeProviders("acme.keep", [makeContribution("k", ["keep.example"])]);
    registerForgeProviders("acme.drop", [makeContribution("d", ["drop.example"])]);

    unregisterForgeProviders("acme.drop");

    const entries = getRegisteredForgeProviders();
    expect(entries).toHaveLength(1);
    expect(entries[0].pluginId).toBe("acme.keep");
  });

  it("is a no-op when unregistering an unknown pluginId", () => {
    registerForgeProviders("acme.solo", [makeContribution("s", ["solo.example"])]);
    expect(() => unregisterForgeProviders("never-loaded")).not.toThrow();
    expect(getRegisteredForgeProviders()).toHaveLength(1);
  });

  it("is a no-op for empty or non-string pluginId", () => {
    registerForgeProviders("acme.solo", [makeContribution("s", ["solo.example"])]);
    expect(() => unregisterForgeProviders("")).not.toThrow();
    expect(() => unregisterForgeProviders(undefined as unknown as string)).not.toThrow();
    expect(getRegisteredForgeProviders()).toHaveLength(1);
  });

  it("is a no-op when unregistering twice", () => {
    registerForgeProviders("acme.twice", [makeContribution("t", ["twice.example"])]);
    unregisterForgeProviders("acme.twice");
    expect(() => unregisterForgeProviders("acme.twice")).not.toThrow();
    expect(getRegisteredForgeProviders()).toHaveLength(0);
  });

  it("supports register → unregister → re-register round-trip", () => {
    registerForgeProviders("acme.cycle", [makeContribution("c", ["cycle.example"])]);
    unregisterForgeProviders("acme.cycle");
    expect(getRegisteredForgeProviders()).toHaveLength(0);

    registerForgeProviders("acme.cycle", [makeContribution("fresh", ["fresh.example"])]);
    const entries = getRegisteredForgeProviders();
    expect(entries).toHaveLength(1);
    expect(entries[0].contribution.id).toBe("fresh");
  });

  it("clearForgeProviderRegistry removes all entries", () => {
    registerForgeProviders("acme.a", [makeContribution("a", ["a.example"])]);
    registerForgeProviders("acme.b", [makeContribution("b", ["b.example"])]);

    clearForgeProviderRegistry();
    expect(getRegisteredForgeProviders()).toHaveLength(0);
  });
});

describe("forgeProviderRegistry — listMatchingProviders", () => {
  it("matches an HTTPS URL against a hostname pattern", () => {
    registerForgeProviders("acme.github", [makeContribution("github", ["github.com"])]);
    const matches = listMatchingProviders("https://github.com/owner/repo.git");
    expect(matches).toHaveLength(1);
    expect(matches[0].pluginId).toBe("acme.github");
  });

  it("matches an SCP URL (git@host:path) against a hostname pattern", () => {
    registerForgeProviders("acme.gitlab", [makeContribution("gitlab", ["gitlab.com"])]);
    const matches = listMatchingProviders("git@gitlab.com:group/repo.git");
    expect(matches).toHaveLength(1);
    expect(matches[0].pluginId).toBe("acme.gitlab");
  });

  it("matches an SCP URL without a user prefix", () => {
    registerForgeProviders("acme.bare", [makeContribution("bare", ["bare.example.com"])]);
    const matches = listMatchingProviders("bare.example.com:group/repo.git");
    expect(matches).toHaveLength(1);
    expect(matches[0].pluginId).toBe("acme.bare");
  });

  it("matches an ssh:// URL", () => {
    registerForgeProviders("acme.github", [makeContribution("github", ["github.com"])]);
    const matches = listMatchingProviders("ssh://git@github.com/owner/repo.git");
    expect(matches).toHaveLength(1);
  });

  it("does not misclassify HTTPS-with-port as SCP form", () => {
    registerForgeProviders("acme.host", [makeContribution("host", ["host.example.com"])]);
    const matches = listMatchingProviders("https://host.example.com:443/owner/repo.git");
    expect(matches).toHaveLength(1);
    expect(matches[0].pluginId).toBe("acme.host");
  });

  it("strips a www. prefix from the URL hostname before matching", () => {
    registerForgeProviders("acme.github", [makeContribution("github", ["github.com"])]);
    const matches = listMatchingProviders("https://www.github.com/owner/repo");
    expect(matches).toHaveLength(1);
  });

  it("strips a www. prefix from the pattern before matching", () => {
    registerForgeProviders("acme.github", [makeContribution("github", ["www.github.com"])]);
    const matches = listMatchingProviders("https://github.com/owner/repo");
    expect(matches).toHaveLength(1);
  });

  it("matches case-insensitively", () => {
    registerForgeProviders("acme.github", [makeContribution("github", ["GitHub.com"])]);
    const matches = listMatchingProviders("https://GITHUB.COM/owner/repo");
    expect(matches).toHaveLength(1);
  });

  it("returns all matching providers in registration order", () => {
    registerForgeProviders("acme.first", [makeContribution("first", ["github.com"])]);
    registerForgeProviders("acme.second", [makeContribution("second", ["github.com"])]);

    const matches = listMatchingProviders("https://github.com/owner/repo");
    expect(matches.map((m) => m.pluginId)).toEqual(["acme.first", "acme.second"]);
  });

  it("returns empty when no provider matches", () => {
    registerForgeProviders("acme.github", [makeContribution("github", ["github.com"])]);
    const matches = listMatchingProviders("https://gitlab.com/owner/repo");
    expect(matches).toEqual([]);
  });

  it("returns empty when the registry has no entries", () => {
    expect(listMatchingProviders("https://github.com/owner/repo")).toEqual([]);
  });

  it("returns empty for an unparseable URL", () => {
    registerForgeProviders("acme.github", [makeContribution("github", ["github.com"])]);
    expect(listMatchingProviders("")).toEqual([]);
    expect(listMatchingProviders("   ")).toEqual([]);
    expect(listMatchingProviders("not a url")).toEqual([]);
    expect(listMatchingProviders(undefined as unknown as string)).toEqual([]);
  });

  it("matches multiple patterns within a single contribution", () => {
    registerForgeProviders("acme.multi", [
      makeContribution("forge", ["primary.example.com", "secondary.example.com"]),
    ]);

    expect(listMatchingProviders("https://primary.example.com/x")).toHaveLength(1);
    expect(listMatchingProviders("https://secondary.example.com/x")).toHaveLength(1);
    expect(listMatchingProviders("https://other.example.com/x")).toHaveLength(0);
  });
});

describe("forgeProviderRegistry — getActiveProvider", () => {
  it("returns the first matching provider for a URL", () => {
    registerForgeProviders("acme.first", [makeContribution("first", ["github.com"])]);
    registerForgeProviders("acme.second", [makeContribution("second", ["github.com"])]);

    const active = getActiveProvider("https://github.com/owner/repo");
    expect(active?.pluginId).toBe("acme.first");
  });

  it("returns the first matching provider for a RepoRef", () => {
    registerForgeProviders("acme.github", [makeContribution("github", ["github.com"])]);
    const active = getActiveProvider(makeRepoRef("github.com"));
    expect(active?.pluginId).toBe("acme.github");
  });

  it("uses RepoRef.host directly without re-parsing a URL", () => {
    registerForgeProviders("acme.github", [makeContribution("github", ["github.com"])]);
    // RepoRef.host is already the hostname; passing a full URL should not match.
    const active = getActiveProvider(makeRepoRef("https://github.com/owner/repo"));
    expect(active).toBeUndefined();
  });

  it("normalizes RepoRef.host case and www. prefix", () => {
    registerForgeProviders("acme.github", [makeContribution("github", ["github.com"])]);
    expect(getActiveProvider(makeRepoRef("GITHUB.COM"))?.pluginId).toBe("acme.github");
    expect(getActiveProvider(makeRepoRef("www.github.com"))?.pluginId).toBe("acme.github");
  });

  it("returns undefined when no provider matches", () => {
    registerForgeProviders("acme.github", [makeContribution("github", ["github.com"])]);
    expect(getActiveProvider("https://gitlab.com/x/y")).toBeUndefined();
    expect(getActiveProvider(makeRepoRef("gitlab.com"))).toBeUndefined();
  });

  it("returns undefined for a malformed RepoRef", () => {
    registerForgeProviders("acme.github", [makeContribution("github", ["github.com"])]);
    expect(getActiveProvider({ host: "", owner: "", repo: "", rawData: null })).toBeUndefined();
    expect(getActiveProvider(null as unknown as RepoRef)).toBeUndefined();
  });
});

describe("forgeProviderRegistry — implementation registry", () => {
  it("stores and retrieves an impl by namespaced id", () => {
    const impl = makeImpl("primary");
    registerForgeProviderImpl("acme", "github", impl);
    expect(getForgeProviderImpl("acme.github")).toBe(impl);
  });

  it("uses the bare contribution id when the plugin id is the built-in convention", () => {
    // The built-in GitHub plugin registers under pluginId "github" with
    // contributionId "github"; lookup uses the same `${pluginId}.${id}` key.
    const impl = makeImpl("builtin");
    registerForgeProviderImpl("github", "github", impl);
    expect(getForgeProviderImpl("github.github")).toBe(impl);
  });

  it("returns undefined for an unbound namespaced id", () => {
    expect(getForgeProviderImpl("acme.github")).toBeUndefined();
  });

  it("overwrites the impl when re-registered under the same key", () => {
    const first = makeImpl("first");
    const second = makeImpl("second");
    registerForgeProviderImpl("acme", "github", first);
    registerForgeProviderImpl("acme", "github", second);
    expect(getForgeProviderImpl("acme.github")).toBe(second);
  });

  it("unregisterForgeProviderImpl removes only the targeted impl", () => {
    const a = makeImpl("a");
    const b = makeImpl("b");
    registerForgeProviderImpl("acme", "github", a);
    registerForgeProviderImpl("acme", "gitlab", b);
    unregisterForgeProviderImpl("acme", "github");
    expect(getForgeProviderImpl("acme.github")).toBeUndefined();
    expect(getForgeProviderImpl("acme.gitlab")).toBe(b);
  });

  it("unregisterForgeProviderImpl with expected impl removes only when identity matches", () => {
    const first = makeImpl("first");
    const second = makeImpl("second");
    registerForgeProviderImpl("acme", "github", first);
    registerForgeProviderImpl("acme", "github", second);
    // The stale disposer holds `first` but the live entry is `second`.
    unregisterForgeProviderImpl("acme", "github", first);
    expect(getForgeProviderImpl("acme.github")).toBe(second);
    // The fresh disposer holds `second` and matches the live entry.
    unregisterForgeProviderImpl("acme", "github", second);
    expect(getForgeProviderImpl("acme.github")).toBeUndefined();
  });

  it("unregisterForgeProviderImpls removes every impl owned by the plugin", () => {
    registerForgeProviderImpl("acme", "github", makeImpl("g"));
    registerForgeProviderImpl("acme", "gitlab", makeImpl("l"));
    registerForgeProviderImpl("other", "github", makeImpl("o"));
    unregisterForgeProviderImpls("acme");
    expect(getForgeProviderImpl("acme.github")).toBeUndefined();
    expect(getForgeProviderImpl("acme.gitlab")).toBeUndefined();
    expect(getForgeProviderImpl("other.github")).toBeDefined();
  });

  it("double-unregister is a safe no-op", () => {
    registerForgeProviderImpl("acme", "github", makeImpl("x"));
    unregisterForgeProviderImpls("acme");
    expect(() => unregisterForgeProviderImpls("acme")).not.toThrow();
    expect(() => unregisterForgeProviderImpl("acme", "github")).not.toThrow();
    expect(getForgeProviderImpl("acme.github")).toBeUndefined();
  });

  it("ignores empty/non-string plugin or contribution ids on register", () => {
    registerForgeProviderImpl("", "github", makeImpl("x"));
    registerForgeProviderImpl("acme", "", makeImpl("x"));
    registerForgeProviderImpl(undefined as unknown as string, "github", makeImpl("x"));
    expect(getForgeProviderImpl(".github")).toBeUndefined();
    expect(getForgeProviderImpl("acme.")).toBeUndefined();
  });

  it("ignores a non-object impl on register", () => {
    registerForgeProviderImpl("acme", "github", null as unknown as ForgeProviderImpl);
    registerForgeProviderImpl("acme", "github", "nope" as unknown as ForgeProviderImpl);
    expect(getForgeProviderImpl("acme.github")).toBeUndefined();
  });

  it("clearForgeProviderImplRegistry wipes every entry", () => {
    registerForgeProviderImpl("acme", "github", makeImpl("g"));
    registerForgeProviderImpl("acme", "gitlab", makeImpl("l"));
    clearForgeProviderImplRegistry();
    expect(getForgeProviderImpl("acme.github")).toBeUndefined();
    expect(getForgeProviderImpl("acme.gitlab")).toBeUndefined();
  });

  it("descriptor cleanup and impl cleanup are independent", () => {
    registerForgeProviders("acme", [makeContribution("github", ["github.com"])]);
    registerForgeProviderImpl("acme", "github", makeImpl("x"));

    unregisterForgeProviders("acme");
    // Descriptor gone, impl still present — descriptor-only cleanup must not
    // touch the impl table (and vice versa).
    expect(getRegisteredForgeProviders()).toHaveLength(0);
    expect(getForgeProviderImpl("acme.github")).toBeDefined();

    unregisterForgeProviderImpls("acme");
    expect(getForgeProviderImpl("acme.github")).toBeUndefined();
  });
});
