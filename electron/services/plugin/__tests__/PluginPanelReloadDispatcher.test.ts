import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { CHANNELS } from "../../../ipc/channels.js";
import type { PanelReloadTarget } from "../PluginPanelLifecycleBroker.js";

const ipcMainMock = vi.hoisted(() => {
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
  return {
    on: vi.fn((channel: string, handler: (...args: unknown[]) => void) => {
      let set = listeners.get(channel);
      if (!set) {
        set = new Set();
        listeners.set(channel, set);
      }
      set.add(handler);
    }),
    removeListener: vi.fn((channel: string, handler: (...args: unknown[]) => void) => {
      listeners.get(channel)?.delete(handler);
    }),
    _emit: (channel: string, event: unknown, payload: unknown) => {
      for (const handler of [...(listeners.get(channel) ?? [])]) handler(event, payload);
    },
    _count: (channel: string) => listeners.get(channel)?.size ?? 0,
    _reset: () => listeners.clear(),
  };
});

vi.mock("electron", () => ({ ipcMain: ipcMainMock }));

import {
  PLUGIN_PANEL_RELOAD_TIMEOUT_MS,
  PluginPanelReloadDispatcher,
  type PluginPanelReloadDispatcherDeps,
} from "../PluginPanelReloadDispatcher.js";

function makeWebContents(id: number) {
  const destroyed = new Set<() => void>();
  return {
    id,
    send: vi.fn(),
    once: (ev: string, h: () => void) => {
      if (ev === "destroyed") destroyed.add(h);
    },
    removeListener: (ev: string, h: () => void) => {
      if (ev === "destroyed") destroyed.delete(h);
    },
    _destroy: () => {
      for (const h of [...destroyed]) h();
    },
    _listenerCount: () => destroyed.size,
  };
}

type FakeWebContents = ReturnType<typeof makeWebContents>;

function setup(
  target: PanelReloadTarget,
  overrides: Partial<PluginPanelReloadDispatcherDeps> = {}
) {
  const webContents = makeWebContents(target.kind === "located" ? target.sourceId : 99);
  const deps: PluginPanelReloadDispatcherDeps = {
    isDisposed: () => false,
    locate: vi.fn(() => target),
    resolveWebContents: vi.fn(() => webContents),
    isCached: vi.fn(() => false),
    projectFor: vi.fn(() => null),
    now: () => 1_000,
    ...overrides,
  };
  return { dispatcher: new PluginPanelReloadDispatcher(deps), deps, webContents };
}

function sentRequest(webContents: FakeWebContents) {
  const call = webContents.send.mock.calls[0];
  expect(call?.[0]).toBe(CHANNELS.PLUGIN_PANEL_RELOAD_REQUEST);
  return call?.[1] as { requestId: string; panelId: string; pluginId: string; expiresAt: number };
}

function reply(senderId: number, payload: unknown) {
  ipcMainMock._emit(CHANNELS.PLUGIN_PANEL_RELOAD_RESPONSE, { sender: { id: senderId } }, payload);
}

beforeEach(() => {
  ipcMainMock._reset();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("PluginPanelReloadDispatcher", () => {
  it("sends the request to exactly the renderer that holds the panel", async () => {
    const { dispatcher, webContents, deps } = setup({ kind: "located", sourceId: 7 });
    const pending = dispatcher.reload("acme", "p1", null);

    expect(deps.locate).toHaveBeenCalledWith("p1", "acme");
    expect(deps.resolveWebContents).toHaveBeenCalledWith(7);
    const request = sentRequest(webContents);
    expect(request).toMatchObject({
      panelId: "p1",
      pluginId: "acme",
      expiresAt: 1_000 + PLUGIN_PANEL_RELOAD_TIMEOUT_MS,
    });

    reply(7, { requestId: request.requestId, result: "scheduled" });
    await expect(pending).resolves.toBe("scheduled");
    expect(webContents._listenerCount()).toBe(0);
  });

  it.each(["not-mounted", "rate-limited", "unavailable"] as const)(
    "passes the renderer's %s through",
    async (result) => {
      const { dispatcher, webContents } = setup({ kind: "located", sourceId: 7 });
      const pending = dispatcher.reload("acme", "p1", null);
      reply(7, { requestId: sentRequest(webContents).requestId, result });
      await expect(pending).resolves.toBe(result);
    }
  );

  it("ignores a reply from any renderer other than the one asked", async () => {
    const { dispatcher, webContents } = setup({ kind: "located", sourceId: 7 });
    const pending = dispatcher.reload("acme", "p1", null);
    const { requestId } = sentRequest(webContents);

    reply(8, { requestId, result: "scheduled" });
    reply(7, { requestId, result: "not-mounted" });
    await expect(pending).resolves.toBe("not-mounted");
  });

  it("reads a malformed result as unavailable, never as scheduled", async () => {
    const { dispatcher, webContents } = setup({ kind: "located", sourceId: 7 });
    const pending = dispatcher.reload("acme", "p1", null);
    reply(7, { requestId: sentRequest(webContents).requestId, result: "rendered" });
    await expect(pending).resolves.toBe("unavailable");
  });

  it.each([
    ["foreign", /belongs to another plugin/],
    ["non-plugin", /is not a plugin panel/],
  ] as const)("rejects when the renderer refuses the target as %s", async (rejected, message) => {
    const { dispatcher, webContents } = setup({ kind: "located", sourceId: 7 });
    const pending = dispatcher.reload("acme", "p1", null);
    reply(7, { requestId: sentRequest(webContents).requestId, rejected });
    await expect(pending).rejects.toThrow(message);
  });

  it("times out to unavailable, and a late reply changes nothing", async () => {
    const { dispatcher, webContents } = setup({ kind: "located", sourceId: 7 });
    const pending = dispatcher.reload("acme", "p1", null);
    const { requestId } = sentRequest(webContents);

    vi.advanceTimersByTime(PLUGIN_PANEL_RELOAD_TIMEOUT_MS);
    await expect(pending).resolves.toBe("unavailable");
    expect(webContents._listenerCount()).toBe(0);
    expect(() => reply(7, { requestId, result: "scheduled" })).not.toThrow();
  });

  it("resolves unavailable when the renderer is destroyed mid-flight", async () => {
    const { dispatcher, webContents } = setup({ kind: "located", sourceId: 7 });
    const pending = dispatcher.reload("acme", "p1", null);
    webContents._destroy();
    await expect(pending).resolves.toBe("unavailable");
  });

  it("resolves unavailable when the send throws", async () => {
    const { dispatcher, webContents } = setup({ kind: "located", sourceId: 7 });
    webContents.send.mockImplementation(() => {
      throw new Error("gone");
    });
    await expect(dispatcher.reload("acme", "p1", null)).resolves.toBe("unavailable");
  });

  it("does not wake a cached project view", async () => {
    const { dispatcher, webContents } = setup(
      { kind: "located", sourceId: 7 },
      { isCached: () => true }
    );
    await expect(dispatcher.reload("acme", "p1", null)).resolves.toBe("unavailable");
    expect(webContents.send).not.toHaveBeenCalled();
  });

  it("resolves unavailable when the renderer is already gone", async () => {
    const { dispatcher } = setup(
      { kind: "located", sourceId: 7 },
      { resolveWebContents: () => null }
    );
    await expect(dispatcher.reload("acme", "p1", null)).resolves.toBe("unavailable");
  });

  it("keeps a project-bound host out of another project's view", async () => {
    const { dispatcher, webContents } = setup(
      { kind: "located", sourceId: 7 },
      { projectFor: () => "proj-b" }
    );
    await expect(dispatcher.reload("acme", "p1", "proj-a")).rejects.toThrow(
      /belongs to another plugin/
    );
    expect(webContents.send).not.toHaveBeenCalled();
  });

  it("lets a project-bound host reach its own project's view", async () => {
    const { dispatcher, webContents } = setup(
      { kind: "located", sourceId: 7 },
      { projectFor: () => "proj-a" }
    );
    const pending = dispatcher.reload("acme", "p1", "proj-a");
    reply(7, { requestId: sentRequest(webContents).requestId, result: "scheduled" });
    await expect(pending).resolves.toBe("scheduled");
  });

  it.each([
    [{ kind: "missing" } as const, "not-mounted"],
    [{ kind: "not-mounted" } as const, "not-mounted"],
    [{ kind: "unavailable" } as const, "unavailable"],
  ])("answers %o without a round-trip", async (target, expected) => {
    const { dispatcher, webContents } = setup(target);
    await expect(dispatcher.reload("acme", "p1", null)).resolves.toBe(expected);
    expect(webContents.send).not.toHaveBeenCalled();
  });

  it.each([
    [{ kind: "foreign" } as const, /belongs to another plugin/],
    [{ kind: "non-plugin" } as const, /is not a plugin panel/],
  ])("rejects a %o target without a round-trip", async (target, message) => {
    const { dispatcher, webContents } = setup(target);
    await expect(dispatcher.reload("acme", "p1", null)).rejects.toThrow(message);
    expect(webContents.send).not.toHaveBeenCalled();
  });

  it("settles only the unloading plugin's requests", async () => {
    const { dispatcher, webContents } = setup({ kind: "located", sourceId: 7 });
    const acme = dispatcher.reload("acme", "p1", null);
    const other = dispatcher.reload("other", "p2", null);
    dispatcher.cancelPlugin("acme");
    await expect(acme).resolves.toBe("unavailable");

    const otherRequest = webContents.send.mock.calls[1]?.[1] as { requestId: string };
    reply(7, { requestId: otherRequest.requestId, result: "scheduled" });
    await expect(other).resolves.toBe("scheduled");
  });

  it("drains pending requests and removes its listener on dispose", async () => {
    const { dispatcher } = setup({ kind: "located", sourceId: 7 });
    const pending = dispatcher.reload("acme", "p1", null);
    expect(ipcMainMock._count(CHANNELS.PLUGIN_PANEL_RELOAD_RESPONSE)).toBe(1);
    dispatcher.dispose();
    await expect(pending).resolves.toBe("unavailable");
    expect(ipcMainMock._count(CHANNELS.PLUGIN_PANEL_RELOAD_RESPONSE)).toBe(0);
  });

  it("answers unavailable once disposed", async () => {
    const { dispatcher, deps } = setup(
      { kind: "located", sourceId: 7 },
      { isDisposed: () => true }
    );
    await expect(dispatcher.reload("acme", "p1", null)).resolves.toBe("unavailable");
    expect(deps.locate).not.toHaveBeenCalled();
  });
});
