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

vi.mock("electron", () => ({ ipcMain: ipcMainMock }));
vi.mock("../../../window/windowRef.js", () => ({
  getWindowRegistry: windowRefMock.getWindowRegistry,
  getProjectViewManager: windowRefMock.getProjectViewManager,
}));

import { PluginUIPromptDispatcher } from "../PluginUIPromptDispatcher.js";
import type { PluginUiPromptParams } from "../../../../shared/types/pluginUiPrompt.js";

function makeWebContents(id: number) {
  const destroyed = new Set<() => void>();
  return {
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
});
