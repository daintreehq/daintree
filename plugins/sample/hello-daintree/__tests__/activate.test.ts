import { describe, expect, it } from "vitest";
import { activate } from "../main/index.js";
import { createMockHost } from "../../../../shared/testing/createMockHost.js";
import type { PluginIpcContext } from "../../../../shared/types/plugin.js";

function makeCtx(overrides: Partial<PluginIpcContext> = {}): PluginIpcContext {
  return {
    projectId: null,
    worktreeId: null,
    webContentsId: 0,
    pluginId: "daintree.hello",
    ...overrides,
  };
}

describe("hello-daintree activate (against createMockHost)", () => {
  it("registers ping handler that echoes plugin + worktree ids", async () => {
    const host = createMockHost({ pluginId: "daintree.hello" });
    await activate(host);
    const ping = host.registeredHandlers.find((h) => h.channel === "ping");
    expect(ping).toBeDefined();
    const result = await ping!.handler(makeCtx({ worktreeId: "wt-7" }));
    expect(result).toEqual({ pluginId: "daintree.hello", worktreeId: "wt-7" });
  });

  it("registers the greet action and dispatches it through to a toast", async () => {
    const host = createMockHost({ pluginId: "daintree.hello" });
    await activate(host);
    expect(host.registeredActions).toHaveLength(1);
    expect(host.registeredActions[0]?.descriptor.id).toBe("greet");
    const result = await host.dispatch("daintree.hello.greet");
    expect(result).toEqual({ ok: true, result: { greeted: true } });
    const greetToast = host.shownToasts.find((t) => t.message.includes("greet action"));
    expect(greetToast).toBeDefined();
  });

  it("fires an activation toast and persists a default greeting", async () => {
    const host = createMockHost({ pluginId: "daintree.hello" });
    await activate(host);
    // Activation toast was scheduled with `void` — wait for the microtask queue
    // to flush so the recording array catches it deterministically.
    await Promise.resolve();
    await Promise.resolve();
    expect(host.shownToasts.some((t) => t.message === "Hello Daintree plugin activated")).toBe(
      true
    );
    expect(await host.settings.get<string>("greeting")).toBe("world");
  });

  it("registers a file-decoration provider on `hello`", async () => {
    const host = createMockHost({ pluginId: "daintree.hello" });
    await activate(host);
    expect(host.registeredFileDecorationProviders).toHaveLength(1);
    expect(host.registeredFileDecorationProviders[0]?.descriptor.id).toBe("hello");
    const impl = host.registeredFileDecorationProviders[0]!.impl;
    const result = await impl.provideDecorations("hello:active", ["/a", "/b"]);
    expect(result).toEqual({
      "/a": { badge: "H", tooltip: "Hello Daintree" },
      "/b": { badge: "H", tooltip: "Hello Daintree" },
    });
  });

  it("invalidates decorations when the active worktree changes", async () => {
    const host = createMockHost({ pluginId: "daintree.hello" });
    await activate(host);
    host.simulateActiveWorktreeChange(null);
    expect(host.invalidationCalls).toContainEqual({ scope: "hello:active", paths: undefined });
  });

  it("disposer unregisters subscriptions and providers", async () => {
    const host = createMockHost({ pluginId: "daintree.hello" });
    const dispose = await activate(host);
    expect(host.registeredFileDecorationProviders).toHaveLength(1);
    dispose();
    expect(host.registeredFileDecorationProviders).toHaveLength(0);
    // After disposal, worktree changes no longer trigger invalidation.
    const before = host.invalidationCalls.length;
    host.simulateActiveWorktreeChange(null);
    expect(host.invalidationCalls.length).toBe(before);
  });
});
