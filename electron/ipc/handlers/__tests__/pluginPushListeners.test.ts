import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ipcMainMock = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => void>(),
}));
vi.mock("electron", () => ({
  ipcMain: {
    on: vi.fn((channel: string, handler: (...args: unknown[]) => void) => {
      ipcMainMock.handlers.set(channel, handler);
    }),
    removeListener: vi.fn((channel: string) => {
      ipcMainMock.handlers.delete(channel);
    }),
  },
}));
vi.mock("../../utils.js", () => ({ getProjectRendererTargets: vi.fn(() => []) }));
const scopeMock = vi.hoisted(() => ({ listeners: new Set<() => void>() }));
vi.mock("../../../window/webContentsRegistry.js", () => ({
  onRendererScopeChanged: vi.fn((listener: () => void) => {
    scopeMock.listeners.add(listener);
    return () => scopeMock.listeners.delete(listener);
  }),
}));

import { CHANNELS } from "../../channels.js";
import {
  MAX_PUSH_LISTENER_REPORTS_PER_SECOND,
  registerPluginPushListenerHandlers,
} from "../pluginPushListeners.js";
import { PluginPushListenerRegistry } from "../../../services/plugin/pluginPushListenerRegistry.js";
import {
  MAX_REPORTED_PUSH_LISTENERS,
  parsePushListenerReport,
} from "../../../schemas/pluginPushListeners.js";

const CH = "plugin:acme.demo:tick";

function sender(id: number) {
  return { id, once: vi.fn(), isDestroyed: () => false };
}

describe("plugin:report-push-listeners", () => {
  let registry: PluginPushListenerRegistry;
  let cleanup: () => void;

  beforeEach(() => {
    registry = new PluginPushListenerRegistry(() => []);
    cleanup = registerPluginPushListenerHandlers(registry);
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  const send = (s: ReturnType<typeof sender>, payload: unknown, frame?: unknown) =>
    ipcMainMock.handlers.get(CHANNELS.PLUGIN_REPORT_PUSH_LISTENERS)!(
      { sender: s, senderFrame: frame },
      payload
    );

  it("records a renderer's reported subscriptions", () => {
    const s = sender(7);
    send(s, [[CH, null]]);
    expect(registry.reportedListeners(7)).toEqual([[CH, null]]);
    expect(s.once).toHaveBeenCalledWith("destroyed", expect.any(Function));
  });

  it("marks a malformed report unknown instead of trusting part of it", () => {
    const s = sender(7);
    send(s, []);
    expect(registry.reportedListeners(7)).toEqual([]);
    send(s, [
      [CH, null],
      ["not-a-plugin-channel", null],
    ]);
    expect(registry.reportedListeners(7)).toBeNull();
    expect(registry.isReported(7)).toBe(false);
  });

  it("re-evaluates passive watchers when a reported renderer joins the scope", () => {
    cleanup();
    const scope: Array<ReturnType<typeof sender>> = [];
    registry = new PluginPushListenerRegistry(() => scope);
    cleanup = registerPluginPushListenerHandlers(registry);
    const s = sender(7);
    send(s, [[CH, null]]);
    const seen: boolean[] = [];
    registry.watch(null, CH, (has) => seen.push(has), { passive: true });
    scope.push(s);
    for (const listener of scopeMock.listeners) listener();
    expect(seen).toEqual([true]);
    cleanup();
    expect(scopeMock.listeners.size).toBe(0);
    cleanup = () => {};
  });

  it("ignores reports from a subframe", () => {
    const s = sender(7);
    send(s, [], { parent: {} });
    expect(registry.isReported(7)).toBe(false);
  });

  it("marks a renderer over its report budget unknown, then applies its newest report", () => {
    vi.useFakeTimers();
    const s = sender(7);
    for (let i = 0; i < MAX_PUSH_LISTENER_REPORTS_PER_SECOND; i++) send(s, []);
    expect(registry.reportedListeners(7)).toEqual([]);
    send(s, [[CH, null]]);
    expect(registry.reportedListeners(7)).toBeNull();
    send(s, []);
    vi.advanceTimersByTime(1_000);
    expect(registry.reportedListeners(7)).toEqual([]);
    expect(registry.isReported(7)).toBe(true);
  });
});

describe("parsePushListenerReport", () => {
  it("accepts broadcast and panel pairs", () => {
    expect(
      parsePushListenerReport([
        [CH, null],
        [CH, "p"],
      ])
    ).toEqual([
      [CH, null],
      [CH, "p"],
    ]);
  });

  it.each([
    ["not an array", "x"],
    ["a non-pair entry", [[CH]]],
    ["a foreign channel", [["terminal:data", null]]],
    ["an empty panel id", [[CH, ""]]],
    ["a numeric panel id", [[CH, 3]]],
    ["an oversized channel", [[`plugin:${"x".repeat(1100)}`, null]]],
    ["too many entries", Array.from({ length: MAX_REPORTED_PUSH_LISTENERS + 1 }, () => [CH, null])],
  ])("refuses %s", (_label, payload) => {
    expect(parsePushListenerReport(payload)).toBeNull();
  });
});
