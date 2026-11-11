import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BrowserWindow, WebContents } from "electron";

const broadcastMock = vi.hoisted(() => vi.fn());
vi.mock("../../ipc/utils.js", () => ({
  broadcastToRendererExcept: broadcastMock,
}));

const appWebContentsByWindow = new Map<number, WebContents>();
vi.mock("../webContentsRegistry.js", () => ({
  getAppWebContents: (win: BrowserWindow) => appWebContentsByWindow.get(win.id),
}));

import { CHANNELS } from "../../ipc/channels.js";
import { freezeWebContents, unfreezeWebContents } from "../../utils/webContentsLifecycle.js";
import { releaseRendererMemory, sampleBlinkMemory } from "../rendererMemorySignals.js";

type ViewState = "loading" | "active" | "cached";

interface FakeWebContents {
  wc: WebContents;
  send: ReturnType<typeof vi.fn>;
}

let nextId = 1;
function makeWebContents(
  opts: { destroyed?: boolean; loadingMainFrame?: boolean; freezeError?: string } = {}
) {
  const send = vi.fn();
  const wc = {
    id: nextId++,
    isDestroyed: () => opts.destroyed ?? false,
    isLoadingMainFrame: () => opts.loadingMainFrame ?? false,
    send,
    debugger: {
      isAttached: () => true,
      attach: vi.fn(),
      sendCommand: vi.fn(async (method: string, params?: { state?: string }) => {
        if (opts.freezeError && method === "Page.setWebLifecycleState") {
          if (params?.state === "frozen") throw new Error(opts.freezeError);
        }
      }),
    },
  } as unknown as WebContents;
  return { wc, send } satisfies FakeWebContents;
}

function makeWindow(
  views: Array<{ fake: FakeWebContents; state: ViewState }> | null,
  appView?: FakeWebContents
) {
  const id = nextId++;
  const browserWindow = { id, isDestroyed: () => false } as unknown as BrowserWindow;
  if (appView) appWebContentsByWindow.set(id, appView.wc);
  const projectViewManager = views
    ? {
        getAllViews: () =>
          views.map(({ fake, state }) => ({ state, view: { webContents: fake.wc } })),
      }
    : undefined;
  return { browserWindow, services: { projectViewManager } } as unknown as Parameters<
    typeof sampleBlinkMemory
  >[0][number];
}

function sentBlinkSample(fake: FakeWebContents): boolean {
  return fake.send.mock.calls.some(
    ([channel, envelope]) =>
      channel === CHANNELS.EVENTS_PUSH &&
      (envelope as { name?: string })?.name === "window:sample-blink-memory"
  );
}

function reclaimSkip(): (wc: WebContents) => boolean {
  expect(broadcastMock).toHaveBeenCalledTimes(1);
  const [skip, channel, envelope] = broadcastMock.mock.calls[0];
  expect(channel).toBe(CHANNELS.EVENTS_PUSH);
  expect(envelope).toEqual({
    name: "window:reclaim-memory",
    payload: { reason: "system-memory-pressure" },
  });
  return skip as (wc: WebContents) => boolean;
}

describe("rendererMemorySignals (#16810)", () => {
  beforeEach(() => {
    broadcastMock.mockReset();
    appWebContentsByWindow.clear();
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  describe("sampleBlinkMemory", () => {
    it("asks active and running cached views, never frozen or loading ones", async () => {
      const active = makeWebContents();
      const cached = makeWebContents();
      const frozen = makeWebContents();
      const loading = makeWebContents();
      await freezeWebContents(frozen.wc);
      const win = makeWindow([
        { fake: active, state: "active" },
        { fake: cached, state: "cached" },
        { fake: frozen, state: "cached" },
        { fake: loading, state: "loading" },
      ]);

      for (let poll = 0; poll < 5; poll++) sampleBlinkMemory([win]);

      expect(active.send).toHaveBeenCalledTimes(5);
      expect(cached.send).toHaveBeenCalledTimes(5);
      expect(frozen.send).not.toHaveBeenCalled();
      expect(loading.send).not.toHaveBeenCalled();
    });

    it("skips a view as soon as its freeze is requested, before CDP acks it", () => {
      const view = makeWebContents();
      const win = makeWindow([{ fake: view, state: "cached" }]);

      void freezeWebContents(view.wc);
      sampleBlinkMemory([win]);

      expect(view.send).not.toHaveBeenCalled();
    });

    it("asks a view again once it is unfrozen", async () => {
      const view = makeWebContents();
      const win = makeWindow([{ fake: view, state: "cached" }]);
      await freezeWebContents(view.wc);
      sampleBlinkMemory([win]);

      await unfreezeWebContents(view.wc);
      sampleBlinkMemory([win]);

      expect(view.send).toHaveBeenCalledTimes(1);
      expect(sentBlinkSample(view)).toBe(true);
    });

    it("holds a view whose freeze failed until a thaw succeeds", async () => {
      const view = makeWebContents({ freezeError: "Target crashed unexpectedly" });
      const win = makeWindow([{ fake: view, state: "cached" }]);

      await freezeWebContents(view.wc);
      sampleBlinkMemory([win]);
      expect(view.send).not.toHaveBeenCalled();

      await unfreezeWebContents(view.wc);
      sampleBlinkMemory([win]);
      expect(sentBlinkSample(view)).toBe(true);
    });

    it("skips a settled view while it reloads, and a bootstrap shell still loading", () => {
      const reloading = makeWebContents({ loadingMainFrame: true });
      const loadingShell = makeWebContents({ loadingMainFrame: true });

      sampleBlinkMemory([
        makeWindow([{ fake: reloading, state: "active" }]),
        makeWindow(null, loadingShell),
      ]);

      expect(reloading.send).not.toHaveBeenCalled();
      expect(loadingShell.send).not.toHaveBeenCalled();
    });

    it("falls back to the app webContents for a window with no project views yet", () => {
      const app = makeWebContents();
      const win = makeWindow(null, app);

      sampleBlinkMemory([win]);

      expect(sentBlinkSample(app)).toBe(true);
    });

    it("never sends to a destroyed view or one in a destroyed window", () => {
      const dead = makeWebContents({ destroyed: true });
      const inDeadWindow = makeWebContents();
      const deadWindow = makeWindow([{ fake: inDeadWindow, state: "active" }]);
      (deadWindow.browserWindow as unknown as { isDestroyed: () => boolean }).isDestroyed = () =>
        true;

      sampleBlinkMemory([makeWindow([{ fake: dead, state: "active" }]), deadWindow]);

      expect(dead.send).not.toHaveBeenCalled();
      expect(inDeadWindow.send).not.toHaveBeenCalled();
    });
  });

  describe("releaseRendererMemory", () => {
    it("leaves frozen and loading views out of the broadcast and keeps the rest", async () => {
      const active = makeWebContents();
      const cached = makeWebContents();
      const frozen = makeWebContents();
      const loading = makeWebContents();
      const reloading = makeWebContents({ loadingMainFrame: true });
      const otherWindowApp = makeWebContents();
      await freezeWebContents(frozen.wc);
      const win = makeWindow([
        { fake: active, state: "active" },
        { fake: cached, state: "cached" },
        { fake: frozen, state: "cached" },
        { fake: loading, state: "loading" },
        { fake: reloading, state: "cached" },
      ]);

      releaseRendererMemory([win, makeWindow(null, otherWindowApp)]);

      const skip = reclaimSkip();
      expect(skip(active.wc)).toBe(false);
      expect(skip(cached.wc)).toBe(false);
      expect(skip(otherWindowApp.wc)).toBe(false);
      expect(skip(frozen.wc)).toBe(true);
      expect(skip(loading.wc)).toBe(true);
      expect(skip(reloading.wc)).toBe(true);
    });

    it("reaches a view again once it is unfrozen", async () => {
      const view = makeWebContents();
      await freezeWebContents(view.wc);
      await unfreezeWebContents(view.wc);

      releaseRendererMemory([makeWindow([{ fake: view, state: "cached" }])]);

      expect(reclaimSkip()(view.wc)).toBe(false);
    });

    it("still broadcasts when no window is registered", () => {
      const app = makeWebContents();

      releaseRendererMemory([]);

      expect(reclaimSkip()(app.wc)).toBe(false);
    });
  });
});
