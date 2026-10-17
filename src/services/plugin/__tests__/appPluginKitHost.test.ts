import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const actionService = vi.hoisted(() => ({
  dispatch: vi.fn(() => Promise.resolve({ ok: true, result: undefined })),
  get: vi.fn(() => ({ title: "Open file", danger: "safe", enabled: true })),
  deniesPluginDispatch: vi.fn(() => true),
  selfNotifiesOnExecutionError: vi.fn(() => true),
}));
const notify = vi.hoisted(() => vi.fn(() => "toast-1"));
const dismissNotification = vi.hoisted(() => vi.fn());
const pluginMetaById = vi.hoisted(() => new Map<string, { displayName?: string }>());

vi.mock("@/services/ActionService", () => ({ actionService }));
vi.mock("@/lib/notify", () => ({ notify }));
vi.mock("@/store/notificationStore", () => ({
  useNotificationStore: { getState: () => ({ dismissNotification }) },
}));
vi.mock("@/store/pluginRuntimeStore", () => ({
  usePluginRuntimeStore: { getState: () => ({ pluginMetaById }) },
}));

import { getPluginKitHost } from "@/components/PluginKit/kitHost";
import { installAppPluginKitHost } from "../appPluginKitHost";

const invoke = vi.fn(() => Promise.resolve({ ok: true }));
let dispose: (() => void) | undefined;

beforeEach(() => {
  vi.stubGlobal("window", { electron: { plugin: { invoke } } });
  dispose = installAppPluginKitHost();
});

afterEach(() => {
  dispose?.();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  pluginMetaById.clear();
});

describe("installAppPluginKitHost", () => {
  it("dispatches and reads actions through ActionService", async () => {
    const host = getPluginKitHost();
    await host.dispatchAction("file.view", { path: "/a" }, { source: "plugin" });
    expect(actionService.dispatch).toHaveBeenCalledWith(
      "file.view",
      { path: "/a" },
      { source: "plugin" }
    );
    expect(host.getAction("file.view")?.title).toBe("Open file");
    expect(actionService.get).toHaveBeenCalledWith("file.view", undefined, {
      includeSchemas: false,
    });
    expect(host.deniesPluginDispatch("file.view")).toBe(true);
    expect(host.selfNotifiesOnExecutionError("file.view")).toBe(true);
  });

  it("shows and dismisses toasts through notify and the notification store", () => {
    const host = getPluginKitHost();
    const toast = { type: "error" as const, message: "Acme: failed", rateLimitKey: "k" };
    expect(host.showToast(toast)).toBe("toast-1");
    expect(notify).toHaveBeenCalledWith(toast);
    host.dismissToast("toast-1");
    expect(dismissNotification).toHaveBeenCalledWith("toast-1");
  });

  it("names a plugin from its runtime metadata, and only when it has a name", () => {
    pluginMetaById.set("acme", { displayName: "Acme Board" });
    pluginMetaById.set("blank", { displayName: "" });
    const host = getPluginKitHost();
    expect(host.pluginDisplayName("acme")).toBe("Acme Board");
    expect(host.pluginDisplayName("blank")).toBeUndefined();
    expect(host.pluginDisplayName("missing")).toBeUndefined();
  });

  it("invokes the plugin's worker over plugin IPC and supplies a diff viewer", async () => {
    const host = getPluginKitHost();
    await host.invokePlugin("acme", "sendToAgent", { text: "hi" });
    expect(invoke).toHaveBeenCalledWith("acme", "sendToAgent", { text: "hi" });
    expect(host.DiffViewer).not.toBeNull();
  });

  it("goes inert again once disposed", () => {
    dispose?.();
    dispose = undefined;
    expect(getPluginKitHost().showToast({ type: "info", message: "x" })).toBeNull();
  });
});
