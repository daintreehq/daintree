import { describe, expect, it, vi } from "vitest";
import { createMockHost } from "../createMockHost.js";
import type { PluginActionContribution, PluginWorktreeSnapshot } from "../../types/plugin.js";
import type { PluginActionManifestEntry } from "../../types/actions.js";

const sampleSnapshot: PluginWorktreeSnapshot = {
  id: "wt-1",
  worktreeId: "wt-1",
  path: "/tmp/repo",
  name: "main",
  isCurrent: true,
  linked: null,
  status: null,
};

const otherSnapshot: PluginWorktreeSnapshot = {
  id: "wt-2",
  worktreeId: "wt-2",
  path: "/tmp/repo-feature",
  name: "feature",
  isCurrent: false,
  linked: null,
  status: null,
};

const safeCatalogEntry: PluginActionManifestEntry = {
  id: "core.openFile",
  title: "Open file",
  description: "Open a file in the editor",
  category: "Files",
  kind: "command",
  danger: "safe",
  requiresArgs: true,
};

const confirmCatalogEntry: PluginActionManifestEntry = {
  id: "core.deleteWorktree",
  title: "Delete worktree",
  description: "Remove a worktree",
  category: "Worktrees",
  kind: "command",
  danger: "confirm",
  requiresArgs: true,
};

const sampleAction: PluginActionContribution = {
  id: "greet",
  title: "Greet",
  description: "Say hello",
  category: "Hello",
  kind: "command",
  danger: "safe",
};

describe("createMockHost", () => {
  it("exposes the plugin id passed in options", () => {
    const host = createMockHost({ pluginId: "daintree.hello" });
    expect(host.pluginId).toBe("daintree.hello");
  });

  it("defaults pluginId when none is provided", () => {
    const host = createMockHost();
    expect(host.pluginId).toBe("test.mock");
  });

  it("records registerAction calls", async () => {
    const host = createMockHost();
    const handler = vi.fn();
    await host.registerAction(sampleAction, handler);
    expect(host.registeredActions).toHaveLength(1);
    expect(host.registeredActions[0]?.descriptor).toEqual(sampleAction);
    expect(host.registeredActions[0]?.handler).toBe(handler);
  });

  it("registerAction replaces a prior registration with the same id", async () => {
    const host = createMockHost({ pluginId: "daintree.hello" });
    const h1 = vi.fn(async () => "v1");
    const h2 = vi.fn(async () => "v2");
    await host.registerAction(sampleAction, h1);
    await host.registerAction(sampleAction, h2);
    expect(host.registeredActions).toHaveLength(1);
    expect(host.registeredActions[0]?.handler).toBe(h2);
    const result = await host.dispatch("daintree.hello.greet");
    expect(result).toEqual({ ok: true, result: "v2" });
    expect(h1).not.toHaveBeenCalled();
  });

  describe("registerAction validation", () => {
    it("rejects null/undefined/non-object descriptors", () => {
      const host = createMockHost();
      expect(() =>
        host.registerAction(
          null as unknown as Parameters<typeof host.registerAction>[0],
          vi.fn() as unknown as Parameters<typeof host.registerAction>[1]
        )
      ).toThrow("registerAction: descriptor must be an object");
      expect(() =>
        host.registerAction(
          undefined as unknown as Parameters<typeof host.registerAction>[0],
          vi.fn() as unknown as Parameters<typeof host.registerAction>[1]
        )
      ).toThrow(/descriptor must be an object/);
      expect(() =>
        host.registerAction(
          "greet" as unknown as Parameters<typeof host.registerAction>[0],
          vi.fn() as unknown as Parameters<typeof host.registerAction>[1]
        )
      ).toThrow(/descriptor must be an object/);
    });

    it("rejects non-function handlers", () => {
      const host = createMockHost();
      expect(() =>
        host.registerAction(
          sampleAction,
          null as unknown as Parameters<typeof host.registerAction>[1]
        )
      ).toThrow("registerAction: handler must be a function");
    });

    it("rejects missing or empty descriptor.id", () => {
      const host = createMockHost();
      expect(() =>
        host.registerAction(
          { ...sampleAction, id: "" },
          vi.fn() as unknown as Parameters<typeof host.registerAction>[1]
        )
      ).toThrow("registerAction: descriptor.id must be a non-empty string");
      expect(() =>
        host.registerAction(
          { ...sampleAction, id: undefined as unknown as string },
          vi.fn() as unknown as Parameters<typeof host.registerAction>[1]
        )
      ).toThrow(/descriptor\.id must be a non-empty string/);
    });

    it("rejects a descriptor.id that already starts with the plugin prefix", () => {
      const host = createMockHost({ pluginId: "daintree.hello" });
      expect(() =>
        host.registerAction(
          { ...sampleAction, id: "daintree.hello.greet" },
          vi.fn() as unknown as Parameters<typeof host.registerAction>[1]
        )
      ).toThrow(/must not include the plugin prefix/);
    });

    it("accepts a descriptor.id that merely contains the plugin id as a substring", () => {
      // Substring ≠ prefix: "hello.greet" against pluginId "daintree.hello"
      // is not a prefixed form, so the host namespaces it to
      // "daintree.hello.hello.greet". The real PluginService enforces the
      // startsWith check, not a containment check.
      const host = createMockHost({ pluginId: "daintree.hello" });
      expect(() =>
        host.registerAction(
          { ...sampleAction, id: "hello.greet" },
          vi.fn() as unknown as Parameters<typeof host.registerAction>[1]
        )
      ).not.toThrow();
      expect(host.registeredActions).toHaveLength(1);
    });

    it("accepts a descriptor.id where the FULL plugin id appears as a substring but not a prefix", () => {
      // Stronger than the "hello.greet" test: the entire plugin id
      // "daintree.hello" is contained in the descriptor id, but the id does
      // not start with the plugin prefix. Catches a regression to a
      // `includes(pluginId)` check, which would silently reject this case.
      const host = createMockHost({ pluginId: "daintree.hello" });
      expect(() =>
        host.registerAction(
          { ...sampleAction, id: "x.daintree.hello.greet" },
          vi.fn() as unknown as Parameters<typeof host.registerAction>[1]
        )
      ).not.toThrow();
      expect(host.registeredActions).toHaveLength(1);
    });

    it("rejects a namespaced id that violates the id-format regex", () => {
      // The production regex requires a dot in the namespaced id
      // (`{pluginId}.{actionId}`). "Bad Id" — when namespaced against
      // `daintree.hello` becomes `daintree.hello.Bad Id`, which contains a
      // space and uppercase middle characters that fail the regex.
      const host = createMockHost({ pluginId: "daintree.hello" });
      expect(() =>
        host.registerAction(
          { ...sampleAction, id: "Bad Id" },
          vi.fn() as unknown as Parameters<typeof host.registerAction>[1]
        )
      ).toThrow(/is invalid/);
    });

    it("rejects a non-string/empty/whitespace-only title", () => {
      const host = createMockHost();
      expect(() =>
        host.registerAction(
          { ...sampleAction, title: "" },
          vi.fn() as unknown as Parameters<typeof host.registerAction>[1]
        )
      ).toThrow("registerAction: descriptor.title must be a non-empty string");
      expect(() =>
        host.registerAction(
          { ...sampleAction, title: "   " },
          vi.fn() as unknown as Parameters<typeof host.registerAction>[1]
        )
      ).toThrow(/descriptor\.title must be a non-empty string/);
      expect(() =>
        host.registerAction(
          { ...sampleAction, title: 42 as unknown as string },
          vi.fn() as unknown as Parameters<typeof host.registerAction>[1]
        )
      ).toThrow(/descriptor\.title must be a non-empty string/);
    });

    it("rejects a non-string description", () => {
      const host = createMockHost();
      expect(() =>
        host.registerAction(
          { ...sampleAction, description: 42 as unknown as string },
          vi.fn() as unknown as Parameters<typeof host.registerAction>[1]
        )
      ).toThrow("registerAction: descriptor.description must be a string");
    });

    it("rejects a non-string/empty/whitespace-only category", () => {
      const host = createMockHost();
      expect(() =>
        host.registerAction(
          { ...sampleAction, category: "" },
          vi.fn() as unknown as Parameters<typeof host.registerAction>[1]
        )
      ).toThrow("registerAction: descriptor.category must be a non-empty string");
      expect(() =>
        host.registerAction(
          { ...sampleAction, category: "   " },
          vi.fn() as unknown as Parameters<typeof host.registerAction>[1]
        )
      ).toThrow(/descriptor\.category must be a non-empty string/);
    });

    it("rejects an unknown kind", () => {
      const host = createMockHost();
      expect(() =>
        host.registerAction(
          { ...sampleAction, kind: "bogus" as unknown as "command" },
          vi.fn() as unknown as Parameters<typeof host.registerAction>[1]
        )
      ).toThrow(/descriptor\.kind/);
    });

    it("rejects a danger outside the safe|confirm set", () => {
      const host = createMockHost();
      expect(() =>
        host.registerAction(
          { ...sampleAction, danger: "restricted" as unknown as "safe" },
          vi.fn() as unknown as Parameters<typeof host.registerAction>[1]
        )
      ).toThrow(/descriptor\.danger/);
    });
  });

  it("records registerHandler calls", async () => {
    const host = createMockHost();
    const handler = vi.fn();
    await host.registerHandler("ping", handler);
    expect(host.registeredHandlers).toHaveLength(1);
    expect(host.registeredHandlers[0]).toEqual({ channel: "ping", handler });
  });

  it("records broadcastToRenderer calls", async () => {
    const host = createMockHost();
    await host.broadcastToRenderer("evt", { foo: 1 });
    expect(host.broadcastCalls).toEqual([{ channel: "evt", payload: { foo: 1 } }]);
  });

  it("records showToast calls and rejects empty messages", async () => {
    const host = createMockHost();
    await host.showToast({ message: "hi", type: "info", durationMs: 100 });
    expect(host.shownToasts).toEqual([{ message: "hi", type: "info", durationMs: 100 }]);
    await expect(host.showToast({ message: "" })).rejects.toThrow(/non-empty/);
  });

  it("records invalidateFileDecorations calls", async () => {
    const host = createMockHost();
    await host.invalidateFileDecorations("hello:*");
    await host.invalidateFileDecorations("hello:active", ["/a", "/b"]);
    expect(host.invalidationCalls).toEqual([
      { scope: "hello:*", paths: undefined },
      { scope: "hello:active", paths: ["/a", "/b"] },
    ]);
  });

  it("returns initial worktree snapshots", async () => {
    const host = createMockHost({
      activeWorktree: sampleSnapshot,
      worktrees: [sampleSnapshot],
    });
    expect(await host.getActiveWorktree()).toEqual(sampleSnapshot);
    expect(await host.getWorktrees()).toEqual([sampleSnapshot]);
  });

  it("delivers active-worktree updates and supports idempotent disposal", async () => {
    const host = createMockHost();
    const cb = vi.fn();
    const dispose = await host.onDidChangeActiveWorktree(cb);
    host.simulateActiveWorktreeChange(sampleSnapshot);
    host.simulateActiveWorktreeChange(null);
    expect(cb).toHaveBeenCalledTimes(2);
    dispose();
    dispose(); // no-op
    host.simulateActiveWorktreeChange(sampleSnapshot);
    expect(cb).toHaveBeenCalledTimes(2);
  });

  it("delivers worktree-set updates", async () => {
    const host = createMockHost();
    const cb = vi.fn();
    await host.onDidChangeWorktrees(cb);
    host.simulateWorktreesChange([sampleSnapshot]);
    expect(cb).toHaveBeenCalledWith([sampleSnapshot]);
  });

  it("getAgentState returns null until a state change is simulated", async () => {
    const host = createMockHost();
    expect(await host.getAgentState()).toBeNull();
  });

  it("delivers agent-state updates and reflects the last one in getAgentState", async () => {
    const host = createMockHost();
    const cb = vi.fn();
    const dispose = await host.onDidChangeAgentState(cb);
    const snapshot = {
      agentId: "a1",
      state: "working" as const,
      previousState: "idle" as const,
      running: true,
      timestamp: 7,
    };
    host.simulateAgentStateChange(snapshot);
    expect(cb).toHaveBeenCalledWith(snapshot);
    expect(await host.getAgentState()).toEqual(snapshot);
    dispose();
    dispose(); // no-op
    host.simulateAgentStateChange({ ...snapshot, state: "idle", running: false });
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it("registers forge providers and unregisters via disposer", async () => {
    const host = createMockHost();
    const impl = { parseRemote: vi.fn() } as unknown as Parameters<
      typeof host.registerForgeProvider
    >[1];
    const dispose = await host.registerForgeProvider({ id: "ghe" }, impl);
    expect(host.registeredForgeProviders).toHaveLength(1);
    dispose();
    expect(host.registeredForgeProviders).toHaveLength(0);
  });

  describe("registerForgeProvider", () => {
    it("replaces a prior registration with the same id (replace-by-id)", async () => {
      const host = createMockHost();
      const impl1 = { parseRemote: vi.fn() } as unknown as Parameters<
        typeof host.registerForgeProvider
      >[1];
      const impl2 = { parseRemote: vi.fn() } as unknown as Parameters<
        typeof host.registerForgeProvider
      >[1];
      await host.registerForgeProvider({ id: "ghe" }, impl1);
      await host.registerForgeProvider({ id: "ghe" }, impl2);
      expect(host.registeredForgeProviders).toHaveLength(1);
      expect(host.registeredForgeProviders[0]?.impl).toBe(impl2);
    });

    it("makes the prior disposer inert when the id is re-registered with a different impl", async () => {
      // Matches `unregisterForgeProviderImpl(pluginId, contributionId, expected)`
      // semantics: a stale disposer (captured against the first impl) must not
      // remove the second impl that has overwritten the slot.
      const host = createMockHost();
      const impl1 = { parseRemote: vi.fn() } as unknown as Parameters<
        typeof host.registerForgeProvider
      >[1];
      const impl2 = { parseRemote: vi.fn() } as unknown as Parameters<
        typeof host.registerForgeProvider
      >[1];
      const dispose1 = await host.registerForgeProvider({ id: "ghe" }, impl1);
      const dispose2 = await host.registerForgeProvider({ id: "ghe" }, impl2);
      dispose1(); // stale — should no-op
      expect(host.registeredForgeProviders).toHaveLength(1);
      expect(host.registeredForgeProviders[0]?.impl).toBe(impl2);
      dispose2(); // fresh — should remove
      expect(host.registeredForgeProviders).toHaveLength(0);
    });

    it("removes the active entry when the same impl is re-registered and the prior disposer fires", async () => {
      // Pinned case: if the second registration passes the same impl, the
      // identity guard's `currentImpl === capturedImpl` check matches and the
      // prior disposer does remove. This mirrors the production
      // `expected` argument's identity comparison, not a "newer wins" rule.
      const host = createMockHost();
      const impl = { parseRemote: vi.fn() } as unknown as Parameters<
        typeof host.registerForgeProvider
      >[1];
      const dispose1 = await host.registerForgeProvider({ id: "ghe" }, impl);
      const dispose2 = await host.registerForgeProvider({ id: "ghe" }, impl);
      expect(host.registeredForgeProviders).toHaveLength(1);
      dispose1();
      expect(host.registeredForgeProviders).toHaveLength(0);
      // The second disposer is now stale (its identity-guard misses) — it
      // must be a no-op, not a throw.
      expect(() => dispose2()).not.toThrow();
      expect(host.registeredForgeProviders).toHaveLength(0);
    });

    it("disposer is idempotent (calling twice is a no-op)", async () => {
      const host = createMockHost();
      const impl = { parseRemote: vi.fn() } as unknown as Parameters<
        typeof host.registerForgeProvider
      >[1];
      const dispose = await host.registerForgeProvider({ id: "ghe" }, impl);
      dispose();
      dispose();
      expect(host.registeredForgeProviders).toHaveLength(0);
    });

    it("rejects null/non-object descriptors", () => {
      const host = createMockHost();
      const impl = { parseRemote: vi.fn() } as unknown as Parameters<
        typeof host.registerForgeProvider
      >[1];
      expect(() =>
        host.registerForgeProvider(
          null as unknown as Parameters<typeof host.registerForgeProvider>[0],
          impl
        )
      ).toThrow(/descriptor must be an object/);
      expect(() =>
        host.registerForgeProvider(
          "ghe" as unknown as Parameters<typeof host.registerForgeProvider>[0],
          impl
        )
      ).toThrow(/descriptor must be an object/);
    });

    it("rejects missing or empty descriptor.id", () => {
      const host = createMockHost();
      const impl = { parseRemote: vi.fn() } as unknown as Parameters<
        typeof host.registerForgeProvider
      >[1];
      expect(() => host.registerForgeProvider({ id: "" }, impl)).toThrow(
        "registerForgeProvider: descriptor.id must be a non-empty string"
      );
      // Boundary: "0" is a non-empty string and should be accepted — pins
      // against a `!descriptor.id` regression.
      expect(() => host.registerForgeProvider({ id: "0" }, impl)).not.toThrow();
    });

    it("rejects null/non-object impls", () => {
      const host = createMockHost();
      expect(() =>
        host.registerForgeProvider(
          { id: "ghe" },
          null as unknown as Parameters<typeof host.registerForgeProvider>[1]
        )
      ).toThrow(/impl must be an object/);
      expect(() =>
        host.registerForgeProvider(
          { id: "ghe" },
          "not-an-object" as unknown as Parameters<typeof host.registerForgeProvider>[1]
        )
      ).toThrow(/impl must be an object/);
    });
  });

  it("registers file-decoration providers and unregisters via disposer", async () => {
    const host = createMockHost();
    const impl = { provideDecorations: vi.fn(async () => ({})) };
    const dispose = await host.registerFileDecorationProvider({ id: "hello" }, impl);
    expect(host.registeredFileDecorationProviders).toHaveLength(1);
    dispose();
    expect(host.registeredFileDecorationProviders).toHaveLength(0);
  });

  describe("registerFileDecorationProvider", () => {
    it("replaces a prior registration with the same id (replace-by-id)", async () => {
      const host = createMockHost();
      const impl1 = { provideDecorations: vi.fn(async () => ({})) };
      const impl2 = { provideDecorations: vi.fn(async () => ({})) };
      await host.registerFileDecorationProvider({ id: "hello" }, impl1);
      await host.registerFileDecorationProvider({ id: "hello" }, impl2);
      expect(host.registeredFileDecorationProviders).toHaveLength(1);
      expect(host.registeredFileDecorationProviders[0]?.impl).toBe(impl2);
    });

    it("makes the prior disposer inert when the id is re-registered with a different impl", async () => {
      const host = createMockHost();
      const impl1 = { provideDecorations: vi.fn(async () => ({})) };
      const impl2 = { provideDecorations: vi.fn(async () => ({})) };
      const dispose1 = await host.registerFileDecorationProvider({ id: "hello" }, impl1);
      const dispose2 = await host.registerFileDecorationProvider({ id: "hello" }, impl2);
      dispose1(); // stale — should no-op
      expect(host.registeredFileDecorationProviders).toHaveLength(1);
      expect(host.registeredFileDecorationProviders[0]?.impl).toBe(impl2);
      dispose2(); // fresh — should remove
      expect(host.registeredFileDecorationProviders).toHaveLength(0);
    });

    it("removes the active entry when the same impl is re-registered and the prior disposer fires", async () => {
      const host = createMockHost();
      const impl = { provideDecorations: vi.fn(async () => ({})) };
      const dispose1 = await host.registerFileDecorationProvider({ id: "hello" }, impl);
      const dispose2 = await host.registerFileDecorationProvider({ id: "hello" }, impl);
      expect(host.registeredFileDecorationProviders).toHaveLength(1);
      dispose1();
      expect(host.registeredFileDecorationProviders).toHaveLength(0);
      // The second disposer is now stale — must be a no-op, not a throw.
      expect(() => dispose2()).not.toThrow();
      expect(host.registeredFileDecorationProviders).toHaveLength(0);
    });

    it("disposer is idempotent (calling twice is a no-op)", async () => {
      const host = createMockHost();
      const impl = { provideDecorations: vi.fn(async () => ({})) };
      const dispose = await host.registerFileDecorationProvider({ id: "hello" }, impl);
      dispose();
      dispose();
      expect(host.registeredFileDecorationProviders).toHaveLength(0);
    });

    it("rejects null/non-object descriptors", () => {
      const host = createMockHost();
      const impl = { provideDecorations: vi.fn(async () => ({})) };
      expect(() =>
        host.registerFileDecorationProvider(
          null as unknown as Parameters<typeof host.registerFileDecorationProvider>[0],
          impl
        )
      ).toThrow(/descriptor must be an object/);
    });

    it("rejects missing or empty descriptor.id", () => {
      const host = createMockHost();
      const impl = { provideDecorations: vi.fn(async () => ({})) };
      expect(() => host.registerFileDecorationProvider({ id: "" }, impl)).toThrow(
        "registerFileDecorationProvider: descriptor.id must be a non-empty string"
      );
      // Boundary: "0" is a non-empty string and should be accepted.
      expect(() => host.registerFileDecorationProvider({ id: "0" }, impl)).not.toThrow();
    });

    it("rejects impls missing the provideDecorations function", () => {
      const host = createMockHost();
      expect(() =>
        host.registerFileDecorationProvider(
          { id: "hello" },
          {} as unknown as Parameters<typeof host.registerFileDecorationProvider>[1]
        )
      ).toThrow(/provideDecorations/);
      expect(() =>
        host.registerFileDecorationProvider({ id: "hello" }, {
          provideDecorations: "not a fn",
        } as unknown as Parameters<typeof host.registerFileDecorationProvider>[1])
      ).toThrow(/provideDecorations/);
    });

    it("rejects null/non-object impls", () => {
      const host = createMockHost();
      expect(() =>
        host.registerFileDecorationProvider(
          { id: "hello" },
          null as unknown as Parameters<typeof host.registerFileDecorationProvider>[1]
        )
      ).toThrow(/provideDecorations/);
    });
  });

  describe("settings", () => {
    it("round-trips values within the default user scope", async () => {
      const host = createMockHost();
      await host.settings.set("greeting", "world");
      expect(await host.settings.get<string>("greeting")).toBe("world");
    });

    it("isolates user and project scopes", async () => {
      const host = createMockHost({
        settings: { user: { mode: "alpha" }, project: { mode: "beta" } },
      });
      expect(await host.settings.get("mode", "user")).toBe("alpha");
      expect(await host.settings.get("mode", "project")).toBe("beta");
    });

    it("rejects undefined writes", async () => {
      const host = createMockHost();
      await expect(host.settings.set("k", undefined)).rejects.toThrow(/undefined/);
    });

    it("fires onDidChange only on value changes and respects disposal", async () => {
      const host = createMockHost();
      const cb = vi.fn();
      const dispose = await host.settings.onDidChange<string>("k", cb);
      await host.settings.set("k", "v1");
      await host.settings.set("k", "v1"); // unchanged → no fire
      await host.settings.set("k", "v2");
      expect(cb).toHaveBeenCalledTimes(2);
      expect(cb).toHaveBeenNthCalledWith(1, "v1");
      expect(cb).toHaveBeenNthCalledWith(2, "v2");
      dispose();
      await host.settings.set("k", "v3");
      expect(cb).toHaveBeenCalledTimes(2);
    });

    it("scopes onDidChange subscriptions independently per scope", async () => {
      const host = createMockHost();
      const user = vi.fn();
      const project = vi.fn();
      await host.settings.onDidChange("k", user, "user");
      await host.settings.onDidChange("k", project, "project");
      await host.settings.set("k", "uv", "user");
      await host.settings.set("k", "pv", "project");
      expect(user).toHaveBeenCalledWith("uv");
      expect(user).not.toHaveBeenCalledWith("pv");
      expect(project).toHaveBeenCalledWith("pv");
    });

    // #10586: loose mode (no manifestSettings) keeps the silent "user" default;
    // manifest-aware mode resolves a key's declared scope on read.
    it("loose mode reads the user scope by default regardless of where a value is seeded", async () => {
      const host = createMockHost({
        settings: { user: {}, project: { ref: "from-project" } },
      });
      // No manifestSettings → a no-scope read targets "user", which is empty here.
      expect(await host.settings.get("ref")).toBeUndefined();
      expect(await host.settings.get("ref", "project")).toBe("from-project");
    });

    it("manifest-aware mode resolves a project-scoped key on a no-scope read", async () => {
      const host = createMockHost({
        settings: { project: { ref: "from-project" } },
        manifestSettings: [{ id: "ref", type: "string", scope: "project" }],
      });
      expect(await host.settings.get<string>("ref")).toBe("from-project");
    });

    it("manifest-aware mode throws when the explicit scope conflicts with the declaration", async () => {
      const host = createMockHost({
        settings: { project: { ref: "from-project" } },
        manifestSettings: [{ id: "ref", type: "string", scope: "project" }],
      });
      await expect(host.settings.get("ref", "user")).rejects.toThrow(
        /settings\.get: key "ref" is declared in "project" scope, not "user"/
      );
    });

    it("manifest-aware mode falls back to the caller scope for an undeclared key", async () => {
      const host = createMockHost({
        settings: { user: { loose: "u" }, project: { loose: "p" } },
        manifestSettings: [{ id: "ref", type: "string", scope: "project" }],
      });
      // "loose" isn't declared, so it keeps the supplied (or default) scope.
      expect(await host.settings.get("loose")).toBe("u");
      expect(await host.settings.get("loose", "project")).toBe("p");
    });
  });

  describe("dispatch", () => {
    it("routes through registered action handler and records the call", async () => {
      const host = createMockHost({ pluginId: "daintree.hello" });
      await host.registerAction(sampleAction, async (args) => ({ echoed: args }));
      const result = await host.dispatch("daintree.hello.greet", { name: "ada" });
      expect(host.dispatchedActions).toEqual([
        { actionId: "daintree.hello.greet", args: { name: "ada" } },
      ]);
      expect(result).toEqual({ ok: true, result: { echoed: { name: "ada" } } });
    });

    it("returns NOT_FOUND for unregistered actions", async () => {
      const host = createMockHost();
      const result = await host.dispatch("unknown");
      expect(result).toEqual({
        ok: false,
        error: { code: "NOT_FOUND", message: "Action not found: unknown" },
      });
    });

    it("requires the plugin-id prefix when the host has one bound", async () => {
      const host = createMockHost({ pluginId: "daintree.hello" });
      await host.registerAction(sampleAction, async () => "ok");
      // Real host receives the fully-namespaced id; an unprefixed local id is
      // not a valid built-in action and must not silently resolve.
      const result = await host.dispatch("greet");
      expect(result.ok).toBe(false);
    });

    it("returns EXECUTION_ERROR when the handler throws", async () => {
      const host = createMockHost();
      await host.registerAction(sampleAction, async () => {
        throw new Error("boom");
      });
      const result = await host.dispatch("test.mock.greet");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("EXECUTION_ERROR");
        expect(result.error.message).toBe("boom");
      }
    });

    it("honors setDispatchResult overrides", async () => {
      const host = createMockHost();
      host.setDispatchResult("daintree.hello.greet", {
        ok: false,
        error: { code: "RESTRICTED", message: "nope" },
      });
      const result = await host.dispatch("daintree.hello.greet");
      expect(result).toEqual({
        ok: false,
        error: { code: "RESTRICTED", message: "nope" },
      });
    });

    it("uses a custom dispatch resolver when provided", async () => {
      const dispatch = vi.fn(async () => ({ ok: true as const, result: 42 }));
      const host = createMockHost({ dispatch });
      const result = await host.dispatch("anything", { x: 1 });
      expect(dispatch).toHaveBeenCalledWith("anything", { x: 1 });
      expect(result).toEqual({ ok: true, result: 42 });
    });
  });

  describe("actions catalog", () => {
    it("returns an empty catalog with no verdicts until seeded", async () => {
      const host = createMockHost();
      expect(await host.actions.list()).toEqual([]);
      expect(await host.actions.get("core.openFile")).toBeNull();
      expect(await host.actions.canDispatch("core.openFile")).toBe("restricted");
    });

    it("lists and looks up seeded entries", async () => {
      const host = createMockHost();
      host.seedActionCatalog([safeCatalogEntry, confirmCatalogEntry]);
      expect(await host.actions.list()).toEqual([safeCatalogEntry, confirmCatalogEntry]);
      expect(await host.actions.get("core.openFile")).toEqual(safeCatalogEntry);
      expect(await host.actions.get("core.deleteWorktree")).toEqual(confirmCatalogEntry);
      expect(await host.actions.get("core.missing")).toBeNull();
    });

    it("derives canDispatch from each entry's danger", async () => {
      const host = createMockHost();
      host.seedActionCatalog([safeCatalogEntry, confirmCatalogEntry]);
      expect(await host.actions.canDispatch("core.openFile")).toBe("ok");
      expect(await host.actions.canDispatch("core.deleteWorktree")).toBe("confirm");
      // Unknown id resolves restricted, never throws.
      expect(await host.actions.canDispatch("core.missing")).toBe("restricted");
    });

    it("replaces (does not merge) the catalog on each seed", async () => {
      const host = createMockHost();
      host.seedActionCatalog([safeCatalogEntry, confirmCatalogEntry]);
      host.seedActionCatalog([safeCatalogEntry]);
      expect(await host.actions.list()).toEqual([safeCatalogEntry]);
      expect(await host.actions.get("core.deleteWorktree")).toBeNull();
      // Seeding [] resets to empty.
      host.seedActionCatalog([]);
      expect(await host.actions.list()).toEqual([]);
    });
  });

  describe("storage worktree scope", () => {
    it("isolates values per active worktree across simulateActiveWorktreeChange", async () => {
      const host = createMockHost({ activeWorktree: sampleSnapshot });
      await host.storage.set("draft", "from-A", "worktree");
      expect(await host.storage.get("draft", "worktree")).toBe("from-A");

      // Switching worktrees re-points the worktree-scope store; the key from A
      // is invisible under B.
      host.simulateActiveWorktreeChange(otherSnapshot);
      expect(await host.storage.get("draft", "worktree")).toBeUndefined();
      await host.storage.set("draft", "from-B", "worktree");
      expect(await host.storage.get("draft", "worktree")).toBe("from-B");

      // Switching back restores A's value.
      host.simulateActiveWorktreeChange(sampleSnapshot);
      expect(await host.storage.get("draft", "worktree")).toBe("from-A");
    });

    it("seeds initial worktree-scope values into the active worktree", async () => {
      const host = createMockHost({
        activeWorktree: sampleSnapshot,
        storage: { worktree: { seeded: "value" } },
      });
      expect(await host.storage.get("seeded", "worktree")).toBe("value");
    });

    it("throws on set when no worktree is active", async () => {
      const host = createMockHost();
      await expect(host.storage.set("k", "v", "worktree")).rejects.toThrow(
        /no active worktree — "worktree" scope has no target/
      );
    });

    it("resolves get to undefined and no-ops delete when no worktree is active", async () => {
      const host = createMockHost();
      expect(await host.storage.get("k", "worktree")).toBeUndefined();
      // delete is a no-op (resolves without throwing).
      await expect(host.storage.delete("k", "worktree")).resolves.toBeUndefined();
    });

    it("keeps onDidChange subscriptions alive across a worktree switch", async () => {
      const host = createMockHost({ activeWorktree: sampleSnapshot });
      const cb = vi.fn();
      await host.storage.onDidChange("draft", cb, "worktree");
      await host.storage.set("draft", "from-A", "worktree");
      expect(cb).toHaveBeenLastCalledWith("from-A");

      // The subscription survives the switch and fires for the new worktree.
      host.simulateActiveWorktreeChange(otherSnapshot);
      await host.storage.set("draft", "from-B", "worktree");
      expect(cb).toHaveBeenCalledTimes(2);
      expect(cb).toHaveBeenLastCalledWith("from-B");
    });
  });

  describe("fs.watch", () => {
    it("fires the watcher callback via simulateFsWatch", async () => {
      const host = createMockHost();
      const cb = vi.fn();
      await host.fs.watch(["/tmp/repo"], cb);
      host.simulateFsWatch("/tmp/repo/file.ts");
      expect(cb).toHaveBeenCalledTimes(1);
      expect(cb).toHaveBeenCalledWith("/tmp/repo/file.ts");
    });

    it("fires every active watcher", async () => {
      const host = createMockHost();
      const a = vi.fn();
      const b = vi.fn();
      await host.fs.watch(["/a"], a);
      await host.fs.watch(["/b"], b);
      host.simulateFsWatch("/changed");
      expect(a).toHaveBeenCalledWith("/changed");
      expect(b).toHaveBeenCalledWith("/changed");
    });

    it("stops firing after the disposer runs, and is idempotent", async () => {
      const host = createMockHost();
      const cb = vi.fn();
      const dispose = await host.fs.watch(["/tmp"], cb);
      dispose();
      dispose(); // idempotent — no throw, no double-removal effect
      host.simulateFsWatch("/tmp/file.ts");
      expect(cb).not.toHaveBeenCalled();
    });

    it("throws if the abort signal is already aborted", async () => {
      const host = createMockHost();
      await expect(
        host.fs.watch(["/tmp"], vi.fn(), { signal: AbortSignal.abort() })
      ).rejects.toThrow();
    });
  });
});
