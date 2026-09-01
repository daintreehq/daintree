import { describe, it, expect, vi, beforeEach } from "vitest";
import { CHANNELS } from "../../../ipc/channels.js";

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
    _listenerCount: (channel: string) => listeners.get(channel)?.size ?? 0,
    _reset: () => listeners.clear(),
  };
});

const windowRefMock = vi.hoisted(() => ({
  getWindowRegistry: vi.fn((): unknown => null),
  getProjectViewManager: vi.fn((): unknown => null),
}));

const webContentsMock = vi.hoisted(() => {
  const byId = new Map<number, unknown>();
  return {
    fromId: vi.fn((id: number) => byId.get(id) ?? undefined),
    _register: (id: number, wc: unknown) => byId.set(id, wc),
    _reset: () => byId.clear(),
  };
});

const registryMock = vi.hoisted(() => ({
  getWebContentsForProject: vi.fn((_projectId: string): unknown[] => []),
  isCachedViewWebContents: vi.fn((_id: number): boolean => false),
}));

vi.mock("electron", () => ({ ipcMain: ipcMainMock, webContents: webContentsMock }));
vi.mock("../../../window/windowRef.js", () => ({
  getWindowRegistry: windowRefMock.getWindowRegistry,
  getProjectViewManager: windowRefMock.getProjectViewManager,
}));
vi.mock("../../../window/webContentsRegistry.js", () => ({
  getWebContentsForProject: registryMock.getWebContentsForProject,
  isCachedViewWebContents: registryMock.isCachedViewWebContents,
}));

import { PluginUIPromptDispatcher } from "../PluginUIPromptDispatcher.js";
import { isAppError } from "../../../utils/errorTypes.js";
import type { PluginUiPromptParams } from "../../../../shared/types/pluginUiPrompt.js";

function makeWebContents(id: number) {
  const destroyed = new Set<() => void>();
  const wc = {
    id,
    isDestroyed: () => false,
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
  };
  // Register so `webContents.fromId(id)` resolves it (the cancel-targeting path).
  webContentsMock._register(id, wc);
  return wc;
}

/** Point the window registry at a single active WebContents. */
function setActiveWebContents(wc: ReturnType<typeof makeWebContents> | null) {
  if (!wc) {
    windowRefMock.getWindowRegistry.mockReturnValue(null);
    windowRefMock.getProjectViewManager.mockReturnValue(null);
    return;
  }
  const ctx = {
    browserWindow: { isDestroyed: () => false },
    services: { projectViewManager: { getActiveView: () => ({ webContents: wc }) } },
  };
  windowRefMock.getWindowRegistry.mockReturnValue({
    getPrimary: () => ctx,
    all: () => [ctx],
  });
  windowRefMock.getProjectViewManager.mockReturnValue(null);
}

/** Point the app-global project→webContents map at a fixed set of views. */
function setProjectViews(
  views: Record<string, ReturnType<typeof makeWebContents>[]>,
  cachedIds: number[] = []
) {
  registryMock.getWebContentsForProject.mockImplementation(
    (projectId: string) => views[projectId] ?? []
  );
  registryMock.isCachedViewWebContents.mockImplementation((id: number) => cachedIds.includes(id));
}

const QUICK_PICK: PluginUiPromptParams = { kind: "quickPick", items: [], options: {} };
const CONFIRM: PluginUiPromptParams = { kind: "confirm", options: { title: "Sure?" } };

/** Read the promptId from the latest PLUGIN_UI_PROMPT_REQUEST send. */
function lastPromptId(wc: ReturnType<typeof makeWebContents>): string {
  const calls = wc.send.mock.calls.filter((c) => c[0] === CHANNELS.PLUGIN_UI_PROMPT_REQUEST);
  const payload = calls[calls.length - 1]?.[1] as { promptId: string };
  return payload.promptId;
}

describe("PluginUIPromptDispatcher", () => {
  beforeEach(() => {
    ipcMainMock._reset();
    ipcMainMock.on.mockClear();
    ipcMainMock.removeListener.mockClear();
    windowRefMock.getWindowRegistry.mockReset();
    windowRefMock.getProjectViewManager.mockReset();
    webContentsMock._reset();
    webContentsMock.fromId.mockClear();
    registryMock.getWebContentsForProject.mockReset();
    registryMock.isCachedViewWebContents.mockReset();
    registryMock.getWebContentsForProject.mockReturnValue([]);
    registryMock.isCachedViewWebContents.mockReturnValue(false);
  });

  it("sends the request to the active renderer and resolves with the response value", async () => {
    const wc = makeWebContents(7);
    setActiveWebContents(wc);
    const d = new PluginUIPromptDispatcher({ isDisposed: () => false });

    const promise = d.requestPrompt("p1", QUICK_PICK);
    expect(wc.send).toHaveBeenCalledWith(
      CHANNELS.PLUGIN_UI_PROMPT_REQUEST,
      expect.objectContaining({ pluginId: "p1", params: QUICK_PICK })
    );

    const promptId = lastPromptId(wc);
    const answer = { id: "a", label: "Alpha" };
    ipcMainMock._emit(
      CHANNELS.PLUGIN_UI_PROMPT_RESPONSE,
      { sender: { id: 7 } },
      {
        promptId,
        result: answer,
      }
    );

    await expect(promise).resolves.toEqual(answer);
  });

  it("ignores a response from an unexpected sender", async () => {
    const wc = makeWebContents(7);
    setActiveWebContents(wc);
    const d = new PluginUIPromptDispatcher({ isDisposed: () => false });

    const promise = d.requestPrompt("p1", QUICK_PICK);
    const promptId = lastPromptId(wc);

    // Forged response from a different window — must NOT resolve.
    ipcMainMock._emit(
      CHANNELS.PLUGIN_UI_PROMPT_RESPONSE,
      { sender: { id: 999 } },
      {
        promptId,
        result: { id: "x", label: "Forged" },
      }
    );
    // Malformed payload (no promptId) — must be ignored, not throw.
    ipcMainMock._emit(CHANNELS.PLUGIN_UI_PROMPT_RESPONSE, { sender: { id: 7 } }, {});
    // The genuine sender then answers.
    ipcMainMock._emit(
      CHANNELS.PLUGIN_UI_PROMPT_RESPONSE,
      { sender: { id: 7 } },
      {
        promptId,
        result: undefined,
      }
    );

    await expect(promise).resolves.toBeUndefined();
  });

  it("resolves the cancel value when no renderer is available (false for confirm, undefined otherwise)", async () => {
    setActiveWebContents(null);
    const d = new PluginUIPromptDispatcher({ isDisposed: () => false });

    await expect(d.requestPrompt("p1", CONFIRM)).resolves.toBe(false);
    await expect(d.requestPrompt("p1", QUICK_PICK)).resolves.toBeUndefined();
  });

  it("resolves the cancel value when the renderer is destroyed before answering", async () => {
    const wc = makeWebContents(7);
    setActiveWebContents(wc);
    const d = new PluginUIPromptDispatcher({ isDisposed: () => false });

    const promise = d.requestPrompt("p1", CONFIRM);
    wc._destroy();
    await expect(promise).resolves.toBe(false);
  });

  it("cancelForPlugin resolves the plugin's pending prompts and dismisses the dialog", async () => {
    const wc = makeWebContents(7);
    setActiveWebContents(wc);
    const d = new PluginUIPromptDispatcher({ isDisposed: () => false });

    const other = d.requestPrompt("other", QUICK_PICK);
    const mine = d.requestPrompt("mine", CONFIRM);

    d.cancelForPlugin("mine");

    await expect(mine).resolves.toBe(false);
    expect(wc.send).toHaveBeenCalledWith(
      CHANNELS.PLUGIN_UI_PROMPT_CANCEL,
      expect.objectContaining({ pluginId: "mine" })
    );

    // The other plugin's prompt is untouched until it answers.
    const otherId = (
      wc.send.mock.calls.find(
        (c) =>
          c[0] === CHANNELS.PLUGIN_UI_PROMPT_REQUEST &&
          (c[1] as { pluginId: string }).pluginId === "other"
      )?.[1] as { promptId: string }
    ).promptId;
    ipcMainMock._emit(
      CHANNELS.PLUGIN_UI_PROMPT_RESPONSE,
      { sender: { id: 7 } },
      {
        promptId: otherId,
        result: { id: "k", label: "Kept" },
      }
    );
    await expect(other).resolves.toEqual({ id: "k", label: "Kept" });
  });

  it("cancelForPlugin dismisses on the ORIGINAL window even after focus switches", async () => {
    const wc1 = makeWebContents(7);
    setActiveWebContents(wc1);
    const d = new PluginUIPromptDispatcher({ isDisposed: () => false });

    const promise = d.requestPrompt("mine", CONFIRM);

    // User switches to another window/project before the plugin unloads.
    const wc2 = makeWebContents(42);
    setActiveWebContents(wc2);

    d.cancelForPlugin("mine");

    await expect(promise).resolves.toBe(false);
    // The cancel must land on wc1 (where the prompt is shown), not the now-active wc2.
    expect(wc1.send).toHaveBeenCalledWith(
      CHANNELS.PLUGIN_UI_PROMPT_CANCEL,
      expect.objectContaining({ pluginId: "mine" })
    );
    expect(wc2.send).not.toHaveBeenCalledWith(CHANNELS.PLUGIN_UI_PROMPT_CANCEL, expect.anything());
  });

  it("dispose resolves every pending prompt with its cancel value and removes the listener", async () => {
    const wc = makeWebContents(7);
    setActiveWebContents(wc);
    const d = new PluginUIPromptDispatcher({ isDisposed: () => false });

    const a = d.requestPrompt("p1", QUICK_PICK);
    const b = d.requestPrompt("p2", CONFIRM);
    expect(ipcMainMock._listenerCount(CHANNELS.PLUGIN_UI_PROMPT_RESPONSE)).toBe(1);

    d.dispose();

    await expect(a).resolves.toBeUndefined();
    await expect(b).resolves.toBe(false);
    expect(ipcMainMock._listenerCount(CHANNELS.PLUGIN_UI_PROMPT_RESPONSE)).toBe(0);
  });

  it("resolves the cancel value immediately when the service is already disposed", async () => {
    setActiveWebContents(makeWebContents(7));
    const d = new PluginUIPromptDispatcher({ isDisposed: () => true });
    await expect(d.requestPrompt("p1", CONFIRM)).resolves.toBe(false);
  });

  it("caps a plugin to one in-flight prompt: a second request cancels immediately without a send", async () => {
    const wc = makeWebContents(7);
    setActiveWebContents(wc);
    const d = new PluginUIPromptDispatcher({ isDisposed: () => false });

    const first = d.requestPrompt("p1", QUICK_PICK);
    const sendsAfterFirst = wc.send.mock.calls.filter(
      (c) => c[0] === CHANNELS.PLUGIN_UI_PROMPT_REQUEST
    ).length;
    expect(sendsAfterFirst).toBe(1);

    // Second prompt for the same plugin while the first is pending: cancelled
    // immediately (false for confirm) and never sent to the renderer.
    await expect(d.requestPrompt("p1", CONFIRM)).resolves.toBe(false);
    const sendsAfterSecond = wc.send.mock.calls.filter(
      (c) => c[0] === CHANNELS.PLUGIN_UI_PROMPT_REQUEST
    ).length;
    expect(sendsAfterSecond).toBe(1);

    // The first prompt is unaffected and still resolves with the real answer.
    const promptId = lastPromptId(wc);
    ipcMainMock._emit(
      CHANNELS.PLUGIN_UI_PROMPT_RESPONSE,
      { sender: { id: 7 } },
      { promptId, result: { id: "a", label: "Alpha" } }
    );
    await expect(first).resolves.toEqual({ id: "a", label: "Alpha" });

    // After the first settles, the plugin can open another prompt.
    const third = d.requestPrompt("p1", QUICK_PICK);
    expect(
      wc.send.mock.calls.filter((c) => c[0] === CHANNELS.PLUGIN_UI_PROMPT_REQUEST).length
    ).toBe(2);
    d.dispose();
    await expect(third).resolves.toBeUndefined();
  });

  it("the per-plugin cap is independent across plugins", async () => {
    const wc = makeWebContents(7);
    setActiveWebContents(wc);
    const d = new PluginUIPromptDispatcher({ isDisposed: () => false });

    const a = d.requestPrompt("p1", QUICK_PICK);
    // A different plugin is not blocked by p1's in-flight prompt.
    const b = d.requestPrompt("p2", QUICK_PICK);
    expect(
      wc.send.mock.calls.filter((c) => c[0] === CHANNELS.PLUGIN_UI_PROMPT_REQUEST).length
    ).toBe(2);

    d.dispose();
    await expect(a).resolves.toBeUndefined();
    await expect(b).resolves.toBeUndefined();
  });

  it("prompts the bound project's renderer, never the focused project's", async () => {
    const wcA = makeWebContents(11);
    const wcB = makeWebContents(22);
    setActiveWebContents(wcB);
    setProjectViews({ A: [wcA], B: [wcB] });
    const d = new PluginUIPromptDispatcher({ isDisposed: () => false });

    const promise = d.requestPrompt("p1", CONFIRM, "A");
    expect(wcA.send).toHaveBeenCalledWith(
      CHANNELS.PLUGIN_UI_PROMPT_REQUEST,
      expect.objectContaining({ pluginId: "p1" })
    );
    expect(wcB.send).not.toHaveBeenCalled();

    const promptId = lastPromptId(wcA);
    // B's renderer must not be able to answer A's prompt.
    ipcMainMock._emit(
      CHANNELS.PLUGIN_UI_PROMPT_RESPONSE,
      { sender: { id: 22 } },
      {
        promptId,
        result: true,
      }
    );
    ipcMainMock._emit(
      CHANNELS.PLUGIN_UI_PROMPT_RESPONSE,
      { sender: { id: 11 } },
      {
        promptId,
        result: true,
      }
    );
    await expect(promise).resolves.toBe(true);
  });

  it("rejects with PROJECT_VIEW_UNAVAILABLE when the bound project has no live view", async () => {
    const wcB = makeWebContents(22);
    setActiveWebContents(wcB);
    setProjectViews({ B: [wcB] });
    const d = new PluginUIPromptDispatcher({ isDisposed: () => false });

    const error: unknown = await d.requestPrompt("p1", CONFIRM, "A").then(
      (value) => value,
      (e: unknown) => e
    );
    expect(isAppError(error)).toBe(true);
    expect(isAppError(error) && error.code).toBe("PROJECT_VIEW_UNAVAILABLE");
    // Never delivered to the focused project instead.
    expect(wcB.send).not.toHaveBeenCalled();
  });

  it("delivers a bound prompt to a cached (not currently visible) view", async () => {
    const cached = makeWebContents(31);
    setActiveWebContents(null);
    setProjectViews({ A: [cached] }, [31]);
    const d = new PluginUIPromptDispatcher({ isDisposed: () => false });

    const promise = d.requestPrompt("p1", QUICK_PICK, "A");
    expect(cached.send).toHaveBeenCalledWith(
      CHANNELS.PLUGIN_UI_PROMPT_REQUEST,
      expect.objectContaining({ pluginId: "p1" })
    );
    d.dispose();
    await expect(promise).resolves.toBeUndefined();
  });

  it("leaves the unbound path on the focused view and never consults the project map", async () => {
    const wcB = makeWebContents(22);
    setActiveWebContents(wcB);
    setProjectViews({ A: [makeWebContents(11)], B: [wcB] });
    const d = new PluginUIPromptDispatcher({ isDisposed: () => false });

    const promise = d.requestPrompt("p1", QUICK_PICK);
    expect(wcB.send).toHaveBeenCalledWith(
      CHANNELS.PLUGIN_UI_PROMPT_REQUEST,
      expect.objectContaining({ pluginId: "p1" })
    );
    expect(registryMock.getWebContentsForProject).not.toHaveBeenCalled();
    d.dispose();
    await expect(promise).resolves.toBeUndefined();
  });
});
