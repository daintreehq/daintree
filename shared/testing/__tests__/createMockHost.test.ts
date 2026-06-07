import { describe, expect, it, vi } from "vitest";
import { createMockHost } from "../createMockHost.js";
import type { PluginActionContribution, PluginWorktreeSnapshot } from "../../types/plugin.js";

const sampleSnapshot: PluginWorktreeSnapshot = {
  id: "wt-1",
  worktreeId: "wt-1",
  path: "/tmp/repo",
  name: "main",
  isCurrent: true,
  linked: null,
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

  it("records registerAction calls", () => {
    const host = createMockHost();
    const handler = vi.fn();
    host.registerAction(sampleAction, handler);
    expect(host.registeredActions).toHaveLength(1);
    expect(host.registeredActions[0]?.descriptor).toEqual(sampleAction);
    expect(host.registeredActions[0]?.handler).toBe(handler);
  });

  it("registerAction replaces a prior registration with the same id", async () => {
    const host = createMockHost({ pluginId: "daintree.hello" });
    const h1 = vi.fn(async () => "v1");
    const h2 = vi.fn(async () => "v2");
    host.registerAction(sampleAction, h1);
    host.registerAction(sampleAction, h2);
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
      ).toThrow(/descriptor must be an object/);
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
      ).toThrow(/handler must be a function/);
    });

    it("rejects missing or empty descriptor.id", () => {
      const host = createMockHost();
      expect(() =>
        host.registerAction(
          { ...sampleAction, id: "" },
          vi.fn() as unknown as Parameters<typeof host.registerAction>[1]
        )
      ).toThrow(/descriptor\.id must be a non-empty string/);
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
  });

  it("records registerHandler calls", () => {
    const host = createMockHost();
    const handler = vi.fn();
    host.registerHandler("ping", handler);
    expect(host.registeredHandlers).toHaveLength(1);
    expect(host.registeredHandlers[0]).toEqual({ channel: "ping", handler });
  });

  it("records broadcastToRenderer calls", () => {
    const host = createMockHost();
    host.broadcastToRenderer("evt", { foo: 1 });
    expect(host.broadcastCalls).toEqual([{ channel: "evt", payload: { foo: 1 } }]);
  });

  it("records showToast calls and rejects empty messages", async () => {
    const host = createMockHost();
    await host.showToast({ message: "hi", type: "info", durationMs: 100 });
    expect(host.shownToasts).toEqual([{ message: "hi", type: "info", durationMs: 100 }]);
    await expect(host.showToast({ message: "" })).rejects.toThrow(/non-empty/);
  });

  it("records invalidateFileDecorations calls", () => {
    const host = createMockHost();
    host.invalidateFileDecorations("hello:*");
    host.invalidateFileDecorations("hello:active", ["/a", "/b"]);
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

  it("delivers active-worktree updates and supports idempotent disposal", () => {
    const host = createMockHost();
    const cb = vi.fn();
    const dispose = host.onDidChangeActiveWorktree(cb);
    host.simulateActiveWorktreeChange(sampleSnapshot);
    host.simulateActiveWorktreeChange(null);
    expect(cb).toHaveBeenCalledTimes(2);
    dispose();
    dispose(); // no-op
    host.simulateActiveWorktreeChange(sampleSnapshot);
    expect(cb).toHaveBeenCalledTimes(2);
  });

  it("delivers worktree-set updates", () => {
    const host = createMockHost();
    const cb = vi.fn();
    host.onDidChangeWorktrees(cb);
    host.simulateWorktreesChange([sampleSnapshot]);
    expect(cb).toHaveBeenCalledWith([sampleSnapshot]);
  });

  it("registers forge providers and unregisters via disposer", () => {
    const host = createMockHost();
    const impl = { parseRemote: vi.fn() } as unknown as Parameters<
      typeof host.registerForgeProvider
    >[1];
    const dispose = host.registerForgeProvider({ id: "ghe" }, impl);
    expect(host.registeredForgeProviders).toHaveLength(1);
    dispose();
    expect(host.registeredForgeProviders).toHaveLength(0);
  });

  describe("registerForgeProvider", () => {
    it("replaces a prior registration with the same id (replace-by-id)", () => {
      const host = createMockHost();
      const impl1 = { parseRemote: vi.fn() } as unknown as Parameters<
        typeof host.registerForgeProvider
      >[1];
      const impl2 = { parseRemote: vi.fn() } as unknown as Parameters<
        typeof host.registerForgeProvider
      >[1];
      host.registerForgeProvider({ id: "ghe" }, impl1);
      host.registerForgeProvider({ id: "ghe" }, impl2);
      expect(host.registeredForgeProviders).toHaveLength(1);
      expect(host.registeredForgeProviders[0]?.impl).toBe(impl2);
    });

    it("makes the prior disposer inert when the id is re-registered with a different impl", () => {
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
      const dispose1 = host.registerForgeProvider({ id: "ghe" }, impl1);
      const dispose2 = host.registerForgeProvider({ id: "ghe" }, impl2);
      dispose1(); // stale — should no-op
      expect(host.registeredForgeProviders).toHaveLength(1);
      expect(host.registeredForgeProviders[0]?.impl).toBe(impl2);
      dispose2(); // fresh — should remove
      expect(host.registeredForgeProviders).toHaveLength(0);
    });

    it("removes the active entry when the same impl is re-registered and the prior disposer fires", () => {
      // Pinned case: if the second registration passes the same impl, the
      // identity guard's `currentImpl === capturedImpl` check matches and the
      // prior disposer does remove. This mirrors the production
      // `expected` argument's identity comparison, not a "newer wins" rule.
      const host = createMockHost();
      const impl = { parseRemote: vi.fn() } as unknown as Parameters<
        typeof host.registerForgeProvider
      >[1];
      const dispose1 = host.registerForgeProvider({ id: "ghe" }, impl);
      host.registerForgeProvider({ id: "ghe" }, impl);
      expect(host.registeredForgeProviders).toHaveLength(1);
      dispose1();
      expect(host.registeredForgeProviders).toHaveLength(0);
    });

    it("disposer is idempotent (calling twice is a no-op)", () => {
      const host = createMockHost();
      const impl = { parseRemote: vi.fn() } as unknown as Parameters<
        typeof host.registerForgeProvider
      >[1];
      const dispose = host.registerForgeProvider({ id: "ghe" }, impl);
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
        /descriptor\.id must be a non-empty string/
      );
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

  it("registers file-decoration providers and unregisters via disposer", () => {
    const host = createMockHost();
    const impl = { provideDecorations: vi.fn(async () => ({})) };
    const dispose = host.registerFileDecorationProvider({ id: "hello" }, impl);
    expect(host.registeredFileDecorationProviders).toHaveLength(1);
    dispose();
    expect(host.registeredFileDecorationProviders).toHaveLength(0);
  });

  describe("registerFileDecorationProvider", () => {
    it("replaces a prior registration with the same id (replace-by-id)", () => {
      const host = createMockHost();
      const impl1 = { provideDecorations: vi.fn(async () => ({})) };
      const impl2 = { provideDecorations: vi.fn(async () => ({})) };
      host.registerFileDecorationProvider({ id: "hello" }, impl1);
      host.registerFileDecorationProvider({ id: "hello" }, impl2);
      expect(host.registeredFileDecorationProviders).toHaveLength(1);
      expect(host.registeredFileDecorationProviders[0]?.impl).toBe(impl2);
    });

    it("makes the prior disposer inert when the id is re-registered with a different impl", () => {
      const host = createMockHost();
      const impl1 = { provideDecorations: vi.fn(async () => ({})) };
      const impl2 = { provideDecorations: vi.fn(async () => ({})) };
      const dispose1 = host.registerFileDecorationProvider({ id: "hello" }, impl1);
      const dispose2 = host.registerFileDecorationProvider({ id: "hello" }, impl2);
      dispose1(); // stale — should no-op
      expect(host.registeredFileDecorationProviders).toHaveLength(1);
      expect(host.registeredFileDecorationProviders[0]?.impl).toBe(impl2);
      dispose2(); // fresh — should remove
      expect(host.registeredFileDecorationProviders).toHaveLength(0);
    });

    it("removes the active entry when the same impl is re-registered and the prior disposer fires", () => {
      const host = createMockHost();
      const impl = { provideDecorations: vi.fn(async () => ({})) };
      const dispose1 = host.registerFileDecorationProvider({ id: "hello" }, impl);
      host.registerFileDecorationProvider({ id: "hello" }, impl);
      expect(host.registeredFileDecorationProviders).toHaveLength(1);
      dispose1();
      expect(host.registeredFileDecorationProviders).toHaveLength(0);
    });

    it("disposer is idempotent (calling twice is a no-op)", () => {
      const host = createMockHost();
      const impl = { provideDecorations: vi.fn(async () => ({})) };
      const dispose = host.registerFileDecorationProvider({ id: "hello" }, impl);
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
        /descriptor\.id must be a non-empty string/
      );
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
      const dispose = host.settings.onDidChange<string>("k", cb);
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
      host.settings.onDidChange("k", user, "user");
      host.settings.onDidChange("k", project, "project");
      await host.settings.set("k", "uv", "user");
      await host.settings.set("k", "pv", "project");
      expect(user).toHaveBeenCalledWith("uv");
      expect(user).not.toHaveBeenCalledWith("pv");
      expect(project).toHaveBeenCalledWith("pv");
    });
  });

  describe("dispatch", () => {
    it("routes through registered action handler and records the call", async () => {
      const host = createMockHost({ pluginId: "daintree.hello" });
      host.registerAction(sampleAction, async (args) => ({ echoed: args }));
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
      host.registerAction(sampleAction, async () => "ok");
      // Real host receives the fully-namespaced id; an unprefixed local id is
      // not a valid built-in action and must not silently resolve.
      const result = await host.dispatch("greet");
      expect(result.ok).toBe(false);
    });

    it("returns EXECUTION_ERROR when the handler throws", async () => {
      const host = createMockHost();
      host.registerAction(sampleAction, async () => {
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
});
