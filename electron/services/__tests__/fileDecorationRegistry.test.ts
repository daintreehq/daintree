import { beforeEach, describe, expect, it } from "vitest";
import type { FileDecoration, FileDecorationProviderImpl } from "../../../shared/types/forge.js";
import {
  clearFileDecorationImplRegistry,
  clearFileDecorationRegistry,
  getFileDecorationImpls,
  getRegisteredFileDecorationProviders,
  registerFileDecorationProviderImpl,
  registerFileDecorationProviders,
  unregisterFileDecorationProviderImpl,
  unregisterFileDecorationProviderImpls,
  unregisterFileDecorationProviders,
} from "../fileDecorationRegistry.js";

beforeEach(() => {
  clearFileDecorationRegistry();
  clearFileDecorationImplRegistry();
});

function makeImpl(badge: string): FileDecorationProviderImpl {
  return {
    async provideDecorations(_scope, paths): Promise<Record<string, FileDecoration>> {
      const out: Record<string, FileDecoration> = {};
      for (const p of paths) out[p] = { badge };
      return out;
    },
  };
}

describe("fileDecorationRegistry", () => {
  it("registers manifest descriptors eagerly and lists them", () => {
    registerFileDecorationProviders("acme.plugin", [{ id: "decor", scopes: ["worktree-diff:*"] }]);
    const listed = getRegisteredFileDecorationProviders();
    expect(listed).toEqual([
      { pluginId: "acme.plugin", contribution: { id: "decor", scopes: ["worktree-diff:*"] } },
    ]);
  });

  it("freezes stored contributions so callers can't mutate the registry", () => {
    registerFileDecorationProviders("acme.plugin", [{ id: "decor", scopes: ["worktree-diff:*"] }]);
    const [{ contribution }] = getRegisteredFileDecorationProviders();
    expect(() => {
      (contribution.scopes as string[]).push("x:*");
    }).toThrow();
  });

  it("returns no impls until one is bound (descriptor present, impl lazy)", () => {
    registerFileDecorationProviders("acme.plugin", [{ id: "decor", scopes: ["worktree-diff:*"] }]);
    expect(getFileDecorationImpls("worktree-diff:/repo")).toEqual([]);

    const impl = makeImpl("1");
    registerFileDecorationProviderImpl("acme.plugin", "decor", impl);
    const resolved = getFileDecorationImpls("worktree-diff:/repo");
    expect(resolved).toHaveLength(1);
    expect(resolved[0]).toMatchObject({ pluginId: "acme.plugin", contributionId: "decor" });
    expect(resolved[0].impl).toBe(impl);
  });

  it("matches exact scopes, prefix wildcards, and the bare wildcard", () => {
    registerFileDecorationProviders("p.exact", [{ id: "a", scopes: ["worktree-diff:/x"] }]);
    registerFileDecorationProviders("p.prefix", [{ id: "b", scopes: ["worktree-diff:*"] }]);
    registerFileDecorationProviders("p.any", [{ id: "c", scopes: ["*"] }]);
    registerFileDecorationProviderImpl("p.exact", "a", makeImpl("a"));
    registerFileDecorationProviderImpl("p.prefix", "b", makeImpl("b"));
    registerFileDecorationProviderImpl("p.any", "c", makeImpl("c"));

    const exact = getFileDecorationImpls("worktree-diff:/x").map((r) => r.pluginId);
    expect(new Set(exact)).toEqual(new Set(["p.exact", "p.prefix", "p.any"]));

    const other = getFileDecorationImpls("worktree-diff:/y").map((r) => r.pluginId);
    expect(new Set(other)).toEqual(new Set(["p.prefix", "p.any"]));

    const unrelated = getFileDecorationImpls("lint:/x").map((r) => r.pluginId);
    expect(unrelated).toEqual(["p.any"]);
  });

  it("ignores empty scope input", () => {
    registerFileDecorationProviders("p", [{ id: "a", scopes: ["*"] }]);
    registerFileDecorationProviderImpl("p", "a", makeImpl("a"));
    expect(getFileDecorationImpls("")).toEqual([]);
  });

  it("unregisterFileDecorationProviderImpl is identity-guarded", () => {
    registerFileDecorationProviders("p", [{ id: "a", scopes: ["*"] }]);
    const first = makeImpl("1");
    const second = makeImpl("2");
    registerFileDecorationProviderImpl("p", "a", first);
    registerFileDecorationProviderImpl("p", "a", second); // overwrite

    // Stale disposer for `first` must not remove the active `second`.
    unregisterFileDecorationProviderImpl("p", "a", first);
    expect(getFileDecorationImpls("x")[0]?.impl).toBe(second);

    unregisterFileDecorationProviderImpl("p", "a", second);
    expect(getFileDecorationImpls("x")).toEqual([]);
  });

  it("bulk-unregisters all impls and descriptors for a plugin on unload", () => {
    registerFileDecorationProviders("p", [
      { id: "a", scopes: ["*"] },
      { id: "b", scopes: ["*"] },
    ]);
    registerFileDecorationProviderImpl("p", "a", makeImpl("a"));
    registerFileDecorationProviderImpl("p", "b", makeImpl("b"));

    unregisterFileDecorationProviderImpls("p");
    expect(getFileDecorationImpls("x")).toEqual([]);

    unregisterFileDecorationProviders("p");
    expect(getRegisteredFileDecorationProviders()).toEqual([]);
  });

  it("empty contributions array clears the descriptor entry", () => {
    registerFileDecorationProviders("p", [{ id: "a", scopes: ["*"] }]);
    registerFileDecorationProviders("p", []);
    expect(getRegisteredFileDecorationProviders()).toEqual([]);
  });
});
