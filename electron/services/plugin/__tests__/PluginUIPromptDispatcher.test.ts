import { afterEach, describe, it, expect, vi, beforeEach } from "vitest";
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

import {
  IMMEDIATE_PROMPT_ACK_GRACE_MS,
  IMMEDIATE_PROMPT_TIMEOUT_MS,
  MAX_PENDING_TARGETED_SENDS_PER_PLUGIN,
  PluginUIPromptDispatcher,
  REMOTE_ABORTED_PICKER_WAIT_MS,
  REMOTE_IMMEDIATE_PROMPT_TIMEOUT_MS,
} from "../PluginUIPromptDispatcher.js";
import {
  _resetPluginFrontendRoutingForTesting,
  getPluginInvokeOrigin,
  runInPluginInvocation,
  setPluginFrontendRouter,
  type PluginFrontend,
} from "../pluginFrontendRouting.js";
import { PluginFrontendMethod } from "../pluginFrontendRequests.js";
import type { ClientEndpoint } from "../../../ipc/endpoint.js";
import { AppError, isAppError } from "../../../utils/errorTypes.js";
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
    // Deliberately unscoped: the bulk drain dismisses every prompt for the
    // plugin, so an accidental `promptId` here would narrow it to one.
    expect(wc.send).toHaveBeenCalledWith(CHANNELS.PLUGIN_UI_PROMPT_CANCEL, {
      pluginId: "mine",
    });

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

  it("never opens a prompt whose signal is already aborted (#12279)", async () => {
    const wc = makeWebContents(7);
    setActiveWebContents(wc);
    const d = new PluginUIPromptDispatcher({ isDisposed: () => false });
    const controller = new AbortController();
    controller.abort();

    await expect(d.requestPrompt("mine", CONFIRM, undefined, controller.signal)).resolves.toBe(
      false
    );

    expect(
      wc.send.mock.calls.filter((c) => c[0] === CHANNELS.PLUGIN_UI_PROMPT_REQUEST)
    ).toHaveLength(0);
    // The one-prompt-per-plugin cap must not have been spent on a dialog that
    // was never shown — the next request still gets through.
    const next = d.requestPrompt("mine", CONFIRM);
    expect(
      wc.send.mock.calls.filter((c) => c[0] === CHANNELS.PLUGIN_UI_PROMPT_REQUEST)
    ).toHaveLength(1);
    d.cancelForPlugin("mine");
    await expect(next).resolves.toBe(false);
  });

  it("aborting a prompt dismisses that one request and settles it (#12279)", async () => {
    const wc = makeWebContents(7);
    setActiveWebContents(wc);
    const d = new PluginUIPromptDispatcher({ isDisposed: () => false });
    const controller = new AbortController();

    const promise = d.requestPrompt("mine", CONFIRM, undefined, controller.signal);
    const promptId = lastPromptId(wc);

    controller.abort();

    await expect(promise).resolves.toBe(false);
    // Scoped by promptId so the renderer drops exactly this dialog.
    expect(wc.send).toHaveBeenCalledWith(CHANNELS.PLUGIN_UI_PROMPT_CANCEL, {
      pluginId: "mine",
      promptId,
    });

    // The abort must release the per-plugin cap, not just settle the promise —
    // otherwise the successor generation's first prompt is answered for it.
    const next = d.requestPrompt("mine", CONFIRM);
    const nextId = lastPromptId(wc);
    expect(nextId).not.toBe(promptId);
    ipcMainMock._emit(
      CHANNELS.PLUGIN_UI_PROMPT_RESPONSE,
      { sender: { id: 7 } },
      { promptId: nextId, result: true }
    );
    await expect(next).resolves.toBe(true);
  });

  it("a late abort cannot dismiss a replacement prompt (#12279)", async () => {
    const wc = makeWebContents(7);
    setActiveWebContents(wc);
    const d = new PluginUIPromptDispatcher({ isDisposed: () => false });
    const controller = new AbortController();

    const first = d.requestPrompt("mine", CONFIRM, undefined, controller.signal);
    const firstId = lastPromptId(wc);
    ipcMainMock._emit(
      CHANNELS.PLUGIN_UI_PROMPT_RESPONSE,
      { sender: { id: 7 } },
      { promptId: firstId, result: true }
    );
    await expect(first).resolves.toBe(true);

    // Same plugin asks again; the earlier caller only now gives up.
    const second = d.requestPrompt("mine", CONFIRM);
    const secondId = lastPromptId(wc);
    expect(secondId).not.toBe(firstId);

    controller.abort();

    // The stale signal must not reach the successor's dialog.
    expect(wc.send).not.toHaveBeenCalledWith(CHANNELS.PLUGIN_UI_PROMPT_CANCEL, expect.anything());
    // Answer affirmatively: `false` would also be the value a wrongly-delivered
    // cancellation produces, so it could not tell the two apart.
    ipcMainMock._emit(
      CHANNELS.PLUGIN_UI_PROMPT_RESPONSE,
      { sender: { id: 7 } },
      { promptId: secondId, result: true }
    );
    await expect(second).resolves.toBe(true);
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

  describe("sendToAgent", () => {
    const PICKER: PluginUiPromptParams = {
      kind: "sendToAgent",
      request: { text: "body", sourceLabel: "Acme" },
    };
    const TARGETED: PluginUiPromptParams = {
      kind: "sendToAgent",
      request: { text: "body", sourceLabel: "Acme", terminalId: "t-1" },
    };

    it("dismisses a picker as cancelled rather than undefined", async () => {
      const wc = makeWebContents(7);
      setActiveWebContents(wc);
      const d = new PluginUIPromptDispatcher({ isDisposed: () => false });
      const promise = d.requestPrompt("p1", PICKER);
      d.cancelForPlugin("p1");
      await expect(promise).resolves.toEqual({ status: "cancelled" });
    });

    it("refuses a second picker as prompt-open instead of claiming the user dismissed it", async () => {
      const wc = makeWebContents(7);
      setActiveWebContents(wc);
      const d = new PluginUIPromptDispatcher({ isDisposed: () => false });
      const first = d.requestPrompt("p1", QUICK_PICK);
      await expect(d.requestPrompt("p1", PICKER)).resolves.toEqual({
        status: "refused",
        reason: "prompt-open",
      });
      d.dispose();
      await first;
    });

    it("never caps, and never counts toward the cap, a send that names its pane", async () => {
      const wc = makeWebContents(7);
      setActiveWebContents(wc);
      const d = new PluginUIPromptDispatcher({ isDisposed: () => false });
      const sends = () =>
        wc.send.mock.calls.filter((c) => c[0] === CHANNELS.PLUGIN_UI_PROMPT_REQUEST).length;

      const picker = d.requestPrompt("p1", PICKER);
      const targeted = d.requestPrompt("p1", TARGETED);
      const alsoTargeted = d.requestPrompt("p1", TARGETED);
      expect(sends()).toBe(3);

      d.dispose();
      await Promise.all([picker, targeted, alsoTargeted]);

      const d2 = new PluginUIPromptDispatcher({ isDisposed: () => false });
      const pending = d2.requestPrompt("p1", TARGETED);
      // A dialog still opens while a targeted send is in flight.
      const dialog = d2.requestPrompt("p1", QUICK_PICK);
      expect(sends()).toBe(5);
      d2.dispose();
      await Promise.all([pending, dialog]);
    });

    it("gives a targeted send its own cap and refuses past it as busy", async () => {
      const wc = makeWebContents(7);
      setActiveWebContents(wc);
      const d = new PluginUIPromptDispatcher({ isDisposed: () => false });
      const inFlight = Array.from({ length: MAX_PENDING_TARGETED_SENDS_PER_PLUGIN }, () =>
        d.requestPrompt("p1", TARGETED)
      );
      await expect(d.requestPrompt("p1", TARGETED)).resolves.toEqual({
        status: "refused",
        reason: "busy",
      });
      // Another plugin is not held to p1's cap.
      const other = d.requestPrompt("p2", TARGETED);
      expect(
        wc.send.mock.calls.filter((c) => c[0] === CHANNELS.PLUGIN_UI_PROMPT_REQUEST)
      ).toHaveLength(MAX_PENDING_TARGETED_SENDS_PER_PLUGIN + 1);
      d.dispose();
      await Promise.all([...inFlight, other]);
    });

    it("times out a targeted send the renderer never answers, and stamps its deadline", async () => {
      vi.useFakeTimers();
      try {
        const wc = makeWebContents(7);
        setActiveWebContents(wc);
        const d = new PluginUIPromptDispatcher({ isDisposed: () => false });
        const now = Date.now();
        const promise = d.requestPrompt("p1", TARGETED);
        const sent = wc.send.mock.calls.find(
          (c) => c[0] === CHANNELS.PLUGIN_UI_PROMPT_REQUEST
        )?.[1] as { expiresAt?: number };
        expect(sent.expiresAt).toBe(now + IMMEDIATE_PROMPT_TIMEOUT_MS);

        // Past the deadline main still waits out the grace for a late answer.
        let settled = false;
        void promise.then(() => {
          settled = true;
        });
        vi.advanceTimersByTime(IMMEDIATE_PROMPT_TIMEOUT_MS);
        await Promise.resolve();
        expect(settled).toBe(false);

        vi.advanceTimersByTime(IMMEDIATE_PROMPT_ACK_GRACE_MS);
        await expect(promise).resolves.toEqual({
          status: "refused",
          reason: "project-unavailable",
        });
        // The slot is released: another targeted send goes out.
        void d.requestPrompt("p1", TARGETED);
        expect(
          wc.send.mock.calls.filter((c) => c[0] === CHANNELS.PLUGIN_UI_PROMPT_REQUEST)
        ).toHaveLength(2);
        d.dispose();
      } finally {
        vi.useRealTimers();
      }
    });

    it("reports a draft whose answer lands just after the deadline, within the grace", async () => {
      vi.useFakeTimers();
      try {
        const wc = makeWebContents(7);
        setActiveWebContents(wc);
        const d = new PluginUIPromptDispatcher({ isDisposed: () => false });
        const promise = d.requestPrompt("p1", TARGETED);
        vi.advanceTimersByTime(IMMEDIATE_PROMPT_TIMEOUT_MS + 1);
        ipcMainMock._emit(
          CHANNELS.PLUGIN_UI_PROMPT_RESPONSE,
          { sender: { id: 7 } },
          { promptId: lastPromptId(wc), result: { status: "drafted", terminalId: "t-1" } }
        );
        await expect(promise).resolves.toEqual({ status: "drafted", terminalId: "t-1" });
        d.dispose();
      } finally {
        vi.useRealTimers();
      }
    });

    it("lets neither an abort nor an unload pre-empt a targeted send's real answer", async () => {
      const wc = makeWebContents(7);
      setActiveWebContents(wc);
      const d = new PluginUIPromptDispatcher({ isDisposed: () => false });
      const controller = new AbortController();
      const promise = d.requestPrompt("p1", TARGETED, undefined, controller.signal);
      const promptId = lastPromptId(wc);

      controller.abort();
      d.cancelForPlugin("p1");
      // No dismissal is sent for it: there is nothing on screen, and the
      // renderer has already acted on the request by the time a cancel arrives.
      expect(
        wc.send.mock.calls.filter((c) => c[0] === CHANNELS.PLUGIN_UI_PROMPT_CANCEL)
      ).toHaveLength(0);

      ipcMainMock._emit(
        CHANNELS.PLUGIN_UI_PROMPT_RESPONSE,
        { sender: { id: 7 } },
        { promptId, result: { status: "drafted", terminalId: "t-1" } }
      );
      await expect(promise).resolves.toEqual({ status: "drafted", terminalId: "t-1" });
      d.dispose();
    });

    const respond = (promptId: string, payload: Record<string, unknown>) =>
      ipcMainMock._emit(
        CHANNELS.PLUGIN_UI_PROMPT_RESPONSE,
        { sender: { id: 7 } },
        { promptId, ...payload }
      );

    it("reports what an accepted picker's launch did, even when cancelled during setup", async () => {
      const wc = makeWebContents(7);
      setActiveWebContents(wc);
      const d = new PluginUIPromptDispatcher({ isDisposed: () => false });
      const controller = new AbortController();
      const promise = d.requestPrompt("p1", PICKER, undefined, controller.signal);
      const promptId = lastPromptId(wc);
      let settled = false;
      void promise.then(() => {
        settled = true;
      });

      // The user chose "New agent in new worktree"; the worktree is being set up.
      respond(promptId, { accepted: true });
      controller.abort();
      d.cancelForPlugin("p1");
      await Promise.resolve();
      expect(settled).toBe(false);
      // The picker is gone, so there is nothing to dismiss.
      expect(
        wc.send.mock.calls.filter((c) => c[0] === CHANNELS.PLUGIN_UI_PROMPT_CANCEL)
      ).toHaveLength(0);
      // And the closed picker no longer holds the plugin's one dialog.
      const next = d.requestPrompt("p1", CONFIRM);
      expect(lastPromptId(wc)).not.toBe(promptId);

      const outcome = { status: "refused", reason: "launch-failed", worktreeId: "wt-new" };
      respond(promptId, { result: outcome });
      await expect(promise).resolves.toEqual(outcome);
      d.dispose();
      await next;
    });

    it("waits out an acceptance already on its way when the abort lands first", async () => {
      vi.useFakeTimers();
      try {
        const wc = makeWebContents(7);
        setActiveWebContents(wc);
        const d = new PluginUIPromptDispatcher({ isDisposed: () => false });
        const controller = new AbortController();
        const promise = d.requestPrompt("p1", PICKER, undefined, controller.signal);
        const promptId = lastPromptId(wc);

        controller.abort();
        expect(wc.send).toHaveBeenCalledWith(CHANNELS.PLUGIN_UI_PROMPT_CANCEL, {
          pluginId: "p1",
          promptId,
        });
        respond(promptId, { accepted: true });
        // Past the grace that bounds an unanswered cancel: the launch is the user's.
        vi.advanceTimersByTime(IMMEDIATE_PROMPT_ACK_GRACE_MS * 2);

        respond(promptId, { result: { status: "drafted", terminalId: "t-new" } });
        await expect(promise).resolves.toEqual({ status: "drafted", terminalId: "t-new" });
        d.dispose();
      } finally {
        vi.useRealTimers();
      }
    });

    it("settles an aborted picker on the renderer's dismissal, or as cancelled if none comes", async () => {
      vi.useFakeTimers();
      try {
        const wc = makeWebContents(7);
        setActiveWebContents(wc);
        const d = new PluginUIPromptDispatcher({ isDisposed: () => false });

        const dismissed = new AbortController();
        const first = d.requestPrompt("p1", PICKER, undefined, dismissed.signal);
        dismissed.abort();
        respond(lastPromptId(wc), { result: { status: "cancelled" } });
        await expect(first).resolves.toEqual({ status: "cancelled" });

        const hung = new AbortController();
        const second = d.requestPrompt("p1", PICKER, undefined, hung.signal);
        hung.abort();
        vi.advanceTimersByTime(IMMEDIATE_PROMPT_ACK_GRACE_MS);
        await expect(second).resolves.toEqual({ status: "cancelled" });
        d.dispose();
      } finally {
        vi.useRealTimers();
      }
    });

    it("ignores an acceptance for a prompt that is not a picker", async () => {
      const wc = makeWebContents(7);
      setActiveWebContents(wc);
      const d = new PluginUIPromptDispatcher({ isDisposed: () => false });
      const controller = new AbortController();
      const promise = d.requestPrompt("p1", CONFIRM, undefined, controller.signal);
      respond(lastPromptId(wc), { accepted: true });
      controller.abort();
      await expect(promise).resolves.toBe(false);
    });

    it("never times out a picker, and sends it no deadline", async () => {
      vi.useFakeTimers();
      try {
        const wc = makeWebContents(7);
        setActiveWebContents(wc);
        const d = new PluginUIPromptDispatcher({ isDisposed: () => false });
        let settled = false;
        const promise = d.requestPrompt("p1", PICKER).then((value) => {
          settled = true;
          return value;
        });
        const sent = wc.send.mock.calls.find(
          (c) => c[0] === CHANNELS.PLUGIN_UI_PROMPT_REQUEST
        )?.[1] as { expiresAt?: number };
        expect(sent).not.toHaveProperty("expiresAt");
        vi.advanceTimersByTime(IMMEDIATE_PROMPT_TIMEOUT_MS * 10);
        await Promise.resolve();
        expect(settled).toBe(false);
        d.dispose();
        await promise;
      } finally {
        vi.useRealTimers();
      }
    });
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

describe("PluginUIPromptDispatcher with a remote driver", () => {
  const PROJECT = "a".repeat(64);
  const CONFIRM: PluginUiPromptParams = { kind: "confirm", options: { title: "Deploy?" } };
  const PICK: PluginUiPromptParams = {
    kind: "quickPick",
    items: [
      { id: "a", label: "Alpha" },
      { id: "b", label: "Beta" },
    ],
    options: {},
  };

  const PICKER: PluginUiPromptParams = {
    kind: "sendToAgent",
    request: { text: "Card body", sourceLabel: "Deploy" },
  };
  const TARGETED: PluginUiPromptParams = {
    kind: "sendToAgent",
    request: { text: "Card body", sourceLabel: "Deploy", terminalId: "t-1" },
  };

  interface Deferred {
    resolve: (value: unknown) => void;
    reject: (error: unknown) => void;
  }

  function makeEndpoint(endpointId = "s1:ep", projectId: string = PROJECT) {
    const requests: Array<{ method: string; payload: unknown; deferred: Deferred }> = [];
    let closed = false;
    const endpoint: ClientEndpoint = {
      endpointId,
      clientId: "client-mbp",
      projectId,
      kind: "remote-view",
      handle: -3,
      send: vi.fn(),
      request: vi.fn((method: string, payload: unknown) => {
        return new Promise((resolve, reject) => {
          requests.push({ method, payload, deferred: { resolve, reject } });
        });
      }),
      onClose: () => ({ dispose: () => {} }),
      isClosed: () => closed,
    };
    return { endpoint, requests, close: () => (closed = true) };
  }

  let frontend: PluginFrontend = { kind: "local" };
  let changeListener: (() => void) | null = null;

  function installRouter() {
    setPluginFrontendRouter({
      resolve: () => frontend,
      onChange: (listener) => {
        changeListener = listener;
        return () => {
          changeListener = null;
        };
      },
    });
  }

  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

  let dispatcher: PluginUIPromptDispatcher;

  beforeEach(() => {
    ipcMainMock._reset();
    webContentsMock._reset();
    webContentsMock.fromId.mockReset();
    windowRefMock.getWindowRegistry.mockReset().mockReturnValue(null);
    windowRefMock.getProjectViewManager.mockReset().mockReturnValue(null);
    registryMock.getWebContentsForProject.mockReset().mockReturnValue([]);
    registryMock.isCachedViewWebContents.mockReset().mockReturnValue(false);
    _resetPluginFrontendRoutingForTesting();
    frontend = { kind: "local" };
    changeListener = null;
    dispatcher = new PluginUIPromptDispatcher({ isDisposed: () => false, now: () => 1_000 });
    installRouter();
  });

  afterEach(() => {
    dispatcher.dispose();
    _resetPluginFrontendRoutingForTesting();
  });

  it("asks the drive-lease holder's endpoint and returns its answer", async () => {
    const { endpoint, requests } = makeEndpoint();
    frontend = { kind: "remote", endpoint };
    const answer = dispatcher.requestPrompt("acme.deploy", CONFIRM, PROJECT, undefined, {
      pluginDisplayName: "Deploy",
    });
    await flush();
    expect(requests).toHaveLength(1);
    expect(requests[0]!.method).toBe(PluginFrontendMethod.PROMPT);
    expect(requests[0]!.payload).toMatchObject({
      pluginId: "acme.deploy",
      pluginDisplayName: "Deploy",
      params: CONFIRM,
    });
    expect(requests[0]!.payload).not.toHaveProperty("askedAt");
    expect(endpoint.request).toHaveBeenCalledWith(PluginFrontendMethod.PROMPT, expect.anything(), {
      timeoutMs: 0,
    });
    requests[0]!.deferred.resolve(true);
    await expect(answer).resolves.toBe(true);
  });

  it("maps a quick pick answer back onto the host's own items", async () => {
    const { endpoint, requests } = makeEndpoint();
    frontend = { kind: "remote", endpoint };
    const answer = dispatcher.requestPrompt("acme.deploy", PICK, PROJECT);
    await flush();
    requests[0]!.deferred.resolve({ id: "b", label: "Injected label" });
    await expect(answer).resolves.toEqual({ id: "b", label: "Beta" });
  });

  it("fails with NO_FRONTEND_ATTACHED when nobody is attached — not the dismiss value", async () => {
    frontend = { kind: "none", reason: "vacant" };
    const error = await dispatcher.requestPrompt("acme.deploy", CONFIRM, PROJECT).catch((e) => e);
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe("NO_FRONTEND_ATTACHED");
    expect((error as AppError).message).toMatch(/^NO_FRONTEND_ATTACHED:/);
  });

  it("queues an opted-in prompt and shows it, marked as waited, when a frontend attaches", async () => {
    frontend = { kind: "none", reason: "vacant" };
    let now = 1_000;
    dispatcher = new PluginUIPromptDispatcher({ isDisposed: () => false, now: () => now });
    const answer = dispatcher.requestPrompt("acme.deploy", CONFIRM, PROJECT, undefined, {
      whenNoFrontend: "queue",
    });
    let settled = false;
    void answer.then(() => (settled = true));
    await flush();
    expect(settled).toBe(false);

    const { endpoint, requests } = makeEndpoint();
    frontend = { kind: "remote", endpoint };
    now = 61_000;
    changeListener?.();
    await flush();
    expect(requests).toHaveLength(1);
    expect(requests[0]!.payload).toMatchObject({ askedAt: 1_000 });
    requests[0]!.deferred.resolve(true);
    await expect(answer).resolves.toBe(true);
  });

  it("an aborted queued prompt settles with the dismiss value", async () => {
    frontend = { kind: "none", reason: "vacant" };
    const controller = new AbortController();
    const answer = dispatcher.requestPrompt("acme.deploy", CONFIRM, PROJECT, controller.signal, {
      whenNoFrontend: "queue",
    });
    controller.abort();
    await expect(answer).resolves.toBe(false);
  });

  it("counts a queued prompt against the one-prompt-per-plugin cap", async () => {
    frontend = { kind: "none", reason: "vacant" };
    void dispatcher.requestPrompt("acme.deploy", CONFIRM, PROJECT, undefined, {
      whenNoFrontend: "queue",
    });
    await expect(
      dispatcher.requestPrompt("acme.deploy", CONFIRM, PROJECT, undefined, {
        whenNoFrontend: "queue",
      })
    ).resolves.toBe(false);
  });

  it("aborting takes the prompt off the remote screen", async () => {
    const { endpoint, requests } = makeEndpoint();
    frontend = { kind: "remote", endpoint };
    const controller = new AbortController();
    const answer = dispatcher.requestPrompt("acme.deploy", CONFIRM, PROJECT, controller.signal);
    await flush();
    const promptId = (requests[0]!.payload as { promptId: string }).promptId;
    controller.abort();
    await expect(answer).resolves.toBe(false);
    expect(requests[1]).toMatchObject({
      method: PluginFrontendMethod.PROMPT_CANCEL,
      payload: { pluginId: "acme.deploy", promptId },
    });
  });

  it("a driver that leaves before answering is NO_FRONTEND_ATTACHED", async () => {
    const { endpoint, requests, close } = makeEndpoint();
    frontend = { kind: "remote", endpoint };
    const answer = dispatcher.requestPrompt("acme.deploy", CONFIRM, PROJECT);
    await flush();
    close();
    frontend = { kind: "none", reason: "reserved" };
    requests[0]!.deferred.reject(new AppError({ code: "HOST_DISCONNECTED", message: "gone" }));
    await expect(answer).rejects.toMatchObject({ code: "NO_FRONTEND_ATTACHED" });
  });

  it("cancelForPlugin dismisses the remote dialog and resolves the dismiss value", async () => {
    const { endpoint, requests } = makeEndpoint();
    frontend = { kind: "remote", endpoint };
    const answer = dispatcher.requestPrompt("acme.deploy", CONFIRM, PROJECT);
    await flush();
    dispatcher.cancelForPlugin("acme.deploy");
    await expect(answer).resolves.toBe(false);
    expect(requests[1]).toMatchObject({
      method: PluginFrontendMethod.PROMPT_CANCEL,
      payload: { pluginId: "acme.deploy" },
    });
  });

  describe("send-to-agent", () => {
    it("returns a targeted draft the driving Shell made", async () => {
      const { endpoint, requests } = makeEndpoint();
      frontend = { kind: "remote", endpoint };
      const answer = dispatcher.requestPrompt("acme.deploy", TARGETED, PROJECT);
      await flush();
      expect(requests[0]!.payload).toMatchObject({ params: TARGETED });
      requests[0]!.deferred.resolve({ status: "drafted", terminalId: "t-1" });
      await expect(answer).resolves.toEqual({ status: "drafted", terminalId: "t-1" });
    });

    it("reads a malformed Shell answer as cancelled", async () => {
      const { endpoint, requests } = makeEndpoint();
      frontend = { kind: "remote", endpoint };
      const answer = dispatcher.requestPrompt("acme.deploy", PICKER, PROJECT);
      await flush();
      requests[0]!.deferred.resolve({ status: "drafted" });
      await expect(answer).resolves.toEqual({ status: "cancelled" });
    });

    it("refuses a second picker as prompt-open, and keeps targeted sends on their own cap", async () => {
      const { endpoint, requests } = makeEndpoint();
      frontend = { kind: "remote", endpoint };
      void dispatcher.requestPrompt("acme.deploy", PICKER, PROJECT);
      await expect(dispatcher.requestPrompt("acme.deploy", PICKER, PROJECT)).resolves.toEqual({
        status: "refused",
        reason: "prompt-open",
      });
      for (let i = 0; i < 8; i++) void dispatcher.requestPrompt("acme.deploy", TARGETED, PROJECT);
      await expect(dispatcher.requestPrompt("acme.deploy", TARGETED, PROJECT)).resolves.toEqual({
        status: "refused",
        reason: "busy",
      });
      await flush();
      // One picker and eight targeted sends reached the Shell; the refusals did not.
      expect(requests.filter((r) => r.method === PluginFrontendMethod.PROMPT)).toHaveLength(9);
    });

    it("keeps waiting on a picker's answer after an abort, so an accepted launch is reported", async () => {
      const { endpoint, requests } = makeEndpoint();
      frontend = { kind: "remote", endpoint };
      const controller = new AbortController();
      const answer = dispatcher.requestPrompt("acme.deploy", PICKER, PROJECT, controller.signal);
      await flush();
      controller.abort();
      await flush();
      expect(requests[1]).toMatchObject({ method: PluginFrontendMethod.PROMPT_CANCEL });
      let settled = false;
      void answer.then(() => (settled = true));
      await flush();
      expect(settled).toBe(false);
      // The user had already picked "new agent here"; the Shell reports the launch.
      requests[0]!.deferred.resolve({ status: "drafted", terminalId: "t-new" });
      await expect(answer).resolves.toEqual({ status: "drafted", terminalId: "t-new" });
    });

    it("still reports a launch the Shell finishes well after the abort", async () => {
      vi.useFakeTimers();
      try {
        const { endpoint, requests } = makeEndpoint();
        frontend = { kind: "remote", endpoint };
        const controller = new AbortController();
        const answer = dispatcher.requestPrompt("acme.deploy", PICKER, PROJECT, controller.signal);
        await vi.advanceTimersByTimeAsync(0);
        controller.abort();
        // An agent that took half a minute to come up after the user picked it.
        await vi.advanceTimersByTimeAsync(30_000);
        requests[0]!.deferred.resolve({ status: "drafted", terminalId: "t-new" });
        await expect(answer).resolves.toEqual({ status: "drafted", terminalId: "t-new" });
      } finally {
        vi.useRealTimers();
      }
    });

    it("reports an aborted targeted send whose Shell then vanished as undelivered, not cancelled", async () => {
      const { endpoint, requests, close } = makeEndpoint();
      frontend = { kind: "remote", endpoint };
      const controller = new AbortController();
      const answer = dispatcher.requestPrompt("acme.deploy", TARGETED, PROJECT, controller.signal);
      await flush();
      controller.abort();
      close();
      requests[0]!.deferred.reject(new AppError({ code: "HOST_DISCONNECTED", message: "gone" }));
      await expect(answer).resolves.toEqual({ status: "refused", reason: "project-unavailable" });
    });

    it("settles an aborted picker as cancelled when the Shell never answers", async () => {
      vi.useFakeTimers();
      try {
        const { endpoint } = makeEndpoint();
        frontend = { kind: "remote", endpoint };
        const controller = new AbortController();
        const answer = dispatcher.requestPrompt("acme.deploy", PICKER, PROJECT, controller.signal);
        await vi.advanceTimersByTimeAsync(0);
        controller.abort();
        await vi.advanceTimersByTimeAsync(REMOTE_ABORTED_PICKER_WAIT_MS);
        await expect(answer).resolves.toEqual({ status: "cancelled" });
      } finally {
        vi.useRealTimers();
      }
    });

    it("gives a targeted send's slot back when the Shell holds it past the deadline", async () => {
      vi.useFakeTimers();
      try {
        const { endpoint } = makeEndpoint();
        frontend = { kind: "remote", endpoint };
        const answer = dispatcher.requestPrompt("acme.deploy", TARGETED, PROJECT);
        await vi.advanceTimersByTimeAsync(REMOTE_IMMEDIATE_PROMPT_TIMEOUT_MS);
        await expect(answer).resolves.toEqual({
          status: "refused",
          reason: "project-unavailable",
        });
      } finally {
        vi.useRealTimers();
      }
    });

    it("stays with the Shell it was sent to when another driver takes over", async () => {
      const a = makeEndpoint("a");
      const b = makeEndpoint("b");
      frontend = { kind: "remote", endpoint: a.endpoint, leaseId: 1 };
      const answer = dispatcher.requestPrompt("acme.deploy", TARGETED, PROJECT);
      await flush();
      frontend = { kind: "remote", endpoint: b.endpoint, leaseId: 2 };
      changeListener?.();
      await flush();
      expect(b.requests).toHaveLength(0);
      a.requests[0]!.deferred.resolve({ status: "drafted", terminalId: "t-1" });
      await expect(answer).resolves.toEqual({ status: "drafted", terminalId: "t-1" });
      expect(b.requests).toHaveLength(0);
    });

    it("never re-sends a targeted draft when its Shell disconnects mid-flight", async () => {
      const a = makeEndpoint("a");
      const b = makeEndpoint("b");
      frontend = { kind: "remote", endpoint: a.endpoint };
      const answer = dispatcher.requestPrompt("acme.deploy", TARGETED, PROJECT);
      await flush();
      a.close();
      frontend = { kind: "remote", endpoint: b.endpoint };
      a.requests[0]!.deferred.reject(new AppError({ code: "HOST_DISCONNECTED", message: "gone" }));
      await expect(answer).resolves.toEqual({ status: "refused", reason: "project-unavailable" });
      expect(b.requests).toHaveLength(0);
    });
  });

  it("with no router the prompt path is the local one", async () => {
    _resetPluginFrontendRoutingForTesting();
    // No project view anywhere: the unchanged local path answers PROJECT_VIEW_UNAVAILABLE.
    await expect(dispatcher.requestPrompt("acme.deploy", CONFIRM, PROJECT)).rejects.toMatchObject({
      code: "PROJECT_VIEW_UNAVAILABLE",
    });
    await expect(dispatcher.requestPrompt("acme.deploy", CONFIRM, null)).resolves.toBe(false);
  });

  it("moves an open prompt to whoever takes the project over", async () => {
    const a = makeEndpoint("a");
    const b = makeEndpoint("b");
    frontend = { kind: "remote", endpoint: a.endpoint, leaseId: 1 };
    const answer = dispatcher.requestPrompt("acme.deploy", CONFIRM, PROJECT);
    await flush();
    expect(a.requests).toHaveLength(1);
    const promptId = (a.requests[0]!.payload as { promptId: string }).promptId;

    frontend = { kind: "remote", endpoint: b.endpoint, leaseId: 2 };
    changeListener?.();
    await flush();
    expect(a.requests[1]).toMatchObject({
      method: PluginFrontendMethod.PROMPT_CANCEL,
      payload: { pluginId: "acme.deploy", promptId },
    });
    expect(b.requests).toHaveLength(1);
    expect(b.requests[0]!.method).toBe(PluginFrontendMethod.PROMPT);

    // The old driver's approval arrives late: it is nobody's answer now.
    a.requests[0]!.deferred.resolve(true);
    let settled = false;
    void answer.then(() => (settled = true));
    await flush();
    expect(settled).toBe(false);
    b.requests[0]!.deferred.resolve(false);
    await expect(answer).resolves.toBe(false);
  });

  it("never returns an approval from a driver whose lease has gone, even unannounced", async () => {
    const a = makeEndpoint("a");
    const b = makeEndpoint("b");
    frontend = { kind: "remote", endpoint: a.endpoint, leaseId: 1 };
    const answer = dispatcher.requestPrompt("acme.deploy", CONFIRM, PROJECT);
    await flush();
    frontend = { kind: "remote", endpoint: b.endpoint, leaseId: 2 };
    a.requests[0]!.deferred.resolve(true);
    await flush();
    expect(b.requests).toHaveLength(1);
    b.requests[0]!.deferred.resolve(true);
    await expect(answer).resolves.toBe(true);
  });

  it("refuses the same driver's approval once it has lost and retaken the lease", async () => {
    const a = makeEndpoint("a");
    frontend = { kind: "remote", endpoint: a.endpoint, leaseId: 1 };
    const answer = dispatcher.requestPrompt("acme.deploy", CONFIRM, PROJECT);
    await flush();
    frontend = { kind: "remote", endpoint: a.endpoint, leaseId: 3 };
    a.requests[0]!.deferred.resolve(true);
    await flush();
    expect(a.requests.map((r) => r.method)).toEqual([
      PluginFrontendMethod.PROMPT,
      PluginFrontendMethod.PROMPT_CANCEL,
      PluginFrontendMethod.PROMPT,
    ]);
    a.requests[2]!.deferred.resolve(true);
    await expect(answer).resolves.toBe(true);
  });

  it("takes a stale driver's dismissal as it is", async () => {
    const a = makeEndpoint("a");
    const b = makeEndpoint("b");
    frontend = { kind: "remote", endpoint: a.endpoint, leaseId: 1 };
    const answer = dispatcher.requestPrompt("acme.deploy", CONFIRM, PROJECT);
    await flush();
    frontend = { kind: "remote", endpoint: b.endpoint, leaseId: 2 };
    a.requests[0]!.deferred.resolve(false);
    await expect(answer).resolves.toBe(false);
    expect(b.requests).toHaveLength(0);
  });

  it("re-routes a queued app-global prompt to the caller whose invocation asked", async () => {
    const a = makeEndpoint("a", PROJECT);
    const b = makeEndpoint("b", "b".repeat(64));
    let attached = false;
    setPluginFrontendRouter({
      resolve: ({ pluginId }) => {
        const origin = getPluginInvokeOrigin(pluginId);
        if (!attached || !origin) return { kind: "none", reason: "vacant" };
        return { kind: "remote", endpoint: origin.endpoint };
      },
      onChange: (listener) => {
        changeListener = listener;
        return () => (changeListener = null);
      },
    });
    const answer = runInPluginInvocation("acme.global", a.endpoint, () =>
      dispatcher.requestPrompt("acme.global", CONFIRM, null, undefined, {
        whenNoFrontend: "queue",
      })
    );
    // B calls the same plugin meanwhile; it must not inherit A's question.
    await runInPluginInvocation("acme.global", b.endpoint, async () => {
      await flush();
    });
    attached = true;
    changeListener?.();
    await flush();
    expect(a.requests).toHaveLength(1);
    expect(b.requests).toHaveLength(0);
    a.requests[0]!.deferred.resolve(true);
    await expect(answer).resolves.toBe(true);
  });

  it("takes a local prompt down when a remote driver takes the project over", async () => {
    const send = vi.fn();
    const wc = {
      id: 7,
      isDestroyed: () => false,
      once: vi.fn(),
      removeListener: vi.fn(),
      send,
    };
    registryMock.getWebContentsForProject.mockReturnValue([wc]);
    const { webContents } = await import("electron");
    vi.mocked(webContents.fromId).mockReturnValue(wc as never);
    frontend = { kind: "local" };
    const answer = dispatcher.requestPrompt("acme.deploy", CONFIRM, PROJECT);
    await flush();
    expect(send).toHaveBeenCalledTimes(1);

    const b = makeEndpoint("b");
    frontend = { kind: "remote", endpoint: b.endpoint, leaseId: 2 };
    changeListener?.();
    await flush();
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1]![1]).toMatchObject({ pluginId: "acme.deploy" });
    expect(b.requests).toHaveLength(1);
    b.requests[0]!.deferred.resolve(true);
    await expect(answer).resolves.toBe(true);
    registryMock.getWebContentsForProject.mockReturnValue([]);
  });

  it("does not hand a prompt cancelled mid-move to the next driver", async () => {
    const a = makeEndpoint("a");
    const b = makeEndpoint("b");
    frontend = { kind: "remote", endpoint: a.endpoint, leaseId: 1 };
    const controller = new AbortController();
    const answer = dispatcher.requestPrompt("acme.deploy", CONFIRM, PROJECT, controller.signal);
    await flush();
    frontend = { kind: "remote", endpoint: b.endpoint, leaseId: 2 };
    // A's approval lands stale, and the caller cancels in the same turn.
    a.requests[0]!.deferred.resolve(true);
    controller.abort();
    await expect(answer).resolves.toBe(false);
    await flush();
    expect(b.requests).toHaveLength(0);
  });

  it("shows a local app-global prompt in the view of the caller's project, not the front window", async () => {
    const wc = {
      id: 9,
      isDestroyed: () => false,
      once: vi.fn(),
      removeListener: vi.fn(),
      send: vi.fn(),
    };
    registryMock.getWebContentsForProject.mockImplementation((projectId: string) =>
      projectId === PROJECT ? [wc] : []
    );
    frontend = { kind: "local" };
    const caller = makeEndpoint("caller", PROJECT).endpoint;
    void runInPluginInvocation("acme.global", caller, () =>
      dispatcher.requestPrompt("acme.global", CONFIRM, null)
    );
    await flush();
    expect(registryMock.getWebContentsForProject).toHaveBeenCalledWith(PROJECT);
    expect(wc.send).toHaveBeenCalledTimes(1);
    registryMock.getWebContentsForProject.mockReset().mockReturnValue([]);
  });
});
